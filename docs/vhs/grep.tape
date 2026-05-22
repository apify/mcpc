# mcpc grep — dynamic tool discovery across sessions
#
#   cd docs/vhs && vhs grep.tape

Output grep.gif

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
Type "mcpc connect mcp.apify.com @apify --header \"Authorization: Bearer ${APIFY_TOKEN}\" >/dev/null 2>&1 || true"
Enter
Type "clear"
Enter
Show

Type "# Find tools by keyword across every live session"
Sleep 600ms
Enter
Type 'mcpc grep "scraper"'
Sleep 400ms
Enter
Sleep 4s

Type "clear"
Enter
Type "# Regex + case-sensitive, limited results"
Sleep 500ms
Enter
Type 'mcpc grep "search|find" -E -m 5'
Sleep 400ms
Enter
Sleep 4s

Type "clear"
Enter
Type "# Search resources and prompts too"
Sleep 500ms
Enter
Type 'mcpc grep "config" --resources --prompts'
Sleep 400ms
Enter
Sleep 4s
