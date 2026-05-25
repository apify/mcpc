# mcpc tools — list / get / call
#
#   cd docs/vhs && vhs tools.tape

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

Hide
Type "export PS1='$ '"
Enter
Type "mcpc connect mcp.apify.com @apify --header \"Authorization: Bearer ${APIFY_TOKEN}\" >/dev/null 2>&1 || true"
Enter
Type "clear"
Enter
Show

Type "# Browse the tools exposed by the server"
Sleep 600ms
Enter
Type "mcpc @apify tools-list | head -15"
Sleep 400ms
Enter
Sleep 4s

Type "clear"
Enter
Type "# Inspect a single tool's input schema and description"
Sleep 500ms
Enter
Type "mcpc @apify tools-get search-actors"
Sleep 400ms
Enter
Sleep 5s

Type "clear"
Enter
Type "# Call with auto-parsed key:=value arguments"
Sleep 500ms
Enter
Type 'mcpc @apify tools-call search-actors keywords:="web scraper" limit:=3'
Sleep 400ms
Enter
Sleep 5s

Type "clear"
Enter
Type "# Pass complex JSON inline or from stdin"
Sleep 500ms
Enter
Type 'echo '"'"'{"keywords":"crawler","limit":2}'"'"' | mcpc @apify tools-call search-actors'
Sleep 400ms
Enter
Sleep 5s
