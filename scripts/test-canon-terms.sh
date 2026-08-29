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
# nowhere. A shape-only test would pass against all three. So the cases at
# the end assert behaviour, not shape, and one of them deliberately feeds in
# the pre-fix pipeline to show a real failure is visible.
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

if ! declare -f canon_terms_usable >/dev/null 2>&1; then
  printf 'FAIL: canon-terms.sh was sourced but defines no canon_terms_usable function.\n' >&2
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

# Whitespace around a term is not part of the term. A stray trailing space
# produces the branch "zzalpha ", which matches only where the term happens
# to be followed by a space: it misses nearly every real occurrence while
# the term count still reads correct.
check 'whitespace around a term is trimmed off both ends' \
  'zzalpha|zzbravo' \
  "$(printf '  zzalpha  \n\tzzbravo\t\n' | canon_terms)"

# Only the ends. A term that legitimately contains a space must survive, or
# the trim above would quietly break multi-word entries.
check 'a term with an internal space keeps it' \
  'zz alpha|zzbravo' \
  "$(printf '  zz alpha  \nzzbravo\n' | canon_terms)"

# A line is documented as a regex FRAGMENT, so "termA|termB" on one line is
# invited, and editing it back down to one term leaves the trailing pipe
# behind. paste then joins it into "termA||termB". An empty alternation
# branch matches the empty string, which is contained in every line, so the
# scan stops being a search and becomes a refusal of the whole tree, with a
# term count next to it that still reads correct.
check 'a stray pipe on a fragment cannot become an empty branch' \
  'zzalpha|zzbravo' \
  "$(printf 'zzalpha|\nzzbravo\n' | canon_terms)"

check 'runs of separators anywhere in the value are squeezed to one' \
  'zzalpha|zzbravo|zzcharlie' \
  "$(printf '||zzalpha||\n|zzbravo|||zzcharlie|\n' | canon_terms)"

# ----------------------------------------------------------------------
# Behaviour, not shape. The cases below are the reason this file is worth
# running.
# ----------------------------------------------------------------------

# A list holding no usable terms is a VALUE, not an error. It has to come
# back as empty output with a zero exit status, because the callers all
# have their own "the list is not configured" branch and that branch is
# where the human-readable reason gets printed. When the filter was grep -v
# it exited 1 on this input, and a caller running under set -e plus
# pipefail died mid-assignment with no message at all.
COMMENTS_ONLY="$(printf '# only a comment\n\n   \n' | canon_terms)"
EMPTY_RC=$?
check 'a list with no usable terms exits 0 rather than killing the caller' \
  '0' "$EMPTY_RC"
check 'a list with no usable terms is empty, so callers see it as unconfigured' \
  '' "$COMMENTS_ONLY"

# The same thing again, one level up, as the caller actually writes it.
# scripts/pre-push-gate.sh runs under set -euo pipefail and builds its
# pattern with a plain assignment, so a non-zero status out of canon_terms
# ends that script ON the assignment: no message, no exit code anyone can
# read, and the gate's own "no usable terms" branch never runs. A list of
# only comments and blanks is what a freshly copied .reserved-terms.example
# looks like, so it is the state a new contributor starts in.
#
# Proving that against the real gate needs a git repository, a push and an
# installed hook. This reproduces the shape it fails in, which is the part
# that regresses.
SURVIVED="$(
  set -euo pipefail
  . "$HERE/canon-terms.sh"
  PATTERN="$(printf '# only a comment\n\n   \n' | canon_terms)"
  if [ -z "$PATTERN" ]; then
    printf 'reached-the-skip-branch\n'
  else
    printf 'unexpected-pattern\n'
  fi
)" 2>/dev/null || SURVIVED='died-mid-assignment'
check 'a caller under set -e plus pipefail reaches its own skip branch' \
  'reached-the-skip-branch' "$SURVIVED"

SUBJECT='a line that contains zzbravo somewhere in it'

# grep -E '' is a legal regex that matches everything, so this case has to
# assert the pattern is non-empty before it asserts the match. Without that
# it reports "matched" when the canonicalizer returns nothing at all, which
# is the exact failure the whole file exists to catch.
FIXED_PATTERN="$(printf 'zzalpha\r\nzzbravo\r\n' | canon_terms)"
if [ -n "$FIXED_PATTERN" ] && printf '%s\n' "$SUBJECT" | grep -qE "$FIXED_PATTERN"; then
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

# The list is one regex FRAGMENT per line, so an unbalanced parenthesis is
# a realistic typo, and the join hides it. grep exits 2 on a pattern it
# refuses and every consumer read exit 2 as "no matches", so one typo in
# the stored value turned every layer green while nothing was checked.
GOOD_PATTERN="$(printf 'zzalpha\nzzbravo\n' | canon_terms)"
if canon_terms_usable "$GOOD_PATTERN"; then
  GOOD_VERDICT=usable
else
  GOOD_VERDICT=refused
fi
check 'a well formed list is reported usable' \
  'usable' "$GOOD_VERDICT"

BROKEN_PATTERN="$(printf 'zzalpha\nzz(bravo\n' | canon_terms)"
if canon_terms_usable "$BROKEN_PATTERN"; then
  BROKEN_VERDICT=usable
else
  BROKEN_VERDICT=refused
fi
check 'a fragment grep cannot compile is refused, not silently accepted' \
  'refused' "$BROKEN_VERDICT"

# Guard against the check above passing for the wrong reason: it must be
# the unbalanced parenthesis being refused, not the canonicalizer having
# dropped the line and handed back something harmless.
check 'the broken fixture really did reach the pattern' \
  'zzalpha|zz(bravo' "$BROKEN_PATTERN"

# Both fixtures below are built by hand rather than through canon_terms,
# which now removes the empty branch at the source: routing them through the
# fix would test the fix instead of the guard, and the guard has to hold for
# any value that reaches it, including one a future consumer builds its own
# way.
#
# An empty alternation branch is undefined in POSIX ERE. GNU grep accepts it
# and matches everything; another grep refuses it outright. Both answers mean
# "do not scan with this", so the guard is asserted against it here without
# claiming which of the two reasons applied.
if canon_terms_usable 'zzalpha||zzbravo'; then
  EMPTY_BRANCH_VERDICT=usable
else
  EMPTY_BRANCH_VERDICT=refused
fi
check 'a stray empty alternation branch is refused, however grep reads it' \
  'refused' "$EMPTY_BRANCH_VERDICT"

# An entirely optional fragment: valid ERE everywhere, and it matches the
# empty string, so it matches every line of every file. The term count still
# reads correct while the scan reports the whole tree as findings.
if canon_terms_usable '(zzalpha)?'; then
  EVERYTHING_VERDICT=usable
else
  EVERYTHING_VERDICT=refused
fi
check 'a pattern that matches everything is refused, not reported usable' \
  'refused' "$EVERYTHING_VERDICT"

# And that fixture really is the hazard, not a strawman: it matches a line
# holding no reserved term at all. If this case ever reports "missed", the
# refusal above is passing for some other reason and proves nothing.
if printf '%s\n' 'an ordinary line with no reserved term in it' | grep -qE '(zzalpha)?'; then
  EVERYTHING_MATCHES=matched
else
  EVERYTHING_MATCHES=missed
fi
check 'the everything fixture does match text containing no term' \
  'matched' "$EVERYTHING_MATCHES"

if canon_terms_usable ""; then
  EMPTY_VERDICT=usable
else
  EMPTY_VERDICT=refused
fi
check 'an empty pattern is never reported usable' \
  'refused' "$EMPTY_VERDICT"

printf '\n%d passed, %d failed\n\n' "$PASSED" "$FAILED"

if [ "$FAILED" -ne 0 ]; then
  printf 'canon-terms self test FAILED\n\n'
  exit 1
fi

printf 'canon-terms self test passed\n\n'
exit 0
