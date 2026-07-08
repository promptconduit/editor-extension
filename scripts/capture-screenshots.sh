#!/usr/bin/env bash
# Capture clean screenshots of every PromptConduit panel in your real, signed-in
# Cursor.app (macOS). Seeds deterministic demo data via PROMPTCONDUIT_DIR, opens
# each panel, and writes PNGs to out/capture/ — then copies them to the committed
# resources/screenshots/ for the README/marketplace.
#
#   npm run capture
#
# One-time setup is handled below: on first run it opens Cursor with a dedicated
# capture profile and waits for you to sign in (~30s). After that it's just
# `npm run capture`. No `cursor` CLI on PATH required.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROFILE="${CURSOR_CAPTURE_PROFILE:-$HOME/.cursor-capture-profile}"
CURSOR_APP="/Applications/Cursor.app"

if [ ! -d "$CURSOR_APP" ]; then
  echo "Cursor.app not found at $CURSOR_APP. Install Cursor first." >&2
  exit 1
fi

# One-time: sign in to the dedicated capture profile. Auth persists in the profile,
# so this is asked only once. Kept separate from your daily Cursor profile.
if [ ! -d "$PROFILE/User" ]; then
  echo "First run — a one-time Cursor sign-in for the capture profile is needed."
  echo "Opening Cursor with a fresh profile at: $PROFILE"
  open -na "Cursor" --args --user-data-dir="$PROFILE"
  echo
  echo "  → In that Cursor window, sign in with your Cursor account, wait until you"
  echo "    can see the editor, then return here."
  read -r -p "Press Enter once you're signed in… " _
  echo
fi

echo "Compiling the extension (loaded from source via --extensionDevelopmentPath)…"
npm run compile

echo "Capturing panel screenshots in Cursor…"
npx playwright test --config playwright.capture.config.ts "$@"

# Curate: copy the produced shots into the committed dir the README/marketplace use.
DEST="resources/screenshots"
mkdir -p "$DEST"
if compgen -G "out/capture/*.png" > /dev/null; then
  cp out/capture/*-window.png out/capture/*-panel.png "$DEST"/ 2>/dev/null || true
  echo
  echo "✔ Screenshots captured → out/capture/  (copied to $DEST/ for the README/marketplace)"
  ls -1 "$DEST"/*.png 2>/dev/null | sed 's/^/    /'
else
  echo "No screenshots were produced — see the Playwright output above." >&2
  exit 1
fi
