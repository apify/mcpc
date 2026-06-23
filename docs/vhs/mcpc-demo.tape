# mcpc demo — flagship overview (≤30s, basic interactions)
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
#   - Auth: export APIFY_TOKEN=...   (use a short-lived token from a TEST account,
#           never a production one — see skills/record-demo/SKILL.md)
#
# Notes:
#   - `2>/dev/null` on connect just hides a "keychain unavailable" notice shown
#     on machines without a keyring daemon (CI/containers); drop it on a desktop.
#   - The screen is cleared (hidden) before each step so commands start fresh;
#     `| head` trims the chattier outputs so each step fits on screen.
#   - mcpc disables color off a TTY, so the setup exports FORCE_COLOR=3 and
#     COLORTERM=truecolor to keep the real (vivid) palette through the pipes.
#   - Drop the `-H` line and point at any public MCP server to record anonymously.
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

# Hidden setup: clean prompt, no scrollback, fresh state
Hide
Type "export PS1='$ '"
Enter
# Force vivid color through pipes (| head, | jq): mcpc disables color off a TTY,
# and basic-16 would mute the palette, so COLORTERM keeps the real truecolor hex.
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
Type "# Connect to any MCP server as a session"
Sleep 200ms
Enter
Type 'mcpc connect mcp.apify.com @apify -H "Authorization: Bearer $APIFY_TOKEN" 2>/dev/null | head -13'
Sleep 150ms
Enter
Sleep 3000ms

# 2. List available tools (start on a fresh screen)
Hide
Type "clear"
Enter
Show
Type "# List the tools it exposes"
Sleep 200ms
Enter
Type "mcpc @apify tools-list | head -12"
Sleep 150ms
Enter
Sleep 1600ms

# 3. Call a tool with typed arguments (start on a fresh screen)
Hide
Type "clear"
Enter
Show
Type "# Call a tool with key:=value arguments"
Sleep 200ms
Enter
Type 'mcpc @apify tools-call search-actors keywords:="web scraper" limit:=3 | head -16'
Sleep 150ms
Enter
Sleep 2100ms

# 4. JSON mode + jq for scripting (code mode) (start on a fresh screen)
Hide
Type "clear"
Enter
Show
Type "# --json composes with jq (code mode)"
Sleep 200ms
Enter
Type "mcpc --json @apify tools-list | jq -r '.[].name' | head -5"
Sleep 150ms
Enter
Sleep 1600ms

# 5. Close the session (start on a fresh screen)
Hide
Type "clear"
Enter
Show
Type "mcpc @apify close"
Sleep 150ms
Enter
Sleep 1200ms
