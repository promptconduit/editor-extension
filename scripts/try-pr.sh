#!/usr/bin/env bash
# Try a PR locally in seconds: check it out, install, run the fast tests, and
# launch it live in Cursor.
#
#   scripts/try-pr.sh 42
set -euo pipefail

PR="${1:?usage: scripts/try-pr.sh <pr-number>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "▸ Checking out PR #$PR…"
gh pr checkout "$PR"

echo "▸ Installing deps…"
npm ci

echo "▸ Running fast logic tests…"
npm test

echo "▸ Launching it in Cursor…"
exec bash scripts/dev.sh
