#!/usr/bin/env bash
# Verify that scripts/pre-push-gate.sh and
# .github/workflows/post-merge-identity-scan.yml agree on the leak
# regex. The two scanners answer the same question on different
# surfaces (pre-push diff vs post-merge tip); if they drift, one will
# silently let leaks through.
#
# Run locally before pushing; also wired into CI.

set -euo pipefail

GATE='scripts/pre-push-gate.sh'
WORKFLOW='.github/workflows/post-merge-identity-scan.yml'

gate_pattern=$(grep -E "^PRIVATE_PATTERN=" "$GATE" | sed -E "s/^PRIVATE_PATTERN='([^']+)'/\1/")
workflow_pattern=$(grep -E "^[[:space:]]+PATTERN: " "$WORKFLOW" | head -1 | sed -E "s/^[[:space:]]+PATTERN: '([^']+)'/\1/")

if [ -z "$gate_pattern" ] || [ -z "$workflow_pattern" ]; then
  echo "ERROR: could not extract pattern from one or both files" >&2
  echo "  gate_pattern length: ${#gate_pattern}" >&2
  echo "  workflow_pattern length: ${#workflow_pattern}" >&2
  exit 2
fi

if [ "$gate_pattern" = "$workflow_pattern" ]; then
  echo "PATTERN drift check: pre-push gate and post-merge workflow agree."
  exit 0
fi

echo "PATTERN drift detected." >&2
echo "" >&2
echo "  $GATE PRIVATE_PATTERN:" >&2
echo "    $gate_pattern" >&2
echo "" >&2
echo "  $WORKFLOW PATTERN:" >&2
echo "    $workflow_pattern" >&2
echo "" >&2
echo "Both files must use the same regex. Update whichever side is stale." >&2
exit 1
