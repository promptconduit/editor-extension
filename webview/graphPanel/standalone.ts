// Standalone "generic website" demo of the Session Graph — proof that the
// portable core (sessionTree + render + connectors + styles + mount) runs with
// ZERO editor context: no vscode, no acquireVsCodeApi, no postMessage. Bundled
// by dev/build-standalone.mjs into a single self-contained HTML file.
//
// A real website would swap the fixture replay below for its own data source
// (poll an API, subscribe to a WebSocket) and call graph.update(state) each
// tick — everything else here is exactly what that site would write.

import { parseEnvelopeV2 } from "../../src/envelope";
import { SessionTreeStore } from "../../src/graphPanel/sessionTree";
import { GRAPH_PANEL_CSS } from "../../src/graphPanel/styles";
import type { GraphPanelState } from "../../src/graphPanel/protocol";
import { mountSessionGraph } from "./mount";
import { sampleGraphLines, GRAPH_FIXTURE_NOW } from "../../dev/fixtures";

// Inject the panel stylesheet once (a site would ship this in its own CSS).
const style = document.createElement("style");
style.textContent = GRAPH_PANEL_CSS;
document.head.appendChild(style);

const app = document.createElement("div");
document.body.appendChild(app);

const store = new SessionTreeStore();
const graph = mountSessionGraph(app);
let selected: string | undefined;
graph.onPickSession = (key) => {
  selected = key;
  render();
};

function render(): void {
  const state: GraphPanelState = {
    revision: Date.now(),
    logDisabled: false,
    ...store.snapshot(selected, GRAPH_FIXTURE_NOW),
  };
  graph.update(state);
}

// Replay the fixture one event at a time so the tree visibly grows and the
// running nodes breathe — the same thing the live tail does in the editor.
let i = 0;
render();
const timer = setInterval(() => {
  const line = sampleGraphLines[i++];
  const env = line && parseEnvelopeV2(line);
  if (env) store.ingest(env);
  render();
  if (i >= sampleGraphLines.length) clearInterval(timer);
}, 500);
