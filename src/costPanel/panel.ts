// Host side of the scripted Cost Breakdown webview. One reused editor-tab
// panel; the extension pushes full CostPanelState (throttled upstream by the
// status bar's single render path) and the client diffs per prompt group.

import * as vscode from "vscode";
import { makeNonce, webviewCsp, webviewShellHtml, isSafeHttpUrl, bustCache } from "../webviewHost";
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
  private readonly extensionUri: vscode.Uri;
  private mode: "session" | "all";
  private ready = false;
  private pendingState: CostPanelState | undefined;
  // Bumped on every shell (re)render so a refresh cache-busts the bundle URI.
  private htmlRev = 0;
  private readonly getState: (mode: "session" | "all") => CostPanelState;

  private constructor(
    extensionUri: vscode.Uri,
    mode: "session" | "all",
    getState: (mode: "session" | "all") => CostPanelState,
  ) {
    this.extensionUri = extensionUri;
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

    this.renderShell();

    this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      void this.onMessage(msg);
    });
    this.panel.onDidDispose(() => {
      if (CostDetailPanel.current === this) {
        CostDetailPanel.current = undefined;
      }
    });
  }

  // (Re)build the webview document. Each call uses a fresh nonce and a cache-
  // busted bundle URI, so calling it again reloads the webview in place and
  // picks up a rebuilt media/costPanel.js — no window reload.
  private renderShell(): void {
    this.htmlRev += 1;
    const nonce = makeNonce();
    const scriptUri = bustCache(
      this.panel.webview
        .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "costPanel.js"))
        .toString(),
      this.htmlRev,
    );
    this.panel.webview.html = webviewShellHtml({
      csp: webviewCsp(this.panel.webview, nonce),
      nonce,
      scriptUri,
      title: "AI Cost Breakdown",
      headHtml: `<style nonce="${nonce}">${COST_PANEL_CSS}</style>`,
      bodyHtml: `<div id="app"></div>`,
    });
  }

  // Reload the webview in place: the client re-initialises and re-requests its
  // bundle, then re-sends "ready" so we push fresh state.
  private refresh(): void {
    this.ready = false;
    this.pendingState = undefined;
    this.renderShell();
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
        if (msg.id === "refresh") {
          this.refresh();
        } else if (msg.id === "showAll" || msg.id === "showSession") {
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

  /**
   * Reload the panel's webview if it is the active editor. Returns whether it
   * acted, so the Refresh Panel command can fall through to another panel.
   */
  static refreshActive(): boolean {
    const p = CostDetailPanel.current;
    if (p && p.panel.active) {
      p.refresh();
      return true;
    }
    return false;
  }
}
