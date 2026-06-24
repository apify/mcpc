# mcpc tools — list / get / call
#
#   cd docs/vhs && vhs tools.tape
#
# No auth needed (public ?tools= endpoint); no shell setup.

Output tools.gif

Require mcpc

Set Shell           "bash"
Set FontFamily      "JetBrains Mono"
Set FontSize        16
Set Width           1100
Set Height          650
Set Padding         20
Set TypingSpeed     50ms
Set Theme           "Catppuccin Mocha"
Set WindowBar       Colorful
Set WindowBarSize   32
Set BorderRadius    8

# Hidden: connect a session, start from a clean screen
Hide
Type 'mcpc connect "https://mcp.apify.com/?tools=search-actors,fetch-actor-details,docs" @apify >/dev/null 2>&1 || true'
Enter
Type "clear"
Enter
Show

Type "# Browse the tools exposed by the server"
Sleep 600ms
Enter
Type "mcpc @apify tools-list"
Sleep 400ms
Enter
Sleep 4s

Enter
Type "# Inspect a single tool's input schema and description"
Sleep 500ms
Enter
Type "mcpc @apify tools-get search-actors"
Sleep 400ms
Enter
Sleep 5s

Enter
Type "# Call with auto-parsed key:=value arguments"
Sleep 500ms
Enter
Type 'mcpc @apify tools-call search-actors keywords:="web scraper" limit:=3'
Sleep 400ms
Enter
Sleep 5s

Enter
Type "# Pass complex JSON inline or from stdin"
Sleep 500ms
Enter
Type 'echo '"'"'{"keywords":"crawler","limit":2}'"'"' | mcpc @apify tools-call search-actors'
Sleep 400ms
Enter
Sleep 5s
