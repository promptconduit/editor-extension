// Browser client for the CLI's `promptconduit graph` viewer — the SECOND
// adapter over the portable graph core (the first is the VS Code webview
// main.ts). It runs the identical sessionTree + render + mount stack; the only
// difference is the transport: instead of vscode postMessage, it polls the Go
// server's /api/events endpoint for raw envelope lines and builds the graph
// state entirely in the browser. This is what keeps the graph logic ONE
// implementation, shared by the editor and the CLI — coupled to neither.
//
// Bundled into a single self-contained graph.html by dev/build-cli-bundle.mjs,
// which the CLI embeds via go:embed.

import { parseEnvelopeV2 } from "../../src/envelope";
import { SessionTreeStore } from "../../src/graphPanel/sessionTree";
import { GRAPH_PANEL_CSS } from "../../src/graphPanel/styles";
import type { GraphPanelState } from "../../src/graphPanel/protocol";
import { mountSessionGraph } from "./mount";

interface EventsResponse {
  lines: string[];
  cursor: number;
  more: boolean;
}

const POLL_MS = 1000;
const BATCH_LIMIT = 5000;

const style = document.createElement("style");
style.textContent = GRAPH_PANEL_CSS;
document.head.appendChild(style);

const app = document.createElement("div");
document.body.appendChild(app);

const store = new SessionTreeStore();
const graph = mountSessionGraph(app);
let selected: string | undefined;
graph.onPickSession = (key) => {
  selected = key; // selection is client-side only — no server round-trip
  render();
};
graph.onRefresh = () => void pull();

let cursor = 0;
let pulling = false;

function render(): void {
  const state: GraphPanelState = {
    revision: Date.now(),
    logDisabled: false,
    ...store.snapshot(selected),
  };
  graph.update(state);
}

// Drain everything newer than `cursor`, ingesting each raw line into the store;
// renders after each batch so a large backfill paints progressively. Guarded so
// overlapping timer ticks can't double-fetch.
async function pull(): Promise<void> {
  if (pulling) return;
  pulling = true;
  try {
    for (;;) {
      const res = await fetch(`/api/events?after=${cursor}&limit=${BATCH_LIMIT}`);
      if (!res.ok) break;
      const body = (await res.json()) as EventsResponse;
      for (const line of body.lines) {
        const env = parseEnvelopeV2(line);
        if (env) store.ingest(env);
      }
      cursor = body.cursor;
      render();
      if (!body.more) break;
    }
  } catch {
    // Server gone or transient error — keep the last view, retry next tick.
  } finally {
    pulling = false;
  }
}

render(); // paint the empty state immediately
void pull();
setInterval(() => void pull(), POLL_MS);
