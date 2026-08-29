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
# We keep both sides. The local-sha is the tip being pushed; the remote-sha is
# what the remote already holds for that ref (all-zeros for a brand-new ref),
# which is the exact base of "what this push adds" for an incremental update.
ZERO_SHA="0000000000000000000000000000000000000000"
# git's canonical empty tree. Diffing a commit against it yields the commit's
# entire content as additions, which lets the reserved-term scan include an
# orphan root commit that a base..sha range would exclude.
EMPTY_TREE="$(git hash-object -t tree /dev/null)"
LOCAL_SHAS=()
REMOTE_SHAS=()
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$ZERO_SHA" ] && continue
  LOCAL_SHAS+=("$local_sha")
  REMOTE_SHAS+=("$remote_sha")
done

if [ ${#LOCAL_SHAS[@]} -eq 0 ]; then
  green "✓ Nothing to push (branch deletion or no commits)."
  exit 0
fi

FAIL=0

# ---- Check 1: /pr-this marker fresh ----
# --absolute-git-dir resolves the per-worktree git dir, where mark-pr-this-ran.sh
# writes the marker. "$REPO_ROOT/.git" would be a plain FILE inside a linked
# worktree, so the marker could never be found and every push from a worktree
# would be refused. Not --git-common-dir: that is shared across worktrees and
# would let one worktree's marker authorise a push from a different branch.
MARKER="$(git rev-parse --absolute-git-dir)/.pr-this-ran"
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

# ---- Shared helper: the base a push is measured against ----
# The base commit a push is measured against, so a scan sees only the commits
# this push adds and not history already on the remote. Prints the base sha, or
# nothing when the pushed tip shares no history with the remote (an orphan or
# the very first commit) -- callers scan from the root in that case instead of
# excluding a base. Every history scan below uses this so they cannot drift on
# what "the base" means.
#
# Preference order:
#   1. The remote ref's current tip (from pre-push stdin), when the remote
#      already has this branch. That is the precise base of an incremental
#      push; using the mainline merge-base instead would re-scan the branch's
#      own earlier commits and could re-trip on a finding already pushed there.
#   2. The merge-base with origin/dev, then origin/main, for a new remote ref.
#   3. Nothing (orphan / initial commit): no shared history to subtract.
push_base() {
  local sha="$1" remote="${2:-$ZERO_SHA}"
  if [ "$remote" != "$ZERO_SHA" ] && git cat-file -e "${remote}^{commit}" 2>/dev/null; then
    printf '%s' "$remote"
    return
  fi
  git merge-base "$sha" origin/dev 2>/dev/null ||
    git merge-base "$sha" origin/main 2>/dev/null ||
    true
}

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
  for i in "${!LOCAL_SHAS[@]}"; do
    sha="${LOCAL_SHAS[$i]}"
    base="$(push_base "$sha" "${REMOTE_SHAS[$i]}")"
    if [ -n "$base" ]; then
      LOG_RANGE="$base..$sha"
      DIFF_ARGS=("$base..$sha")
    else
      # Orphan / initial commit: no shared history, so scan the whole thing,
      # root included. git log takes the bare sha (every reachable commit);
      # git diff needs two endpoints, so diff against the empty tree. A
      # base..sha range would exclude the root and let a reserved term in the
      # very first commit escape.
      LOG_RANGE="$sha"
      DIFF_ARGS=("$EMPTY_TREE" "$sha")
    fi
    # Commit messages. The Claude co-author trailer with the
    # noreply@anthropic.com email is filtered out first: that email is
    # Anthropic's public GitHub integration address and the model name is a
    # public identifier, so the line carries no Orange Way internal string.
    # GitHub injects it on squash/rebase merges, so it cannot be prevented at
    # commit time. This mirrors the server post-merge identity scan so the two
    # cannot drift. Only this exact trailer line is dropped.
    COAUTHOR_EXEMPT='^[[:space:]]*Co-authored-by:[[:space:]]*Claude[[:space:]]+[A-Za-z]+[[:space:]]+[0-9.]+[[:space:]]*<noreply@anthropic\.com>[[:space:]]*$'
    if git log --format='%H%n%s%n%b' "$LOG_RANGE" 2>/dev/null | grep -viE "$COAUTHOR_EXEMPT" | grep -nEi "$PRIVATE_PATTERN" >/dev/null; then
      red "✗ Reserved-term leak in commit messages:"
      git log --format='%H%n%s%n%b' "$LOG_RANGE" | grep -viE "$COAUTHOR_EXEMPT" | grep -nEi --color=always "$PRIVATE_PATTERN"
      FAIL=1
    fi
    # Diff content: ADDED lines only. Deletions are how leaks get removed;
    # blocking a push because its diff deletes a reserved term would make
    # cleanups impossible.
    if git diff "${DIFF_ARGS[@]}" 2>/dev/null | grep -E '^\+' | grep -nEi "$PRIVATE_PATTERN" >/dev/null; then
      red "✗ Reserved-term leak in added diff lines:"
      git diff "${DIFF_ARGS[@]}" | grep -E '^\+' | grep -nEi --color=always "$PRIVATE_PATTERN" | head -20
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
for i in "${!LOCAL_SHAS[@]}"; do
  sha="${LOCAL_SHAS[$i]}"
  base="$(push_base "$sha" "${REMOTE_SHAS[$i]}")"
  # With a base, walk base..sha. Orphan / initial commit has no base: walk the
  # bare sha, which for git log is every reachable commit, root included. A
  # base..sha range would exclude the root and let a non-noreply identity in
  # the very first commit escape.
  if [ -n "$base" ]; then IDENT_RANGE="$base..$sha"; else IDENT_RANGE="$sha"; fi
  BAD_IDENT=$(git log "$IDENT_RANGE" --format='%H %ae %ce' 2>/dev/null \
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
  for i in "${!LOCAL_SHAS[@]}"; do
    sha="${LOCAL_SHAS[$i]}"
    base="$(push_base "$sha" "${REMOTE_SHAS[$i]}")"
    # With a base, scan base..sha. Orphan / initial commit has no base: scan
    # the bare sha, which for --log-opts means every commit reachable from it
    # (root included). That is exactly this push's new commits when nothing is
    # shared with the remote, and it keeps the root from slipping through the
    # way base..sha would by excluding it.
    if [ -n "$base" ]; then LOGOPTS="$base..$sha"; else LOGOPTS="$sha"; fi
    # shellcheck disable=SC2086 # CFG is a deliberate two-word flag or empty.
    if ! gitleaks detect $CFG --no-banner --log-opts="$LOGOPTS" >/tmp/.gl.out 2>&1; then
      red "✗ gitleaks found secrets in $LOGOPTS:"
      tail -10 /tmp/.gl.out
      GITLEAKS_FAIL=1
    fi
  done
  if [ "$GITLEAKS_FAIL" = "0" ]; then
    green "✓ gitleaks clean."
  else
    FAIL=1
  fi
else
  # An absent scanner is not a clean scan. This branch did not exist: with
  # gitleaks off PATH nothing ran, nothing printed, FAIL was untouched, and
  # the gate went on to print PASSED, which reads as "a secret scan covered
  # these commits". Announce the gap every time instead.
  #
  # This warns rather than refusing, unlike the checks above, and the
  # difference is deliberate: the term list and the canonicalizer are
  # repository state, so their absence means a broken tree, while gitleaks
  # is an optional external binary a fresh clone will not have. Whether
  # this should also refuse is one decision for both twins, and it is being
  # settled on evidence rather than guessed.
  yellow "- gitleaks is not installed: NO secret scan ran on the commits being pushed."
  yellow "  The checks above look for reserved terms and commit identities. None of"
  yellow "  them looks for secret-shaped strings such as API keys, tokens or private keys."
  yellow "  Install gitleaks and push again for that cover: https://github.com/gitleaks/gitleaks"
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
