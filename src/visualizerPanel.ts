import * as vscode from "vscode";
import { readHistory } from "./visualizer/eventLog";
import { latestSession } from "./visualizer/sessions";
import { buildScene } from "./visualizer/graph";
import { demoScene } from "./visualizer/demo";
import { GitHubEnricher, EnrichmentMode, resolveGitHubToken } from "./visualizer/github";
import type { Scene } from "./visualizer/types";
import type { HostMessage, WebviewMessage } from "./visualizer/protocol";
import { SCENE_CSS, SCENE_BODY } from "./visualizer/chrome";

/**
 * VisualizerPanel hosts the 3D Orchestration Theater in a full editor tab. Unlike
 * the cost/telemetry webviews (enableScripts:false), this one runs scripts, so it
 * sets a strict CSP with a per-load nonce, restricts localResourceRoots to media/,
 * and loads the esbuild bundle via asWebviewUri. Singleton — reveal an existing
 * tab rather than stacking duplicates.
 */
export class VisualizerPanel {
  public static readonly viewType = "promptconduitVisualizer";
  private static current: VisualizerPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active;
    if (VisualizerPanel.current) {
      VisualizerPanel.current.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VisualizerPanel.viewType,
      "AI Orchestration Theater",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );
    VisualizerPanel.current = new VisualizerPanel(panel, extensionUri);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
  ) {
    this.panel.webview.html = this.getHtml(this.panel.webview, extensionUri);

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.onMessage(msg),
      undefined,
      this.disposables,
    );

    // Pause the render loop when the tab is hidden (context is retained, so the
    // GL state survives — we just stop drawing to spare the GPU/battery).
    this.panel.onDidChangeViewState(
      () => this.post({ type: "visibility", visible: this.panel.visible }),
      undefined,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  private onMessage(msg: WebviewMessage): void {
    switch (msg.type) {
      case "ready":
        void this.loadScene();
        break;
      case "open_external":
        if (isSafeHttpUrl(msg.url)) {
          void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        break;
      case "log":
        console[msg.level === "error" ? "error" : "log"](`[promptconduit:viz] ${msg.msg}`);
        break;
      case "scene_ready":
        break;
    }
  }

  // Read the latest session from the local log, build the scene, enrich GitHub
  // refs per the user's setting, and hand it to the webview. Falls back to a
  // baked demo when there is no local activity yet.
  private async loadScene(): Promise<void> {
    const session = latestSession(readHistory());
    const isDemo = session.length === 0;
    const scene: Scene = isDemo ? demoScene() : buildScene(session);

    if (!isDemo) {
      await this.enrich(scene);
    }

    this.post({
      type: "load",
      scene,
      mode: "playback",
      reducedMotion: reduceMotionEnabled(),
      isDemo,
    });
  }

  private async enrich(scene: Scene): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("promptconduit.visualizer");
    const mode = (cfg.get<string>("githubEnrichment", "fetch") as EnrichmentMode) || "fetch";
    if (mode === "off") {
      for (const node of scene.graph.nodes) node.github = undefined;
      return;
    }
    if (mode === "inferOnly") return; // keep inferred numbers/urls, no network
    const token = resolveGitHubToken(cfg.get<string>("githubToken", ""));
    const enricher = new GitHubEnricher("fetch", token);
    for (const node of scene.graph.nodes) {
      if (node.github) node.github = await enricher.enrich(node.github);
    }
  }

  private post(msg: HostMessage): void {
    void this.panel.webview.postMessage(msg);
  }

  private getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "visualizer.js"));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `connect-src 'none'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style nonce="${nonce}">${SCENE_CSS}</style>
</head>
<body>
${SCENE_BODY}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    if (VisualizerPanel.current === this) VisualizerPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

function reduceMotionEnabled(): boolean {
  return vscode.workspace.getConfiguration("workbench").get<string>("reduceMotion") === "on";
}

function makeNonce(): string {
  const bytes = require("crypto").randomBytes(16) as Buffer;
  return bytes.toString("hex");
}

function isSafeHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
