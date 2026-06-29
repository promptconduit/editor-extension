// The webview's DOM chrome (CSS + body scaffold) shared by the live panel
// (src/visualizerPanel.ts) and the browser dev preview (dev/preview.ts) so they
// never drift. The 3D scene draws into #app; the rest are DOM overlays styled
// with --vscode-* vars so they match the editor theme.

export const SCENE_CSS = `
  :root { --fg: var(--vscode-editor-foreground, #e6e9f2); --dim: var(--vscode-descriptionForeground, #8a94b0); }
  html, body { margin: 0; height: 100%; overflow: hidden; background: #05070D; color: var(--fg);
    font-family: var(--vscode-font-family, system-ui); }
  #app { position: fixed; inset: 0; }
  canvas { display: block; }
  .hidden { display: none !important; }

  .hud { position: fixed; top: 14px; left: 16px; pointer-events: none; user-select: none; }
  .hud .title { font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--dim); }
  .hud .session { font-size: 15px; margin-top: 2px; }
  .legend { margin-top: 10px; display: flex; flex-direction: column; gap: 3px; }
  .legend .row { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--dim); }
  .legend .sw { width: 9px; height: 9px; border-radius: 50%; box-shadow: 0 0 6px currentColor; }

  .hover-card { position: fixed; min-width: 180px; max-width: 320px; padding: 10px 12px;
    background: rgba(12, 16, 26, 0.92); border: 1px solid rgba(125, 249, 255, 0.25);
    border-radius: 10px; backdrop-filter: blur(8px); box-shadow: 0 8px 30px rgba(0,0,0,0.5);
    font-size: 12px; pointer-events: auto; transform: translate(-50%, -100%); z-index: 5; }
  .hover-card .h-title { font-weight: 600; margin-bottom: 2px; }
  .hover-card .h-sub { color: var(--dim); font-size: 11px; margin-bottom: 6px; }
  .hover-card a { display: block; color: var(--vscode-textLink-foreground, #7df9ff); text-decoration: none;
    padding: 2px 0; cursor: pointer; }
  .hover-card a:hover { text-decoration: underline; }
  .hover-card .tag { display: inline-block; min-width: 30px; color: var(--dim); }

  .transport { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
    display: flex; align-items: center; gap: 12px; padding: 8px 14px;
    background: rgba(12, 16, 26, 0.82); border: 1px solid var(--vscode-panel-border, rgba(125,249,255,0.15));
    border-radius: 999px; backdrop-filter: blur(8px); z-index: 5; }
  .transport button { background: none; border: none; color: var(--fg); cursor: pointer; font-size: 13px;
    padding: 3px 7px; border-radius: 6px; }
  .transport button:hover { background: rgba(255,255,255,0.08); }
  .transport .play { font-size: 15px; min-width: 22px; }
  .transport .scrub { width: 220px; accent-color: #7df9ff; cursor: pointer; }
  .transport .time { font-variant-numeric: tabular-nums; color: var(--dim); font-size: 11px; min-width: 78px; }
  .transport .speed.active { color: #7df9ff; }
  .transport .live { color: #4ade80; font-size: 11px; letter-spacing: 0.1em; }
  .transport .live.off { color: var(--dim); opacity: 0.5; }
  .demo-badge { position: fixed; top: 14px; right: 16px; font-size: 11px; letter-spacing: 0.1em;
    color: #ffb454; text-transform: uppercase; }
`;

export const SCENE_BODY = `
  <div id="app"></div>
  <div id="hud" class="hud hidden"></div>
  <div id="hover" class="hover-card hidden"></div>
  <div id="transport" class="transport hidden"></div>
  <div id="demo" class="demo-badge hidden">Demo</div>
`;
