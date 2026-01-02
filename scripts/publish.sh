#!/bin/bash

# Publish script for mcpc
# - Ensures releases are from main branch only
# - Ensures working directory is clean
# - Ensures branch is up-to-date with remote
# - Runs lint, build, and tests
# - Bumps version (patch by default, or specify: major, minor, patch)
# - Creates git tag
# - Pushes commit and tag
# - Publishes to npm

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Default values
VERSION_TYPE="patch"
RELEASE_BRANCH="main"
ALLOW_ANY_BRANCH=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    major|minor|patch)
      VERSION_TYPE="$1"
      shift
      ;;
    --allow-branch)
      ALLOW_ANY_BRANCH=true
      shift
      ;;
    -h|--help)
      echo "Usage: ./scripts/publish.sh [major|minor|patch] [--allow-branch]"
      echo ""
      echo "Options:"
      echo "  major|minor|patch  Version bump type (default: patch)"
      echo "  --allow-branch     Allow release from any branch (not recommended)"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Usage: ./scripts/publish.sh [major|minor|patch] [--allow-branch]"
      exit 1
      ;;
  esac
done

echo -e "${YELLOW}📦 Publishing mcpc ($VERSION_TYPE version bump)${NC}"
echo ""

# Check if logged in to npm
echo "Checking npm login..."
if ! npm whoami > /dev/null 2>&1; then
  echo -e "${RED}❌ Not logged in to npm. Please run: npm login${NC}"
  exit 1
fi
NPM_USER=$(npm whoami)
echo -e "${GREEN}✓ Logged in as: $NPM_USER${NC}"

# Check current branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "Current branch: $BRANCH"

if [ "$BRANCH" != "$RELEASE_BRANCH" ] && [ "$ALLOW_ANY_BRANCH" = false ]; then
  echo -e "${RED}❌ Releases must be from '$RELEASE_BRANCH' branch.${NC}"
  echo -e "   Current branch: $BRANCH"
  echo ""
  echo "Options:"
  echo "  1. Switch to $RELEASE_BRANCH: git checkout $RELEASE_BRANCH"
  echo "  2. Override (not recommended): npm run release -- --allow-branch"
  exit 1
fi
echo -e "${GREEN}✓ On release branch: $BRANCH${NC}"

# Check for uncommitted changes
echo "Checking for uncommitted changes..."
if ! git diff-index --quiet HEAD --; then
  echo -e "${RED}❌ Uncommitted changes detected. Please commit or stash them first.${NC}"
  git status --short
  exit 1
fi
echo -e "${GREEN}✓ Working directory is clean${NC}"

# Check for untracked files (excluding common patterns)
UNTRACKED=$(git ls-files --others --exclude-standard)
if [ -n "$UNTRACKED" ]; then
  echo -e "${YELLOW}⚠️  Untracked files detected:${NC}"
  echo "$UNTRACKED"
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 0
  fi
fi

# Fetch and check if up-to-date with remote
echo "Fetching from remote..."
git fetch origin "$BRANCH" 2>/dev/null || true

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "")

if [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
  BEHIND=$(git rev-list --count HEAD..origin/"$BRANCH")
  AHEAD=$(git rev-list --count origin/"$BRANCH"..HEAD)

  if [ "$BEHIND" -gt 0 ]; then
    echo -e "${RED}❌ Branch is behind origin/$BRANCH by $BEHIND commit(s). Please pull first.${NC}"
    exit 1
  fi

  if [ "$AHEAD" -gt 0 ]; then
    echo -e "${RED}❌ Branch is ahead of origin/$BRANCH by $AHEAD commit(s). Please push first.${NC}"
    echo "   Run: git push origin $BRANCH"
    exit 1
  fi
fi
echo -e "${GREEN}✓ Branch is up-to-date${NC}"

# Run lint
echo ""
echo "Running lint..."
npm run lint
echo -e "${GREEN}✓ Lint passed${NC}"

# Run build
echo ""
echo "Building..."
npm run build
echo -e "${GREEN}✓ Build succeeded${NC}"

# Run tests
echo ""
echo "Running tests..."
npm run test:unit && ./test/e2e/run.sh --no-build --parallel 1
echo -e "${GREEN}✓ Tests passed${NC}"

# Get current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo ""
echo "Current version: $CURRENT_VERSION"

# Bump version (without git tag - we'll do it manually)
echo "Bumping $VERSION_TYPE version..."
npm version "$VERSION_TYPE" --no-git-tag-version

# Get new version
NEW_VERSION=$(node -p "require('./package.json').version")
echo -e "${GREEN}New version: $NEW_VERSION${NC}"

# Create git commit and tag
echo ""
echo "Creating git commit and tag..."
git add package.json package-lock.json
git commit -m "v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"

echo -e "${GREEN}✓ Created tag v$NEW_VERSION${NC}"

# Push commit and tag
echo ""
echo "Pushing to origin..."
git push origin "$BRANCH"
git push origin "v$NEW_VERSION"
echo -e "${GREEN}✓ Pushed commit and tag${NC}"

# Publish to npm
echo ""
echo "Publishing to npm..."
npm publish --access public

echo ""
echo -e "${GREEN}✅ Successfully published mcpc@$NEW_VERSION${NC}"
echo ""
echo "🔗 npm: https://www.npmjs.com/package/@apify/mcpc"
echo "🔗 tag: https://github.com/apify/mcpc/releases/tag/v$NEW_VERSION"
echo ""
echo "Next steps:"
echo "  - Create a GitHub release at: https://github.com/apify/mcpc/releases/new?tag=v$NEW_VERSION"
