#!/usr/bin/env bash
# Push a screenshot to the orphan `ci-screenshots` branch and upsert a sticky PR
# comment that embeds it inline (raw.githubusercontent URLs render in comments).
# Keeps images off main and out of the PR diff. Best-effort.
#
# Usage:  post-pr-screenshot.sh <png> <pr-number>
# Env:    GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID
set -euo pipefail

PNG="${1:?usage: post-pr-screenshot.sh <png> <pr-number>}"
PR="${2:?pr number}"
REPO="${GITHUB_REPOSITORY:?}"
BRANCH="ci-screenshots"
DEST="pr-${PR}/telemetry-panel.png"
AUTH="https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"

TMP="$(mktemp -d)"
# Clone the asset branch, or start it as an orphan if it doesn't exist yet.
if git clone --quiet --depth 1 --branch "$BRANCH" "$AUTH" "$TMP" 2>/dev/null; then
  :
else
  git clone --quiet --depth 1 "$AUTH" "$TMP"
  git -C "$TMP" switch --orphan "$BRANCH"
  git -C "$TMP" rm -rfq . 2>/dev/null || true
fi

mkdir -p "$TMP/$(dirname "$DEST")"
cp "$PNG" "$TMP/$DEST"
git -C "$TMP" config user.name "github-actions[bot]"
git -C "$TMP" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git -C "$TMP" add "$DEST"
if git -C "$TMP" commit -q -m "screenshot: PR #${PR} (run ${GITHUB_RUN_ID})"; then
  git -C "$TMP" push -q "$AUTH" "HEAD:$BRANCH"
else
  echo "Screenshot unchanged — skipping push."
fi

RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}/${DEST}?v=${GITHUB_RUN_ID}"
MARKER="<!-- pr-screenshot -->"
BODY="${MARKER}
### 📸 Telemetry panel — rendered in Cursor

![Telemetry panel](${RAW})

<sub>Auto-captured from real Cursor by the **PR screenshot** workflow, updated on each run.</sub>"

# Upsert a single sticky comment.
CID="$(gh api "repos/${REPO}/issues/${PR}/comments" \
        --jq "map(select(.body|startswith(\"${MARKER}\")))|.[0].id" 2>/dev/null || true)"
if [ -n "$CID" ] && [ "$CID" != "null" ]; then
  gh api -X PATCH "repos/${REPO}/issues/comments/${CID}" -f body="$BODY" >/dev/null
  echo "Updated screenshot comment on PR #${PR}."
else
  gh api -X POST "repos/${REPO}/issues/${PR}/comments" -f body="$BODY" >/dev/null
  echo "Posted screenshot comment on PR #${PR}."
fi
