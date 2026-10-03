#!/bin/bash

# Thin wrapper that validates preconditions and triggers the release.yml
# GitHub Actions workflow. All actual release work (lint, build, test,
# version bump, changelog, npm publish, GitHub release) happens in CI.

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Defaults
VERSION_TYPE="patch"
RELEASE_TYPE="release"
RELEASE_BRANCH="main"
SKIP_WINDOWS_E2E="false"
SKIP_MACOS_E2E="false"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    major|minor|patch)
      VERSION_TYPE="$1"
      shift
      ;;
    --pre-release)
      RELEASE_TYPE="pre-release"
      shift
      ;;
    --skip-windows-e2e)
      SKIP_WINDOWS_E2E="true"
      shift
      ;;
    --skip-macos-e2e)
      SKIP_MACOS_E2E="true"
      shift
      ;;
    -h|--help)
      echo "Usage: ./scripts/publish.sh [major|minor|patch] [--pre-release] [--skip-windows-e2e] [--skip-macos-e2e]"
      echo ""
      echo "Triggers the release.yml GitHub Actions workflow."
      echo ""
      echo "Options:"
      echo "  major|minor|patch   Version bump type (default: patch)"
      echo "  --pre-release       Create a pre-release (beta) instead of a stable release"
      echo "  --skip-windows-e2e  Skip the slow Windows E2E tests (included by default)"
      echo "  --skip-macos-e2e    Skip the slow macOS E2E tests (included by default)"
      echo ""
      echo "Examples:"
      echo "  npm run release                      # patch release"
      echo "  npm run release:minor                # minor release"
      echo "  npm run release:pre                  # patch pre-release"
      echo "  npm run release:pre -- minor         # minor pre-release"
      echo "  npm run release -- --skip-windows-e2e  # patch release, skip Windows E2E"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Usage: ./scripts/publish.sh [major|minor|patch] [--pre-release] [--skip-windows-e2e] [--skip-macos-e2e]"
      exit 1
      ;;
  esac
done

echo -e "${YELLOW}📦 Triggering $RELEASE_TYPE ($VERSION_TYPE)${NC}"
echo ""

# Check gh CLI
if ! command -v gh &> /dev/null; then
  echo -e "${RED}❌ GitHub CLI (gh) not installed. Install: https://cli.github.com/${NC}"
  exit 1
fi
if ! gh auth status &> /dev/null 2>&1; then
  echo -e "${RED}❌ Not logged in to GitHub CLI. Run: gh auth login${NC}"
  exit 1
fi
echo -e "${GREEN}✓ GitHub CLI authenticated${NC}"

# Check branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$RELEASE_TYPE" == "release" && "$BRANCH" != "$RELEASE_BRANCH" ]]; then
  echo -e "${RED}❌ Releases must be from '$RELEASE_BRANCH' branch (current: $BRANCH).${NC}"
  echo "   Switch to main: git checkout $RELEASE_BRANCH"
  exit 1
fi
echo -e "${GREEN}✓ On branch: $BRANCH${NC}"

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
  echo -e "${RED}❌ Uncommitted changes detected. Please commit or stash them first.${NC}"
  git status --short
  exit 1
fi
echo -e "${GREEN}✓ Working directory is clean${NC}"

# Check branch is up-to-date with remote
git fetch origin "$BRANCH" 2>/dev/null || true
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "")

if [[ -n "$REMOTE" && "$LOCAL" != "$REMOTE" ]]; then
  BEHIND=$(git rev-list --count HEAD.."origin/$BRANCH")
  AHEAD=$(git rev-list --count "origin/$BRANCH"..HEAD)
  if [[ "$BEHIND" -gt 0 ]]; then
    echo -e "${RED}❌ Branch is behind origin/$BRANCH by $BEHIND commit(s). Pull first.${NC}"
    exit 1
  fi
  if [[ "$AHEAD" -gt 0 ]]; then
    echo -e "${RED}❌ Branch is ahead of origin/$BRANCH by $AHEAD commit(s). Push first.${NC}"
    exit 1
  fi
fi
echo -e "${GREEN}✓ Branch is up-to-date with remote${NC}"

# Check dependency age (same gate the release workflow runs, failed early here so a
# too-young dependency is caught before burning a full CI matrix on the release run)
echo ""
echo "Checking dependency age..."
if ! node "$(dirname "$0")/check-dependency-age.mjs"; then
  echo -e "${RED}❌ Dependency age check failed. See above.${NC}"
  exit 1
fi
echo -e "${GREEN}✓ All dependencies are old enough to publish${NC}"

# Trigger the workflow
echo ""
echo "Triggering release.yml workflow..."
gh workflow run release.yml \
  --ref "$BRANCH" \
  -f type="$RELEASE_TYPE" \
  -f version="$VERSION_TYPE" \
  -f skip-windows-e2e="$SKIP_WINDOWS_E2E" \
  -f skip-macos-e2e="$SKIP_MACOS_E2E"
echo -e "${GREEN}✓ Workflow triggered${NC}"

# Wait briefly for the run to appear, then fetch its URL
echo ""
echo "Fetching workflow run URL..."
sleep 3
RUN_ID=$(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)

if [[ -n "$RUN_ID" ]]; then
  REPO=$(gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null || echo "apify/mcp-cli")
  RUN_URL="https://github.com/$REPO/actions/runs/$RUN_ID"
  echo -e "${GREEN}✓ Monitor the release:${NC} $RUN_URL"
  # Try to open in browser
  open "$RUN_URL" 2>/dev/null || xdg-open "$RUN_URL" 2>/dev/null || true
else
  echo -e "${YELLOW}Could not fetch run URL. Check: https://github.com/apify/mcp-cli/actions/workflows/release.yml${NC}"
fi
