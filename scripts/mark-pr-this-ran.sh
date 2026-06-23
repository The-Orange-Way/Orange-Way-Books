#!/usr/bin/env bash
#
# mark-pr-this-ran.sh, record that /pr-this has been run against the current
# HEAD. The pre-push hook reads `.git/.pr-this-ran` and refuses to push if the
# recorded SHA doesn't match HEAD.
#
# Usage:
#   - Run at the very end of the /pr-this gauntlet, AFTER every intended commit
#     has landed and the gauntlet is fully green.
#   - Refuses to write the marker on a dirty working tree (so the marker can't
#     lie). Stash or commit, then re-run.
#
# Idempotent: re-running on an already-marked clean HEAD is a no-op.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Refuse on a dirty tree so the marker honestly reflects what was gauntleted.
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ refusing to mark on a dirty working tree" >&2
  echo "  stash or commit pending changes, then re-run" >&2
  git status --short
  exit 1
fi

HEAD_SHA="$(git rev-parse HEAD)"
echo "$HEAD_SHA" > .git/.pr-this-ran

echo "✓ /pr-this marker set → $(echo "$HEAD_SHA" | head -c 12) on $(git rev-parse --abbrev-ref HEAD)"
