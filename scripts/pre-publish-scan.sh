#!/usr/bin/env bash
# pre-publish-scan.sh — leak check for the open-source Orange Way Books repo.
#
# Runs a categorized grep over the source tree looking for content that
# should never ship to a public repo: legacy brand names, internal
# codenames, personal names, infrastructure hostnames, internal wiki
# URLs, milestone tags from prior internal audits, dead PR refs, and
# personally identifiable email addresses.
#
# Exit code:
#   0  — tree is clean, safe to publish or merge
#   1  — one or more categories reported a leak; review output, clean up,
#        re-run
#
# Run locally before pushing:   bash scripts/pre-publish-scan.sh
# Runs in CI as a required check (see .github/workflows/leak-check.yml).
#
# Updating the allowlist: if you introduce a brand or product reference
# that is intentional and acceptable (for example a new sibling project),
# add it to the ACCEPTABLE_PROJECTS list below AND to the leak-check
# workflow in lock-step. PRs that change this script require a second
# reviewer.

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
# When the per-category scan finds matches, results are filtered against
# these patterns so the matches are dropped without raising the exit code.

EXEMPT_GENERIC=(
  # This script and the PR template document the forbidden patterns
  # as examples; they intentionally contain the strings they scan for.
  "scripts/pre-publish-scan.sh"
  ".github/PULL_REQUEST_TEMPLATE.md"
  ".github/workflows/leak-check.yml"
  ".github/workflows/post-merge-identity-scan.yml"
  "docs/CONTRIBUTING.md"
  # Pre-push gate scripts: the gate's private-host regex enumerates
  # exactly the strings the scanner is looking for; install-hooks.sh
  # references the gate by path.
  "scripts/pre-push-gate.sh"
  "scripts/install-hooks.sh"
)

EXEMPT_BITBOOKS_LITERAL=()
EXEMPT_OSK_ENUM=()

EXIT_CODE=0

# ----------------------------------------------------------------------
# scan: run one categorized grep + exemption filter
# ----------------------------------------------------------------------
#
# Args:
#   $1  human-readable category name (printed in output)
#   $2  grep pattern (extended regex)
#   $3  grep flags (e.g. -i for case-insensitive). Empty string for none.
#   $4  extra-exemption pattern (extended regex). Empty string for none.

scan() {
  local name="$1"
  local pattern="$2"
  local flags="$3"
  local extra_exempt="$4"

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

  # Always-drop exemptions
  local drop_patterns=""
  for e in "${EXEMPT_GENERIC[@]}"; do
    drop_patterns+="${drop_patterns:+|}$(printf '%s' "$e" | sed 's/[.[\]*]/\\&/g')"
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
  printf '%s\n' "$filtered" | sed 's/^/      /' | head -30
  if [[ "$count" -gt 30 ]]; then
    printf "      ... %d more\n" "$((count - 30))"
  fi
  EXIT_CODE=1
}

# ----------------------------------------------------------------------
# Build per-category exemption regexes
# ----------------------------------------------------------------------

join_pipe() {
  local IFS="|"
  printf '%s' "$*"
}

EXEMPT_BB_RE="$(join_pipe "${EXEMPT_BITBOOKS_LITERAL[@]}")"
EXEMPT_OSK_RE="$(join_pipe "${EXEMPT_OSK_ENUM[@]}")"

# ----------------------------------------------------------------------
# Header
# ----------------------------------------------------------------------

printf "\n\033[1m▎ Pre-publish leak scan\033[0m\n"
printf "  repo: %s\n\n" "$REPO_ROOT"

# ----------------------------------------------------------------------
# Category 1 — Legacy brand / private codebase references
# ----------------------------------------------------------------------

printf "\033[1m1. Brand + product references\033[0m\n"

scan "BitBooks brand (all variants)" \
     "\\b(BitBooks|Bitbooks)\\b|\\bbitbooks\\b" \
     "" \
     "$EXEMPT_BB_RE"

scan "Cala / Galoy ledger brand" \
     "\\b(Cala|Galoy|GaloyMoney)\\b" \
     "" \
     ""

scan "Lovable builder platform" \
     "\\bLovable\\b|lovable\\.app" \
     "" \
     "lovable-tagger"

scan "Standalone V2/V3 product references" \
     "V[23] BitBooks|V3 Vault|BitBooks Vault|BitBooks family|BitBooks Personal|BitBooksSupport" \
     "" \
     ""

scan "Internal codename: MB / OWM as acronym" \
     "\\(MB\\)|MB —| in MB\\b|MB's|\\bOWM\\b" \
     "" \
     ""

scan "Other personal-project brands" \
     "\\b(TESSA|COLE|ADUB|ADDLY)\\b|Petit Chou|petitchou" \
     "" \
     ""

# ----------------------------------------------------------------------
# Category 2 — Personal names + PII
# ----------------------------------------------------------------------

printf "\n\033[1m2. Personal names + PII\033[0m\n"

# Allow "Tim May", "Hal Finney" etc. (cypherpunk figures) in README lineage.
# The pattern below targets the bare given names; the README citations
# include surnames so they don't match. "tsaekoo" / "Abuelo" remain because
# they're nicknames, not historical figures.
scan "Personal first names" \
     "\\b(Miguel|Daenon|Roark|Brandon|Ashar|tsaekoo|Abuelo)\\b" \
     "" \
     ""

scan "External contact names" \
     "Charles Taylor|Ruben Izmailyan" \
     "" \
     ""

scan "Personal-domain emails" \
     "@(bitbooks\\.com|abascal\\.ca|thrivefaster\\.ca|tryfaster\\.ca)" \
     "" \
     ""

# ----------------------------------------------------------------------
# Category 3 — Internal infrastructure leaks
# ----------------------------------------------------------------------

printf "\n\033[1m3. Internal infrastructure\033[0m\n"

scan "Internal hostnames" \
     "\\b(jarvis-hosted|bb-support|Jarvis-hosted)\\b|kiwi@jarvis|ubuntu@100\\." \
     "" \
     ""

scan "Internal wiki URLs" \
     "wiki\\.(abascal\\.ca|bitbooks\\.com)" \
     "" \
     ""

scan "Windows-style internal paths" \
     "C:\\\\CLAUDE|C:\\\\Users\\\\micro" \
     "" \
     ""

scan "Home-path leaks" \
     "/home/(kiwi|cactus|claude)/" \
     "" \
     ""

scan "Tailscale 100.x IP leaks" \
     "\\b100\\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\\.[0-9]+\\.[0-9]+\\b" \
     "" \
     ""

# ----------------------------------------------------------------------
# Category 4 — Internal milestone tags + dead PR references
# ----------------------------------------------------------------------

printf "\n\033[1m4. Internal milestone tags + dead PR refs\033[0m\n"

# D-number milestone tags. Match the specific milestone form
# ("D12:" / "D12)" / "(D12)" / "D12 —" / "D12 .") to avoid false-positives
# on UUID fragments and generic identifiers.
scan "D-number milestone tags" \
     "\\bD[0-9]{1,3}[:)] |\\(D[0-9]{1,3}\\)|\\bD[0-9]{1,3} —" \
     "" \
     ""

scan "SEC-N audit tags" \
     "\\bSEC-[0-9]+\\b|#SEC-[0-9]+" \
     "" \
     ""

scan "CQ-N code-quality tags" \
     "\\bCQ-[0-9]+\\b|#CQ-[0-9]+" \
     "" \
     ""

scan "DB-N database-audit tags" \
     "\\bDB-[0-9]+\\b|#DB-[0-9]+" \
     "" \
     ""

scan "PERF-N performance-audit tags" \
     "\\bPERF-[0-9]+\\b|#PERF-[0-9]+" \
     "" \
     ""

scan "Dead PR references" \
     "PR #[0-9]+|V[23] PR\\b|OR PR #" \
     "" \
     ""

# ----------------------------------------------------------------------
# Category 5 — GitHub handle pinning
# ----------------------------------------------------------------------
#
# After the move from MorningRevolution → OrangeWay org, no source file
# should reference the old handle. Any reintroduction is flagged.

printf "\n\033[1m5. GitHub handle pinning\033[0m\n"

scan "Old GitHub handle MorningRevolution/orangewaybooks" \
     "MorningRevolution/orangewaybooks|MorningRevolution/orange-way-books" \
     "" \
     ""

# Intermediate handle that briefly existed during planning (OrangeWay org
# was not available on GitHub; the actual org was created as
# The-Orange-Way). Catch any file that still carries the planning handle.
scan "Planning handle OrangeWay/ (use The-Orange-Way/ instead)" \
     "github\\.com/OrangeWay/|^OrangeWay/Orange-Way-" \
     "" \
     ""

# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------

printf "\n"
if [[ "$EXIT_CODE" -eq 0 ]]; then
  printf "\033[32m▎ Tree is clean. Safe to publish or merge.\033[0m\n\n"
else
  printf "\033[31m▎ Leaks found. Clean up the items above before publishing.\033[0m\n"
  printf "  See \033[1mdocs/CONTRIBUTING.md\033[0m for the rules and exemption process.\n\n"
fi

exit "$EXIT_CODE"
