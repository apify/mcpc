#!/bin/bash

# Example AI-generated "code mode" script by Claude Code + Opus 4.5
# Company Lookup Script using mcpc + Apify RAG Web Browser
# Usage: ./company-lookup.sh "Company Name"

COMPANY="${1:-}"

if [ -z "$COMPANY" ]; then
    echo "Usage: $0 \"Company Name\""
    echo "Example: $0 \"Stripe\""
    exit 1
fi

echo "🔍 Looking up: $COMPANY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "⏳ Searching the web..."
echo ""

# Build the query - company name + search terms
QUERY="${COMPANY} company headquarters address"

# Use mcpc with the RAG web browser to fetch results as JSON
# Syntax: query:="value" allows spaces in the value
MARKDOWN=$(mcpc @test tools-call apify-slash-rag-web-browser \
    query:="$QUERY" \
    maxResults:=1 \
    outputFormats:='["markdown"]' \
    --json 2>/dev/null \
    | jq -r '.content[0].text // empty' 2>/dev/null \
    | jq -r '.[0].markdown // empty' 2>/dev/null)

# Check if we got results
if [ -z "$MARKDOWN" ]; then
    echo "❌ No results found for '$COMPANY'"
    exit 1
fi

echo "📄 Company Information:"
echo "────────────────────────────────────────────────────"
# Show first 50 lines of markdown
echo "$MARKDOWN" | head -50

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Done"
