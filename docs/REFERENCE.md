<!-- AUTO-GENERATED FILE, DO NOT EDIT. Run `pnpm run build:reference` to regenerate. -->

# mcpc command reference

Complete `--help` output for every `mcpc` command, in the order the commands are listed
by `mcpc --help`. It is generated from the CLI itself, so it always matches the installed
version — run `mcpc help <command>` to get the same text in your terminal.

New to mcpc? Start with the [README](../README.md), or run `mcpc help --skill` for the agent guide.

- [`mcpc connect`](#mcpc-connect)
- [`mcpc close`](#mcpc-close)
- [`mcpc restart`](#mcpc-restart)
- [`mcpc login`](#mcpc-login)
- [`mcpc logout`](#mcpc-logout)
- [`mcpc clean`](#mcpc-clean)
- [`mcpc grep`](#mcpc-grep)
- [`mcpc x402`](#mcpc-x402)
  - [`mcpc x402 init`](#mcpc-x402-init)
  - [`mcpc x402 import`](#mcpc-x402-import)
  - [`mcpc x402 remove`](#mcpc-x402-remove)
  - [`mcpc x402 sign`](#mcpc-x402-sign)
- [`mcpc help`](#mcpc-help)
- [`mcpc @<session>`](#mcpc-session)
  - [`mcpc @<session> close`](#mcpc-session-close)
  - [`mcpc @<session> restart`](#mcpc-session-restart)
  - [`mcpc @<session> grep`](#mcpc-session-grep)
  - [`mcpc @<session> tools-list`](#mcpc-session-tools-list)
  - [`mcpc @<session> tools-get`](#mcpc-session-tools-get)
  - [`mcpc @<session> tools-call`](#mcpc-session-tools-call)
  - [`mcpc @<session> tasks-list`](#mcpc-session-tasks-list)
  - [`mcpc @<session> tasks-get`](#mcpc-session-tasks-get)
  - [`mcpc @<session> tasks-result`](#mcpc-session-tasks-result)
  - [`mcpc @<session> tasks-cancel`](#mcpc-session-tasks-cancel)
  - [`mcpc @<session> prompts-list`](#mcpc-session-prompts-list)
  - [`mcpc @<session> prompts-get`](#mcpc-session-prompts-get)
  - [`mcpc @<session> resources-list`](#mcpc-session-resources-list)
  - [`mcpc @<session> resources-read`](#mcpc-session-resources-read)
  - [`mcpc @<session> resources-subscribe`](#mcpc-session-resources-subscribe)
  - [`mcpc @<session> resources-unsubscribe`](#mcpc-session-resources-unsubscribe)
  - [`mcpc @<session> resources-templates-list`](#mcpc-session-resources-templates-list)
  - [`mcpc @<session> skills-list`](#mcpc-session-skills-list)
  - [`mcpc @<session> skills-get`](#mcpc-session-skills-get)
  - [`mcpc @<session> logging-set-level`](#mcpc-session-logging-set-level)
  - [`mcpc @<session> ping`](#mcpc-session-ping)
  - [`mcpc @<session> server-discover`](#mcpc-session-server-discover)
  - [`mcpc @<session> logs`](#mcpc-session-logs)

## `mcpc`

```text
Usage: mcpc [<@session>] [<command>] [options]

Universal command-line client for the Model Context Protocol (MCP).

Commands:
  connect [<server>] [@session]  Connect to an MCP server and start a new named @session
  close <@session>               Close a session
  restart <@session>             Restart a session (losing all state)
  login <server>                 Log in to a server and save an OAuth profile
  logout <server>                Delete an OAuth profile for a server
  clean [resources...]           Clean up mcpc data (sessions, profiles, logs, all)
  grep <pattern>                 Search tools and instructions across all active sessions
  x402 [subcommand] [args...]    Configure an x402 payment wallet (EXPERIMENTAL)
  help [command] [subcommand]    Show help for a command

Options:
  --json                         Output in JSON format for scripting
  --verbose                      Enable debug logging
  --profile <name>               OAuth profile for the server ("default" if not provided)
  --timeout <seconds>            Request timeout in seconds (default: 60)
  --max-chars <n>                Truncate output to n characters (ignored in --json mode)
  --insecure                     Skip TLS certificate verification (for self-signed certs)
  -v, --version                  Output the version number
  -h, --help                     Display help

MCP session commands (after connecting):
  <@session>                     Show MCP server info, capabilities, and tools overview
  <@session> grep <pattern>      Search tools and instructions
  <@session> tools-list          List all server tools
  <@session> tools-get <name>    Get tool details and schema
  <@session> tools-call <name> [arg:=val ... | <json> | <stdin]
  <@session> tasks-list
  <@session> tasks-get <taskId>
  <@session> tasks-result <taskId>
  <@session> tasks-cancel <taskId>
  <@session> prompts-list
  <@session> prompts-get <name> [arg:=val ... | <json> | <stdin]
  <@session> resources-list
  <@session> resources-read <uri> [-o <file> | --raw]
  <@session> resources-subscribe <uri> <file>
  <@session> resources-unsubscribe <uri>
  <@session> resources-templates-list
  <@session> skills-list
  <@session> skills-get <name> [--raw]
  <@session> logging-set-level <level>
  <@session> ping
  <@session> server-discover
  <@session> logs [-n N] [--follow] [--since 1h]

Run "mcpc" without arguments to show active sessions and OAuth profiles.
Run "mcpc --json" to get the same data as `{ sessions: [...], profiles: [...] }`.

Agent guide: mcpc help --skill
```

## `mcpc connect`

```text
Usage: mcpc connect [<server>] [@session] [options]

Connect to an MCP server and start a new named @session

Options:
  -H, --header <header>         HTTP header (can be repeated)
  --profile <name>              OAuth profile to use ("default" if skipped)
  --no-profile                  Skip OAuth profile (connect anonymously)
  --proxy <[host:]port>         Start proxy MCP server for session
  --proxy-bearer-token <token>  Require authentication for access to proxy server
  --stdio                       Launch all local stdio servers from selected config files
  --protocol-version <version>  Pin the MCP protocol version (see below)
  --x402 [scheme]               Enable x402 auto-payment (see below)
  --json                        Output in JSON format

Server formats:
  mcp.apify.com                 Remote HTTP server (https:// auto-added)
  ~/.vscode/mcp.json:puppeteer  Config file entry (file:entry)
  ~/.vscode/mcp.json            Config file — connect every entry
  (no server)                   Auto-discover configs and connect everything

Auto-discovery (no server arg):
  Scans ./ and ~ for .mcp.json, mcp.json, mcp_config.json, .cursor/mcp.json,
  .vscode/mcp.json, .kiro/settings/mcp.json, ~/.claude.json,
  ~/.codeium/windsurf/mcp_config.json, plus VS Code & Claude Desktop configs.

Session name:
  Omit @session to auto-generate from the server (mcp.apify.com → @apify)
  or config entry. Matching sessions (same server, profile, header keys)
  are reused. Bulk connects don't accept @session.

Stdio servers (command-based, run locally):
  Config entries spawn the command on connect, even if the handshake
  later fails — only connect to configs you trust. Bulk connects skip
  stdio by default; pass --stdio to include them.

Protocol version:
  mcpc negotiates the newest MCP version both sides support, from
  2026-07-28 down to 2024-10-07. Pass --protocol-version to pin one exact
  version instead — the connection fails if the server does not offer it.
  Run mcpc @session to see the negotiated version.

x402 payments (experimental):
  --x402 pays for paid tool calls from the wallet set up with mcpc x402.
  Schemes: auto (default, prefers upto), upto, exact.

Output:
  For a single server, shows session, server info, capabilities, and tools.
  Bulk connects list every session with its state, then a summary.

JSON output (--json):
  Array of `InitializeResult` or `DiscoverResult` objects extended with `toolNames` and `_mcpc`:
  `[{ protocolVersion?, supportedVersions?, capabilities?, serverInfo?, instructions?, _meta?, toolNames?, _mcpc: { ... } }]`
  Schema: https://modelcontextprotocol.io/specification/2025-11-25/schema#initializeresult
          https://modelcontextprotocol.io/specification/2026-07-28/schema#discoverresult
```

## `mcpc close`

```text
Usage: mcpc close <@session> [options]

Close a session

Options:
  --json  Output in JSON format

JSON output (--json):
  `{ sessionName, closed: true }`
```

## `mcpc restart`

```text
Usage: mcpc restart <@session> [options]

Restart a session (losing all state)

Options:
  --json  Output in JSON format

Output:
  After restarting, shows session, server info, capabilities, and tools.

JSON output (--json):
  `InitializeResult` or `DiscoverResult` object extended with `toolNames` and `_mcpc`:
  `{ protocolVersion?, supportedVersions?, capabilities?, serverInfo?, instructions?, _meta?, toolNames?, _mcpc: { ... } }`
  Schema: https://modelcontextprotocol.io/specification/2025-11-25/schema#initializeresult
          https://modelcontextprotocol.io/specification/2026-07-28/schema#discoverresult
```

## `mcpc login`

```text
Usage: mcpc login <server> [options]

Log in to a server and save an OAuth profile

Options:
  --profile <name>              Profile name (default: "default")
  --scope <scopes>              OAuth scopes to request (e.g. --scope "read write")
  --grant <type>                Grant: authorization-code (default), client-credentials, id-jag
  --client-id <id>              Pre-registered OAuth client ID (skips CIMD and DCR)
  --client-secret <secret>      Pre-registered OAuth client secret (requires --client-id)
  --client-key <pem-or-path>    Private key (PEM path or literal) for private_key_jwt auth
  --client-key-alg <alg>        JWT signing algorithm for --client-key (default: RS256)
  --token-endpoint <url>        OAuth token endpoint (client-credentials only, auto-discovered)
  --idp <url>                   Enterprise IdP issuer URL (id-jag only)
  --idp-client-id <id>          Client ID pre-registered at the enterprise IdP (id-jag only)
  --idp-client-secret <secret>  Client secret for the enterprise IdP (id-jag only)
  --idp-scope <scopes>          OIDC scopes for the IdP SSO (id-jag only, see below)
  --client-metadata-url <url>   HTTPS URL of an OAuth CIMD (default: mcpc CIMD)
  --no-client-metadata-url      Disable CIMD; force DCR on CIMD-capable servers
  --callback-port <port>        Loopback port for OAuth callback (default: 13316/31613/16133)
  --callback-host <host>        OAuth callback host: 127.0.0.1 (default) or localhost
  --json                        Output in JSON format

Interactive login:
  By default, the command opens your browser to authorize the server,
  then saves the credentials as a reusable profile any session can use:

  default profile: mcpc login mcp.apify.com
  named profile:   mcpc login mcp.apify.com --profile work
  then connect:    mcpc connect mcp.apify.com @app --profile work

Client registration (how mcpc identifies itself to the server):
  1. Client ID Metadata Documents (CIMD): the default. mcpc's hosted CIMD at
     https://apify.github.io/mcpc/client-metadata.json identifies all mcpc
     installs as one client. Override with --client-metadata-url <url>, or
     disable with --no-client-metadata-url.
  2. Pre-registration: pass --client-id (and --client-secret if issued). If the
     client's redirect URI uses localhost (e.g. localhost:3118), match it with
     --callback-host localhost --callback-port 3118.
  3. Dynamic Client Registration (DCR): fallback when CIMD is unsupported or
     disabled and the server exposes a registration_endpoint.

  See https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

Machine-to-machine authentication (for CI/CD and daemons):
  Pass --grant client-credentials, --client-id, and one credential:

  mcpc login mcp.example.com --grant client-credentials \
    --client-id my-svc --client-secret s3cr3t --scope "read write"
  mcpc login mcp.example.com --grant client-credentials \
    --client-id my-svc --client-key ./key.pem

  --client-secret uses client_secret_basic; --client-key signs a private_key_jwt
  assertion (RFC 7523). The token endpoint is auto-discovered; pin it with
  --token-endpoint <url> for servers without discoverable metadata.

  See https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials

Enterprise-managed authorization (SSO via your organization's IdP):
  Pass --grant id-jag when your organization controls MCP server access
  centrally through its identity provider (e.g. Okta). You sign in once with
  your corporate SSO; mcpc then obtains MCP tokens via identity assertion
  grants (ID-JAG) without any per-server consent screens:

  mcpc login mcp.example.com --grant id-jag \
    --idp https://acme.okta.com --idp-client-id <idp-client> \
    --client-id <mcp-as-client> --client-secret <secret>

  Both clients are pre-registered by your IT team: --idp-client-id at the
  enterprise IdP (add --idp-client-secret if it is a confidential client),
  --client-id/--client-secret at the MCP server's authorization server.
  --scope requests MCP-server scopes; --idp-scope overrides the OIDC scopes
  used for the SSO itself (default: "openid profile email offline_access").

  See https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization

JSON output (--json):
  Interactive prompts go to stderr; stdout is a clean JSON object:
  `{ profile, serverUrl, scopes }`
```

## `mcpc logout`

```text
Usage: mcpc logout <server> [options]

Delete an OAuth profile for a server

Options:
  --profile <name>  Profile name (default: "default")
  --json            Output in JSON format

JSON output (--json):
  `{ profile, serverUrl, deleted: true, affectedSessions }`
```

## `mcpc clean`

```text
Usage: mcpc clean [options] [resources...]

Clean up mcpc data (sessions, profiles, logs, all)

Options:
  --json  Output in JSON format

Resources:
  sessions    Remove stale/crashed session records
  profiles    Remove authentication profiles
  logs        Remove bridge log files
  all         Remove all of the above

  Without arguments, performs safe cleanup of stale data only.

JSON output (--json):
  `{ crashedBridges, expiredSessions, orphanedBridgeLogs, sessions, profiles, logs }`
```

## `mcpc grep`

```text
Usage: mcpc grep <pattern> [options]

Search tools and instructions across all active sessions

Options:
  --tools                Search tools
  --resources            Search resources
  --prompts              Search prompts
  --instructions         Search server instructions
  -E, --regex            Treat pattern as a regular expression
  -s, --case-sensitive   Case-sensitive matching
  -m, --max-results <n>  Limit the number of results
  --json                 Output in JSON format

Type filters:
  By default, tools and instructions are searched. Use --resources or --prompts
  to search those instead. Combine flags to search multiple types (e.g. --tools --resources).

Examples:
  mcpc grep "search"                        Search tools and instructions in all sessions
  mcpc grep "search" --resources            Search resources only
  mcpc grep "search" --tools --prompts      Search tools and prompts
  mcpc grep "search|find" -E                Regex search across tools and instructions
  mcpc @apify grep "actor"                  Search within a single session
  mcpc grep "file" --json                   JSON output for scripting
  mcpc grep "actor" -m 5                    Show at most 5 results

Exit codes:
  0 = matches found, 1 = no matches (grep convention)

JSON output (--json):
  `[{ sessionName, tools?: Tool[], resources?: Resource[], prompts?: Prompt[], instructions?: string[] }]`
```

## `mcpc x402`

```text
Usage: mcpc x402 [options] [command]

x402 wallet management and payment signing (EXPERIMENTAL)

Options:
  --json                             Output in JSON format
  --verbose                          Enable debug logging
  -h, --help                         Display help

Commands:
  init                               Create a new x402 wallet (generates a random private key)
  import <private-key>               Import an existing wallet from a private key
  remove                             Remove the wallet
  sign [options] <payment-required>  Sign a payment from a base64 PAYMENT-REQUIRED header
  help [command]                     Display help for command

sign options:
  --amount <usd>         Override amount in USD (for upto: max authorization cap)
  --expiry <seconds>     Override expiry in seconds
  --scheme <preference>  Payment scheme: auto (default), upto, or exact
  --no-approve           Skip the upto Permit2 allowance check & auto-approval

JSON output (--json):
  `{ address, createdAt, balances: { eth, usdc } | null }` (null if no wallet)
```

### `mcpc x402 init`

```text
Usage: mcpc x402 init [options]

Create a new x402 wallet (generates a random private key)

Options:
  -h, --help  Display help

JSON output (--json):
  `{ address }`
```

### `mcpc x402 import`

```text
Usage: mcpc x402 import [options] <private-key>

Import an existing wallet from a private key

Options:
  -h, --help  Display help

JSON output (--json):
  `{ address }`
```

### `mcpc x402 remove`

```text
Usage: mcpc x402 remove [options]

Remove the wallet

Options:
  -h, --help  Display help

JSON output (--json):
  `{ removed: true }`
```

### `mcpc x402 sign`

```text
Usage: mcpc x402 sign [options] <payment-required>

Sign a payment from a base64 PAYMENT-REQUIRED header

Options:
  --amount <usd>              Override amount in USD (for upto: max authorization cap)
  --expiry <seconds>          Override expiry in seconds
  --scheme <auto|upto|exact>  Payment scheme preference (default: "auto")
  --no-approve                Skip the upto Permit2 allowance check & auto-approval
  -h, --help                  Display help

Signs the given base64-encoded PAYMENT-REQUIRED header offline using the configured
wallet and prints the resulting PAYMENT-SIGNATURE header (plus an MCP config snippet)
to stdout. Useful for pre-signing payments or integrating with other MCP clients.

JSON output (--json):
  `{ paymentSignature, from, to, amount, amountAtomicUnits, network, expiresAt }`
```

## `mcpc help`

```text
Usage: mcpc help [options] [command] [subcommand]

Show help for a command

Options:
  --skill  Print the agent skill (mental model, workflows, examples)
  --json   Output in JSON format
```

## `mcpc @<session>`

```text
Usage: mcpc @<session> [options] [command]

Show MCP session info or execute commands.

Options:
  --json                            Output in JSON format for scripting and code mode
  --verbose                         Enable debug logging
  --profile <name>                  OAuth profile override
  --timeout <seconds>               Request timeout in seconds (default: 60)
  --max-chars <n>                   Truncate output to n characters (ignored in --json mode)
  --insecure                        Skip TLS certificate verification (for self-signed certs)
  -h, --help                        Display help

Commands:
  close                             Close MCP session.
  restart                           Restart MCP session (losing all state).
  grep <pattern>                    Search MCP session objects.
  tools-list                        List all MCP tools.
  tools-get <name>                  Get details and schema for an MCP tool.
  tools-call <name> [args...]       Call an MCP tool with arguments.
  tasks-list                        List all MCP tasks.
  tasks-get <taskId>                Get MCP task status.
  tasks-result <taskId>             Get MCP task final result (blocks until the task finishes).
  tasks-cancel <taskId>             Cancel an MCP task.
  resources-list                    List all MCP resources.
  resources-read <uri>              Read an MCP resource by URI.
  resources-subscribe <uri> <file>  Subscribe to an MCP resource and sync it to a local file.
  resources-unsubscribe <uri>       Stop syncing a subscribed MCP resource (keeps the local file).
  resources-templates-list          List MCP resource templates.
  skills-list                       [EXPERIMENTAL] List agent skills from the server (SEP-2640).
  skills-get <name>                 [EXPERIMENTAL] Read a skill's SKILL.md by name (SEP-2640).
  prompts-list                      List all MCP prompts.
  prompts-get <name> [args...]      Get an MCP prompt with arguments.
  logging-set-level <level>         Set MCP server logging level (deprecated).
  ping                              Ping the MCP server.
  server-discover                   Ask the server what it supports (MCP 2026-07-28+).
  logs                              Show or follow the bridge log file for this session.

Output:
  When no command is given, shows session, server info, capabilities, and tools.

JSON output (--json):
  `InitializeResult` or `DiscoverResult` object extended with `toolNames` and `_mcpc`:
  `{ protocolVersion?, supportedVersions?, capabilities?, serverInfo?, instructions?, _meta?, toolNames?, _mcpc: { ... } }`
  Schema: https://modelcontextprotocol.io/specification/2025-11-25/schema#initializeresult
          https://modelcontextprotocol.io/specification/2026-07-28/schema#discoverresult
```

### `mcpc @<session> close`

```text
Usage: mcpc @<session> close [options]

Close MCP session.

Options:
  --json  Output in JSON format

JSON output (--json):
  `{ sessionName, closed: true }`
```

### `mcpc @<session> restart`

```text
Usage: mcpc @<session> restart [options]

Restart MCP session (losing all state).

Options:
  --json  Output in JSON format

Output:
  After restarting, shows session, server info, capabilities, and tools.

JSON output (--json):
  `InitializeResult` or `DiscoverResult` object extended with `toolNames` and `_mcpc`:
  `{ protocolVersion?, supportedVersions?, capabilities?, serverInfo?, instructions?, _meta?, toolNames?, _mcpc: { ... } }`
  Schema: https://modelcontextprotocol.io/specification/2025-11-25/schema#initializeresult
          https://modelcontextprotocol.io/specification/2026-07-28/schema#discoverresult
```

### `mcpc @<session> grep`

```text
Usage: mcpc @<session> grep <pattern> [options]

Search MCP session objects.

Options:
  --tools                Search tools
  --resources            Search resources
  --prompts              Search prompts
  --instructions         Search server instructions
  -E, --regex            Treat pattern as a regular expression
  -s, --case-sensitive   Case-sensitive matching
  -m, --max-results <n>  Limit the number of results
  --json                 Output in JSON format

Type filters:
  By default, tools and instructions are searched. Use --resources or --prompts
  to search those instead. Combine flags to search multiple types.

Examples:
  mcpc @<session> grep "search"                  Search tools and instructions
  mcpc @<session> grep "search" --resources      Search resources only
  mcpc @<session> grep "search|find" -E          Regex search

Exit codes:
  0 = matches found, 1 = no matches (grep convention)

JSON output (--json):
  `{ tools?: Tool[], resources?: Resource[], prompts?: Prompt[], instructions?: string[] }`
```

### `mcpc @<session> tools-list`

```text
Usage: mcpc @<session> tools-list [options]

List all MCP tools.

Options:
  --full  Show full tool details including schema
  --json  Output in JSON format

JSON output (--json):
  Array of `Tool` objects:
  `[{ name, description?, inputSchema, outputSchema?, annotations? }, ...]`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#tool
```

### `mcpc @<session> tools-get`

```text
Usage: mcpc @<session> tools-get [options] <name>

Get details and schema for an MCP tool.

Options:
  --schema <file>       Validate tool schema against expected schema
  --schema-mode <mode>  Schema validation mode: strict, compatible (default), ignore
  --json                Output in JSON format

Schema validation:
  --schema <file>       Validate against expected schema (save with tools-get --json)
  --schema-mode <mode>  strict | compatible (default) | ignore

JSON output (--json):
  `Tool` object:
  `{ name, description?, inputSchema, outputSchema?, annotations? }`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#tool
```

### `mcpc @<session> tools-call`

```text
Usage: mcpc @<session> tools-call [options] <name> [args...]

Call an MCP tool with arguments.

Options:
  --task                Use async task execution; Ctrl+C prints the task ID and exits (experimental)
  --detach              Start task and return immediately with task ID (implies --task)
  --schema <file>       Validate tool schema against expected schema before calling
  --schema-mode <mode>  Schema validation mode: strict, compatible (default), ignore
  --json                Output in JSON format

Arguments:
  key:=value pairs    mcpc @<session> tools-call search query:=hello limit:=10
  Inline JSON         mcpc @<session> tools-call search '{"query":"hello"}'
  Stdin pipe          echo '{"query":"hello"}' | mcpc @<session> tools-call search

  Values are auto-parsed: strings, numbers, booleans, JSON objects/arrays.
  To force a string, wrap in quotes: id:='"123"'
  Tip: mcpc @<session> tools-call <tool> --help prints the tool's parameter schema.

Async tasks (--task, --detach):
  --task shows a progress spinner while the task runs on the server.
  If you press Ctrl+C, the task keeps running and a hint with the task ID
  is printed so you can fetch or cancel it later.
  --detach returns the task ID immediately without waiting.
  Both flags require a server that advertises the tasks capability and uses
  MCP protocol 2025-11-25 (on 2026-07-28 servers tasks are an extension not
  yet supported by mcpc). If it does not, the command fails instead of
  running the tool synchronously — the flags change the output shape, so the
  fallback would silently return a result where a task ID is expected.
  Check per-tool support in tools-list: [task:optional|required|forbidden].

Schema validation:
  --schema <file>       Validate tool schema before calling (save with tools-get --json)
  --schema-mode <mode>  strict | compatible (default) | ignore

JSON output (--json):
  `CallToolResult` object:
  `{ content: [{ type, text?, ... }], isError?, structuredContent?: { ... } }`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#calltoolresult

  With `--detach`: `CreateTaskResult` object:
  `{ taskId: string, status: string }`
  Schema: https://modelcontextprotocol.io/specification/2025-11-25/schema#createtaskresult
```

### `mcpc @<session> tasks-list`

```text
Usage: mcpc @<session> tasks-list [options]

List all MCP tasks.

Options:
  --json  Output in JSON format

JSON output (--json):
  `{ tasks: Task[] }`:
  `{ tasks: [{ taskId, status, ttl, createdAt, lastUpdatedAt, statusMessage?, pollInterval? }] }`
  Schema: https://modelcontextprotocol.io/specification/2025-11-25/schema#task
```

### `mcpc @<session> tasks-get`

```text
Usage: mcpc @<session> tasks-get [options] <taskId>

Get MCP task status.

Options:
  --json  Output in JSON format

JSON output (--json):
  `Task` object:
  `{ taskId, status, ttl, createdAt, lastUpdatedAt, statusMessage?, pollInterval? }`
  Schema: https://modelcontextprotocol.io/specification/2025-11-25/schema#task
```

### `mcpc @<session> tasks-result`

```text
Usage: mcpc @<session> tasks-result [options] <taskId>

Get MCP task final result (blocks until the task finishes).

Options:
  --json  Output in JSON format

JSON output (--json):
  `CallToolResult` object:
  `{ content: [{ type, text?, ... }], isError?, structuredContent?: { ... } }`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#calltoolresult
```

### `mcpc @<session> tasks-cancel`

```text
Usage: mcpc @<session> tasks-cancel [options] <taskId>

Cancel an MCP task.

Options:
  --json  Output in JSON format

JSON output (--json):
  `Task` object:
  `{ taskId, status, ttl, createdAt, lastUpdatedAt, statusMessage?, pollInterval? }`
  Schema: https://modelcontextprotocol.io/specification/2025-11-25/schema#task
```

### `mcpc @<session> prompts-list`

```text
Usage: mcpc @<session> prompts-list [options]

List all MCP prompts.

Options:
  --json  Output in JSON format

JSON output (--json):
  Array of `Prompt` objects:
  `[{ name, description?, arguments?: [{ name, required? }] }, ...]`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#prompt
```

### `mcpc @<session> prompts-get`

```text
Usage: mcpc @<session> prompts-get [options] <name> [args...]

Get an MCP prompt with arguments.

Options:
  --json  Output in JSON format

Arguments:
  key:=value pairs    mcpc @<session> prompts-get summarize style:=brief lang:=en
  Inline JSON         mcpc @<session> prompts-get summarize '{"style":"brief"}'
  Stdin pipe          echo '{"style":"brief"}' | mcpc @<session> prompts-get summarize

  Values are auto-parsed: strings, numbers, booleans, JSON objects/arrays.
  To force a string, wrap in quotes: id:='"123"'

JSON output (--json):
  `GetPromptResult` object:
  `{ description?, messages: [{ role, content: { type, text?, ... } }] }`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#getpromptresult
```

### `mcpc @<session> resources-list`

```text
Usage: mcpc @<session> resources-list [options]

List all MCP resources.

Options:
  --json  Output in JSON format

JSON output (--json):
  Array of `Resource` objects:
  `[{ uri, name, description?, mimeType? }, ...]`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#resource
```

### `mcpc @<session> resources-read`

```text
Usage: mcpc @<session> resources-read [options] <uri>

Read an MCP resource by URI.

Options:
  -o, --output <file>  Save the resource to a file (decodes binary content)
  --raw                Print only the resource content, suitable for piping
  --json               Output in JSON format

Output:
  Default: pretty view; binary (blob) content is summarized, never dumped.
  --raw prints the bare content (binary requires a redirect or -o).
  -o <file> saves the content; base64 `blob` data is decoded to bytes.
  If the server returns multiple content items, --raw and -o use the item
  matching <uri> (or the first one) — use --json to get all items.

JSON output (--json):
  `ReadResourceResult` object:
  `{ contents: [{ uri, mimeType?, text? | blob? }], ttlMs?, cacheScope? }`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#readresourceresult

  `ttlMs`/`cacheScope` are caching hints only present on 2026-07-28 connections.
  With `-o`: `{ uri, file, bytes, mimeType? }` summary instead.
```

### `mcpc @<session> resources-subscribe`

```text
Usage: mcpc @<session> resources-subscribe [options] <uri> <file>

Subscribe to an MCP resource and sync it to a local file.

Options:
  --json  Output in JSON format

Behavior:
  Downloads the resource to <file> now; afterwards the session bridge rewrites
  the file whenever the server announces a change for <uri> (the MCP
  notifications/resources/updated flow). Requires the server capability
  `resources.subscribe` — check with `mcpc @<session>`. Subscriptions are
  re-established automatically when the session reconnects or restarts.
  Subscribing to the same <uri> again just changes the target <file>.

Example:
  mcpc @<session> resources-subscribe file:///app/config.json ./config.json

JSON output (--json):
  `{ subscribed: true, uri, file, bytes, mimeType? }`
```

### `mcpc @<session> resources-unsubscribe`

```text
Usage: mcpc @<session> resources-unsubscribe [options] <uri>

Stop syncing a subscribed MCP resource (keeps the local file).

Options:
  --json  Output in JSON format

JSON output (--json):
  `{ unsubscribed: true, uri, file }`
```

### `mcpc @<session> resources-templates-list`

```text
Usage: mcpc @<session> resources-templates-list [options]

List MCP resource templates.

Options:
  --json  Output in JSON format

JSON output (--json):
  Array of `ResourceTemplate` objects:
  `[{ uriTemplate, name, description?, mimeType? }, ...]`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#resourcetemplate
```

### `mcpc @<session> skills-list`

```text
Usage: mcpc @<session> skills-list [options]

[EXPERIMENTAL] List agent skills from the server (SEP-2640).

Options:
  --json  Output in JSON format

Discovery:
  Tries `skill://index.json`, else scans `skill://*/SKILL.md`. Types:
  `skill-md`, `mcp-resource-template`, `archive` (use `resources-read <url>`).

JSON output (--json):
  `[{ name, description, type, url }, ...]`
  Schema: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640
```

### `mcpc @<session> skills-get`

```text
Usage: mcpc @<session> skills-get [options] <name>

[EXPERIMENTAL] Read a skill's SKILL.md by name (SEP-2640).

Options:
  --raw   Print only the SKILL.md text (Markdown), suitable for piping
  --json  Output in JSON format

Names:
  `name`, `nested/path`, or `skill://...` URI. For `archive` skills, use
  `resources-read <url>`. With --json, --raw is ignored.

JSON output (--json):
  `ReadResourceResult`: `{ contents: [{ uri, mimeType?, text? | blob? }], ttlMs?, cacheScope? }`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#readresourceresult
```

### `mcpc @<session> logging-set-level`

```text
Usage: mcpc @<session> logging-set-level [options] <level>

Set MCP server logging level (deprecated).

Options:
  --json  Output in JSON format

Deprecated:
  MCP 2026-07-28 removed logging/setLevel, so this works on 2025-11-25 (and older)
  servers only and will be removed in a future mcpc release. Use --verbose for
  client-side logging instead.

JSON output (--json):
  `{ level: string }`
```

### `mcpc @<session> ping`

```text
Usage: mcpc @<session> ping [options]

Ping the MCP server.

Options:
  --json  Output in JSON format

Notes:
  Measures the request roundtrip. MCP 2026-07-28 removed `ping`, so on modern
  connections the liveness probe is `server/discover` instead — run
  `mcpc @<session> server-discover` to see what that request returns.

JSON output (--json):
  `{ success: true, durationMs: number }`
```

### `mcpc @<session> server-discover`

```text
Usage: mcpc @<session> server-discover [options]

Ask the server what it supports (MCP 2026-07-28+).

Options:
  --json  Output in JSON format

Notes:
  A live `server/discover` request; `mcpc @<session>` shows the cached connect-time
  answer instead — use it on 2025-11-25 (and older) connections, where this fails.

JSON output (--json):
  `DiscoverResult` object, verbatim:
  `{ supportedVersions: [...], capabilities: { ... }, instructions?, _meta? }`
  Schema: https://modelcontextprotocol.io/specification/2026-07-28/schema#discoverresult
```

### `mcpc @<session> logs`

```text
Usage: mcpc @<session> logs [options]

Show or follow the bridge log file for this session.

Options:
  -n, --tail <n>   Number of recent lines to show (default: 50)
  --follow         Stream new log lines as they are written
  --since <value>  Only show entries newer than a duration (30s, 5m, 2h, 1d) or ISO timestamp
  --json           Output in JSON format

Examples:
  mcpc @<session> logs                  Last 50 lines
  mcpc @<session> logs -n 200           Last 200 lines
  mcpc @<session> logs --follow         Stream new lines (ESC/Ctrl+C/q to stop)
  mcpc @<session> logs --since 1h       Lines from the last hour
  mcpc @<session> logs --since 30m -n 50

Notes:
  Reads ~/.mcpc/logs/bridge-@<session>.log and transparently spans
  rotated files (.log.1 … .log.5) when -n or --since needs older lines.
  Continuation lines (e.g. stack traces) fold into the preceding entry's msg.

JSON output (--json):
  Array of log records (JSONL when streaming with --follow):
  `[{ time, level, context?, msg } | { raw }, ...]`
```
