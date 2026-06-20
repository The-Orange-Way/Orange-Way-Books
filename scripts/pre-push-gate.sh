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
#   3. No private-host / private-wiki URL leaks in the commits being pushed
#      (commit messages + diff).
#   4. No secret-shaped strings in the diff that gitleaks would catch.
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

# ---- Check 3: private-host / private-wiki URL leaks ----
PRIVATE_PATTERN='wiki\.abascal|wiki\.bitbooks|bb-support|tail[a-z0-9]+\.ts\.net|100\.(91|94)\.[0-9]+\.[0-9]+|jarvis\.local|@bitbooks\.com|@abascal\.ca'

# Scan commits being pushed: messages + diff
for sha in "${LOCAL_SHAS[@]}"; do
  # If pushing a brand-new branch, walk back to origin/dev (or origin/main) for the diff base.
  BASE=$(git merge-base "$sha" origin/dev 2>/dev/null || git merge-base "$sha" origin/main 2>/dev/null || git rev-list --max-parents=0 "$sha" | head -1)
  RANGE="$BASE..$sha"
  # Commit messages
  if git log --format='%H%n%s%n%b' "$RANGE" 2>/dev/null | grep -nEi "$PRIVATE_PATTERN" >/dev/null; then
    red "✗ Private-host URL leak in commit messages:"
    git log --format='%H%n%s%n%b' "$RANGE" | grep -nEi --color=always "$PRIVATE_PATTERN"
    FAIL=1
  fi
  # Diff content — exclude the gate itself (whose regex literally contains the patterns)
  if git diff "$RANGE" -- ':!scripts/pre-push-gate.sh' ':!scripts/install-hooks.sh' 2>/dev/null | grep -nEi "$PRIVATE_PATTERN" >/dev/null; then
    red "✗ Private-host URL leak in diff content:"
    git diff "$RANGE" -- ':!scripts/pre-push-gate.sh' ':!scripts/install-hooks.sh' | grep -nEi --color=always "$PRIVATE_PATTERN" | head -20
    FAIL=1
  fi
done
[ "$FAIL" = "0" ] && green "✓ No private-host URLs in commits being pushed."

# ---- Check 4: author + committer identity ----
# Every commit being pushed must use a *@users.noreply.github.com address.
# An ad-hoc `git config user.email` (or no config at all, falling back to
# $USER@$HOSTNAME) is the leak pattern that put a tailnet hostname into
# public history. This catches it before the next push.
ALLOWED_IDENT_RE='@users\.noreply\.github\.com$'
for sha in "${LOCAL_SHAS[@]}"; do
  BASE=$(git merge-base "$sha" origin/dev 2>/dev/null || git merge-base "$sha" origin/main 2>/dev/null || git rev-list --max-parents=0 "$sha" | head -1)
  RANGE="$BASE..$sha"
  BAD_IDENT=$(git log "$RANGE" --format='%H %ae %ce' 2>/dev/null \
    | awk -v re="$ALLOWED_IDENT_RE" '$2 !~ re || $3 !~ re { print }')
  if [ -n "$BAD_IDENT" ]; then
    red "✗ Commit author or committer email is not a GitHub noreply:"
    echo "$BAD_IDENT" | head -10
    red "  Fix with: git config user.email '<id>+<handle>@users.noreply.github.com'"
    red "  Then rewrite history (filter-branch / filter-repo) and force-push."
    FAIL=1
  fi
  # Also forbid Co-authored-by trailers naming private hosts / corporate domains.
  TRAILER_LEAKS=$(git log --format='%B' "$RANGE" 2>/dev/null \
    | grep -iE '^Co-authored-by:.*@(pop-os|tail[a-z0-9]+\.ts\.net|bitbooks\.com|abascal\.ca|thrivefaster\.ca|cursor\.com|lovable\.dev|gpt-engineer-app)' || true)
  if [ -n "$TRAILER_LEAKS" ]; then
    red "✗ Co-authored-by trailer leaks a private host / corporate domain:"
    echo "$TRAILER_LEAKS" | head -10
    FAIL=1
  fi
done
[ "$FAIL" = "0" ] && green "✓ Commit identities look clean."

# ---- Check 5: gitleaks on the prepared commits (if installed) ----
if command -v gitleaks >/dev/null; then
  CFG=""
  [ -f .gitleaks.toml ] && CFG="--config .gitleaks.toml"
  if gitleaks detect $CFG --no-banner --log-opts="${LOCAL_SHAS[0]}" >/tmp/.gl.out 2>&1; then
    green "✓ gitleaks clean."
  else
    red "✗ gitleaks found secrets:"
    tail -10 /tmp/.gl.out
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
