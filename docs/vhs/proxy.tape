# mcpc proxy — AI sandbox: expose a credentialed session without leaking tokens
#
#   cd docs/vhs && vhs proxy.tape
#
# This tape keeps auth on purpose — it demos proxying a token-backed session.
# Set APIFY_TOKEN (a test-account token) before recording. No shell setup otherwise.

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

# Hidden: tear down any prior sessions, start from a clean screen
Hide
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

Enter
Type "# The proxy forwards MCP traffic but hides the upstream token"
Sleep 600ms
Enter
Type "mcpc"
Sleep 400ms
Enter
Sleep 4s

Enter
Type "# An AI agent (or another tool) connects to the proxy as a normal MCP server"
Sleep 600ms
Enter
Type "mcpc connect localhost:8080 @sandbox"
Sleep 400ms
Enter
Sleep 3s

Enter
Type "mcpc @sandbox tools-list"
Sleep 400ms
Enter
Sleep 5s

Enter
Type "# Tear down both sides"
Sleep 500ms
Enter
Type "mcpc @sandbox close && mcpc @relay close"
Sleep 400ms
Enter
Sleep 2s
