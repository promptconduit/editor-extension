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
