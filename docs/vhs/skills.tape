# mcpc skills — MCP Skills extension (skills-list / skills-get)
#
#   cd docs/vhs && vhs skills.tape
#
# Needs a 2026-07-28 server at mcp.example.com that declares the
# io.modelcontextprotocol/skills extension. The e2e test server serves one:
#   WITH_SKILLS=true pnpm exec tsx test/e2e/server/index-v2.ts
# fronted by TLS on mcp.example.com (hosts entry + a cert trusted through
# NODE_EXTRA_CA_CERTS, and mcp.example.com in NO_PROXY), exported before running vhs.

Output skills.gif

Require mcpc

Set Shell           "bash"
Set FontFamily      "JetBrains Mono"
Set FontSize        16
Set Width           1100
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
Type 'mcpc connect mcp.example.com @example >/dev/null 2>&1 || true'
Enter
Sleep 7000ms
Type "clear"
Enter
Sleep 1500ms
Show

Type "mcpc @example skills-list"
Sleep 300ms
Enter
Sleep 3500ms

Enter
Type "mcpc @example skills-get refunds"
Sleep 300ms
Enter
Sleep 5000ms

Enter
Type "mcpc @example skills-get refunds templates/invoice.md"
Sleep 300ms
Enter
Sleep 4000ms
