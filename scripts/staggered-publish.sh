#!/bin/bash
#
# Staggered Publish Script for aimatey Monorepo
#
# Publishes all 25 packages to npm in dependency order with delays
# to avoid rate limiting.
#
# Usage:
#   ./scripts/staggered-publish.sh           # Full publish
#   ./scripts/staggered-publish.sh --dry-run # Dry run (no actual publish)
#
# Configuration:
#   DELAY_BETWEEN_PACKAGES - seconds between each package (default: 5)
#   DELAY_BETWEEN_BATCHES  - seconds between batches (default: 30)
#

set -e

# Configuration
DELAY_BETWEEN_PACKAGES=${DELAY_BETWEEN_PACKAGES:-5}
DELAY_BETWEEN_BATCHES=${DELAY_BETWEEN_BATCHES:-30}
DRY_RUN=false

# Parse arguments
if [[ "$1" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "🔍 DRY RUN MODE - No packages will be published"
  echo ""
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
TOTAL=0
SUCCESS=0
SKIPPED=0
FAILED=0

# Function to publish a single package
publish_package() {
  local pkg=$1
  TOTAL=$((TOTAL + 1))

  echo -e "${BLUE}[$TOTAL/25]${NC} Publishing ${YELLOW}$pkg${NC}..."

  if $DRY_RUN; then
    echo "  → Would run: npm publish --workspace=$pkg --access public"
    SUCCESS=$((SUCCESS + 1))
  else
    local output
    if output=$(npm publish --workspace="$pkg" --access public 2>&1); then
      echo "$output"
      echo -e "  ${GREEN}✓ Published successfully${NC}"
      SUCCESS=$((SUCCESS + 1))
    elif echo "$output" | grep -q "cannot publish over the previously published"; then
      # Version already on the registry — package unchanged this release
      echo -e "  ${YELLOW}↷ Skipped (version already published)${NC}"
      SKIPPED=$((SKIPPED + 1))
    else
      echo "$output"
      echo -e "  ${RED}✗ Failed to publish${NC}"
      FAILED=$((FAILED + 1))
      FAILED_PACKAGES+=("$pkg")
    fi
  fi
}

# Function to wait between packages
wait_between() {
  local seconds=$1
  if ! $DRY_RUN && [ "$seconds" -gt 0 ]; then
    echo -e "  ${BLUE}Waiting ${seconds}s...${NC}"
    sleep "$seconds"
  fi
}

# Function to publish a batch
publish_batch() {
  local batch_name=$1
  shift
  local packages=("$@")

  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}  Batch: $batch_name${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  for pkg in "${packages[@]}"; do
    publish_package "$pkg"
    wait_between "$DELAY_BETWEEN_PACKAGES"
  done
}

# Track failed packages
FAILED_PACKAGES=()

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║       aimatey Staggered Publish Script                      ║"
echo "║                                                              ║"
echo "║  Publishing 25 packages in dependency order                  ║"
echo "║  Delay between packages: ${DELAY_BETWEEN_PACKAGES}s                              ║"
echo "║  Delay between batches: ${DELAY_BETWEEN_BATCHES}s                               ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# Ensure we're in the repo root
if [ ! -f "package.json" ]; then
  echo -e "${RED}Error: Must run from repository root${NC}"
  exit 1
fi

# Build first
echo ""
echo -e "${YELLOW}Building all packages...${NC}"
if ! $DRY_RUN; then
  npm run build
fi
echo -e "${GREEN}Build complete!${NC}"

# ============================================================================
# BATCH 1: Core Types and Errors (no dependencies)
# ============================================================================
publish_batch "Core Types & Errors" \
  "@johnhenry/aimatey-types" \
  "@johnhenry/aimatey-errors"

wait_between "$DELAY_BETWEEN_BATCHES"

# ============================================================================
# BATCH 2: Core Utilities (depends on types, errors)
# ============================================================================
publish_batch "Core Utilities" \
  "@johnhenry/aimatey-utils" \
  "@johnhenry/aimatey-testing"

wait_between "$DELAY_BETWEEN_BATCHES"

# ============================================================================
# BATCH 3: Core Package (depends on utils)
# ============================================================================
publish_batch "Core" \
  "@johnhenry/aimatey-core"

wait_between "$DELAY_BETWEEN_BATCHES"

# ============================================================================
# BATCH 4: Backend Adapters (depends on core)
# ============================================================================
publish_batch "Backend Adapters" \
  "@johnhenry/aimatey-backend" \
  "@johnhenry/aimatey-backend-browser"

wait_between "$DELAY_BETWEEN_BATCHES"

# ============================================================================
# BATCH 5: Frontend Adapters (depends on backend for some imports)
# ============================================================================
publish_batch "Frontend Adapters" \
  "@johnhenry/aimatey-frontend"

wait_between "$DELAY_BETWEEN_BATCHES"

# ============================================================================
# BATCH 6: Middleware (depends on core)
# ============================================================================
publish_batch "Middleware" \
  "@johnhenry/aimatey-middleware"

wait_between "$DELAY_BETWEEN_BATCHES"

# ============================================================================
# BATCH 6b: Patterns (depends on core)
# ============================================================================
publish_batch "Patterns" \
  "@johnhenry/aimatey-patterns"

wait_between "$DELAY_BETWEEN_BATCHES"

# ============================================================================
# BATCH 6c: MCP (depends only on types)
# ============================================================================
publish_batch "MCP" \
  "@johnhenry/aimatey-mcp"

wait_between "$DELAY_BETWEEN_BATCHES"

# ============================================================================
# BATCH 7: HTTP (depends on core, middleware)
# ============================================================================
publish_batch "HTTP Adapters" \
  "@johnhenry/aimatey-http-core" \
  "@johnhenry/aimatey-http"

wait_between "$DELAY_BETWEEN_BATCHES"

# ============================================================================
# BATCH 8: Wrappers (depends on core)
# ============================================================================
publish_batch "Wrappers" \
  "@johnhenry/aimatey-wrapper"

wait_between "$DELAY_BETWEEN_BATCHES"

# ============================================================================
# BATCH 9: React (depends on core)
# ============================================================================
publish_batch "React" \
  "@johnhenry/aimatey-react-core" \
  "@johnhenry/aimatey-react-hooks" \
  "@johnhenry/aimatey-react-nextjs" \
  "@johnhenry/aimatey-react-stream"

wait_between "$DELAY_BETWEEN_BATCHES"

# ============================================================================
# BATCH 10: Native (depends on core)
# ============================================================================
publish_batch "Native" \
  "@johnhenry/aimatey-native-apple" \
  "@johnhenry/aimatey-native-model-runner" \
  "@johnhenry/aimatey-native-node-llamacpp" \
  "@johnhenry/aimatey-native-onnx" \
  "@johnhenry/aimatey-native-laya"

wait_between "$DELAY_BETWEEN_BATCHES"

# ============================================================================
# BATCH 11: CLI (depends on many packages)
# ============================================================================
publish_batch "CLI" \
  "@johnhenry/aimatey-cli"

wait_between "$DELAY_BETWEEN_BATCHES"

# ============================================================================
# BATCH 12: Main Package (umbrella, depends on everything)
# ============================================================================
publish_batch "Main Package" \
  "@johnhenry/aimatey"

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                      PUBLISH COMPLETE                        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo -e "  Total packages: ${BLUE}$TOTAL${NC}"
echo -e "  Successful:     ${GREEN}$SUCCESS${NC}"
echo -e "  Skipped:        ${YELLOW}$SKIPPED${NC} (already published)"
echo -e "  Failed:         ${RED}$FAILED${NC}"

if [ ${#FAILED_PACKAGES[@]} -gt 0 ]; then
  echo ""
  echo -e "${RED}Failed packages:${NC}"
  for pkg in "${FAILED_PACKAGES[@]}"; do
    echo -e "  - $pkg"
  done
  echo ""
  echo "To retry failed packages:"
  for pkg in "${FAILED_PACKAGES[@]}"; do
    echo "  npm publish --workspace=$pkg --access public"
  done
  exit 1
fi

echo ""
echo -e "${GREEN}All packages published successfully! 🎉${NC}"
