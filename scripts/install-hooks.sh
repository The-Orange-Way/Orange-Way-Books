#!/usr/bin/env bash
#
# install-hooks.sh — wire the pre-commit + pre-push gates into this clone's
# .git/hooks.
#
# Run once per fresh clone. The hooks themselves live under scripts/ so
# they're version-controlled (CI + every contributor sees the same gates).
#
# What this does:
#   - Writes .git/hooks/pre-commit that execs scripts/pre-commit-format.sh
#     (auto-formats staged files with prettier so commits land clean).
#   - Writes .git/hooks/pre-push that execs scripts/pre-push-gate.sh
#     (refuses pushes that haven't been gauntleted via /pr-this).
#   - Makes both gate scripts executable.
#
# Idempotent: re-running is safe.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

chmod +x scripts/pre-commit-format.sh
chmod +x scripts/pre-push-gate.sh

cat > .git/hooks/pre-commit <<'EOF'
#!/usr/bin/env bash
exec "$(git rev-parse --show-toplevel)/scripts/pre-commit-format.sh" "$@"
EOF
chmod +x .git/hooks/pre-commit

cat > .git/hooks/pre-push <<'EOF'
#!/usr/bin/env bash
exec "$(git rev-parse --show-toplevel)/scripts/pre-push-gate.sh" "$@"
EOF
chmod +x .git/hooks/pre-push

echo "✓ Installed pre-commit hook  → scripts/pre-commit-format.sh"
echo "✓ Installed pre-push  hook   → scripts/pre-push-gate.sh"
echo
echo "Every commit will auto-format its staged files with prettier."
echo "Next push will refuse unless /pr-this has been run on the current HEAD."
echo "Emergency override (loud warning): PR_THIS_BYPASS=1 git push"
