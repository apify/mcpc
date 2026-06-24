# mcpc demo — basic use (local stdio server + remote HTTP server)
#
#   cd docs/vhs && vhs mcpc-demo.tape
#
# Produces mcpc-demo.gif; copy to docs/images/mcpc-demo.gif for the README.
#
# Prerequisites:
#   - VHS:        brew install vhs
#   - mcpc:       npm install -g @apify/mcpc
#   - filesystem: npm install -g @modelcontextprotocol/server-filesystem
#                 (the stdio server launched via mcp.json)
#   - APIFY_TOKEN: a short-lived, low-permission test token, exported before
#                  recording, for the remote connect step. Only the variable
#                  name is shown on screen, never the value.

Output mcpc-demo.gif

Require mcpc

Set Shell           "bash"
Set FontFamily      "JetBrains Mono"
Set FontSize        16
Set Width           1100
Set Height          700
Set Padding         20
Set TypingSpeed     40ms
Set PlaybackSpeed   1.0
Set Theme           "Catppuccin Mocha"
Set WindowBar       Colorful
Set WindowBarSize   32
Set BorderRadius    8
Set CursorBlink     true
Set Framerate       24

# Hidden setup: fresh empty home, bright-green $ prompt, bold-white typed input.
# The DEBUG trap resets attributes before each command so the bold-white input
# never bleeds into command output.
Hide
Type 'export MCPC_HOME_DIR="$(mktemp -d)"'
Enter
Type 'export PS1="\[\e[1;38;2;25;230;77m\]$\[\e[0m\] \[\e[1;97m\]"'
Enter
Type "trap 'tput sgr0' DEBUG"
Enter
Type "clear"
Enter
Show

Type "mcpc"
Sleep 300ms
Enter
Sleep 2200ms

Enter
Type "mcpc connect mcp.json:filesystem"
Sleep 300ms
Enter
Sleep 3000ms

Enter
Type "mcpc"
Sleep 300ms
Enter
Sleep 2200ms

Enter
Type "mcpc @filesystem tools-list"
Sleep 300ms
Enter
Sleep 2800ms

Enter
Type "mcpc @filesystem tools-list --json"
Sleep 300ms
Enter
Sleep 2800ms

Enter
Type 'mcpc connect mcp.apify.com -H "Authorization: Bearer $APIFY_TOKEN"'
Sleep 300ms
Enter
Sleep 3200ms

Enter
Type "mcpc @apify tools-list"
Sleep 300ms
Enter
Sleep 2800ms

Enter
Type "mcpc @apify tools-get search-actors"
Sleep 300ms
Enter
Sleep 3000ms

Enter
Type 'mcpc @apify tools-call search-actors keywords:="web scraper" limit:=3'
Sleep 300ms
Enter
Sleep 3200ms

Enter
Type "mcpc @apify close"
Sleep 300ms
Enter
Sleep 1800ms
