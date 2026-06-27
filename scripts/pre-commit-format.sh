#!/usr/bin/env bash
#
# pre-commit-format.sh, auto-format staged files with prettier so commits
# always land prettier-clean, and block em-dashes from entering staged
# diffs at commit time (the pre-push gate also checks; this is the
# earlier and faster signal so contributors don't lose time on a push
# that the gate would refuse).
#
# How it works:
#   - Lists files staged for commit (`git diff --cached --name-only --diff-filter=ACMR`)
#   - Filters to extensions prettier knows about
#   - Runs `prettier --write` on those (and only those) files
#   - Re-stages the modified files so the formatting is part of the commit
#
# Idempotent and fast: only touches staged files, never the whole tree.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Collect staged files matching prettier-relevant extensions.
mapfile -t STAGED < <(
  git diff --cached --name-only --diff-filter=ACMR \
    | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yml|yaml|css|html)$' \
    || true
)

if [ ${#STAGED[@]} -eq 0 ]; then
  exit 0
fi

# Honor .prettierignore: prettier does this on its own, but only for files
# it's asked about. Passing the list explicitly is fine, ignored files
# get a no-op.
bunx prettier --write --log-level warn "${STAGED[@]}"

# Detect which files prettier actually modified so we can tell the
# contributor (and so we only re-stage what changed — a quiet `git add`
# of an untouched file is a no-op but the log makes the surprise visible).
CHANGED=()
for f in "${STAGED[@]}"; do
  if ! git diff --quiet -- "$f" 2>/dev/null; then
    CHANGED+=("$f")
  fi
done

if [ ${#CHANGED[@]} -gt 0 ]; then
  echo "prettier reformatted ${#CHANGED[@]} staged file(s); re-staging:"
  printf '  %s\n' "${CHANGED[@]}"
  git add "${CHANGED[@]}"
fi

# Em-dash gate. Scans the staged diff (additions only) for U+2014.
# Skip files that DEFINE the em-dash rule itself; they have to contain
# the character to document it. Update this allow-list (here and in
# scripts/pre-push-gate.sh) if a new house-style doc lands.
EM_DASH_HITS=$(
  git diff --cached -U0 \
    -- ':(exclude)scripts/pre-publish-scan.sh' \
    ':(exclude)scripts/pre-commit-format.sh' \
    ':(exclude)scripts/pre-push-gate.sh' \
    ':(exclude)CONTRIBUTING.md' \
    | grep -E '^\+' \
    | grep -nE '—|&mdash;' \
    || true
)
if [ -n "$EM_DASH_HITS" ]; then
  echo ""
  echo "::error::Em-dashes (U+2014) found in staged diff. House style"
  echo "uses commas, parens, or colons instead. The pre-push gate would"
  echo "also block this; catching here saves you a push round-trip."
  echo ""
  echo "$EM_DASH_HITS" | head -20
  echo ""
  echo "Replace each em-dash, re-stage, commit again."
  exit 1
fi
