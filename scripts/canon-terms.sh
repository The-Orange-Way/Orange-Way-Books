#!/usr/bin/env bash
# canon-terms.sh: the ONE canonicalizer for the reserved-term list.
#
# The reserved-term list is not committed. It arrives at runtime as an
# environment value or a gitignored file, and every consumer has to turn it
# into a single regex alternation before it can be used. That conversion
# lives here, once, and every consumer sources this file:
#
#   scripts/pre-publish-scan.sh
#   scripts/pre-push-gate.sh
#   .github/workflows/post-merge-identity-scan.yml
#   .github/workflows/leak-check.yml
#
# Why one copy and not four. Every way this conversion can go wrong fails in
# the same direction: the pattern still compiles, it just matches nothing,
# and a scan that matches nothing is indistinguishable from a clean tree.
# The consumers each print a term count, which reads as proof in both cases.
# So a divergence here is invisible from the outside, and the only defence
# is that there is nothing to diverge from.
#
# Usage:
#   . "<repo root>/scripts/canon-terms.sh"
#   PATTERN="$(printf '%s\n' "$OW_RESERVED_TERMS" | canon_terms)"
#   PATTERN="$(canon_terms < .reserved-terms)"
#
# Each step is load bearing:
#
#   tr -d '\r'
#       Deletes carriage returns. A value saved with Windows line endings
#       leaves a trailing CR on every fragment, so each branch of the
#       alternation looks for "term<CR>", finds it nowhere in the tree, and
#       the scan reports clean against a list that is fully populated.
#
#   grep -vE '^[[:space:]]*(#|$)'
#       Drops comment lines and blank lines. A comment compiled into the
#       regex becomes a live fragment that matches its own literal text. A
#       blank line becomes an empty alternation branch, which matches EVERY
#       line of every file and turns the scan into a refusal of everything.
#
#   paste -sd'|' -
#       Joins what survives into one alternation.
#
#   sed -e 's/^|*//' -e 's/|*$//'
#       Trims leading and trailing separators. They are empty branches with
#       the same match-everything effect as a blank line.
#
# The output is EMPTY when the input holds no usable terms. Callers must
# treat empty as "not configured" and say so loudly. Empty is never clean.
#
# scripts/test-canon-terms.sh proves this still matches real text, and
# carries a negative control proving the test can fail.

canon_terms() {
  tr -d '\r' \
    | grep -vE '^[[:space:]]*(#|$)' \
    | paste -sd'|' - \
    | sed -e 's/^|*//' -e 's/|*$//'
}
