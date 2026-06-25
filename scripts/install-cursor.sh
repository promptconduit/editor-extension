#!/usr/bin/env bash
# Download a Cursor Linux x64 AppImage, extract it without FUSE, and print the
# path to the launchable Electron binary (for Playwright's executablePath).
#
# Usage:  scripts/install-cursor.sh [DEST_DIR]
# Env:
#   CURSOR_URL      explicit AppImage URL (highest priority; fully pins the build)
#   CURSOR_VERSION  pick this version from oslook/cursor-ai-downloads (e.g. 3.9.8)
#                   default: the most recent entry in that list
#
# Why oslook: the old downloader.cursor.sh redirect is stale/unreliable; the
# community-maintained version-history.json holds immutable downloads.cursor.com
# URLs (commit-hash pinned) per version. Pin CURSOR_VERSION for reproducible CI.
set -euo pipefail

DEST="${1:-$PWD/.cursor-test}"
HIST_URL="https://raw.githubusercontent.com/oslook/cursor-ai-downloads/main/version-history.json"

mkdir -p "$DEST"
cd "$DEST"

URL="${CURSOR_URL:-}"
if [ -z "$URL" ]; then
  echo "Resolving Cursor linux-x64 URL from oslook/cursor-ai-downloads (version=${CURSOR_VERSION:-latest})…"
  curl -fSL --retry 3 "$HIST_URL" -o version-history.json
  URL="$(CURSOR_VERSION="${CURSOR_VERSION:-}" python3 - <<'PY'
import json, os
data = json.load(open("version-history.json"))["versions"]
want = os.environ.get("CURSOR_VERSION") or ""
entry = next((v for v in data if v.get("version") == want), None) if want else data[0]
if not entry:
    raise SystemExit(f"version {want!r} not found in version-history.json")
url = entry["platforms"].get("linux-x64")
if not url:
    raise SystemExit(f"no linux-x64 build for version {entry.get('version')}")
print(url)
PY
)"
fi

echo "Downloading Cursor AppImage: $URL"
curl -fSL --retry 3 "$URL" -o cursor.AppImage
chmod +x cursor.AppImage

echo "Extracting (no FUSE)…"
./cursor.AppImage --appimage-extract >/dev/null

# The Electron binary is squashfs-root/usr/share/cursor/cursor (AppRun is a
# wrapper; squashfs-root/cursor is usually a symlink to it). Resolve defensively.
BIN=""
for cand in \
  "$DEST/squashfs-root/usr/share/cursor/cursor" \
  "$DEST/squashfs-root/cursor"; do
  if [ -x "$cand" ] && [ ! -L "$cand" ]; then BIN="$cand"; break; fi
done
if [ -z "$BIN" ]; then
  BIN="$(find "$DEST/squashfs-root" -maxdepth 4 -type f -name cursor -perm -u+x \
          -printf '%s\t%p\n' 2>/dev/null | sort -rn | head -1 | cut -f2 || true)"
fi
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  echo "ERROR: could not locate the Cursor Electron binary under $DEST/squashfs-root" >&2
  find "$DEST/squashfs-root" -maxdepth 3 -type f -name 'cursor*' >&2 || true
  exit 1
fi

echo "Cursor binary: $BIN"
[ -n "${GITHUB_OUTPUT:-}" ] && echo "cursor_bin=$BIN" >> "$GITHUB_OUTPUT"
echo "$BIN"
