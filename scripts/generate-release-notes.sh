#!/bin/bash
set -e

# Generate intelligent release notes using Claude CLI
# This script analyzes commits since the last release and generates a structured summary

# Colors for output (all logging goes to stderr)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1" >&2; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1" >&2; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1" >&2; }

# Check if Claude CLI is installed
if ! command -v claude &> /dev/null; then
    log_warning "Claude CLI is not installed"
    log_info "Install with: npm install -g @anthropic-ai/claude-code"
    log_info "Falling back to simple release notes"
    echo "Release ${1:-unknown}"
    exit 0
fi

# Get current tag from argument or environment
if [ -n "$1" ]; then
    CURRENT_TAG="$1"
elif [ -n "$GITHUB_REF_NAME" ]; then
    CURRENT_TAG="${GITHUB_REF_NAME}"
else
    log_error "Current tag required as argument or GITHUB_REF_NAME environment variable"
    log_info "Usage: $0 <tag>"
    exit 1
fi

log_info "Current release tag: ${CURRENT_TAG}"

# Get the previous release tag
PREVIOUS_TAG=$(git describe --tags --abbrev=0 HEAD 2>/dev/null || echo "")

if [ -z "$PREVIOUS_TAG" ]; then
    log_warning "No previous tag found, using all commits"
    COMMIT_RANGE="HEAD"
else
    log_info "Previous release tag: ${PREVIOUS_TAG}"
    COMMIT_RANGE="${PREVIOUS_TAG}..HEAD"
fi

# Get commits since last release
log_info "Fetching commits in range: ${COMMIT_RANGE}"
COMMITS=$(git log "${COMMIT_RANGE}" --pretty=format:"%h | %s | %an | %ar" --no-merges 2>/dev/null || echo "")

if [ -z "$COMMITS" ]; then
    log_warning "No commits found in range"
    echo "Release ${CURRENT_TAG} - No changes since last release."
    exit 0
fi

COMMIT_COUNT=$(echo "$COMMITS" | wc -l | tr -d ' ')
log_info "Found ${COMMIT_COUNT} commits to analyze"

# Get file statistics
if [ -n "$PREVIOUS_TAG" ]; then
    FILES_CHANGED=$(git diff --stat "${PREVIOUS_TAG}..HEAD" 2>/dev/null | tail -1 || echo "")
else
    FILES_CHANGED=$(git diff --stat HEAD~${COMMIT_COUNT}..HEAD 2>/dev/null | tail -1 || echo "No statistics available")
fi
log_info "Changes: ${FILES_CHANGED}"

# Create prompt for Claude
read -r -d '' PROMPT << 'EOM' || true
Analyze the following Git commits and generate a concise, well-structured release summary.

**Commit History:**
```
COMMITS_PLACEHOLDER
```

**Statistics:**
STATS_PLACEHOLDER

**Instructions:**
1. Group changes into categories (Features, Bug Fixes, Improvements, Documentation, etc.)
2. Highlight the most important changes first
3. Be technical but concise - this is for developers
4. Mention breaking changes if any
5. Keep the summary under 300 words
6. Use bullet points for clarity

**Output Format:**
Start with a 1-2 sentence summary, then list changes by category.
Use markdown formatting with ## for main sections.
Do not include any preamble or explanation - just the release notes.

Example output format:
## Summary
Brief description of what this release includes.

## What's Changed

### Features
- New feature description

### Bug Fixes
- Bug fix description

### Improvements
- Improvement description

## Statistics
- X commits
- Y files changed
EOM

# Replace placeholders
PROMPT="${PROMPT/COMMITS_PLACEHOLDER/$COMMITS}"
PROMPT="${PROMPT/STATS_PLACEHOLDER/$FILES_CHANGED}"

log_info "Generating release notes with Claude..."

# Call Claude CLI with the prompt
# Use --print to just output the result without interactive mode
SUMMARY=$(echo "$PROMPT" | claude --print 2>/dev/null)
EXIT_CODE=$?

# Check for errors
if [ $EXIT_CODE -ne 0 ] || [ -z "$SUMMARY" ]; then
    log_warning "Claude CLI failed or returned empty response"
    log_info "Falling back to simple release notes"

    # Generate simple release notes
    echo "## Release ${CURRENT_TAG}"
    echo ""
    echo "### Changes"
    echo ""
    echo "$COMMITS" | while IFS='|' read -r hash subject author date; do
        echo "- ${subject}"
    done
    echo ""
    echo "### Statistics"
    echo "- ${COMMIT_COUNT} commits"
    echo "- ${FILES_CHANGED}"
    exit 0
fi

log_success "Successfully generated release notes"

# Output the summary to stdout
echo "$SUMMARY"
