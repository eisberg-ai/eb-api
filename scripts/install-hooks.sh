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
# Pre-commit hook: runs lint + unit tests
# Bypass with: git commit --no-verify

set -e

echo "=== Running pre-commit checks ==="

# Run linting first (fast)
echo "Running lint..."
task test:lint

# Run unit tests (no services needed)
echo "Running unit tests..."
task test:unit

echo "=== Pre-commit checks passed ==="
EOF

chmod +x "$HOOKS_DIR/pre-commit"
echo "Installed: $HOOKS_DIR/pre-commit"

echo "Done! Pre-commit hook will run: task test:lint && task test:unit"
echo "Bypass with: git commit --no-verify"
