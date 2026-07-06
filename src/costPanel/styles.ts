// Cost Breakdown webview stylesheet. Injected by the host inside a nonce'd
// <style> tag (the CSP allows no inline style attributes — geometry is applied
// via CSSOM in the client).
//
// Aesthetic: a precision cost ledger. Every color derives from --vscode-*
// variables so light/dark/high-contrast themes come for free; the character
// is typographic — tabular mono numerals, small-caps letter-spaced labels,
// hairline rules, ink-bar fills, and a spine down the prompt timeline.

export const COST_PANEL_CSS = `
:root {
  --hairline: color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);
  --ink: var(--vscode-editor-foreground);
  --paper: var(--vscode-editor-background);
  --accent: var(--vscode-textLink-foreground);
  --good: var(--vscode-charts-green);
  --warn: var(--vscode-charts-yellow);
  --bad: var(--vscode-charts-red);
  --bar: var(--vscode-charts-blue);
}
* { box-sizing: border-box; }
body {
  font-family: var(--vscode-font-family);
  color: var(--ink);
  background: var(--paper);
  margin: 0;
  padding: 0 1.5rem 4rem;
  max-width: 60rem;
  line-height: 1.55;
}
code, .sid, .hero-cost, .entry-cost, .req-cost, .cmp-alt, .models .n, .tape {
  font-family: var(--vscode-editor-font-family, monospace);
  font-variant-numeric: tabular-nums;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
h2, .label, .kicker, .metric-label {
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--vscode-descriptionForeground);
}
h2 { border-bottom: 1px solid var(--hairline); padding-bottom: 0.35rem; margin: 2.2rem 0 0.8rem; }
section { margin-top: 1.6rem; }
.muted { color: var(--vscode-descriptionForeground); }
.small { font-size: 0.85em; }
.dot { margin: 0 0.45em; color: var(--vscode-descriptionForeground); }

/* ---- toolbar ---- */
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

/* ---- hero ---- */
.hero { margin-top: 1.6rem; }
.kicker { margin: 0 0 0.1rem; }
.hero-cost {
  font-size: 3.4rem; font-weight: 700; line-height: 1.1; margin: 0 0 0.5rem;
  letter-spacing: -0.02em;
}
.hero-meta { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.vcs-line { margin-top: 0.5rem; font-size: 0.85rem; display: flex; align-items: center; flex-wrap: wrap; }

/* ---- chips & badges ---- */
.chip {
  display: inline-block; font-size: 0.72rem; line-height: 1.5;
  padding: 0 0.5em; border-radius: 999px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  white-space: nowrap;
}
.chip-live { background: color-mix(in srgb, var(--good) 25%, var(--paper)); color: var(--ink); }
.chip-int { background: color-mix(in srgb, var(--warn) 30%, var(--paper)); color: var(--ink); }
.chip-wt { border: 1px dashed var(--hairline); background: transparent; color: var(--vscode-descriptionForeground); }
.chip-mode { background: color-mix(in srgb, var(--accent) 18%, var(--paper)); color: var(--ink); }
.chip-plan { background: color-mix(in srgb, var(--vscode-charts-purple) 25%, var(--paper)); }
.chip-bypassPermissions { background: color-mix(in srgb, var(--bad) 22%, var(--paper)); }
.sid { font-size: 0.78rem; opacity: 0.75; }

/* ---- drivers ---- */
.drivers { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 1px; background: var(--hairline); border: 1px solid var(--hairline); }
.metric { background: var(--paper); padding: 0.7rem 0.9rem; }
.metric-val { display: block; font-size: 1.35rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.metric.good .metric-val { color: var(--good); }
.metric.warn .metric-val { color: var(--warn); }

/* ---- ledger entries (prompts) ---- */
.ledger-items { position: relative; }
.ledger-items::before {
  content: ""; position: absolute; left: 0.35rem; top: 0.8rem; bottom: 0.8rem;
  width: 1px; background: var(--hairline);
}
details.entry {
  position: relative; margin: 0; padding: 0.55rem 0 0.55rem 1.4rem;
  border-bottom: 1px solid var(--hairline);
}
details.entry::before {
  content: ""; position: absolute; left: 0.2rem; top: 1.15rem;
  width: 0.33rem; height: 0.33rem; border-radius: 50%;
  background: var(--vscode-descriptionForeground);
}
details.entry[open]::before { background: var(--accent); }
details.entry > summary { cursor: pointer; list-style: none; }
details.entry > summary::-webkit-details-marker { display: none; }
.entry-head { display: flex; align-items: baseline; gap: 0.6rem; flex-wrap: wrap; }
.entry-cost { font-weight: 700; min-width: 4.5rem; }
.entry-excerpt { flex: 1 1 16rem; overflow: hidden; text-overflow: ellipsis; }
.entry-meta { font-size: 0.78rem; margin-top: 0.1rem; }
.bar { height: 3px; background: color-mix(in srgb, var(--bar) 15%, transparent); margin-top: 0.4rem; border-radius: 2px; }
.bar-fill { height: 100%; background: var(--bar); border-radius: 2px; width: 0; transition: width 0.4s ease; }
.entry-body { padding: 0.6rem 0 0.4rem; }
.prompt-full {
  margin: 0.3rem 0; padding: 0.5rem 0.8rem; white-space: pre-wrap;
  border-left: 2px solid var(--hairline);
  background: var(--vscode-textBlockQuote-background);
}

/* ---- requests ---- */
.req-row { display: flex; gap: 0.7rem; flex-wrap: wrap; font-size: 0.85rem; padding: 0.15rem 0; }
.req-cost { font-weight: 600; min-width: 4rem; }

/* ---- inner expanders ---- */
details.sub { margin: 0.45rem 0; border-left: 2px solid var(--hairline); padding-left: 0.7rem; }
details.sub > summary { cursor: pointer; list-style: none; }
details.sub > summary::-webkit-details-marker { display: none; }
details.sub > summary .label::before { content: "▸ "; }
details.sub[open] > summary .label::before { content: "▾ "; }

/* ---- tool calls ---- */
.tc-row { display: flex; align-items: baseline; gap: 0.55rem; font-size: 0.85rem; padding: 0.1rem 0; }
.tc-name { font-family: var(--vscode-editor-font-family, monospace); }
.tc-dur { margin-left: auto; font-variant-numeric: tabular-nums; }
.ok { color: var(--good); font-size: 0.7em; }
.fail { color: var(--bad); font-size: 0.7em; }
.fail-text { color: var(--bad); }
.chip-mcp { background: color-mix(in srgb, var(--vscode-charts-orange) 22%, var(--paper)); color: var(--ink); }

/* ---- subagent lanes ---- */
.sa-row { display: grid; grid-template-columns: 10rem 1fr; gap: 0.2rem 0.8rem; align-items: center; padding: 0.2rem 0; font-size: 0.85rem; }
.sa-meta { grid-column: 2; font-size: 0.78rem; }
.lane { position: relative; height: 8px; background: color-mix(in srgb, var(--vscode-charts-purple) 12%, transparent); border-radius: 4px; }
.lane-bar { position: absolute; top: 0; height: 100%; background: var(--vscode-charts-purple); border-radius: 4px; }

/* ---- raw JSON tape ---- */
.raw-ev > summary { display: flex; gap: 0.6rem; align-items: baseline; }
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

/* ---- comparison ---- */
.compare { margin-top: 1.1rem; padding: 0.8rem 1rem; border: 1px solid var(--hairline); border-left: 3px solid var(--accent); }
.cmp-row { display: flex; gap: 0.8rem; flex-wrap: wrap; align-items: baseline; padding: 0.15rem 0; font-size: 0.9rem; }
.cmp-model { font-family: var(--vscode-editor-font-family, monospace); min-width: 11rem; }
.cmp-delta.save { color: var(--good); font-weight: 600; }
.cmp-delta.spend { color: var(--warn); font-weight: 600; }
.caveat { border-top: 1px dashed var(--hairline); padding-top: 0.4rem; margin-top: 0.5rem; }

/* ---- by-model table ---- */
table.models { border-collapse: collapse; width: 100%; font-size: 0.88rem; }
table.models th, table.models td { padding: 0.3rem 0.6rem; border-bottom: 1px solid var(--hairline); text-align: left; }
table.models .n { text-align: right; }
table.models th { font-size: 0.7rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }

/* ---- tips / edge cases / links ---- */
.tip-card { padding: 0.55rem 0.8rem; border-left: 3px solid var(--good); margin: 0.5rem 0; background: var(--vscode-textBlockQuote-background); }
.tip-card.warn { border-left-color: var(--warn); }
.tip-card p { margin: 0.15rem 0 0; }
ul.links { padding-left: 1.2rem; }

/* ---- glossary tooltips ---- */
.term { border-bottom: 1px dotted var(--vscode-descriptionForeground); cursor: help; position: relative; }
.term .tip {
  visibility: hidden; opacity: 0; transition: opacity 0.12s ease;
  position: absolute; z-index: 30; left: 0; bottom: calc(100% + 6px);
  width: 19rem; max-width: 70vw; padding: 0.55rem 0.7rem;
  font-size: 0.8rem; line-height: 1.45; text-transform: none; letter-spacing: normal; font-weight: 400;
  color: var(--vscode-editorHoverWidget-foreground, var(--ink));
  background: var(--vscode-editorHoverWidget-background, var(--paper));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--hairline));
  border-radius: 4px; box-shadow: 0 4px 14px rgba(0,0,0,0.25);
}
.term:hover .tip, .term:focus .tip, .term:focus-within .tip { visibility: visible; opacity: 1; }
.tip strong { display: block; margin-bottom: 0.15rem; }
.tip-more { display: inline-block; margin-top: 0.2rem; }

/* ---- session cards (all-sessions mode) ---- */
details.session-card { padding-left: 1.4rem; }
.perms { margin-top: 0.3rem; }
`;
