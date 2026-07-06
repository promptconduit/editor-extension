// Stream webview stylesheet. Injected by the host inside a nonce'd <style>
// tag (the CSP allows no inline style attributes).
//
// Sibling of the Cost Breakdown ledger (src/costPanel/styles.ts): the same
// hairline rules, toolbar, copy buttons, and raw-JSON "tape" — but the body is
// a live event table where every row expands into the event's raw envelope
// JSON. Every color derives from --vscode-* variables so light/dark/high-
// contrast themes come for free.

export const STREAM_PANEL_CSS = `
:root {
  --hairline: color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
  --ink: var(--vscode-editor-foreground);
  --paper: var(--vscode-editor-background);
  --accent: var(--vscode-textLink-foreground);
  --good: var(--vscode-charts-green);
  --bad: var(--vscode-charts-red);
}
* { box-sizing: border-box; }
body {
  font-family: var(--vscode-font-family);
  color: var(--ink);
  background: var(--paper);
  margin: 0;
  padding: 0 1.5rem 4rem;
  max-width: 70rem;
  line-height: 1.55;
}
code, .skey, .time, .tape {
  font-family: var(--vscode-editor-font-family, monospace);
  font-variant-numeric: tabular-nums;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
h1 { font-size: 1.05rem; margin: 1rem 0 0.15rem; }
.muted { color: var(--vscode-descriptionForeground); }
.small { font-size: 0.85em; }
code { background: var(--vscode-textCodeBlock-background); padding: 0.1rem 0.35rem; border-radius: 0.35rem; }

/* ---- toolbar (mirrors the cost panel) ---- */
.toolbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; gap: 0.4rem;
  padding: 0.55rem 0;
  background: color-mix(in srgb, var(--paper) 88%, transparent);
  backdrop-filter: blur(6px);
  border-bottom: 1px solid var(--hairline);
}
.toolbar-spacer { flex: 1; }
.focus-note { font-size: 0.8rem; font-style: italic; }
button.tb {
  font: inherit; font-size: 0.78rem;
  color: var(--vscode-button-secondaryForeground, var(--ink));
  background: var(--vscode-button-secondaryBackground, transparent);
  border: 1px solid var(--hairline);
  border-radius: 3px; padding: 0.15rem 0.6rem; cursor: pointer;
}
button.tb:hover { background: var(--vscode-toolbar-hoverBackground); }

/* ---- header / session identity ---- */
.pill { display: inline-block; font-size: 0.72rem; padding: 0.05rem 0.45rem; border-radius: 0.6rem;
        background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-left: 0.35rem; }
.skey-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin: 0.25rem 0 0.1rem; }
.skey-label {
  font-size: 0.72rem; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--vscode-descriptionForeground);
}
.skey {
  font-size: 0.82rem; padding: 0.1rem 0.45rem; border-radius: 0.35rem;
  background: var(--vscode-textCodeBlock-background);
  word-break: break-all;
}

/* ---- event table (grid rows so each row can expand) ---- */
.evt-table { margin-top: 0.6rem; border-top: 1px solid var(--hairline); }
.evt-cols {
  display: grid;
  grid-template-columns: 6.5rem 7.5rem minmax(11rem, 1fr) 8.5rem minmax(8rem, 16rem);
  gap: 0 0.6rem; align-items: baseline;
  padding: 0.25rem 0.5rem;
}
.evt-head {
  position: sticky; top: 2.35rem; z-index: 5;
  background: var(--paper);
  border-bottom: 1px solid var(--hairline);
  font-size: 0.72rem; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--vscode-descriptionForeground);
}
details.evt { border-bottom: 1px solid var(--hairline); }
details.evt > summary { cursor: pointer; list-style: none; }
details.evt > summary::-webkit-details-marker { display: none; }
details.evt > summary:hover { background: var(--vscode-list-hoverBackground, transparent); }
details.evt[open] > summary { background: var(--vscode-list-hoverBackground, transparent); }
.time { white-space: nowrap; font-size: 0.82rem; }
.tool, .hook { display: inline-block; font-size: 0.78rem; padding: 0.1rem 0.5rem; border-radius: 0.5rem;
               background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.subagent-badge { display: inline-block; font-size: 0.72rem; padding: 0.05rem 0.4rem; border-radius: 0.5rem;
                  margin-left: 0.25rem; background: var(--vscode-charts-purple, #a78bfa); color: #fff; }
.cell-tools, .cell-repo { font-size: 0.82rem; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.evt-body { padding: 0.4rem 0.5rem 0.7rem 1rem; }

/* ---- raw JSON tape (same look as the cost panel's) ---- */
.tape {
  margin: 0.4rem 0 0.2rem; padding: 0.6rem 0.8rem; overflow-x: auto;
  font-size: 0.8rem; line-height: 1.45;
  background: var(--vscode-textCodeBlock-background);
  border: 1px solid var(--hairline); border-radius: 3px;
  max-height: 24rem; overflow-y: auto;
}
.j-key { color: var(--vscode-charts-blue); }
.j-str { color: var(--vscode-charts-green); }
.j-num { color: var(--vscode-charts-orange); }
.j-kw { color: var(--vscode-charts-purple); }
button.copy {
  font: inherit; font-size: 0.75rem; cursor: pointer;
  color: var(--accent); background: transparent;
  border: 1px solid var(--hairline); border-radius: 3px; padding: 0.1rem 0.5rem;
}
button.copy:hover { background: var(--vscode-toolbar-hoverBackground); }
button.copy.done { color: var(--good); border-color: var(--good); }

/* ---- empty state / footer ---- */
.empty { margin-top: 1rem; }
footer { margin-top: 1rem; font-size: 0.8rem; }
`;
