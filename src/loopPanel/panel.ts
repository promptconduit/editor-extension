// Host side of The Loop webview: one reused editor-tab panel. The extension
// pushes full LoopPanelState (throttled upstream by the status bar's single
// render path); the panel keeps which prompt the user picked.

import * as vscode from "vscode";
import { makeNonce, webviewCsp, webviewShellHtml, isSafeHttpUrl, bustCache } from "../webviewHost";
import { LOOP_PANEL_CSS } from "./styles";
import type { LoopPanelState, WebviewMessage } from "./protocol";
import type { LoopSelection } from "./viewModel";

const VIEW_TYPE = "promptconduitLoop";
const TITLE = "The Loop";

/** Commands a webview button may invoke, mapped to real extension commands. */
const COMMAND_MAP: Record<string, string> = {
  pinSession: "promptconduit.cost.pinSession",
  followActive: "promptconduit.cost.followActive",
  login: "promptconduit.account.login",
  dismissLogin: "promptconduit.account.dismissLogin",
  registerMcp: "promptconduit.agent.registerMcp",
  dismissAgentHint: "promptconduit.agent.dismissHint",
  inviteTeammate: "promptconduit.team.invite",
  installCli: "promptconduit.setup.installCli",
  runInit: "promptconduit.setup.runInit",
};

// Live refreshes (driven by status-bar renders, up to 4/s) are coalesced to at
// most one per second, and skipped entirely while the panel is hidden.
const REFRESH_MIN_MS = 1000;

export class LoopPanel {
  static current: LoopPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private ready = false;
  private pendingState: LoopPanelState | undefined;
  private htmlRev = 0;
  private selection: LoopSelection = { followLatest: true };
  // A live refresh arrived while hidden; push fresh state on reveal.
  private dirty = false;
  private disposed = false;
  private lastRefreshAt = 0;
  private refreshTimer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getState: (sel: LoopSelection) => LoopPanelState,
  ) {
    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, TITLE, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "resources", "icon.png");
    this.renderShell();
    this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      void this.onMessage(msg);
    });
    this.panel.onDidChangeViewState(() => {
      if (this.panel.visible && this.dirty) this.pushFresh();
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
      }
      if (LoopPanel.current === this) LoopPanel.current = undefined;
    });
  }

  /** Live refresh: deferred while hidden, throttled to one push per REFRESH_MIN_MS (trailing edge kept). */
  private requestRefresh(): void {
    if (this.disposed) return;
    if (!this.panel.visible) {
      this.dirty = true;
      return;
    }
    if (this.refreshTimer) return; // a trailing refresh is already scheduled
    const wait = this.lastRefreshAt + REFRESH_MIN_MS - Date.now();
    if (wait <= 0) {
      this.pushFresh();
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.disposed) return;
      if (this.panel.visible) this.pushFresh();
      else this.dirty = true;
    }, wait);
  }

  private pushFresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.dirty = false;
    this.lastRefreshAt = Date.now();
    this.push(this.getState(this.selection));
  }

  // (Re)build the document with a fresh nonce and a cache-busted bundle URI,
  // so calling it again reloads the webview in place.
  private renderShell(): void {
    this.htmlRev += 1;
    const nonce = makeNonce();
    const scriptUri = bustCache(
      this.panel.webview
        .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "loopPanel.js"))
        .toString(),
      this.htmlRev,
    );
    this.panel.webview.html = webviewShellHtml({
      csp: webviewCsp(this.panel.webview, nonce),
      nonce,
      scriptUri,
      title: TITLE,
      headHtml: `<style nonce="${nonce}">${LOOP_PANEL_CSS}</style>`,
      bodyHtml: `<div id="app"></div>`,
    });
  }

  private refresh(): void {
    this.ready = false;
    this.pendingState = undefined;
    this.renderShell();
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.ready = true;
        this.push(this.pendingState ?? this.getState(this.selection));
        this.pendingState = undefined;
        break;
      case "selectPrompt":
        this.selection = { promptId: msg.promptId, followLatest: false };
        this.push(this.getState(this.selection));
        break;
      case "open_external":
        if (isSafeHttpUrl(msg.url)) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case "command":
        if (msg.id === "refresh") {
          this.refresh();
        } else if (msg.id === "followLatest") {
          this.selection = { followLatest: true };
          this.push(this.getState(this.selection));
        } else if (COMMAND_MAP[msg.id]) {
          await vscode.commands.executeCommand(COMMAND_MAP[msg.id]);
        }
        break;
      case "log":
        console[msg.level === "error" ? "error" : "log"](`[loopPanel] ${msg.msg}`);
        break;
    }
  }

  private push(state: LoopPanelState): void {
    if (!this.ready) {
      this.pendingState = state;
      return;
    }
    void this.panel.webview.postMessage({ type: "state", state });
  }

  /** Open (or reveal) the panel and push fresh state. */
  static show(extensionUri: vscode.Uri, getState: (sel: LoopSelection) => LoopPanelState): void {
    const p = LoopPanel.current;
    if (p) {
      // Push before revealing: pushFresh clears `dirty`, so the reveal's
      // view-state change doesn't push the same state twice.
      p.pushFresh();
      p.panel.reveal(vscode.ViewColumn.Active, false);
      return;
    }
    LoopPanel.current = new LoopPanel(extensionUri, getState);
  }

  /** Live refresh of an open panel; no-op when closed. */
  static refresh(): void {
    LoopPanel.current?.requestRefresh();
  }

  /** The displayed session changed: go back to following its newest prompt. */
  static followLatest(): void {
    const p = LoopPanel.current;
    if (p) {
      p.selection = { followLatest: true };
      p.requestRefresh();
    }
  }

  /** Reload the webview if it is the active editor; returns whether it acted. */
  static refreshActive(): boolean {
    const p = LoopPanel.current;
    if (p && p.panel.active) {
      p.refresh();
      return true;
    }
    return false;
  }
}
