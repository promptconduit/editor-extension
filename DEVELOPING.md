# Developing the extension

A fast local loop for changing the cost/telemetry UI and logic and seeing it
work in seconds — no marketplace, no CI round-trip.

```bash
npm install
```

## 1. Fast logic tests — the safety net

Millisecond unit tests over the pure logic (cost tips, signals, schema parsing,
per-conversation state, feed/tooltip rendering). No editor, no `vscode`.

```bash
npm test            # run once
npm run test:watch  # re-run on save — keep this open while you work
```

Add tests under `test/unit/`. Sample data lives in `dev/fixtures.ts` (shared by
the tests, the preview, and dev). The pure logic is in vscode-free modules
(`types.ts`, `tips.ts`, `state.ts`); render helpers in vscode-coupled files
(`eventsFeed.ts`, `statusBar.ts`) are exported and tested through a tiny `vscode`
stub (`test/mocks/vscode.ts`).

## 2. See it live in Cursor

Press **F5** in Cursor/VS Code ("Run Extension") — launches an Extension
Development Host with the extension loaded from source and a watch build running.
Or from the terminal:

```bash
npm run dev
```

Both load the extension into your real, logged-in Cursor, so the **Telemetry
panel** (bottom panel → "PromptConduit") and **cost status bar** show your real
`~/.promptconduit` data. Edit code → reload the dev window (**Cmd+R** /
"Developer: Reload Window") to pick up changes.

## 3. Webview preview in a browser — instant UI iteration

Render the UI surfaces (telemetry feed, landing/zero-state, tooltip headline)
with sample data to static HTML and open them in your browser. Best for
tweaking look/feel without booting the editor.

```bash
npm run preview                 # render + open
PREVIEW_NO_OPEN=1 npm run preview   # render only
```

Edit a builder (e.g. `buildFeedHtml`) and re-run. Output is in
`dev/preview-out/` (gitignored).

## 4. Try a PR locally in seconds

```bash
scripts/try-pr.sh 42   # checkout PR #42, install, run tests, launch it live
```

## End-to-end gate (CI)

A separate Playwright suite drives the panel in real Cursor; it's the
**required** `cursor-e2e` PR check, not part of the local loop. See
`test/e2e/README.md`.
