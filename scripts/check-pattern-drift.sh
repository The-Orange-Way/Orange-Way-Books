#!/usr/bin/env bash
# Verify that scripts/pre-push-gate.sh and
# .github/workflows/post-merge-identity-scan.yml agree on every regex
# they jointly enforce: the leak PATTERN itself plus the
# DOC_STRIP_CGNAT and DOC_STRIP_REGEX_ALT helpers that allow
# documentation examples through without false-positiving on real
# leaks. The two scanners answer the same question on different
# surfaces (pre-push diff vs post-merge tip); if any pair drifts, one
# scanner silently lets through what the other would catch.
#
# Output policy: on agreement, prints "OK" per label and exits 0. On
# drift, prints the *labels* that diverge plus the SHA-256 fingerprint
# of each side so a maintainer can confirm the diff without echoing
# the actual regex bodies into CI stdout (this script runs in
# `ci.yml`, whose logs are public on a public-launch repo). Full
# bodies are visible only when run locally with VERBOSE=1.
#
# Run locally before pushing; also wired into CI.

set -euo pipefail

GATE='scripts/pre-push-gate.sh'
WORKFLOW='.github/workflows/post-merge-identity-scan.yml'
VERBOSE="${VERBOSE:-0}"

fail=0

# Extract a single-quoted shell-style assignment. Handles values that
# themselves contain single quotes via the standard bash escape form
# '...'\''...'. Use python rather than sed so the quote handling is
# explicit and easy to audit.
extract_quoted() {
  local file="$1"
  local prefix_regex="$2"
  python3 - "$file" "$prefix_regex" <<'PY'
import re, sys
path, pat = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as f:
    for line in f:
        m = re.match(pat + r"'((?:[^'\\]|\\.|'\\''')*)'", line)
        if m:
            print(m.group(1))
            sys.exit(0)
sys.exit(0)
PY
}

fingerprint() {
  printf '%s' "$1" | sha256sum | awk '{print substr($1,1,16)}'
}

check_pair() {
  local label="$1"
  local gate_value="$2"
  local workflow_value="$3"
  if [ -z "$gate_value" ] || [ -z "$workflow_value" ]; then
    echo "ERROR: could not extract $label (gate ${#gate_value} chars, workflow ${#workflow_value} chars)" >&2
    fail=1
    return
  fi
  local gf wf
  gf=$(fingerprint "$gate_value")
  wf=$(fingerprint "$workflow_value")
  if [ "$gate_value" = "$workflow_value" ]; then
    echo "$label: OK (sha256:$gf)"
  else
    echo "$label: DRIFT" >&2
    echo "  $GATE       sha256:$gf, ${#gate_value} chars" >&2
    echo "  $WORKFLOW   sha256:$wf, ${#workflow_value} chars" >&2
    if [ "$VERBOSE" = "1" ]; then
      echo "  gate value:     $gate_value" >&2
      echo "  workflow value: $workflow_value" >&2
    else
      echo "  Set VERBOSE=1 locally to print full values; CI keeps them off-log." >&2
    fi
    fail=1
  fi
}

gate_pattern=$(extract_quoted "$GATE" '^PRIVATE_PATTERN=')
workflow_pattern=$(extract_quoted "$WORKFLOW" '^\s+PATTERN: ')
check_pair "PATTERN" "$gate_pattern" "$workflow_pattern"

gate_cgnat=$(extract_quoted "$GATE" '^DOC_STRIP_CGNAT=')
workflow_cgnat=$(extract_quoted "$WORKFLOW" '^\s+DOC_STRIP_CGNAT: ')
check_pair "DOC_STRIP_CGNAT" "$gate_cgnat" "$workflow_cgnat"

gate_alt=$(extract_quoted "$GATE" '^DOC_STRIP_REGEX_ALT=')
workflow_alt=$(extract_quoted "$WORKFLOW" '^\s+DOC_STRIP_REGEX_ALT: ')
check_pair "DOC_STRIP_REGEX_ALT" "$gate_alt" "$workflow_alt"

if [ $fail -ne 0 ]; then
  echo "Update whichever side is stale so the two files agree." >&2
  exit 1
fi
