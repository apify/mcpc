# mcpc scripting — JSON mode + jq + pipelines (code mode)
#
#   cd docs/vhs && vhs scripting.tape

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

Hide
Type "export PS1='$ '"
Enter
Type "mcpc connect mcp.apify.com @apify --header \"Authorization: Bearer ${APIFY_TOKEN}\" >/dev/null 2>&1 || true"
Enter
Type "clear"
Enter
Show

Type "# --json emits MCP-spec JSON to stdout, errors to stderr"
Sleep 600ms
Enter
Type "mcpc --json @apify tools-list | jq -r '.[].name' | head -5"
Sleep 400ms
Enter
Sleep 4s

Type "clear"
Enter
Type "# Chain tools across calls with jq + xargs"
Sleep 500ms
Enter
Type "mcpc --json @apify tools-call search-actors keywords:=\"scraper\" limit:=1 \\"
Sleep 200ms
Enter
Type '  | jq -r ".content[0].text | fromjson | .[0].name"'
Sleep 400ms
Enter
Sleep 5s

Type "clear"
Enter
Type "# Snapshot every tool's schema for CI / contract tests"
Sleep 500ms
Enter
Type "for tool in $(mcpc --json @apify tools-list | jq -r '.[].name' | head -3); do"
Sleep 200ms
Enter
Type '  mcpc --json @apify tools-get "$tool" > "/tmp/$tool.json"'
Sleep 200ms
Enter
Type "  echo \"saved /tmp/$tool.json\""
Sleep 200ms
Enter
Type "done"
Sleep 400ms
Enter
Sleep 6s
