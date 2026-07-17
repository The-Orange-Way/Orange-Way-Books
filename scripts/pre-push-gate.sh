#!/usr/bin/env bash
#
# pre-push-gate.sh — enforce that /pr-this ran before any push to a public branch.
#
# Wire as a git pre-push hook (see scripts/install-hooks.sh).
#
# What it checks (refuses the push if any FAIL):
#   1. /pr-this marker (`.git/.pr-this-ran`) is newer than HEAD on the branch
#      being pushed. If absent or stale, the push is refused.
#   2. The repo's pre-publish leak scanner (`scripts/pre-publish-scan.sh`)
#      reports clean.
#   3. No reserved-term leaks in the commits being pushed (messages + diff).
#   4. Commit author + committer identities are GitHub noreply addresses.
#   5. No secret-shaped strings in the diff that gitleaks would catch.
#
# Override (escape hatch — emits a loud warning, do not use casually):
#   PR_THIS_BYPASS=1 git push
#
# Install on a fresh clone:
#   bash scripts/install-hooks.sh

set -euo pipefail

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }

if [ "${PR_THIS_BYPASS:-}" = "1" ]; then
  yellow "⚠ pre-push gate BYPASSED via PR_THIS_BYPASS=1."
  yellow "  This emits a loud warning. Skipping the gate is for true emergencies only."
  yellow "  If this becomes a habit, fix the underlying gauntlet step instead."
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Read pre-push args from stdin: <local-ref> <local-sha> <remote-ref> <remote-sha>
# We only need the local-shas being pushed.
LOCAL_SHAS=()
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "0000000000000000000000000000000000000000" ] && continue
  LOCAL_SHAS+=("$local_sha")
done

if [ ${#LOCAL_SHAS[@]} -eq 0 ]; then
  green "✓ Nothing to push (branch deletion or no commits)."
  exit 0
fi

FAIL=0

# The commits a push actually adds, as a git range. A bare sha means "every
# commit reachable from here", which for scanning purposes is the entire
# history, most of it already on the remote. The reserved-term scan, the
# identity scan, and the gitleaks scan all want only what this push
# introduces, so they share one definition of the base rather than each
# computing (and drifting on) its own. A brand-new branch has no upstream, so
# fall back to origin/dev, then origin/main, then the root commit.
push_range() {
  local sha="$1" base
  base=$(git merge-base "$sha" origin/dev 2>/dev/null ||
    git merge-base "$sha" origin/main 2>/dev/null ||
    git rev-list --max-parents=0 "$sha" | head -1)
  printf '%s..%s' "$base" "$sha"
}

# ---- Check 1: /pr-this marker fresh ----
MARKER="$REPO_ROOT/.git/.pr-this-ran"
HEAD_SHA=$(git rev-parse HEAD)
if [ ! -f "$MARKER" ]; then
  red "✗ /pr-this has NEVER been recorded for this clone."
  red "  Invoke /pr-this via the Skill tool before pushing."
  FAIL=1
elif [ "$(cat "$MARKER")" != "$HEAD_SHA" ]; then
  red "✗ /pr-this marker is stale (recorded $(head -c 8 "$MARKER"), HEAD is $(echo "$HEAD_SHA" | head -c 8))."
  red "  Invoke /pr-this on the current HEAD before pushing."
  FAIL=1
else
  green "✓ /pr-this marker matches HEAD."
fi

# ---- Check 2: pre-publish leak scan ----
if [ -x "$REPO_ROOT/scripts/pre-publish-scan.sh" ]; then
  if bash "$REPO_ROOT/scripts/pre-publish-scan.sh" >/tmp/.pps.out 2>&1; then
    green "✓ pre-publish-scan clean."
  else
    red "✗ pre-publish-scan FAILED:"
    tail -20 /tmp/.pps.out
    FAIL=1
  fi
fi

# ---- Check 3: reserved-term leaks ----
# The reserved-term list is NOT hardcoded here: committing the list would
# publish the very strings it exists to keep out of the public tree. It is
# sourced at runtime from the OW_RESERVED_TERMS environment variable or a
# gitignored .reserved-terms file (see .reserved-terms.example). The
# post-merge identity-scan workflow sources the same list from the
# repository secret, so local and server-side enforcement share one source
# of truth and cannot drift.
#
# Both sources go through the SAME canonicalizer as pre-publish-scan.sh:
# one fragment per line, blank lines and #-comment lines dropped, the rest
# joined into a single alternation. A comment line inside the secret is
# therefore ignored, not compiled into a live regex fragment. A
# single-line "a|b|c" value passes through unchanged.
canon_terms() {
  grep -vE '^[[:space:]]*(#|$)' | paste -sd'|' - | sed -e 's/^|*//' -e 's/|*$//'
}

PRIVATE_PATTERN=""
if [ -n "${OW_RESERVED_TERMS:-}" ]; then
  PRIVATE_PATTERN="$(printf '%s\n' "$OW_RESERVED_TERMS" | canon_terms || true)"
fi
if [ -z "$PRIVATE_PATTERN" ] && [ -f "$REPO_ROOT/.reserved-terms" ]; then
  PRIVATE_PATTERN="$(canon_terms < "$REPO_ROOT/.reserved-terms" || true)"
fi

if [ -z "$PRIVATE_PATTERN" ]; then
  yellow "– Reserved-term scan skipped (no OW_RESERVED_TERMS / .reserved-terms)."
  yellow "  The server-side post-merge identity scan still enforces the list."
else
  # Scan commits being pushed: messages + diff
  for sha in "${LOCAL_SHAS[@]}"; do
    RANGE="$(push_range "$sha")"
    # Commit messages
    if git log --format='%H%n%s%n%b' "$RANGE" 2>/dev/null | grep -nEi "$PRIVATE_PATTERN" >/dev/null; then
      red "✗ Reserved-term leak in commit messages:"
      git log --format='%H%n%s%n%b' "$RANGE" | grep -nEi --color=always "$PRIVATE_PATTERN"
      FAIL=1
    fi
    # Diff content: ADDED lines only. Deletions are how leaks get removed;
    # blocking a push because its diff deletes a reserved term would make
    # cleanups impossible.
    if git diff "$RANGE" 2>/dev/null | grep -E '^\+' | grep -nEi "$PRIVATE_PATTERN" >/dev/null; then
      red "✗ Reserved-term leak in added diff lines:"
      git diff "$RANGE" | grep -E '^\+' | grep -nEi --color=always "$PRIVATE_PATTERN" | head -20
      FAIL=1
    fi
  done
  [ "$FAIL" = "0" ] && green "✓ No reserved terms in commits being pushed."
fi

# ---- Check 4: author + committer identity ----
# Every commit being pushed must use a *@users.noreply.github.com address.
# An ad-hoc `git config user.email` (or no config at all, falling back to
# $USER@$HOSTNAME) is the leak pattern that put a private hostname into
# public history. This catches it before the next push. Co-authored-by
# trailers are covered by the reserved-term scan in Check 3.
ALLOWED_IDENT_RE='@users\.noreply\.github\.com$'
for sha in "${LOCAL_SHAS[@]}"; do
  RANGE="$(push_range "$sha")"
  BAD_IDENT=$(git log "$RANGE" --format='%H %ae %ce' 2>/dev/null \
    | awk -v re="$ALLOWED_IDENT_RE" '$2 !~ re || $3 !~ re { print }')
  if [ -n "$BAD_IDENT" ]; then
    red "✗ Commit author or committer email is not a GitHub noreply:"
    echo "$BAD_IDENT" | head -10
    red "  Fix with: git config user.email '<id>+<handle>@users.noreply.github.com'"
    FAIL=1
  fi
done
[ "$FAIL" = "0" ] && green "✓ Commit identities look clean."

# ---- Check 5: gitleaks on the prepared commits (if installed) ----
# Scans the same range as checks 3 and 4: only what this push adds. Passing a
# bare sha to --log-opts scanned every commit reachable from HEAD, so any
# finding anywhere in history refused every push from every branch, no matter
# what the push contained. Re-reporting a commit already on the remote cannot
# prevent anything: if it is a real leak it is public already and needs
# rotation, not a blocked push. Only the first sha was scanned, too, so a
# multi-branch push checked one branch and waved the rest through.
if command -v gitleaks >/dev/null; then
  CFG=""
  [ -f .gitleaks.toml ] && CFG="--config .gitleaks.toml"
  GITLEAKS_FAIL=0
  for sha in "${LOCAL_SHAS[@]}"; do
    RANGE="$(push_range "$sha")"
    # shellcheck disable=SC2086 # CFG is a deliberate two-word flag or empty.
    if ! gitleaks detect $CFG --no-banner --log-opts="$RANGE" >/tmp/.gl.out 2>&1; then
      red "✗ gitleaks found secrets in $RANGE:"
      tail -10 /tmp/.gl.out
      GITLEAKS_FAIL=1
    fi
  done
  if [ "$GITLEAKS_FAIL" = "0" ]; then
    green "✓ gitleaks clean."
  else
    FAIL=1
  fi
fi

if [ "$FAIL" != "0" ]; then
  red ""
  red "PUSH REFUSED. Fix the issues above, run /pr-this again, then retry."
  red "Emergency override (loud warning): PR_THIS_BYPASS=1 git push"
  exit 1
fi

green ""
green "/pr-this pre-push gate PASSED — pushing."
exit 0
