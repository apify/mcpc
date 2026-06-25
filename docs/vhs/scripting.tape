# mcpc scripting — JSON mode + jq + pipelines (code mode)
#
#   cd docs/vhs && vhs scripting.tape
#
# No auth needed (Apify public ?tools= endpoint).

Output scripting.gif

Require mcpc
Require jq

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

# Hidden setup: fresh home, prompt styling, connect a session.
Hide
Type 'export MCPC_HOME_DIR="$(mktemp -d)"'
Enter
Type 'export PS1="\[\e[1;38;2;25;230;77m\]$\[\e[0m\] \[\e[1;97m\]"'
Enter
Type "trap 'tput sgr0' DEBUG"
Enter
Type 'mcpc connect "https://mcp.apify.com/?tools=search-actors,fetch-actor-details,docs" @apify >/dev/null 2>&1 || true'
Enter
Sleep 7000ms
Type "clear"
Enter
Sleep 1500ms
Show

Type "mcpc --json @apify tools-list | jq -r '.[].name'"
Sleep 300ms
Enter
Sleep 3000ms

Enter
Type 'mcpc --json @apify tools-call search-actors keywords:="scraper" limit:=1 | jq -r ".content[0].text | fromjson | .[0].name"'
Sleep 300ms
Enter
Sleep 3500ms

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
Sleep 300ms
Enter
Sleep 4000ms
