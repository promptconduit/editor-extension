# Session Graph

A live, "breathing" tree of one AI coding session: the session root → each
prompt→Stop turn (with per-turn cost and aggregated tool chips) → subagents
nested as child nodes, with `⑂` badges for nodes that ran in a different git
worktree. Running nodes pulse; turns end completed / failed / interrupted. It
grows in place from the tail of `~/.promptconduit/events.jsonl`.

## Architecture

```
events.jsonl ──tail──▶ parseEnvelopeV2 ──▶ SessionTreeStore.ingest(env)
                                                   │
                                       .snapshot(selectedKey) ──▶ GraphPanelState
                                                                       │
                              mountSessionGraph(el).update(state) ─────┘
                                     │
                     render() ─▶ innerHTML ─▶ drawConnectors() (SVG elbow wires)
```

- **`sessionTree.ts`** — `SessionTreeStore`: wraps the shared `PromptGroupStore`
  (turn grouping, tool aggregation, subagent start/stop pairing) plus per-session
  metadata, and derives the serializable `GraphPanelState`. All node-state rules
  (running/completed/failed/interrupted, worktree badges, session live/idle/ended)
  live here.
- **`protocol.ts`** — `GraphPanelState`, the portable data contract.
- **`styles.ts`** — `GRAPH_PANEL_CSS`, the panel stylesheet.
- **`../../webview/graphPanel/render.ts`** — pure `GraphPanelState → HTML string`.
- **`../../webview/graphPanel/connectors.ts`** — draws elbow wires from DOM rects.
- **`../../webview/graphPanel/mount.ts`** — `mountSessionGraph()`: framework-free
  DOM mount (render + connectors + interaction wiring). The reusable core.
- **`panel.ts`** — the VS Code host (webview + `RawEventTail`). Editor-only.

## Portability — using it in a generic website

Everything above **except `panel.ts`** (and the editor adapter
`webview/graphPanel/main.ts`) is **free of any vscode / node / filesystem
import**. The whole rendering + state stack runs in a plain browser. A website
only needs to (1) build a `GraphPanelState` from its own data source and (2)
call `graph.update(state)`:

```ts
import { mountSessionGraph } from ".../webview/graphPanel/mount";
import { GRAPH_PANEL_CSS } from ".../src/graphPanel/styles";
// import { SessionTreeStore } from ".../src/graphPanel/sessionTree"; // if you
// have raw envelopes; otherwise emit GraphPanelState however you like.

document.head.insertAdjacentHTML("beforeend", `<style>${GRAPH_PANEL_CSS}</style>`);
const graph = mountSessionGraph(document.getElementById("app")!);
graph.onPickSession = (key) => { /* refetch, then graph.update(...) */ };

// on each poll / WebSocket push:
graph.update(myGraphPanelState);
```

Two adapters over the same core exist today:

- **Editor:** `webview/graphPanel/main.ts` bridges VS Code `postMessage` to
  `mountSessionGraph`.
- **Plain website:** `webview/graphPanel/standalone.ts` builds state from sample
  envelopes and replays them on a timer. Run `npm run demo:web` to produce
  `dev/preview-out/graph-standalone.html` — a single self-contained file (JS
  inlined, no external requests, no vscode) that renders the graph in any
  browser. This is the reference for a real platform-web integration.

### Theming

`styles.ts` colors are `var(--vscode-*, <literal-fallback>)`. Inside the editor
they inherit the active theme; on a plain page the fallbacks apply. A host site
can define those variables (or fork the palette) to reskin without touching the
markup.
