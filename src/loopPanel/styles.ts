// The Loop stylesheet. Colors come from the editor theme (var(--vscode-*)) with
// literal fallbacks so the same CSS renders on a plain web page. Three data
// colors carry the whole story: history re-read (dull, the dead weight), new
// context written (amber), and what the model wrote (brand teal).

export const LOOP_PANEL_CSS = `
:root{
  --bg:var(--vscode-editor-background,#0e1416);
  --panel:var(--vscode-editorWidget-background,#141c1f);
  --fg:var(--vscode-foreground,#dde7e7);
  --muted:var(--vscode-descriptionForeground,#8a9ea1);
  --line:var(--vscode-widget-border,var(--vscode-panel-border,#243034));
  --chip:var(--vscode-badge-background,#1b2528);
  --chip-fg:var(--vscode-badge-foreground,#dde7e7);
  --read:color-mix(in srgb,var(--fg) 26%,var(--bg));
  --write:#e3a948;
  --out:#3fd8c8;
  --accent:#3fd8c8;
  --warn:#f08a4b;
  --mono:var(--vscode-editor-font-family,ui-monospace,"SF Mono",Menlo,monospace);
  --sans:var(--vscode-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);
}
body.vscode-light{--write:#b8740c;--out:#0b8f84;--accent:#0b8f84;--warn:#b4531a;--read:color-mix(in srgb,var(--fg) 22%,var(--bg))}
body.vscode-high-contrast{--read:var(--fg)}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:13.5px;line-height:1.55;margin:0}
#app{max-width:1040px;margin:0 auto;padding:20px 20px 56px;display:flex;flex-direction:column;gap:30px}
.mono,.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.muted{color:var(--muted)}
p{margin:0;max-width:72ch}
h1,h2{margin:0;text-wrap:balance}
h1{font-size:22px;font-weight:600;line-height:1.25}
h2{font-size:15.5px;font-weight:600}
.eyebrow{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
header{display:flex;flex-direction:column;gap:10px}
.bar{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
.bar .grow{flex:1}
select,button{font:inherit;font-size:12.5px;color:var(--fg);background:var(--vscode-dropdown-background,var(--panel));border:1px solid var(--line);border-radius:4px;padding:4px 8px}
select{max-width:min(100%,520px)}
button{cursor:pointer;background:var(--vscode-button-secondaryBackground,var(--chip));color:var(--vscode-button-secondaryForeground,var(--fg))}
button:hover{border-color:var(--accent)}
button.primary{background:var(--vscode-button-background,#0b8f84);color:var(--vscode-button-foreground,#fff);border-color:transparent}
:focus-visible{outline:1px solid var(--vscode-focusBorder,var(--accent));outline-offset:2px}
.meta{display:flex;flex-wrap:wrap;gap:4px 14px;font-family:var(--mono);font-size:11.5px;color:var(--muted)}
.meta b{color:var(--fg);font-weight:500}
.prompt{font-family:var(--mono);font-size:12px;background:var(--chip);color:var(--chip-fg);border-radius:3px;padding:1px 6px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.live,.focus{color:var(--accent);font-family:var(--mono);font-size:11px}
.lede{font-size:15px;line-height:1.5;max-width:68ch}
.lede .r{border-bottom:3px solid var(--read)}
.lede .o{color:var(--out);font-weight:600}
section{display:flex;flex-direction:column;gap:12px}
.sec-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px 16px;border-top:1px solid var(--line);padding-top:16px}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11.5px;color:var(--muted)}
.sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.sw.read,.f-read{background:var(--read);fill:var(--read)}
.sw.write,.f-write{background:var(--write);fill:var(--write)}
.sw.out,.f-out{background:var(--out);fill:var(--out)}
.f-accent{fill:var(--accent)} .f-warn{fill:var(--warn)} .f-chip{fill:var(--chip)} .f-none{fill:transparent}
.s-line{stroke:var(--line)} .s-faint{stroke:var(--muted);opacity:.6} .s-warn{stroke:var(--warn)} .s-accent{stroke:var(--accent)}
svg{display:block;max-width:none}
svg text{font-family:var(--mono);fill:var(--muted)}
svg text.fg{fill:var(--fg)} svg text.warn{fill:var(--warn)} svg text.write{fill:var(--write)} svg text.accent{fill:var(--accent)}
svg text.b{font-weight:700}
.stage{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 8px 6px}
.scroll{overflow-x:auto}
.controls{display:flex;gap:10px;align-items:center;padding:0 6px 6px}
.meter{font-family:var(--mono);font-size:12px;color:var(--muted)}
.meter b{color:var(--fg);font-size:16px;margin-left:6px}
.notes{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:12px}
.note{border-left:3px solid var(--line);padding:2px 0 2px 12px;display:flex;flex-direction:column;gap:3px;min-width:0}
.note.reread{border-left-color:var(--read)} .note.good{border-left-color:var(--accent)} .note.warn{border-left-color:var(--warn)}
.note .k{font-family:var(--mono);font-size:18px;font-weight:700}
.note p{font-size:12.5px;color:var(--muted)}
.note p strong{color:var(--fg)}
.whatif{display:flex;flex-direction:column;gap:12px}
.wi{display:grid;grid-template-columns:minmax(0,1fr) 70px;gap:3px 12px;align-items:center}
.wi .lab{font-weight:600}
.wi .lab small{display:block;font-weight:400;color:var(--muted);font-size:12.5px;max-width:76ch}
.wi .amt{font-family:var(--mono);font-weight:700;text-align:right}
.wi svg{grid-column:1 / -1;width:100%;height:7px}
.wi.base .lab{color:var(--muted)}
.delta{font-family:var(--mono);font-size:11.5px;font-weight:500;margin-left:6px}
.delta.save{color:var(--accent)} .delta.more{color:var(--warn)}
a{color:var(--vscode-textLink-foreground,var(--accent));text-decoration:none;cursor:pointer}
a:hover{text-decoration:underline}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr));gap:10px}
.stat{display:flex;flex-direction:column;gap:2px;border-top:2px solid var(--line);padding-top:6px}
.stat .v{font-family:var(--mono);font-size:19px;font-weight:700}
.stat .v span{font-size:12px;color:var(--muted);font-weight:500;margin-left:6px}
.stat .l{font-size:11.5px;color:var(--muted)}
.card{border:1px dashed var(--line);border-radius:8px;padding:12px 14px;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:space-between}
.card p{font-size:12.5px;color:var(--muted)}
.card > div{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1}
.card h2{font-size:14px}
.card ol,.card ul{margin:0;padding-left:20px;font-size:12.5px;color:var(--muted);display:flex;flex-direction:column;gap:6px}
.card.setup,.card.agent{border-style:solid}
code{font-family:var(--mono);font-size:12px;background:var(--chip);color:var(--chip-fg);border-radius:3px;padding:1px 5px}
.cmdline{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin-top:4px}
.cmdline code{overflow-x:auto;max-width:100%}
.questions q{color:var(--fg)}
.split{display:flex;height:12px;border-radius:3px;overflow:hidden;gap:2px}
.split svg{width:100%;height:12px}
.splitlab{display:flex;flex-wrap:wrap;gap:3px 18px;font-size:12px;color:var(--muted)}
.splitlab b{font-family:var(--mono);color:var(--fg)}
.empty{padding:40px 0;display:flex;flex-direction:column;gap:10px;align-items:flex-start}
.tip{position:fixed;pointer-events:none;background:var(--vscode-editorHoverWidget-background,var(--panel));border:1px solid var(--vscode-editorHoverWidget-border,var(--line));border-radius:4px;padding:6px 9px;font:11.5px/1.5 var(--mono);color:var(--fg);z-index:20;max-width:320px;white-space:pre-line}
@media (prefers-reduced-motion: reduce){*{transition:none!important}}
`;
