// Session Graph webview stylesheet. Injected by the host inside a nonce'd
// <style> tag (the CSP allows no inline style attributes).
//
// Graphviz-style boxes joined by SVG elbow wires; the tree "breathes" through a
// CSS pulse on running nodes. Every color derives from --vscode-* variables
// WITH literal fallbacks, so the same stylesheet renders correctly outside the
// editor too (browser preview today; the platform web app later — the state
// contract and this CSS are the portable pieces).

export const GRAPH_PANEL_CSS = `
:root {
  --ink: var(--vscode-editor-foreground, #ccc);
  --paper: var(--vscode-editor-background, #1e1e1e);
  --muted: var(--vscode-descriptionForeground, #8b8b8b);
  --hairline: color-mix(in srgb, var(--vscode-panel-border, #333) 70%, transparent);
  --accent: var(--vscode-textLink-foreground, #4daafc);
  --good: var(--vscode-charts-green, #89d185);
  --bad: var(--vscode-charts-red, #f14c4c);
  --warn: var(--vscode-charts-yellow, #cca700);
  --agent: var(--vscode-charts-purple, #a78bfa);
  --box: var(--vscode-textCodeBlock-background, #262626);
  --wire: color-mix(in srgb, var(--vscode-panel-border, #444) 90%, transparent);
}
* { box-sizing: border-box; }
body {
  font-family: var(--vscode-font-family, -apple-system, "Segoe UI", sans-serif);
  color: var(--ink);
  background: var(--paper);
  margin: 0;
  padding: 0 1.5rem 4rem;
  line-height: 1.5;
}
code, .mono { font-family: var(--vscode-editor-font-family, Menlo, Consolas, monospace); font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }
.small { font-size: 0.85em; }

/* ---- toolbar (mirrors the stream panel) ---- */
.toolbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.55rem 0;
  background: color-mix(in srgb, var(--paper) 88%, transparent);
  backdrop-filter: blur(6px);
  border-bottom: 1px solid var(--hairline);
}
.toolbar-spacer { flex: 1; }
.toolbar label { font-size: 0.78rem; color: var(--muted); }
select.picker {
  font: inherit; font-size: 0.82rem;
  color: var(--ink);
  background: var(--vscode-dropdown-background, #3c3c3c);
  border: 1px solid var(--hairline);
  border-radius: 3px; padding: 0.15rem 0.4rem;
  max-width: 24rem;
}
button.tb {
  font: inherit; font-size: 0.78rem;
  color: var(--vscode-button-secondaryForeground, var(--ink));
  background: var(--vscode-button-secondaryBackground, transparent);
  border: 1px solid var(--hairline);
  border-radius: 3px; padding: 0.15rem 0.6rem; cursor: pointer;
}
button.tb:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }

/* ---- header ---- */
h1 { font-size: 1.05rem; margin: 1rem 0 0.15rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.header-meta { display: flex; gap: 0.9rem; flex-wrap: wrap; font-size: 0.82rem; color: var(--muted); margin-bottom: 0.4rem; }

/* Live dot: the session-level heartbeat. */
.dot { display: inline-block; width: 0.55rem; height: 0.55rem; border-radius: 50%; background: var(--muted); }
.dot.live { background: var(--good); animation: breathe 1.6s ease-in-out infinite; }
.live-label { font-size: 0.72rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
.live-label.on { color: var(--good); }

.pill { display: inline-block; font-size: 0.72rem; padding: 0.05rem 0.45rem; border-radius: 0.6rem;
        background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); }
.pill.worktree { background: color-mix(in srgb, var(--accent) 25%, transparent); color: var(--accent); border: 1px solid var(--accent); }

/* ---- two-column layout: graph left, resizable detail right ---- */
.layout { display: flex; align-items: flex-start; }
.graph-col { flex: 1; min-width: 0; padding-right: 0.4rem; }
.detail-col {
  width: 24rem; flex: 0 0 24rem;
  position: sticky; top: 3rem;
  max-height: calc(100vh - 4rem); overflow-y: auto;
  padding: 0.2rem 0 1rem 1.2rem;
  font-size: 0.85rem;
}
/* Drag handle between the columns; a hairline that thickens on hover/drag. */
.divider {
  flex: 0 0 auto; align-self: stretch;
  width: 9px; margin: 0 -1px; cursor: col-resize;
  position: relative; z-index: 6;
  background: transparent;
}
.divider::before {
  content: ""; position: absolute; top: 0; bottom: 0; left: 4px; width: 1px;
  background: var(--hairline);
}
.divider:hover::before, body.pc-graph-resizing .divider::before { width: 2px; background: var(--accent); }
body.pc-graph-resizing { cursor: col-resize; user-select: none; }
@media (max-width: 62rem) {
  .layout { flex-direction: column; }
  .divider { display: none; }
  .detail-col { width: 100% !important; flex: 0 0 auto !important; position: static; max-height: none;
                border-top: 1px solid var(--hairline); padding: 1rem 0 0; }
}

/* ---- detail panel ---- */
.detail-hint { color: var(--muted); font-style: italic; padding-top: 0.6rem; }
.detail-title {
  font-weight: 600; font-size: 0.95rem; margin: 0.2rem 0 0.6rem;
  word-break: break-word; line-height: 1.35;
}
.dsec { margin: 0 0 0.9rem; }
.dsec > h3 {
  font-size: 0.7rem; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--muted); margin: 0 0 0.35rem; padding-bottom: 0.2rem;
  border-bottom: 1px solid var(--hairline);
}
.kv { display: flex; justify-content: space-between; gap: 0.8rem; padding: 0.12rem 0; align-items: baseline; }
.kv.col { flex-direction: column; align-items: stretch; gap: 0.25rem; }
.kv .k { color: var(--muted); white-space: nowrap; }
.kv .v { text-align: right; word-break: break-word; }
.kv .k.bad, .bad { color: var(--bad); }

.prompt-box {
  background: var(--box); border: 1px solid var(--hairline); border-radius: 4px;
  padding: 0.5rem 0.6rem; max-height: 12rem; overflow-y: auto;
  white-space: pre-wrap; word-break: break-word; line-height: 1.45;
  font-family: var(--vscode-editor-font-family, Menlo, monospace); font-size: 0.8rem;
}

/* token table: label · count · usd, cache rows tinted as "memory" */
.tok-table { display: flex; flex-direction: column; gap: 0.1rem; }
.tok-row { display: grid; grid-template-columns: 1fr auto auto; gap: 0.6rem; padding: 0.1rem 0; align-items: baseline; }
.tok-row .tok-label { color: var(--muted); }
.tok-row .tok-count { text-align: right; min-width: 5rem; }
.tok-row .tok-usd { text-align: right; min-width: 4.5rem; color: var(--muted); }
.tok-row.mem .tok-label { color: var(--accent); }
.tok-row.total { border-top: 1px solid var(--hairline); margin-top: 0.15rem; padding-top: 0.25rem; font-weight: 600; }
.tok-row.total .tok-label { color: var(--ink); }

.savings {
  margin-top: 0.4rem; padding: 0.3rem 0.5rem; border-radius: 4px;
  background: color-mix(in srgb, var(--good) 15%, transparent);
  color: var(--good); font-weight: 600; text-align: center;
}

/* detail tables (tools) */
.dtable { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
.dtable th { text-align: left; color: var(--muted); font-weight: 600; font-size: 0.72rem;
             text-transform: uppercase; letter-spacing: 0.08em; padding: 0.15rem 0.3rem; }
.dtable td { padding: 0.15rem 0.3rem; border-top: 1px solid var(--hairline); vertical-align: top; }
.dtable th.num, .dtable td.num { text-align: right; white-space: nowrap; }
.tool-anno { color: var(--agent); font-size: 0.9em; }

/* ---- the tree ---- */
.tree { position: relative; margin-top: 0.9rem; }
svg.wires {
  position: absolute; inset: 0; width: 100%; height: 100%;
  pointer-events: none; overflow: visible;
}
svg.wires path { fill: none; stroke: var(--wire); stroke-width: 1.5; }
svg.wires path[data-state="running"] { stroke: var(--accent); }

.children { margin-left: 2.2rem; }

/* ---- nodes: graphviz-style boxes ---- */
.node {
  position: relative;
  background: var(--box);
  border: 1px solid var(--hairline);
  border-radius: 5px;
  padding: 0.4rem 0.7rem;
  margin: 0.55rem 0;
  max-width: 46rem;
  cursor: pointer;
}
.node:hover { border-color: color-mix(in srgb, var(--accent) 50%, var(--hairline)); }
.node.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent), 0 0 0 5px color-mix(in srgb, var(--accent) 14%, transparent);
}
.node[data-state="running"] {
  border-color: var(--accent);
}
.node[data-state="failed"] { border-color: var(--bad); }
.node[data-state="interrupted"] { border-style: dashed; border-color: var(--warn); }

/* The breathing: a soft pulse on anything currently running. */
@media (prefers-reduced-motion: no-preference) {
  .node[data-state="running"] {
    animation: breathe-box 1.6s ease-in-out infinite;
  }
  @keyframes breathe-box {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
    50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent); }
  }
  @keyframes breathe {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
}

.node-row { display: flex; align-items: baseline; gap: 0.6rem; }
.node-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.88rem; }
.node-side { display: flex; gap: 0.7rem; font-size: 0.78rem; color: var(--muted); white-space: nowrap; }
.node-side .usd { color: var(--ink); }

.node.session { border-width: 1.5px; max-width: 46rem; }
.node.session .node-label { font-weight: 600; }

.node.turn .glyph { color: var(--accent); }
.node.turn[data-state="failed"] .glyph { color: var(--bad); }
.node.turn[data-state="interrupted"] .glyph { color: var(--warn); }
.turn-tag { font-size: 0.72rem; padding: 0.02rem 0.4rem; border-radius: 0.5rem; }
.turn-tag.interrupted { color: var(--warn); border: 1px solid var(--warn); }
.turn-tag.failed { color: var(--bad); border: 1px solid var(--bad); }

/* Tool chips: aggregated per turn ("Read ×12"). */
.chips { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.35rem; }
.chip {
  font-size: 0.74rem; padding: 0.05rem 0.45rem; border-radius: 0.5rem;
  background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff);
}
.chip.failed { background: color-mix(in srgb, var(--bad) 30%, transparent); color: var(--bad); }

.node.agent { border-left: 3px solid var(--agent); max-width: 42rem; }
.node.agent .glyph { color: var(--agent); }
.node.agent[data-state="running"] { border-color: var(--accent); border-left-color: var(--agent); }

.state-dot { display: inline-block; width: 0.45rem; height: 0.45rem; border-radius: 50%; margin-right: 0.15rem; vertical-align: 0.05rem; }
.state-dot[data-state="running"] { background: var(--accent); animation: breathe 1.6s ease-in-out infinite; }
.state-dot[data-state="completed"] { background: var(--good); }
.state-dot[data-state="failed"] { background: var(--bad); }
.state-dot[data-state="interrupted"] { background: var(--warn); }

/* "N earlier turns" stub. */
.stub { font-size: 0.78rem; color: var(--muted); margin: 0.55rem 0; padding-left: 0.2rem; }

/* ---- empty state / footer ---- */
.empty { margin-top: 1.2rem; }
footer { margin-top: 1.4rem; font-size: 0.8rem; color: var(--muted); }
`;
