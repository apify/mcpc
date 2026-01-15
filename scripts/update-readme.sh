#!/bin/bash
# Updates README.md:
# 1. Updates Usage section with output from "mcpc --help"
# 2. Updates table of contents
# 3. Checks for broken internal links

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
README="$PROJECT_ROOT/README.md"

# Marker that identifies the auto-generated help section
HELP_MARKER="<!-- AUTO-GENERATED: mcpc --help -->"

# Step 1: Update Usage section with mcpc --help output
echo "Updating Usage section..."

# Check that the marker exists in README
if ! grep -q "$HELP_MARKER" "$README"; then
  echo "ERROR: Marker not found in README.md: $HELP_MARKER" >&2
  exit 1
fi

TEMP_HELP=$(mktemp)
TEMP_README=$(mktemp)

# Get help output, remove the "Full docs:" line and trailing empty line
mcpc --help | sed '/^Full docs:/d' | sed '${/^$/d;}' > "$TEMP_HELP"

# Use awk to replace content in the code block following the marker
awk -v marker="$HELP_MARKER" '
    index($0, marker) {
        print
        marker_found = 1
        next
    }
    marker_found && /^```$/ && in_code {
        # End of code block - insert new content
        print "```"
        while ((getline line < "'"$TEMP_HELP"'") > 0) {
            print line
        }
        print "```"
        marker_found = 0
        in_code = 0
        next
    }
    marker_found && /^```/ {
        # Start of code block after marker
        in_code = 1
        next
    }
    marker_found && in_code {
        # Skip old content inside code block
        next
    }
    { print }
' "$README" > "$TEMP_README"

mv "$TEMP_README" "$README"
rm -f "$TEMP_HELP"
echo "  Done"

# Step 2: Update table of contents
echo "Updating table of contents..."
doctoc "$README" --github --notitle --maxlevel 2
# Remove mcpc: entries from TOC (internal anchors that shouldn't be in TOC)
sed -i '' '/^- \[mcpc:/d' "$README"
echo "  Done"

# Step 3: Check for broken internal links
echo "Checking internal links..."
markdown-link-check "$README" --config "$SCRIPT_DIR/markdown-link-check.json"
echo "  Done"

echo ""
echo "README.md updated successfully!"
