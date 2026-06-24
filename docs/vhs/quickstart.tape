# mcpc quickstart — first-time user flow
#
#   cd docs/vhs && vhs quickstart.tape
#
# No auth needed (Apify public ?tools= endpoint). Connect -> list -> call -> close.

Output quickstart.gif

Require mcpc

Set Shell           "bash"
Set FontFamily      "JetBrains Mono"
Set FontSize        16
Set Width           1100
Set Height          640
Set Padding         20
Set TypingSpeed     40ms
Set Theme           "Catppuccin Mocha"
Set WindowBar       Colorful
Set WindowBarSize   32
Set BorderRadius    8
Set CursorBlink     true
Set Framerate       24

# Hidden setup: fresh home, bright-green $ prompt + bold-white input.
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

Type 'mcpc connect "https://mcp.apify.com/?tools=search-actors,fetch-actor-details,docs" @apify'
Sleep 300ms
Enter
Sleep 3000ms

Enter
Type "mcpc @apify tools-list"
Sleep 300ms
Enter
Sleep 2800ms

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
