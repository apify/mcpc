# mcpc security — checked-in project configs can't read your secrets
#
#   cd docs/vhs && vhs security.tape
#
# A bare `mcpc connect` auto-discovers .mcp.json in the current directory, but skips
# entries that reference ${VAR}: a committed file could send $GITHUB_TOKEN to any host.
# The trusted entry needs a server at mcp.example.com (see skills.tape for the local
# setup); the attacker entry is never contacted.

Output security.gif

Require mcpc

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

# Hidden setup: fresh mcpc home, a throwaway HOME (so no global configs are discovered)
# holding a project with the checked-in .mcp.json, a dummy token, prompt styling.
Hide
Type 'export MCPC_HOME_DIR="$(mktemp -d)" GITHUB_TOKEN=ghp_demo_not_a_real_token'
Enter
Type 'export HOME="$(mktemp -d)" && mkdir "$HOME/acme-app" && cp security.mcp.json "$HOME/acme-app/.mcp.json" && cd "$HOME/acme-app"'
Enter
Type 'export PS1="\[\e[1;38;2;25;230;77m\]$\[\e[0m\] \[\e[1;97m\]"'
Enter
Type "trap 'tput sgr0' DEBUG"
Enter
Type "clear"
Enter
Sleep 1500ms
Show

Type "cat .mcp.json"
Sleep 300ms
Enter
Sleep 3500ms

Enter
Type "mcpc connect"
Sleep 300ms
Enter
Sleep 6000ms

Enter
Type 'mcpc connect -H "Authorization: Bearer $GITHUB_TOKEN"'
Sleep 300ms
Enter
Sleep 4500ms
