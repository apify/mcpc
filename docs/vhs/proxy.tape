# mcpc proxy — AI sandbox: expose a credentialed session without leaking tokens
#
#   cd docs/vhs && vhs proxy.tape

Output proxy.gif

Require mcpc

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
Type "mcpc @relay close 2>/dev/null; mcpc @sandbox close 2>/dev/null; true"
Enter
Type "clear"
Enter
Show

Type "# Human authenticates once and exposes a localhost MCP proxy"
Sleep 600ms
Enter
Type 'mcpc connect mcp.apify.com @relay --header "Authorization: Bearer ${APIFY_TOKEN}" --proxy 8080'
Sleep 400ms
Enter
Sleep 4s

Type "# The proxy forwards MCP traffic but hides the upstream token"
Sleep 600ms
Enter
Type "mcpc"
Sleep 400ms
Enter
Sleep 4s

Type "clear"
Enter
Type "# An AI agent (or another tool) connects to the proxy as a normal MCP server"
Sleep 600ms
Enter
Type "mcpc connect localhost:8080 @sandbox"
Sleep 400ms
Enter
Sleep 3s

Type "mcpc @sandbox tools-list | head -8"
Sleep 400ms
Enter
Sleep 5s

Type "clear"
Enter
Type "# Tear down both sides"
Sleep 500ms
Enter
Type "mcpc @sandbox close && mcpc @relay close"
Sleep 400ms
Enter
Sleep 2s
