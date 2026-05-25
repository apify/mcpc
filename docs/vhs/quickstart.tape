# mcpc quickstart — first-time user flow
#
# A minimal demo of "install → connect → list tools → call tool".
# Best for the README hero / landing-page GIF.
#
#   cd docs/vhs && vhs quickstart.tape

Output quickstart.gif

Require mcpc

Set Shell           "bash"
Set FontFamily      "JetBrains Mono"
Set FontSize        16
Set Width           1100
Set Height          600
Set Padding         20
Set TypingSpeed     50ms
Set Theme           "Catppuccin Mocha"
Set WindowBar       Colorful
Set WindowBarSize   32
Set BorderRadius    8

Hide
Type "export PS1='$ '"
Enter
Type "mcpc @apify close 2>/dev/null; true"
Enter
Type "clear"
Enter
Show

Type "# Connect to any MCP server, get a stateful session"
Sleep 600ms
Enter
Type 'mcpc connect mcp.apify.com @apify --header "Authorization: Bearer ${APIFY_TOKEN}"'
Sleep 400ms
Enter
Sleep 3s

Type "# List the tools the server exposes"
Sleep 500ms
Enter
Type "mcpc @apify tools-list | head -10"
Sleep 400ms
Enter
Sleep 4s

Type "# Call one of them with typed key:=value arguments"
Sleep 500ms
Enter
Type 'mcpc @apify tools-call search-actors keywords:="web scraper" limit:=3'
Sleep 400ms
Enter
Sleep 5s

Type "mcpc @apify close"
Enter
Sleep 2s
