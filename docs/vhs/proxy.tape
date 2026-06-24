# mcpc proxy — AI sandbox: expose a credentialed session without leaking tokens
#
#   cd docs/vhs && vhs proxy.tape
#
# Keeps auth on purpose (it demos proxying a token-backed session). Export a
# short-lived, low-permission test token before recording: export APIFY_TOKEN=...
# Only the variable name appears on screen, never the value.

Output proxy.gif

Require mcpc

Set Shell           "bash"
Set FontFamily      "JetBrains Mono"
Set FontSize        16
Set Width           1200
Set Height          700
Set Padding         20
Set TypingSpeed     40ms
Set Theme           "Catppuccin Mocha"
Set WindowBar       Colorful
Set WindowBarSize   32
Set BorderRadius    8
Set CursorBlink     true
Set Framerate       24

# Hidden setup: fresh home, prompt styling.
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

Type 'mcpc connect mcp.apify.com @relay -H "Authorization: Bearer $APIFY_TOKEN" --proxy 8080'
Sleep 300ms
Enter
Sleep 4000ms

Enter
Type "mcpc"
Sleep 300ms
Enter
Sleep 3000ms

Enter
Type "mcpc connect localhost:8080 @sandbox"
Sleep 300ms
Enter
Sleep 3500ms

Enter
Type "mcpc @sandbox tools-list"
Sleep 300ms
Enter
Sleep 3000ms

Enter
Type "mcpc @sandbox close && mcpc @relay close"
Sleep 300ms
Enter
Sleep 2000ms
