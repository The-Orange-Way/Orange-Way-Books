#!/usr/bin/env bash
# pre-publish-scan.sh — leak check for the open-source Orange Way Books repo.
#
# Runs a categorized grep over the source tree looking for content that
# should never ship to a public repo: internal-only naming (earlier
# codenames, non-public hostnames, personal names, private contact
# strings), internal milestone tags, and dead PR refs.
#
# Exit code:
#   0  — tree is clean, safe to publish or merge
#   1  — one or more categories reported a leak; review output, clean up,
#        re-run
#
# Run locally before pushing:   bash scripts/pre-publish-scan.sh
# Runs in CI as a required check (see .github/workflows/leak-check.yml).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ----------------------------------------------------------------------
# Path scope
# ----------------------------------------------------------------------

EXCLUDE_DIRS=(
  --exclude-dir=node_modules
  --exclude-dir=dist
  --exclude-dir=build
  --exclude-dir=coverage
  --exclude-dir=.git
  --exclude-dir=test-results
  --exclude-dir=playwright-report
  --exclude-dir=.husky
)

# Lock files + binary assets: skip wholesale.
EXCLUDE_FILES=(
  # The gitignored reserved-term list itself (never committed, but grep -r
  # would still read it from the working tree and flag its own contents).
  --exclude=.reserved-terms
  --exclude=bun.lock
  --exclude=package-lock.json
  --exclude=yarn.lock
  --exclude="*.png"
  --exclude="*.jpg"
  --exclude="*.jpeg"
  --exclude="*.webp"
  --exclude="*.gif"
  --exclude="*.ico"
  --exclude="*.woff"
  --exclude="*.woff2"
  --exclude="*.ttf"
  --exclude="*.eot"
  --exclude="*.xlsx"
)

# ----------------------------------------------------------------------
# Load-bearing exemptions
# ----------------------------------------------------------------------
#
# These files legitimately contain otherwise-forbidden tokens because the
# strings are part of an at-rest data format (vault verifier plaintext,
# Argon2id salt context, localStorage key namespace).
#
# NOTE: the scanner scripts are NO LONGER exempted from the reserved-term
# category. They used to be, because they carried the reserved list
# inline — which meant the one file most likely to leak the list was the
# one file the scanner would never look at. The list now lives out of
# tree, so the scripts are scanned like any other file and a
# reintroduced literal is caught.
#
# Entries are repo-relative paths. They are anchored to the path column
# at filter time (see scan() below), so an entry exempts the file it
# names and nothing else.

EXEMPT_GENERIC=(
  ".github/PULL_REQUEST_TEMPLATE.md"
  "CONTRIBUTING.md"
)

# This file is the one unavoidable special case. It enumerates the
# structural patterns inline, so a tree-wide grep for a structural pattern
# always matches the line that defines it: the definition IS the match.
# Those are definitions, not leaks, and without an exemption the check can
# never report green on its own source.
#
# So this file is exempted from the STRUCTURAL categories ONLY. It stays
# fully in scope for the reserved-term category above, which is the whole
# point of sourcing that list out of tree: an internal literal
# reintroduced into this file must still be caught. Pass this as the
# extra-exemption argument to structural scans, never to the reserved-term
# scan.
SELF_SOURCE_EXEMPT='^\./scripts/pre-publish-scan\.sh:'

EXIT_CODE=0

# ----------------------------------------------------------------------
# Output redaction
# ----------------------------------------------------------------------
#
# GitHub Actions logs on a PUBLIC repo are public. A finding in the
# reserved-term category is, by definition, a line containing an
# internal-only string: printing that line to a CI log would publish the
# very string the scanner exists to keep out of the tree, and would do it
# in a searchable place. So in CI we print file:line only and suppress the
# matched text. Local runs (CI unset) print full context, because the
# person running it already has the list.
#
# GitHub sets CI=true on every runner.
REDACT_MATCHES="${CI:+1}"

# ----------------------------------------------------------------------
# Reserved-term list (sourced OUT of this committed file)
# ----------------------------------------------------------------------
#
# The public tree must not carry internal-only naming: earlier project or
# experiment codenames, non-public hostnames, personal names, or private
# contact strings. The list of such reserved terms is NOT hardcoded here,
# because committing the list would publish the very strings it exists to
# keep out of the public tree. It is provided at runtime, from either
# source, in this order:
#
#   1. The OW_RESERVED_TERMS environment variable (CI sources this from a
#      repository secret: see the leak-check and post-merge identity-scan
#      workflows).
#   2. A gitignored .reserved-terms file. See .reserved-terms.example.
#
# BOTH sources accept the same format and go through the SAME shared
# canonicalizer, scripts/canon-terms.sh: one regex fragment per line,
# blank lines and #-comment lines ignored, remaining lines joined into a
# single regex alternation. A single-line "a|b|c" value passes through
# unchanged.
#
# If neither is configured the reserved-term scan is SKIPPED with a notice
# (the structural checks below still run). Outside contributors therefore
# get a working scanner with zero exposure to the internal list. Note that
# CI does NOT rely on that skip path: the leak-check and identity-scan
# workflows hard-fail when the secret is missing, so a missing list can
# never read as a green scan on a protected branch.

# The canonicalizer is NOT defined here. This scan, the pre-push gate, the
# post-merge identity-scan workflow and the leak-check workflow all source
# ONE implementation, so they cannot drift the way they had. See
# scripts/canon-terms.sh for what each step of the pipeline is holding up.
#
# Fail closed when the library is absent. Without this check the script
# would carry on with canon_terms undefined, RESERVED_TERMS would resolve
# empty, category 1 would print itself as skipped, and the whole run would
# still exit 0. An unrunnable scanner is a broken guard, not a clean tree.
CANON_TERMS_LIB="$REPO_ROOT/scripts/canon-terms.sh"
if [[ ! -f "$CANON_TERMS_LIB" ]]; then
  printf "\n\033[31m▎ scripts/canon-terms.sh is missing; the reserved-term scan cannot run.\033[0m\n\n" >&2
  exit 1
fi
# shellcheck source=scripts/canon-terms.sh
. "$CANON_TERMS_LIB"

# Present is not the same as usable. The file can exist and fail to source,
# which is what a syntax error introduced by a later edit looks like, and
# this script has no set -e: canon_terms would simply be undefined, the
# list would resolve empty, category 1 would print itself as skipped and
# the run would still exit 0. In CI the canonicalizer self test runs as an
# earlier step and would catch that first, so the property would be held by
# step ORDER rather than by this script. Ask for the function itself.
if ! declare -f canon_terms >/dev/null 2>&1; then
  printf "\n\033[31m▎ scripts/canon-terms.sh was sourced but defines no canon_terms; the reserved-term scan cannot run.\033[0m\n\n" >&2
  exit 1
fi

RESERVED_TERMS=""
if [[ -n "${OW_RESERVED_TERMS:-}" ]]; then
  RESERVED_TERMS="$(printf '%s\n' "$OW_RESERVED_TERMS" | canon_terms)"
fi
if [[ -z "$RESERVED_TERMS" && -f .reserved-terms ]]; then
  RESERVED_TERMS="$(canon_terms < .reserved-terms)"
fi

# A list that does not compile is not a clean tree. The list is one regex
# fragment per line, so an unbalanced parenthesis or bracket is a realistic
# typo; grep exits 2 on a pattern it refuses, scan() below discards that
# status with "|| true", and the category prints a green tick having
# matched nothing. Refuse the run here, while we still know why.
if [[ -n "$RESERVED_TERMS" ]] && ! canon_terms_usable "$RESERVED_TERMS"; then
  printf "\n\033[31m▎ The reserved-term list does not compile as a regular expression, so the scan would check for nothing.\033[0m\n" >&2
  printf "  Fix the offending fragment in OW_RESERVED_TERMS or .reserved-terms (one regex fragment per line).\n" >&2
  printf "  No part of the list is printed here.\n\n" >&2
  exit 1
fi

# ----------------------------------------------------------------------
# scan: run one categorized grep + exemption filter
# ----------------------------------------------------------------------
#
# Args:
#   $1  human-readable category name (printed in output)
#   $2  grep pattern (extended regex)
#   $3  grep flags (e.g. -i for case-insensitive). Empty string for none.
#   $4  extra-exemption pattern (extended regex). Empty string for none.
#   $5  "1" to redact matched text (print file:line only). Empty for none.
#       Set for any category whose pattern comes from the internal list.

scan() {
  local name="$1"
  local pattern="$2"
  local flags="$3"
  local extra_exempt="$4"
  local redact="${5:-}"

  local raw
  if [[ -n "$flags" ]]; then
    raw=$(grep -rnE $flags "$pattern" . \
            "${EXCLUDE_DIRS[@]}" "${EXCLUDE_FILES[@]}" 2>/dev/null || true)
  else
    raw=$(grep -rnE "$pattern" . \
            "${EXCLUDE_DIRS[@]}" "${EXCLUDE_FILES[@]}" 2>/dev/null || true)
  fi

  if [[ -z "$raw" ]]; then
    printf "  \033[32m✓\033[0m  %s\n" "$name"
    return 0
  fi

  # Always-drop exemptions.
  #
  # Each entry is anchored to the PATH COLUMN of the grep -rnE output,
  # whose lines are "./path:LINE:text". An unanchored bare filename
  # matches anywhere on the line, including inside the matched text of an
  # unrelated file, which silently drops a real finding. Anchor as
  # ^\./<path>: so an entry exempts only the file it names. This is the
  # same shape as SELF_SOURCE_EXEMPT.
  local drop_patterns=""
  local e esc
  for e in "${EXEMPT_GENERIC[@]}"; do
    esc=$(printf '%s' "$e" | sed 's/[.[\]*]/\\&/g')
    drop_patterns+="${drop_patterns:+|}^\\./${esc}:"
  done
  if [[ -n "$extra_exempt" ]]; then
    drop_patterns+="${drop_patterns:+|}$extra_exempt"
  fi

  local filtered
  if [[ -n "$drop_patterns" ]]; then
    filtered=$(printf '%s\n' "$raw" | grep -Ev "$drop_patterns" || true)
  else
    filtered="$raw"
  fi

  if [[ -z "$filtered" ]]; then
    printf "  \033[32m✓\033[0m  %s\n" "$name"
    return 0
  fi

  local count
  count=$(printf '%s\n' "$filtered" | wc -l)
  printf "  \033[31m✗\033[0m  %s (%d findings)\n" "$name" "$count"

  if [[ -n "$redact" ]]; then
    # file:line only. The matched text is an internal string by definition;
    # never print it to a log that may be public.
    printf '%s\n' "$filtered" | cut -d: -f1,2 | sed 's/^/      /' | head -30
    printf "      (matched text redacted; re-run this scan locally to see it)\n"
  else
    printf '%s\n' "$filtered" | sed 's/^/      /' | head -30
  fi

  if [[ "$count" -gt 30 ]]; then
    printf "      ... %d more\n" "$((count - 30))"
  fi
  EXIT_CODE=1
}

# ----------------------------------------------------------------------
# Header
# ----------------------------------------------------------------------

printf "\n\033[1m▎ Pre-publish leak scan\033[0m\n"
printf "  repo: %s\n\n" "$REPO_ROOT"

# ----------------------------------------------------------------------
# Category 1: Reserved terms (internal list, sourced at runtime)
# ----------------------------------------------------------------------
#
# No extra exemption here, deliberately: every file in scope is checked,
# including this one.

printf "\033[1m1. Reserved terms\033[0m\n"

if [[ -n "$RESERVED_TERMS" ]]; then
  scan "Reserved terms (internal list)" \
       "$RESERVED_TERMS" \
       "" \
       "" \
       "$REDACT_MATCHES"
else
  printf "  \033[33m–\033[0m  Reserved-term scan skipped (set OW_RESERVED_TERMS or add .reserved-terms)\n"
fi

# ----------------------------------------------------------------------
# Category 2: Public-safe structural checks
# ----------------------------------------------------------------------
#
# These patterns are hardcoded and contain no internal-only strings, so
# their findings are safe to print in full, in CI or locally. They are
# also the categories this file matches against itself, so each one takes
# SELF_SOURCE_EXEMPT.

printf "\n\033[1m2. Structural naming checks\033[0m\n"

scan "Internal codename: MB / OWM as acronym" \
     "\\(MB\\)|MB —| in MB\\b|MB's|\\bOWM\\b" \
     "" \
     "$SELF_SOURCE_EXEMPT" \
     ""

# ----------------------------------------------------------------------
# Category 3: Internal milestone tags + dead PR refs
# ----------------------------------------------------------------------

printf "\n\033[1m3. Internal milestone tags + dead PR refs\033[0m\n"

# D-number milestone tags. Match the specific milestone form
# ("D12:" / "D12)" / "(D12)" / "D12 —" / "D12 .") to avoid false-positives
# on UUID fragments and generic identifiers.
scan "D-number milestone tags" \
     "\\bD[0-9]{1,3}[:)] |\\(D[0-9]{1,3}\\)|\\bD[0-9]{1,3} —" \
     "" \
     "$SELF_SOURCE_EXEMPT" \
     ""

scan "SEC-N audit tags" \
     "\\bSEC-[0-9]+\\b|#SEC-[0-9]+" \
     "" \
     "$SELF_SOURCE_EXEMPT" \
     ""

scan "CQ-N code-quality tags" \
     "\\bCQ-[0-9]+\\b|#CQ-[0-9]+" \
     "" \
     "$SELF_SOURCE_EXEMPT" \
     ""

scan "DB-N database-audit tags" \
     "\\bDB-[0-9]+\\b|#DB-[0-9]+" \
     "" \
     "$SELF_SOURCE_EXEMPT" \
     ""

scan "PERF-N performance-audit tags" \
     "\\bPERF-[0-9]+\\b|#PERF-[0-9]+" \
     "" \
     "$SELF_SOURCE_EXEMPT" \
     ""

scan "Dead PR references" \
     "PR #[0-9]+|V[23] PR\\b|OR PR #" \
     "" \
     "$SELF_SOURCE_EXEMPT" \
     ""

# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------

printf "\n"
if [[ "$EXIT_CODE" -eq 0 ]]; then
  printf "\033[32m▎ Tree is clean. Safe to publish or merge.\033[0m\n\n"
else
  printf "\033[31m▎ Leaks found. Clean up the items above before publishing.\033[0m\n"
  printf "  See \033[1mCONTRIBUTING.md\033[0m for the rules and exemption process.\n\n"
fi

exit "$EXIT_CODE"
