# mcpc scripting — JSON mode + jq + pipelines (code mode)
#
#   cd docs/vhs && vhs scripting.tape
#
# No auth needed (public ?tools= endpoint); no shell setup.

Output scripting.gif

Require mcpc
Require jq

Set Shell           "bash"
Set FontFamily      "JetBrains Mono"
Set FontSize        16
Set Width           1200
Set Height          700
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

Type "# --json emits MCP-spec JSON to stdout, errors to stderr"
Sleep 600ms
Enter
Type "mcpc --json @apify tools-list | jq -r '.[].name'"
Sleep 400ms
Enter
Sleep 4s

Enter
Type "# Chain tools across calls with jq"
Sleep 500ms
Enter
Type 'mcpc --json @apify tools-call search-actors keywords:="scraper" limit:=1 | jq -r ".content[0].text | fromjson | .[0].name"'
Sleep 400ms
Enter
Sleep 5s

Enter
Type "# Snapshot every tool's schema for CI / contract tests"
Sleep 500ms
Enter
Type "for tool in $(mcpc --json @apify tools-list | jq -r '.[].name'); do"
Sleep 200ms
Enter
Type '  mcpc --json @apify tools-get "$tool" > "/tmp/$tool.json"'
Sleep 200ms
Enter
Type '  echo "saved /tmp/$tool.json"'
Sleep 200ms
Enter
Type "done"
Sleep 400ms
Enter
Sleep 6s
