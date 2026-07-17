// Live Session Graph panel: the "breathing" tree view of one AI coding session
// (session → turns → tools + subagents, worktree badges), growing in place as
// events land in ~/.promptconduit/events.jsonl.
//
// Same architecture as the Stream panel: a pure store (sessionTree.ts) fed by a
// tail, a host-agnostic controller with a throttled state push, and a scripted
// webview host (strict CSP + nonce, esbuild bundle, ready/lastState handshake).
// The tail is RawEventTail — bounded history on open (so a session already
// mid-flight renders fully and the picker sees recent sessions), then live.

import * as vscode from "vscode";
import { parseEnvelopeV2 } from "../envelope";
import { RawEventTail, logDisabled } from "../tail";
import { bustCache, makeNonce, webviewCsp, webviewShellHtml } from "../webviewHost";
import { SessionTreeStore } from "./sessionTree";
import { GRAPH_PANEL_CSS } from "./styles";
import type { GraphPanelState, WebviewMessage } from "./protocol";

// Coalesce bursty appends into one render (matches streamFeed/statusBar).
const RENDER_THROTTLE_MS = 250;
// A live session's "N s ago" header and live/idle flips should tick even when
// no events arrive; a slow heartbeat re-snapshot covers that.
const HEARTBEAT_MS = 15_000;

/**
 * GraphController wires the pure SessionTreeStore to the live tail of
 * events.jsonl and a throttled state push. Host-agnostic: it pushes
 * GraphPanelState to a sink callback (the panel posts it to the webview; the
 * preview writes it into a shim page).
 */
export class GraphController {
  private readonly tail: RawEventTail;
  private readonly store = new SessionTreeStore();
  // The user's explicit pick, latched; undefined → follow the store's default
  // (most recently active live session).
  private selectedKey: string | undefined;
  private disposed = false;
  private pending = false;
  private throttle: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private revision = 0;

  constructor(private readonly push: (state: GraphPanelState) => void) {
    this.tail = new RawEventTail({
      onLines: (lines) => this.ingest(lines),
    });
  }

  start(): void {
    this.render(); // push the empty / disabled state immediately
    if (!logDisabled()) {
      this.tail.start();
      this.heartbeat = setInterval(() => this.render(), HEARTBEAT_MS);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.tail.dispose();
    if (this.throttle) {
      clearTimeout(this.throttle);
      this.throttle = undefined;
    }
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  /** Latch an explicit session pick (from the webview's picker). */
  pickSession(key: string): void {
    this.selectedKey = key;
    this.render();
  }

  private ingest(lines: string[]): void {
    for (const line of lines) {
      const env = parseEnvelopeV2(line);
      if (env) this.store.ingest(env);
    }
    this.scheduleRender();
  }

  // Render now, then coalesce a single trailing render if more events arrive
  // inside the throttle window.
  private scheduleRender(): void {
    if (this.throttle) {
      this.pending = true;
      return;
    }
    this.render();
    this.throttle = setTimeout(() => {
      this.throttle = undefined;
      if (this.pending) {
        this.pending = false;
        this.render();
      }
    }, RENDER_THROTTLE_MS);
  }

  private render(): void {
    if (this.disposed) {
      return;
    }
    this.revision += 1;
    const snap = this.store.snapshot(this.selectedKey);
    this.push({
      revision: this.revision,
      logDisabled: logDisabled(),
      ...snap,
    });
  }
}

/**
 * GraphPanel hosts the live session graph as a scripted editor-tab webview
 * (same host pattern as Stream/Cost Breakdown: strict CSP + nonce, esbuild
 * bundle from media/, ready/pendingState handshake). A single reused panel;
 * show() reveals it.
 */
export class GraphPanel {
  private static current: GraphPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly controller: GraphController;
  private disposed = false;
  private ready = false;
  // Bumped on every shell (re)render so a refresh cache-busts the bundle URI.
  private htmlRev = 0;
  private lastState: GraphPanelState | undefined;

  static show(extensionUri: vscode.Uri): void {
    if (GraphPanel.current && !GraphPanel.current.disposed) {
      GraphPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    GraphPanel.current = new GraphPanel(extensionUri);
  }

  private constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
    this.panel = vscode.window.createWebviewPanel(
      "promptconduitGraph",
      "PromptConduit Session Graph",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );

    this.renderShell();

    this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      this.onMessage(msg);
    });
    this.controller = new GraphController((state) => this.push(state));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.controller.dispose();
      if (GraphPanel.current === this) {
        GraphPanel.current = undefined;
      }
    });
    this.controller.start();
  }

  // (Re)build the webview document with a fresh nonce and cache-busted bundle
  // URI, so calling it again reloads the webview in place and picks up a rebuilt
  // media/graphPanel.js — no window reload.
  private renderShell(): void {
    this.htmlRev += 1;
    const nonce = makeNonce();
    const scriptUri = bustCache(
      this.panel.webview
        .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "graphPanel.js"))
        .toString(),
      this.htmlRev,
    );
    this.panel.webview.html = webviewShellHtml({
      csp: webviewCsp(this.panel.webview, nonce),
      nonce,
      scriptUri,
      title: "PromptConduit Session Graph",
      headHtml: `<style nonce="${nonce}">${GRAPH_PANEL_CSS}</style>`,
      bodyHtml: `<div id="app"></div>`,
    });
  }

  // Reload the webview in place; live events keep flowing through the controller
  // and lastState is re-pushed on the next "ready".
  private refresh(): void {
    this.ready = false;
    this.renderShell();
  }

  /**
   * Reload the panel's webview if it is the active editor. Returns whether it
   * acted, so the Refresh Panel command can fall through to another panel.
   */
  static refreshActive(): boolean {
    const p = GraphPanel.current;
    if (p && !p.disposed && p.panel.active) {
      p.refresh();
      return true;
    }
    return false;
  }

  private push(state: GraphPanelState): void {
    this.lastState = state;
    if (!this.ready) {
      return; // delivered on "ready"
    }
    void this.panel.webview.postMessage({ type: "state", state });
  }

  private onMessage(msg: WebviewMessage): void {
    switch (msg.type) {
      case "ready":
        this.ready = true;
        if (this.lastState) {
          void this.panel.webview.postMessage({ type: "state", state: this.lastState });
        }
        break;
      case "pickSession":
        this.controller.pickSession(msg.key);
        break;
      case "command":
        if (msg.id === "refresh") {
          this.refresh();
        }
        break;
    }
  }
}
