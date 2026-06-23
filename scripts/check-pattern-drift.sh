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
# Run locally before pushing; also wired into CI.

set -euo pipefail

GATE='scripts/pre-push-gate.sh'
WORKFLOW='.github/workflows/post-merge-identity-scan.yml'

fail=0

check_pair() {
  local label="$1"
  local gate_value="$2"
  local workflow_value="$3"
  if [ -z "$gate_value" ] || [ -z "$workflow_value" ]; then
    echo "ERROR: could not extract $label from one or both files" >&2
    echo "  gate length: ${#gate_value}" >&2
    echo "  workflow length: ${#workflow_value}" >&2
    fail=1
    return
  fi
  if [ "$gate_value" = "$workflow_value" ]; then
    echo "$label drift check: pre-push gate and post-merge workflow agree."
  else
    echo "$label drift detected." >&2
    echo "" >&2
    echo "  $GATE $label:" >&2
    echo "    $gate_value" >&2
    echo "" >&2
    echo "  $WORKFLOW $label:" >&2
    echo "    $workflow_value" >&2
    echo "" >&2
    fail=1
  fi
}

gate_pattern=$(grep -E "^PRIVATE_PATTERN=" "$GATE" | sed -E "s/^PRIVATE_PATTERN='([^']+)'/\1/")
workflow_pattern=$(grep -E "^[[:space:]]+PATTERN: " "$WORKFLOW" | head -1 | sed -E "s/^[[:space:]]+PATTERN: '([^']+)'/\1/")
check_pair "PATTERN" "$gate_pattern" "$workflow_pattern"

gate_cgnat=$(grep -E "^DOC_STRIP_CGNAT=" "$GATE" | sed -E "s/^DOC_STRIP_CGNAT='([^']+)'/\1/")
workflow_cgnat=$(grep -E "^[[:space:]]+DOC_STRIP_CGNAT: " "$WORKFLOW" | head -1 | sed -E "s/^[[:space:]]+DOC_STRIP_CGNAT: '([^']+)'/\1/")
check_pair "DOC_STRIP_CGNAT" "$gate_cgnat" "$workflow_cgnat"

gate_alt=$(grep -E "^DOC_STRIP_REGEX_ALT=" "$GATE" | sed -E "s/^DOC_STRIP_REGEX_ALT='([^']+)'/\1/")
workflow_alt=$(grep -E "^[[:space:]]+DOC_STRIP_REGEX_ALT: " "$WORKFLOW" | head -1 | sed -E "s/^[[:space:]]+DOC_STRIP_REGEX_ALT: '([^']+)'/\1/")
check_pair "DOC_STRIP_REGEX_ALT" "$gate_alt" "$workflow_alt"

if [ $fail -ne 0 ]; then
  echo "Update whichever side is stale so the two files agree." >&2
  exit 1
fi
