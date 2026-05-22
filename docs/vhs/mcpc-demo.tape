# mcpc demo — flagship overview
#
# Generate the GIF with VHS (https://github.com/charmbracelet/vhs):
#
#   cd docs/vhs && vhs mcpc-demo.tape
#
# This produces mcpc-demo.gif in the current directory. To update the demo
# embedded in the main README, copy it to docs/images/mcpc-demo.gif.
#
# Prerequisites:
#   - VHS:  brew install vhs   (or see https://github.com/charmbracelet/vhs#installation)
#   - mcpc: npm install -g @apify/mcpc
#   - jq:   brew install jq    (for the scripting section)
#   - Auth: export APIFY_TOKEN=... (or remove the --header line to use anonymous access)
#
# This is a template — adapt the commands below for your own server,
# tools, and audience. Use the focused tapes in this folder
# (quickstart.tape, tools.tape, scripting.tape, grep.tape, proxy.tape)
# as a starting point for shorter, single-feature demos.

Output mcpc-demo.gif

Require mcpc

# Look & feel
Set Shell           "bash"
Set FontFamily      "JetBrains Mono"
Set FontSize        16
Set Width           1100
Set Height          650
Set Padding         20
Set TypingSpeed     50ms
Set PlaybackSpeed   1.0
Set Theme           "Catppuccin Mocha"
Set WindowBar       Colorful
Set WindowBarSize   32
Set BorderRadius    8
Set CursorBlink     true

# Hidden setup: clean prompt, no scrollback, fresh state
Hide
Type "export PS1='$ '"
Enter
Type "mcpc @apify close 2>/dev/null; mcpc @fs close 2>/dev/null; true"
Enter
Type "clear"
Enter
Show

# 1. Discover mcpc
Type "# mcpc — a universal MCP CLI client"
Sleep 800ms
Enter
Sleep 600ms

Type "mcpc --help | head -25"
Sleep 400ms
Enter
Sleep 4s

Type "clear"
Enter
Sleep 300ms

# 2. List sessions and OAuth profiles
Type "# No sessions or profiles yet"
Sleep 600ms
Enter
Sleep 400ms

Type "mcpc"
Sleep 400ms
Enter
Sleep 3s

# 3. Connect to a remote MCP server
Type "# Connect to Apify's MCP server as session @apify"
Sleep 600ms
Enter
Sleep 400ms

Type 'mcpc connect mcp.apify.com @apify --header "Authorization: Bearer ${APIFY_TOKEN}"'
Sleep 400ms
Enter
Sleep 3s

# 4. Server info, capabilities, instructions
Type "# Show server capabilities and instructions"
Sleep 600ms
Enter
Sleep 400ms

Type "mcpc @apify"
Sleep 400ms
Enter
Sleep 4s

Type "clear"
Enter
Sleep 300ms

# 5. List available tools
Type "# List available tools"
Sleep 600ms
Enter
Sleep 400ms

Type "mcpc @apify tools-list | head -15"
Sleep 400ms
Enter
Sleep 4s

# 6. Dynamic tool discovery
Type "clear"
Enter
Type "# Find tools by keyword — useful for AI agents"
Sleep 600ms
Enter
Sleep 400ms

Type 'mcpc @apify grep "scraper"'
Sleep 400ms
Enter
Sleep 4s

# 7. Inspect a tool's schema
Type "clear"
Enter
Type "# Inspect a tool's input schema"
Sleep 600ms
Enter
Sleep 400ms

Type "mcpc @apify tools-get search-actors"
Sleep 400ms
Enter
Sleep 5s

# 8. Call a tool
Type "clear"
Enter
Type "# Call a tool with key:=value arguments"
Sleep 600ms
Enter
Sleep 400ms

Type 'mcpc @apify tools-call search-actors keywords:="web scraper" limit:=3'
Sleep 400ms
Enter
Sleep 5s

# 9. JSON mode + jq for scripting (code mode)
Type "clear"
Enter
Type "# JSON mode composes with jq for scripts and agents"
Sleep 600ms
Enter
Sleep 400ms

Type "mcpc --json @apify tools-list | jq -r '.[].name' | head -5"
Sleep 400ms
Enter
Sleep 4s

# 10. Close the session
Type "# Close the session when done"
Sleep 600ms
Enter
Sleep 400ms

Type "mcpc @apify close"
Sleep 400ms
Enter
Sleep 2s

Type "# Learn more: https://github.com/apify/mcpc"
Sleep 2s
Enter
Sleep 1500ms
