# mcpc demo — flagship overview (~30s, basic interactions)
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
#   - jq:   brew install jq    (for the code-mode section)
#
# No auth needed: this demo uses Apify's public MCP endpoint with a pinned set
# of read-only tools (?tools=...), so anyone — or CI — can regenerate the GIF.
#
# Notes:
#   - Each step clears the screen and leaves a blank line before the command so
#     its output reads on its own — like a normal terminal session.
#   - mcpc disables color off a TTY, so the setup exports FORCE_COLOR=3 and
#     COLORTERM=truecolor to keep the real (vivid) palette.
#   - Swap the server URL for any other MCP server to record a different demo.
#   - Focused, single-feature demos live alongside this one (quickstart.tape,
#     tools.tape, scripting.tape, grep.tape, proxy.tape).

Output mcpc-demo.gif

Require mcpc

# Look & feel
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

# Hidden setup: green prompt, vivid color through the session, fresh state
Hide
Type 'export PS1="\[\e[38;2;25;230;77m\]$\[\e[0m\] "'
Enter
Type "export FORCE_COLOR=3"
Enter
Type "export COLORTERM=truecolor"
Enter
Type "mcpc @apify close 2>/dev/null; true"
Enter
Type "clear"
Enter
Show

# 1. Connect to a remote MCP server
Enter
Type "# Connect to any MCP server as a session"
Sleep 250ms
Enter
Type 'mcpc connect "https://mcp.apify.com/?tools=search-actors,fetch-actor-details,docs" @apify | head -13'
Sleep 200ms
Enter
Sleep 3000ms

# 2. List available tools
Hide
Type "clear"
Enter
Show
Enter
Type "# List the tools it exposes"
Sleep 250ms
Enter
Type "mcpc @apify tools-list"
Sleep 200ms
Enter
Sleep 2800ms

# 3. Call a tool with typed arguments
Hide
Type "clear"
Enter
Show
Enter
Type "# Call a tool with key:=value arguments"
Sleep 250ms
Enter
Type 'mcpc @apify tools-call search-actors keywords:="web scraper" limit:=3 | head -16'
Sleep 200ms
Enter
Sleep 2800ms

# 4. JSON mode + jq for scripting (code mode)
Hide
Type "clear"
Enter
Show
Enter
Type "# --json composes with jq (code mode)"
Sleep 250ms
Enter
Type "mcpc --json @apify tools-list | jq -r '.[].name'"
Sleep 200ms
Enter
Sleep 2300ms

# 5. Close the session
Hide
Type "clear"
Enter
Show
Enter
Type "mcpc @apify close"
Sleep 200ms
Enter
Sleep 1600ms
