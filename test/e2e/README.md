# Cursor E2E (POC)

End-to-end test that boots the **real Cursor editor** in CI, opens the docked
**Telemetry** panel against a seeded `events.jsonl`, asserts the rendered rows in
the webview, and uploads a screenshot. This is the surface we couldn't observe
from a headless shell — here it becomes a downloadable CI artifact.

## Run it

CI only (Cursor + xvfb don't run on macOS): trigger the **E2E (Cursor)** workflow
(`.github/workflows/e2e-cursor.yml`). Screenshots land in the
`cursor-e2e-artifacts` artifact (uploaded even on failure):
`01-cursor-loaded.png`, `02-panel-opened.png`, `telemetry-panel.png`.

## How it works

1. `scripts/install-cursor.sh` downloads + extracts the Cursor Linux AppImage and
   resolves the Electron binary (`squashfs-root/usr/share/cursor/cursor`).
2. `npm run compile` builds the extension; Cursor loads it from source via
   `--extensionDevelopmentPath` (no vsix packaging/install — sidesteps Cursor's
   CLI `--install-extension` symlink bug).
3. The test seeds a temp `HOME` with a known `~/.promptconduit/events.jsonl`,
   launches Cursor under `xvfb`, focuses the panel via the command palette, walks
   the two webview iframes, and asserts the seeded rows.

The panel reads a plain file, so input is fully deterministic — no CLI, no AI.

## Hard-won gotchas (baked in; don't regress)

- **`runs-on: ubuntu-22.04`** — the Cursor AppImage **SIGTRAPs on 24.04** (glibc
  2.39/t64) and `--no-sandbox` doesn't fix it. `ubuntu-latest` is 24.04.
- **Strip `VSCODE_*` env** before launch, or webviews fail with a ServiceWorker
  "invalid state" error and render blank (see `launchEnv()`).
- **Webview = two nested iframes** (`iframe.webview` → inner `#active-frame`),
  read via the modern `.contentFrame()` chain. Selectors are runtime-fragile;
  assert on our own text and use generous waits.
- **Pin the Cursor version** (`CURSOR_VERSION`) for reproducibility — URLs come
  from `oslook/cursor-ai-downloads`, not the stale `downloader.cursor.sh`.
- **Playwright ↔ Electron**: if `firstWindow()` hangs, bump `@playwright/test` to
  match Cursor's Electron version.

## Reference

The launch flags + env scrub + webview frame pattern follow
[`ruifigueira/vscode-test-playwright`](https://github.com/ruifigueira/vscode-test-playwright),
the maintained library that does this for stock VS Code. If we productionize,
adopting it (and just swapping `executablePath` to Cursor) is the likely path.
