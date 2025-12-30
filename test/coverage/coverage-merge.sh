#!/bin/bash
# Merge unit and e2e coverage reports into a single nyc-style HTML report
#
# Prerequisites:
#   npm run test:coverage:unit  # Generate unit test coverage
#   npm run test:coverage:e2e   # Generate e2e test coverage
#
# Then run:
#   npm run test:coverage:merge

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

UNIT_JSON="$PROJECT_ROOT/test/coverage/unit/coverage-final.json"
E2E_JSON="$PROJECT_ROOT/test/coverage/e2e/coverage-final.json"
OUTPUT_DIR="$PROJECT_ROOT/test/coverage/merged"
NYC_OUTPUT="$OUTPUT_DIR/.nyc_output"

echo -e "${BLUE}Merging coverage reports...${NC}"

# Check if coverage files exist
missing=()
[[ ! -f "$UNIT_JSON" ]] && missing+=("unit (run: npm run test:coverage:unit)")
[[ ! -f "$E2E_JSON" ]] && missing+=("e2e (run: npm run test:coverage:e2e)")

if [[ ${#missing[@]} -gt 0 ]]; then
  echo -e "${RED}Missing coverage data:${NC}"
  for m in "${missing[@]}"; do
    echo "  - $m"
  done
  exit 1
fi

# Create output directories
rm -rf "$OUTPUT_DIR"
mkdir -p "$NYC_OUTPUT"

# Copy coverage JSON files to nyc output directory
echo "Copying coverage files..."
cp "$UNIT_JSON" "$NYC_OUTPUT/unit.json"
cp "$E2E_JSON" "$NYC_OUTPUT/e2e.json"

# Generate merged report using nyc
echo "Generating merged HTML report..."
cd "$PROJECT_ROOT"
npx nyc report \
  --temp-dir "$NYC_OUTPUT" \
  --report-dir "$OUTPUT_DIR" \
  --reporter=html \
  --reporter=text \
  --reporter=lcov

# Add custom title to HTML report
find "$OUTPUT_DIR" -name "*.html" -exec sed -i '' \
  -e 's/Code coverage report for All files/mcpc Coverage (Merged: Unit + E2E)/g' \
  -e 's/<h1>All files<\/h1>/<h1>Merged Coverage (Unit + E2E)<\/h1>/g' \
  {} \;

echo ""
echo -e "${GREEN}HTML report:${NC}  $OUTPUT_DIR/index.html"
echo -e "${GREEN}LCOV data:${NC}    $OUTPUT_DIR/lcov.info"
