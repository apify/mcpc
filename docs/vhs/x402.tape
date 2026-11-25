# mcpc x402 — pay for an MCP server with x402: wallet → challenge → sign → prepaid token → connect → call
#
#   X402_DEMO_HOME=<mcpc home with a funded wallet> vhs x402.tape
#
# Follows the "Full x402 usage example" in README.md against agi.apify.com and
# mcp.apify.com. Each render makes a REAL payment of 1 USDC on Base mainnet, so
# the wallet in $X402_DEMO_HOME must hold at least 1 USDC (no ETH needed: the
# exact scheme is a gasless EIP-3009 signature). The minted token is written to
# $X402_DEMO_HOME/token (never shown on screen) so it can be reused or checked.

Output x402.gif

Require mcpc
Require jq
Require curl

Set Shell           "bash"
Set FontFamily      "JetBrains Mono"
Set FontSize        16
Set Width           1280
Set Height          760
Set Padding         20
Set TypingSpeed     30ms
Set Theme           "Catppuccin Mocha"
Set WindowBar       Colorful
Set WindowBarSize   32
Set BorderRadius    8
Set CursorBlink     true
Set Framerate       24

# Hidden setup: the funded wallet's home, prompt styling, and a PROMPT_COMMAND
# that saves the token off-screen once it exists.
Hide
Type 'export MCPC_HOME_DIR="$X402_DEMO_HOME"'
Enter
Type `export PROMPT_COMMAND='[ -n "$TOKEN" ] && printf %s "$TOKEN" > "$MCPC_HOME_DIR/token"'`
Enter
Type 'export PS1="\[\e[1;38;2;25;230;77m\]$\[\e[0m\] \[\e[1;97m\]"'
Enter
Type "trap 'tput sgr0' DEBUG"
Enter
Type "clear"
Enter
Sleep 1000ms
Show

Type "mcpc x402"
Sleep 300ms
Enter
Sleep 5000ms

Enter
Type "URL='https://agi.apify.com/protocols/x402/prepaid-tokens?amount=1&currency=usd'"
Sleep 300ms
Enter
Sleep 500ms

Type `REQ=$(curl -s -D - -o /dev/null "$URL" | awk -F': ' 'tolower($1)=="payment-required"{print $2}' | tr -d '\r\n')`
Sleep 300ms
Enter
Sleep 2000ms

Enter
Type `echo "$REQ" | base64 -d | jq '.accepts[0]'`
Sleep 300ms
Enter
Sleep 4000ms

Enter
Type `SIG=$(mcpc x402 sign "$REQ" --scheme exact --json | jq -r .paymentSignature)`
Sleep 300ms
Enter
Sleep 2000ms

Type `TOKEN=$(curl -s -H "PAYMENT-SIGNATURE: $SIG" "$URL" | jq -r .token)`
Sleep 300ms
Enter
Sleep 8000ms

Enter
Type `mcpc connect mcp.apify.com @apify --header "Authorization: Bearer $TOKEN"`
Sleep 300ms
Enter
Sleep 9000ms

Enter
Type `mcpc @apify tools-call search-actors keywords:="Google Maps" limit:=3`
Sleep 300ms
Enter
Sleep 9000ms

Enter
Type 'curl -s -H "Authorization: Bearer $TOKEN" https://agi.apify.com/prepaid-tokens/balance | jq'
Sleep 300ms
Enter
Sleep 5000ms
