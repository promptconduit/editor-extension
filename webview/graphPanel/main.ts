// Session Graph webview client — the VS Code adapter over the portable
// mountSessionGraph() core. All rendering, connector-drawing, and interaction
// wiring lives in mount.ts (zero vscode); this file only bridges the editor's
// postMessage transport to it, so a plain website reuses the exact same core.

import type { GraphPanelState, HostMessage, WebviewMessage } from "../../src/graphPanel/protocol";
import { mountSessionGraph } from "./mount";

declare function acquireVsCodeApi(): { postMessage(msg: WebviewMessage): void };

const vscode = acquireVsCodeApi();
const app = document.getElementById("app") ?? document.body;

const graph = mountSessionGraph(app);
graph.onPickSession = (key) => vscode.postMessage({ type: "pickSession", key });
graph.onRefresh = () => vscode.postMessage({ type: "command", id: "refresh" });

window.addEventListener("message", (e: MessageEvent<HostMessage>) => {
  if (e.data?.type === "state") {
    graph.update(e.data.state);
  }
});

vscode.postMessage({ type: "ready" });
