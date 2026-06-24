# mcpc quickstart — first-time user flow
#
#   cd docs/vhs && vhs quickstart.tape
#
# A minimal "connect → list tools → call tool" demo. No auth needed (public
# ?tools= endpoint); no shell setup — VHS's default prompt and TTY color suffice.

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

# Start from a clean screen with no stale session (hidden)
Hide
Type "mcpc @apify close 2>/dev/null; true"
Enter
Type "clear"
Enter
Show

Type "# Connect to any MCP server, get a stateful session"
Sleep 600ms
Enter
Type 'mcpc connect "https://mcp.apify.com/?tools=search-actors,fetch-actor-details,docs" @apify'
Sleep 400ms
Enter
Sleep 3s

Enter
Type "# List the tools the server exposes"
Sleep 500ms
Enter
Type "mcpc @apify tools-list"
Sleep 400ms
Enter
Sleep 4s

Enter
Type "# Call one of them with typed key:=value arguments"
Sleep 500ms
Enter
Type 'mcpc @apify tools-call search-actors keywords:="web scraper" limit:=3'
Sleep 400ms
Enter
Sleep 5s

Enter
Type "mcpc @apify close"
Sleep 400ms
Enter
Sleep 2s
