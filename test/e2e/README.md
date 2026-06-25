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

## POC result + the one open limitation

**Functional E2E in real Cursor works and is green.** Cursor boots under xvfb,
the extension loads, and the panel's webview renders the seeded events — proven
by the DOM assertions (`AI telemetry`, `UserPromptSubmit`, `PreToolUse`,
`demo-repo`×3) passing inside the webview iframe. That is genuine verification
that the panel works in actual Cursor.

**Clean pixel screenshots are blocked by Cursor's login wall.** On a fresh,
unauthenticated CI profile, Cursor paints a full-window "Log In / Sign Up" gate
over the workbench that `workbench.startupEditor:none` + Escape do **not**
dismiss. The panel still renders in the DOM underneath (hence the green
assertions), but `screenshot()` captures the occluding login pixels — so
`telemetry-panel.png` shows the login screen, not the panel.

To get pixel screenshots in Cursor you'd need to **authenticate it in CI** —
inject a Cursor auth/session token (as a secret) into the user-data-dir before
launch. Alternatively, run the *pixel* screenshot against stock VS Code (no
login wall) while keeping this Cursor run for the DOM-level functional
assertions. The functional verification here needs neither.

## PR screenshots (authenticated Cursor)

`.github/workflows/pr-screenshot.yml` renders the panel in **real, logged-in
Cursor** and posts the screenshot **inline as a sticky PR comment**. It's
non-blocking and separate from the `e2e-cursor` gate. With no auth secret it
no-ops.

**Why auth:** a fresh Cursor profile shows a full-window login wall that occludes
the workbench. Cursor keeps its session as plaintext rows in `state.vscdb`
(not the OS keychain), so we inject a captured token into the CI profile
(`scripts/inject-cursor-auth.sh`) and Cursor boots logged in.

### One-time setup

1. **Use a dedicated Cursor account for CI** — logging in from CI can log your
   personal account out elsewhere (Cursor allows one active session).
2. Log into Cursor with that account, quit Cursor, then capture the session:
   ```bash
   sqlite3 ~/.config/Cursor/User/globalStorage/state.vscdb \
     "SELECT key,value FROM ItemTable WHERE key LIKE 'cursorAuth/%';"
   # macOS: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
   ```
3. Add repo secrets (Settings → Secrets and variables → Actions):
   - `CURSOR_ACCESS_TOKEN` — the `cursorAuth/accessToken` value (**required**)
   - `CURSOR_REFRESH_TOKEN` — `cursorAuth/refreshToken` (recommended)
   - `CURSOR_EMAIL` — `cursorAuth/cachedEmail` (optional, for the UI)

That's it — the next PR gets an inline Cursor screenshot.

### Caveats

- The access token is a short-lived JWT; if the wall returns, re-capture (the
  refresh token helps the client renew). For a screenshot you usually only need
  the client-side logged-in state, which is forgiving.
- Screenshots live on an orphan `ci-screenshots` branch (off `main`, off the PR
  diff). Internal-branch PRs only — fork PRs get a read-only token and skip.

## Reference

The launch flags + env scrub + webview frame pattern follow
[`ruifigueira/vscode-test-playwright`](https://github.com/ruifigueira/vscode-test-playwright),
the maintained library that does this for stock VS Code. If we productionize,
adopting it (and just swapping `executablePath` to Cursor) is the likely path.
