#!/bin/bash
# Install git hooks for eb-api
# Run this once: ./scripts/install-hooks.sh

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

echo "Installing git hooks for eb-api..."

# Create pre-commit hook
cat > "$HOOKS_DIR/pre-commit" << 'EOF'
#!/bin/bash
# Pre-commit hook: runs unit + local tests (auto-starts services)
# Bypass with: git commit --no-verify

set -e

echo "=== Running pre-commit tests ==="

# Run unit tests first (no services needed)
echo "Running unit tests..."
task test:unit

# Run local tests with auto-start
echo "Running local tests (auto-starting services)..."
task test:local:auto

echo "=== Pre-commit tests passed ==="
EOF

chmod +x "$HOOKS_DIR/pre-commit"
echo "Installed: $HOOKS_DIR/pre-commit"

echo "Done! Pre-commit hook will run: task test (unit + local)"
echo "Bypass with: git commit --no-verify"
