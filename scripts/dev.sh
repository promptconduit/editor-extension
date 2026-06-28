#!/usr/bin/env bash
# Live local dev: compile, launch the extension in your (logged-in) Cursor from
# source, and watch-compile. The terminal equivalent of pressing F5.
#
# The Telemetry panel + cost bar use your REAL ~/.promptconduit data (no login
# wall locally — you're already signed in). For controlled sample data, use
# `npm run preview` (browser) instead.
#
# Edit code, then reload the dev window (Cmd+R / "Developer: Reload Window").
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CURSOR="$(command -v cursor || true)"
if [ -z "$CURSOR" ] && [ -x "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" ]; then
  CURSOR="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
fi
if [ -z "$CURSOR" ]; then
  echo "Cursor CLI not found. In Cursor: Cmd+Shift+P → \"Shell Command: Install 'cursor' command in PATH\"." >&2
  exit 1
fi

echo "Compiling…"
npm run compile

echo "Launching Cursor (Extension Development Host)…"
"$CURSOR" --extensionDevelopmentPath="$ROOT" "$ROOT" >/dev/null 2>&1 &

cat <<'MSG'

✔ Cursor is opening with the extension loaded from source.
  • Telemetry panel: bottom panel → "PromptConduit"
  • Cost: the status-bar item (click for the breakdown)
  Both use your real ~/.promptconduit data.

  Edit code → reload the dev window (Cmd+R) to see changes.

Starting tsc --watch (Ctrl-C to stop)…
MSG

exec npm run watch
