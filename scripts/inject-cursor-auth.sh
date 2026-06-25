#!/usr/bin/env bash
# Inject a captured Cursor auth session into a fresh --user-data-dir so Cursor
# launches already logged in (no "Log In / Sign Up" wall), for clean screenshots.
#
# Cursor stores its session as PLAINTEXT rows in state.vscdb (the VS Code
# ItemTable) — not the OS keychain — so CI injection is just a few SQL upserts.
#
# Usage:  inject-cursor-auth.sh <user-data-dir>
# Env (from CI secrets):
#   CURSOR_ACCESS_TOKEN   (required) cursorAuth/accessToken JWT
#   CURSOR_REFRESH_TOKEN  (optional, recommended) cursorAuth/refreshToken
#   CURSOR_EMAIL          (optional) cursorAuth/cachedEmail (for the UI)
#
# Capture once from a logged-in machine (Cursor closed):
#   sqlite3 ~/.config/Cursor/User/globalStorage/state.vscdb \
#     "SELECT key,value FROM ItemTable WHERE key LIKE 'cursorAuth/%';"
# Use a DEDICATED Cursor account for CI — logging in here can log out that
# account elsewhere (single active session).
set -euo pipefail

UD="${1:?usage: inject-cursor-auth.sh <user-data-dir>}"
: "${CURSOR_ACCESS_TOKEN:?CURSOR_ACCESS_TOKEN is required}"

GS="$UD/User/globalStorage"
DB="$GS/state.vscdb"
mkdir -p "$GS"

# SQL string-escape (double any single quotes; JWTs don't contain them, but be safe).
esc() { printf '%s' "$1" | sed "s/'/''/g"; }

sqlite3 "$DB" <<SQL
CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value BLOB);
INSERT OR REPLACE INTO ItemTable (key,value) VALUES ('cursorAuth/accessToken','$(esc "$CURSOR_ACCESS_TOKEN")');
INSERT OR REPLACE INTO ItemTable (key,value) VALUES ('cursorAuth/cachedSignUpType','Auth_0');
SQL

if [ -n "${CURSOR_REFRESH_TOKEN:-}" ]; then
  sqlite3 "$DB" "INSERT OR REPLACE INTO ItemTable (key,value) VALUES ('cursorAuth/refreshToken','$(esc "$CURSOR_REFRESH_TOKEN")');"
fi
if [ -n "${CURSOR_EMAIL:-}" ]; then
  sqlite3 "$DB" "INSERT OR REPLACE INTO ItemTable (key,value) VALUES ('cursorAuth/cachedEmail','$(esc "$CURSOR_EMAIL")');"
fi

echo "Injected Cursor auth into $DB ($(sqlite3 "$DB" "SELECT count(*) FROM ItemTable WHERE key LIKE 'cursorAuth/%';") rows)"
