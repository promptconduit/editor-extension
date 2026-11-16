# PromptConduit Editor Extension

VS Code / Cursor extension that shows AI coding cost and activity live (status bar, docked "PromptConduit" panel, The Loop view). It is local-only: it reads the event log written by the open-source `promptconduit` CLI and never talks to a server. Public MIT repo: https://github.com/promptconduit/editor-extension

## Commands

```bash
scripts/verify            # what PR CI runs: npm ci, compile, unit tests, vsce package (--fast skips packaging)
npm run compile           # tsc + webview bundle
npm test                  # vitest (test:watch while iterating)
npm run dev               # launch an Extension Development Host in Cursor (or press F5)
npm run preview           # render webview states to static HTML in dev/preview-out/
scripts/e2e               # Playwright against real Cursor; needs CURSOR_BIN=<path to Cursor executable>
scripts/try-pr.sh <n>     # check out PR <n>, install, test, launch
```

No dev-server port: this is an editor extension, not a web app.

## Layout

- `src/` extension host code (TypeScript); pure, vscode-free modules (`types.ts`, `tips.ts`, `state.ts`, ...) are unit-tested directly
- `webview/` browser-side UI bundled by `scripts/build-webview.mjs`
- `test/unit/` vitest; `test/mocks/vscode.ts` is the vscode stub; `test/e2e/` Playwright-on-Cursor; `test/capture/` screenshot capture
- `dev/` fixtures, preview and standalone-demo tooling (fixtures are shared by tests and preview)
- `scripts/` build, dev, Cursor install and screenshot helpers
- `docs/` research notes and plans

## Deploy & release

- PRs run `ci.yml` (compile, unit tests, vsce package) and `e2e-cursor.yml` (real Cursor under xvfb).
- Publishing to Open VSX / VS Code Marketplace is done by `publish.yml` on a release tag. Manual; do not publish from an agent.
- The `promptconduit` CLI embeds a built `.vsix` of this extension, so bump the `package.json` version for any user-visible change.

## Rules

- Branch + PR only (`feat/`, `fix/`, `chore/`); never commit to `main`. PRs are squash-merged.
- `npm run compile` and `npx vsce package` must succeed; never commit the generated `.vsix`.
- Keep the extension local-only: talk to the CLI/event log, never to a remote server.
- Public repo: no API keys or credentials, no private-service internals, no unreleased plans in code, commits or PR text.
- Host-code changes need a window reload; webview changes can use the Refresh Panel button.
- The event envelope (`src/envelope.ts`) and update marker (`src/updatePrompt.ts`) mirror CLI structures: keep field names in sync, additive changes only.
- Headed e2e can hang on a locked screen; run it in an unlocked session.

## Docs

- `DEVELOPING.md` fast local loop, preview, try-a-PR
- `CONTRIBUTING.md` setup and PR guidelines
- `test/e2e/README.md` Cursor e2e details
- `CHANGELOG.md`
