#!/usr/bin/env bash
#
# Frontend tsc ratchet decision (DL-0782), extracted from the CI step so the
# proof step in .github/workflows/ci.yml can drive the SAME code paths with
# synthetic inputs and watch every guard go RED. A ratchet nobody has watched
# fail is a green light with no bulb behind it.
#
# Usage: tsc-ratchet.sh <src_dir> <tsc_log_file> <baseline> <tsc_exit_code>
#
# Exits non-zero (a RED check) when any of:
#   1. <src_dir> resolves to zero .ts/.tsx files      (the check is checking nothing)
#   2. tsc exited non-zero but reported no diagnostic  (the check itself broke)
#   3. diagnostic count exceeds <baseline>             (new type errors landed)
# Otherwise prints the count and exits 0, and prints a lower-the-baseline notice
# when the count has dropped below the baseline.
set -u

SRC_DIR="$1"
LOG="$2"
BASELINE="$3"
RC="${4:-0}"

# Guard 1: the source tree must resolve to real files, or a green result means
# nothing. This is the silent-success shape the deno job also guards.
FILE_COUNT=$(find "$SRC_DIR" -type f \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null | wc -l | tr -d ' ')
if [ "$FILE_COUNT" -eq 0 ]; then
  echo "::error::No .ts/.tsx files found under ${SRC_DIR} -- this job is checking nothing. Fix the path rather than let it report green."
  exit 1
fi

# One "error TSxxxx" token per diagnostic. The trailing "Found N errors in M
# files." summary carries no "TS" token, so it is not double-counted.
ERRORS=$(grep -cE 'error TS[0-9]+' "$LOG" || true)

# Guard 2: a non-zero exit with zero diagnostics means tsc itself broke (bad
# flag, unresolvable config, crash). Never score that as "0 errors, pass" -- a
# check that silently stops checking is the precise failure this job ends.
if [ "$RC" -ne 0 ] && [ "$ERRORS" -eq 0 ]; then
  echo "::error::tsc exited $RC without reporting any type diagnostic. The check is broken, not passing."
  exit 1
fi

echo "tsc: ${ERRORS} error(s) across ${FILE_COUNT} file(s); ratchet baseline ${BASELINE}"

# Guard 3: the ratchet. New type errors cannot land.
if [ "$ERRORS" -gt "$BASELINE" ]; then
  echo "::error::Frontend type errors went UP: ${ERRORS} > baseline ${BASELINE}. Fix the new errors listed above. Do not raise the baseline."
  exit 1
fi

if [ "$ERRORS" -lt "$BASELINE" ]; then
  echo "::notice::Error count dropped to ${ERRORS}. Lower TSC_CHECK_BASELINE to ${ERRORS} in .github/workflows/ci.yml in this PR so the ratchet holds the ground you just took."
fi
