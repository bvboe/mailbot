#!/bin/bash
#
# Lint script for MailBot
#
# Usage:
#   ./scripts/lint.sh        # Run linting
#   ./scripts/lint.sh --fix  # Run linting with auto-fix
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Check if node_modules exists
if [[ ! -d "node_modules" ]]; then
    echo "Installing dependencies..."
    npm install
fi

# Run ESLint
if [[ "$1" == "--fix" ]]; then
    echo "Running ESLint with auto-fix..."
    npx eslint src/**/*.gs --fix
else
    echo "Running ESLint..."
    npx eslint src/**/*.gs
fi

echo "Lint complete!"
