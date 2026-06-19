#!/usr/bin/env bash
#
# install-hooks.sh — wire the pre-push gate into this clone's .git/hooks.
#
# Run once per fresh clone. The hook itself lives at scripts/pre-push-gate.sh
# so it's version-controlled (CI + every contributor sees the same gate).
#
# What this does:
#   - Writes .git/hooks/pre-push that execs scripts/pre-push-gate.sh
#   - Makes the gate executable
#
# Idempotent: re-running is safe.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

chmod +x scripts/pre-push-gate.sh

cat > .git/hooks/pre-push <<'EOF'
#!/usr/bin/env bash
exec "$(git rev-parse --show-toplevel)/scripts/pre-push-gate.sh" "$@"
EOF
chmod +x .git/hooks/pre-push

echo "✓ Installed pre-push hook → scripts/pre-push-gate.sh"
echo
echo "Next push will refuse unless /pr-this has been run on the current HEAD."
echo "Emergency override (loud warning): PR_THIS_BYPASS=1 git push"
