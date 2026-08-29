#!/usr/bin/env bash
# test-canon-terms.sh: proves scripts/canon-terms.sh actually canonicalizes,
# and proves this test is able to report a failure.
#
# Run locally:  bash scripts/test-canon-terms.sh
# Runs in CI as a step of .github/workflows/leak-check.yml.
#
# Why the emphasis on being able to fail. Every defect this gate has had was
# an absence that read as green: a term list that resolved to nothing, an
# exemption that swallowed a whole file, a pattern that compiled and matched
# nowhere. A shape-only test would pass against all three. So the two cases
# at the end assert behaviour, not shape, and the last one deliberately
# feeds in the pre-fix pipeline to show a real failure is visible.
#
# Every fixture term here is invented (zz prefix). No part of the real list
# appears in this file.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$HERE/canon-terms.sh" ]; then
  printf 'FAIL: scripts/canon-terms.sh is missing, so the canonicalizer cannot be tested.\n' >&2
  exit 1
fi

# shellcheck source=scripts/canon-terms.sh
. "$HERE/canon-terms.sh"

if ! declare -f canon_terms >/dev/null 2>&1; then
  printf 'FAIL: canon-terms.sh was sourced but defines no canon_terms function.\n' >&2
  exit 1
fi

PASSED=0
FAILED=0

check() {
  local name="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    printf '  ok    %s\n' "$name"
    PASSED=$((PASSED + 1))
  else
    printf '  FAIL  %s\n          want: [%s]\n          got:  [%s]\n' "$name" "$want" "$got"
    FAILED=$((FAILED + 1))
  fi
}

printf '\ncanon-terms self test\n\n'

check 'a plain list joins into one alternation' \
  'zzalpha|zzbravo|zzcharlie' \
  "$(printf 'zzalpha\nzzbravo\nzzcharlie\n' | canon_terms)"

check 'windows line endings do not survive into the pattern' \
  'zzalpha|zzbravo|zzcharlie' \
  "$(printf 'zzalpha\r\nzzbravo\r\nzzcharlie\r\n' | canon_terms)"

check 'comment lines are dropped, indented ones too' \
  'zzalpha|zzbravo' \
  "$(printf '# a note\nzzalpha\n   # an indented note\nzzbravo\n' | canon_terms)"

check 'blank and whitespace lines cannot become a match everything branch' \
  'zzalpha|zzbravo' \
  "$(printf 'zzalpha\n\n   \nzzbravo\n' | canon_terms)"

check 'leading and trailing separators are trimmed away' \
  'zzalpha|zzbravo' \
  "$(printf '|zzalpha|zzbravo|\n' | canon_terms)"

check 'a value already stored as one joined line passes through unchanged' \
  'zzalpha|zzbravo|zzcharlie' \
  "$(printf 'zzalpha|zzbravo|zzcharlie\n' | canon_terms)"

check 'a list of only comments and blanks yields nothing, so callers can refuse it' \
  '' \
  "$(printf '# only a comment\n\n   \n' | canon_terms)"

# ----------------------------------------------------------------------
# Behaviour, not shape. The two cases below are the reason this file is
# worth running.
# ----------------------------------------------------------------------

SUBJECT='a line that contains zzbravo somewhere in it'

FIXED_PATTERN="$(printf 'zzalpha\r\nzzbravo\r\n' | canon_terms)"
if printf '%s\n' "$SUBJECT" | grep -qE "$FIXED_PATTERN"; then
  FIXED_RESULT=matched
else
  FIXED_RESULT=missed
fi
check 'a windows line ending list still MATCHES real text' \
  'matched' "$FIXED_RESULT"

# Negative control. This is the pipeline as it stood before the
# carriage-return strip: it still produces a plausible looking pattern and
# still prints a term count, and it hits nothing. If this case ever reports
# "matched", this harness is not measuring what it claims to measure and
# none of the cases above can be believed.
UNSTRIPPED="$(printf 'zzalpha\r\nzzbravo\r\n' \
  | grep -vE '^[[:space:]]*(#|$)' \
  | paste -sd'|' - \
  | sed -e 's/^|*//' -e 's/|*$//')"
if printf '%s\n' "$SUBJECT" | grep -qE "$UNSTRIPPED"; then
  UNSTRIPPED_RESULT=matched
else
  UNSTRIPPED_RESULT=missed
fi
check 'negative control: without the strip the same list matches NOTHING' \
  'missed' "$UNSTRIPPED_RESULT"

printf '\n%d passed, %d failed\n\n' "$PASSED" "$FAILED"

if [ "$FAILED" -ne 0 ]; then
  printf 'canon-terms self test FAILED\n\n'
  exit 1
fi

printf 'canon-terms self test passed\n\n'
exit 0
