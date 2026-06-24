# mcpc demo — flagship overview (basic interactions)
#
#   cd docs/vhs && vhs mcpc-demo.tape
#
# Produces mcpc-demo.gif; copy to docs/images/mcpc-demo.gif for the README.
#
# Prerequisites: VHS, mcpc, jq. No auth needed — connects to Apify's public
# MCP endpoint (?tools=...), so anyone or CI can regenerate it. No shell setup:
# VHS's default prompt and TTY color detection keep it clean on their own.

Output mcpc-demo.gif

Require mcpc

Set Shell           "bash"
Set FontFamily      "JetBrains Mono"
Set FontSize        16
Set Width           1100
Set Height          680
Set Padding         20
Set TypingSpeed     36ms
Set PlaybackSpeed   1.0
Set Theme           "Catppuccin Mocha"
Set WindowBar       Colorful
Set WindowBarSize   32
Set BorderRadius    8
Set CursorBlink     true
Set Framerate       24

# Start from a clean screen with no stale session (hidden)
Hide
Type "mcpc @apify close 2>/dev/null; true"
Enter
Type "clear"
Enter
Show

Type "# Connect to any MCP server as a session"
Sleep 250ms
Enter
Type 'mcpc connect "https://mcp.apify.com/?tools=search-actors,fetch-actor-details,docs" @apify'
Sleep 200ms
Enter
Sleep 3500ms

Enter
Type "# List the tools it exposes"
Sleep 250ms
Enter
Type "mcpc @apify tools-list"
Sleep 200ms
Enter
Sleep 2800ms

Enter
Type "# Call a tool with key:=value arguments"
Sleep 250ms
Enter
Type 'mcpc @apify tools-call search-actors keywords:="web scraper" limit:=3'
Sleep 200ms
Enter
Sleep 3500ms

Enter
Type "# --json composes with jq (code mode)"
Sleep 250ms
Enter
Type "mcpc --json @apify tools-list | jq -r '.[].name'"
Sleep 200ms
Enter
Sleep 2500ms

Enter
Type "mcpc @apify close"
Sleep 200ms
Enter
Sleep 1600ms
