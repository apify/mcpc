# mcpc grep — dynamic tool discovery across multiple sessions
#
#   cd docs/vhs && vhs grep.tape
#
# No auth needed. Connects two servers so grep has more than one to search:
#   - Apify's public ?tools= endpoint (remote HTTP)
#   - a local filesystem stdio server (mcp.json:filesystem)
# Prereq: npm i -g @modelcontextprotocol/server-filesystem

Output grep.gif

Require mcpc

Set Shell           "bash"
Set FontFamily      "JetBrains Mono"
Set FontSize        16
Set Width           1100
Set Height          680
Set Padding         20
Set TypingSpeed     40ms
Set Theme           "Catppuccin Mocha"
Set WindowBar       Colorful
Set WindowBarSize   32
Set BorderRadius    8
Set CursorBlink     true
Set Framerate       24

# Hidden setup: fresh home, bright-green $ prompt + bold-white input, two sessions.
# Sleep after each connect so both are live before the visible commands run.
Hide
Type 'export MCPC_HOME_DIR="$(mktemp -d)"'
Enter
Type 'export PS1="\[\e[1;38;2;25;230;77m\]$\[\e[0m\] \[\e[1;97m\]"'
Enter
Type "trap 'tput sgr0' DEBUG"
Enter
Type 'mcpc connect "https://mcp.apify.com/?tools=search-actors,fetch-actor-details,docs" @apify >/dev/null 2>&1 || true'
Enter
Type "mcpc connect mcp.json:filesystem >/dev/null 2>&1 || true"
Enter
Sleep 8000ms
Type "clear"
Enter
Sleep 1500ms
Show

Type "mcpc"
Sleep 300ms
Enter
Sleep 2500ms

Enter
Type "mcpc grep search"
Sleep 300ms
Enter
Sleep 3000ms

Enter
Type 'mcpc grep "read|write" -E'
Sleep 300ms
Enter
Sleep 3000ms

Enter
Type "mcpc grep file -m 5"
Sleep 300ms
Enter
Sleep 3000ms
