// Host side of the scripted Cost Breakdown webview. One reused editor-tab
// panel; the extension pushes full CostPanelState (throttled upstream by the
// status bar's single render path) and the client diffs per prompt group.

import * as vscode from "vscode";
import { makeNonce, webviewCsp, webviewShellHtml, isSafeHttpUrl } from "../webviewHost";
import { COST_PANEL_CSS } from "./styles";
import { CostPanelState, WebviewMessage } from "./protocol";

const VIEW_TYPE = "promptconduitCostBreakdown";

/** Commands a webview button may invoke, mapped to real extension commands. */
const COMMAND_MAP: Record<string, string> = {
  pinSession: "promptconduit.cost.pinSession",
  followActive: "promptconduit.cost.followActive",
};

export class CostDetailPanel {
  static current: CostDetailPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private mode: "session" | "all";
  private ready = false;
  private pendingState: CostPanelState | undefined;
  private readonly getState: (mode: "session" | "all") => CostPanelState;

  private constructor(
    extensionUri: vscode.Uri,
    mode: "session" | "all",
    getState: (mode: "session" | "all") => CostPanelState,
  ) {
    this.mode = mode;
    this.getState = getState;
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "AI Cost Breakdown",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );

    const nonce = makeNonce();
    const scriptUri = this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "costPanel.js"))
      .toString();
    this.panel.webview.html = webviewShellHtml({
      csp: webviewCsp(this.panel.webview, nonce),
      nonce,
      scriptUri,
      title: "AI Cost Breakdown",
      headHtml: `<style nonce="${nonce}">${COST_PANEL_CSS}</style>`,
      bodyHtml: `<div id="app"></div>`,
    });

    this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      void this.onMessage(msg);
    });
    this.panel.onDidDispose(() => {
      if (CostDetailPanel.current === this) {
        CostDetailPanel.current = undefined;
      }
    });
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.ready = true;
        this.push(this.pendingState ?? this.getState(this.mode));
        this.pendingState = undefined;
        break;
      case "open_external":
        if (isSafeHttpUrl(msg.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        break;
      case "command":
        if (msg.id === "showAll" || msg.id === "showSession") {
          this.mode = msg.id === "showAll" ? "all" : "session";
          this.push(this.getState(this.mode));
        } else if (COMMAND_MAP[msg.id]) {
          await vscode.commands.executeCommand(COMMAND_MAP[msg.id]);
        }
        break;
      case "log":
        // Client-side diagnostics land in the extension host console.
        console[msg.level === "error" ? "error" : "log"](`[costPanel] ${msg.msg}`);
        break;
    }
  }

  private push(state: CostPanelState): void {
    if (!this.ready) {
      this.pendingState = state;
      return;
    }
    void this.panel.webview.postMessage({ type: "state", state });
  }

  /** Open (or reveal) the panel in the given mode and push fresh state. */
  static show(
    extensionUri: vscode.Uri,
    mode: "session" | "all",
    getState: (mode: "session" | "all") => CostPanelState,
  ): void {
    if (CostDetailPanel.current) {
      CostDetailPanel.current.mode = mode;
      CostDetailPanel.current.panel.reveal(vscode.ViewColumn.Active, false);
      CostDetailPanel.current.push(getState(mode));
      return;
    }
    CostDetailPanel.current = new CostDetailPanel(extensionUri, mode, getState);
  }

  /** Push fresh state into an open panel; no-op when the panel is closed. */
  static refresh(): void {
    const p = CostDetailPanel.current;
    if (p) {
      p.push(p.getState(p.mode));
    }
  }
}
