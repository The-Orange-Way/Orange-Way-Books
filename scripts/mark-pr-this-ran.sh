#!/usr/bin/env bash
#
# mark-pr-this-ran.sh — record that /pr-this has been run against the current
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

# File-scoped dirty check: refuse only when files THIS agent is pushing are dirty.
# A shared checkout may have another agent's uncommitted edits to unrelated paths;
# those must not block marking /pr-this as run on this agent's own clean work.
# "This agent's files" = paths between HEAD and the merge-base with origin/dev.
# CTO decision 2026-08-23: safety checks must validate only the files the pushing
# agent changed and never require a clean tree for paths it does not own.
MERGE_BASE="$(git merge-base HEAD origin/dev 2>/dev/null \
  || git merge-base HEAD origin/main 2>/dev/null \
  || echo "")"
if [ -n "$MERGE_BASE" ]; then
  AGENT_FILES="$(git diff --name-only "$MERGE_BASE" HEAD 2>/dev/null || true)"
else
  AGENT_FILES="$(git diff --name-only HEAD~ HEAD 2>/dev/null || true)"
fi
DIRTY_STATUS="$(git status --porcelain 2>/dev/null || true)"
if [ -n "$DIRTY_STATUS" ]; then
  DIRTY_FILES="$(printf '%s\n' "$DIRTY_STATUS" | awk '{print $NF}' | sort -u)"
  if [ -n "$AGENT_FILES" ]; then
    OVERLAP="$(comm -12 <(printf '%s\n' "$AGENT_FILES" | sort -u) \
                        <(printf '%s\n' "$DIRTY_FILES") || true)"
  else
    # No agent-owned files identified -- refuse on any dirty tree (safe default).
    OVERLAP="$DIRTY_FILES"
  fi
  if [ -n "$OVERLAP" ]; then
    echo "✗ refusing to mark on a dirty working tree for this agent's paths" >&2
    echo "  stash or commit paths this agent is pushing, then re-run" >&2
    echo "  /pr-this's gauntlet must certify the exact code being pushed." >&2
    printf '%s\n' "$OVERLAP" | sed 's/^/  /' >&2
    exit 1
  fi
  # Tree has dirty files outside this agent's diff -- shared-checkout scenario, allowed.
fi

HEAD_SHA="$(git rev-parse HEAD)"
# Resolve the per-worktree git dir. A bare ".git/" path is a regular FILE
# inside a linked worktree, so this redirect would fail with "Not a directory"
# and no marker would be written. --absolute-git-dir is per-worktree (not
# --git-common-dir, which is shared and would let one worktree authorise a
# push from another branch).
echo "$HEAD_SHA" > "$(git rev-parse --absolute-git-dir)/.pr-this-ran"

echo "✓ /pr-this marker set → $(echo "$HEAD_SHA" | head -c 12) on $(git rev-parse --abbrev-ref HEAD)"
