# mcpc tasks — MCP Tasks extension (tools-call --task / --detach, tasks-get / -list / -result)
#
#   cd docs/vhs && vhs tasks.tape
#
# Needs a 2026-07-28 server at mcp.example.com that declares the
# io.modelcontextprotocol/tasks extension. The e2e test server serves one (its
# `slow-task` tool is answered with a task):
#   pnpm exec tsx test/e2e/server/index-v2.ts
# fronted by TLS on mcp.example.com (hosts entry + a cert trusted through
# NODE_EXTRA_CA_CERTS, and mcp.example.com in NO_PROXY), exported before running vhs.
# Width 1280 so the tasks-list note fits on one line.

Output tasks.gif

Require mcpc
Require jq

Set Shell           "bash"
Set FontFamily      "JetBrains Mono"
Set FontSize        16
Set Width           1280
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

Type "mcpc @example tools-call slow-task ms:=6000 steps:=3 --task"
Sleep 300ms
Enter
Sleep 8500ms

Enter
Type "TASK=$(mcpc --json @example tools-call slow-task ms:=20000 steps:=4 --detach | jq -r .taskId)"
Sleep 300ms
Enter
Sleep 2000ms

Enter
Type "mcpc @example tasks-get $TASK"
Sleep 300ms
Enter
Sleep 4000ms

Enter
Type "mcpc @example tasks-list"
Sleep 300ms
Enter
Sleep 4000ms

Enter
Type "mcpc @example tasks-result $TASK"
Sleep 300ms
Enter
Sleep 8000ms
