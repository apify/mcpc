# mcpc: a command-line client for MCP

`mcpc` is a command-line client for the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
over standard transports (Streamable HTTP and stdio).
It maps MCP concepts to intuitive CLI commands, and uses a bridge process per session,
so you can keep multiple MCP connections alive simultaneously.

`mcpc` is useful for testing and debugging of MCP servers,
as well as for AI coding agents to compose MCP operations and tool calls using code generation
rather than direct tool calling, to [save tokens](https://www.anthropic.com/engineering/code-execution-with-mcp) and increase accuracy.

## Features

- 🔌 **Universal MCP client** - Works with any MCP server over Streamable HTTP or stdio.
- 🔄 **Persistent sessions** - Keep multiple server connections alive simultaneously.
- 🚀 **Zero setup** - Connect to remote servers or run local packages instantly.
- 🔧 **Full protocol support** - Tools, resources, prompts, sampling, dynamic discovery, and async notifications.
- 📊 **JSON output** - Easy integration with `jq`, scripts, and other CLI tools.
- 🤖 **AI-friendly** - Designed for code generation and automated workflows.
- 🔒 **Secure** - OS keychain integration for credentials, encrypted auth storage.

## Install

```bash
npm install -g mcpc
```

## Quickstart

```bash
# Connect to a remote MCP server
mcpc https://mcp.example.com
mcpc https://mcp.example.com tools-list

# Run a local MCP server package
mcpc @modelcontextprotocol/server-filesystem tools-list

# Use your custom MCP config
mcpc --config ~/.vscode/mcp.json myserver tools-list

# Authenticate to OAuth-enabled server and save authentication profile
mcpc https://mcp.example.com auth --profile personal

# Create a persistent session with auth profile
mcpc https://mcp.example.com connect --session @myserver --profile personal
mcpc @myserver tools-call search --args query=hello

# List all sessions and saved auth profiles
mcpc

# Interactive shell
mcpc @myserver shell
mcpc https://mcp.example.com shell
```

## Usage

```bash
mcpc [--json] [--config <file>] [-H|--header "K: V"] [-v|--verbose] [--schema <file>]
     [--schema-mode <mode>] [--timeout <seconds>] [--protocol-version <version>]
     [--no-cache] [--insecure]
     <target> <command...>

mcpc                  # lists all active sessions and saved authentication profiles
mcpc <target>         # shows server info, instructions, and capabilities
mcpc @<session>       # shows session details including auth info
mcpc <target> help    # alias for "mcpc <target>"

# MCP commands
mcpc <target> tools
mcpc <target> tools-list [--cursor <cursor>]
mcpc <target> tools-schema <tool-name>
mcpc <target> tools-call <tool-name> [--args key=val key2:=json ...] [--args-file <file>]

mcpc <target> prompts
mcpc <target> prompts-list [--cursor <cursor>]
mcpc <target> prompts-get <prompt-name> [--args key=val key2:=json ...] [--args-file <file>]

mcpc <target> resources
mcpc <target> resources-list [--cursor <cursor>]
mcpc <target> resources-read <uri> [-o <file>] [--raw] [--max-size <bytes>]
mcpc <target> resources-subscribe <uri>
mcpc <target> resources-unsubscribe <uri>
mcpc <target> resources-templates-list

mcpc <target> logging-set-level <level>

# Session management
mcpc <target> connect --session @<session-name> [--profile <name>]
mcpc @<session-name> <command...>
mcpc @<session-name> help
mcpc @<session-name> close

# Authentication profile management (for remote MCP servers)
mcpc <server> auth [--profile <name>]
mcpc <server> auth-list
mcpc <server> auth-show --profile <name>
mcpc <server> auth-delete --profile <name>

# Interactive shell
mcpc <target> shell
```

where `<target>` can be one of:

- **Named session** prefixed with `@` (e.g. `@apify`) - highest priority
- **Remote MCP endpoint** URL (e.g. `https://mcp.apify.com`)
- **Named entry** in a config file, when used with `--config` (e.g. `linear-mcp`)
- **Local MCP server package** (e.g. `@microsoft/playwright-mcp`)

Target types are resolved in the order listed above. Use explicit format to avoid ambiguity.

`mcpc` automatically selects the transport protocol based on the `<target>`:
- HTTP/HTTPS URLs use the MCP Streamable HTTP transport (only current standard; HTTP with SSE is not supported)
- Local packages use stdio transport (spawned as subprocess)

### MCP command arguments

`mcpc` supports multiple ways to pass arguments to `tools-call` and `prompts-get` commands:

```bash
# Inline JSON object (most convenient)
... --args '{"query":"hello","count":10}'

# String values (default) - use = for strings
... --args name=value query="hello world"

# JSON literals - use := for JSON types
... --args count:=123 enabled:=true value:=null
... --args config:='{"key":"value"}' items:='[1,2,3]'

# Mixed strings and JSON
... --args query="search term" limit:=10 verbose:=true

# Load all arguments from JSON file
... --args-file tool-arguments.json

# Read from stdin (automatic when piped, no flag needed)
echo '{"query":"hello","count":10}' | mcpc @server tools-call my-tool
```

**Rules:**
- Use only one method: `--args` (inline JSON or key=value pairs), `--args-file`, or stdin (piped input)
- Inline JSON: If first argument starts with `{` or `[`, it's parsed as JSON object/array
- Key=value pairs: After `--args`, all `key=value` or `key:=json` pairs are consumed until next flag
- `=` assigns as string, `:=` parses as JSON
- Stdin is automatically detected when input is piped (not interactive terminal)

## Global flags

- `--json` - Input and output in JSON format for scripting
- `--config <file>` - Use MCP config file (e.g., `.vscode/mcp.json`)
- `-H, --header "Key: Value"` - Add HTTP header (can be repeated)
- `-v, --verbose` - Enable verbose logging (shows protocol details)
- `--timeout <seconds>` - Request timeout in seconds (default: 300)
- `--protocol-version <version>` - Force specific MCP protocol version (e.g., `2025-11-25`)
- `--schema <file>` - Validate against expected tool/prompt schema
- `--schema-mode <mode>` - Schema validation mode: `strict`, `compatible`, or `ignore` (default: `compatible`)
- `--no-cache` - Disable prefetching and caching of server objects. 
- `--insecure` - Disable SSL certificate validation (not recommended)

## Caching

By default, `mcpc` prefetches and caches the full list of server tools, prompts, and resources,
to reduce the number of requests made to the server and simplify the use of CLI.
This means that commands such as `tools-list` or `tools-schema` use the cached data rather than 
making a request to the server. Also, `mcpc` automatically refreshes the cache when
the server sends a `notifications/tools/list_changed` or `notifications/resources/list_changed` notification.

To disable caching, use the `--no-cache` flag. In that case, you-ll need to explicitely run commands
like `tools-list` or `resources-list` to get the lists and handle the
[pagination](https://modelcontextprotocol.io/specification/latest/server/utilities/pagination) using `--cursor`.

## Authentication

`mcpc` supports all standard [authorization methods](https://modelcontextprotocol.io/specification/latest/basic/authorization) for MCP servers,
including the `WWW-Authenticate` discovery mechanism and OAuth 2.1 with PKCE.
It uses OS keychain to securely store authentication tokens and credentials.

### Anonymous access

For local servers (stdio) or remote servers (Streamable HTTP) which do not require credentials,
`mcpc` can be used without authentication:

```bash
# Local stdio server
mcpc @modelcontextprotocol/server-filesystem resources-list

# Remote server without auth
mcpc https://public-mcp.example.com tools-list
```

### Bearer token authentication

For remote servers that require a bearer token (but not OAuth), use the `--header` flag.
The token is stored securely in the OS keychain for the session, but **not** saved as a reusable auth profile:

```bash
# One-time command with bearer token
mcpc --header "Authorization: Bearer ${APIFY_TOKEN}" https://mcp.apify.com tools-list

# Create session with bearer token (saved to keychain for this session only)
mcpc --header "Authorization: Bearer ${APIFY_TOKEN}" https://mcp.apify.com connect --session @apify

# Use the session (token loaded from keychain automatically)
mcpc @apify tools-list
```

### OAuth authentication

For OAuth-enabled servers, `mcpc` implements the full OAuth 2.1 flow with PKCE, including:
- `WWW-Authenticate` header discovery
- Authorization server metadata discovery (RFC 8414)
- Client ID metadata documents (SEP-991)
- Dynamic client registration (RFC 7591)
- Automatic token refresh

The OAuth authentication is performed via a web browser.
`mcpc` **always** prompts the user before opening the browser and requesting the login.

#### Authentication profiles

For OAuth-enabled servers, `mcpc` uses **authentication profiles** - reusable credentials that can be shared across multiple sessions.
This allows you to:
- Authenticate once, create multiple sessions
- Use different accounts (profiles) with the same server
- Manage credentials independently from sessions

**Key concepts:**
- **Auth profile**: Named set of OAuth credentials for a specific server (stored in `~/.mcpc/auth-profiles.json` + OS keychain)
- **Session**: Active connection to a server that might reference an auth profile (stored in `~/.mcpc/sessions.json`)
- **Default profile**: When `--profile` is not specified, `mcpc` uses the auth profile named `default`

**Example:**

```bash
# Authenticate to server and save as named auth profile
mcpc https://mcp.apify.com auth --profile personal

# Authenticate with 'default' profile name
mcpc https://mcp.apify.com auth

# Re-authenticate existing profile (e.g., to refresh or change scopes)
mcpc https://mcp.apify.com auth --profile personal
```

#### Managing authentication profiles

```bash
# List all profiles for a specific server
mcpc https://mcp.apify.com auth-list

# Show detailed info for a profile
mcpc https://mcp.apify.com auth-show --profile personal

# Delete a profile
mcpc https://mcp.apify.com auth-delete --profile work
```

#### Automatic OAuth behavior

`mcpc` automatically handles authentication based on whether you specify a profile:

**When `--profile <name>` is specified:**

1. **Profile exists**: Use its stored credentials
   - If authentication succeeds → Continue with command/session
   - If authentication fails (expired/invalid) → Prompt to re-authenticate and update the profile
2. **Profile doesn't exist**: Prompt to authenticate and create new profile with that name

**When no `--profile` is specified (uses `default` profile):**

1. **`default` profile exists**: Use its stored credentials
   - If authentication succeeds → Continue with command/session
   - If authentication fails (expired/invalid) → Prompt to re-authenticate and update `default`
2. **`default` profile doesn't exist**: Attempt unauthenticated connection
   - If server accepts (no auth required) → Continue without creating profile
   - If server rejects with 401 + `WWW-Authenticate` → Prompt to authenticate and create `default` profile

**This flow ensures:**
- You only authenticate when necessary
- Credentials are never silently downgraded (authenticated → unauthenticated)
- You can mix authenticated sessions (with named profiles) and public access on the same server

**Examples:**

```bash
# With specific profile - always authenticated:
# - Uses 'personal' if it exists
# - Prompts to create 'personal' if it doesn't exist
mcpc https://mcp.apify.com connect --session @apify1 --profile personal

# Without profile - opportunistic authentication:
# - Uses 'default' if it exists
# - Tries unauthenticated if 'default' doesn't exist
# - Prompts to create 'default' only if server requires auth
mcpc https://mcp.apify.com connect --session @apify2

# Public server - no authentication needed:
mcpc https://public-mcp.example.com tools-list
```

#### Multiple accounts for the same server

Authentication profiles enable using multiple accounts with the same MCP server:

```bash
# Authenticate with personal account
mcpc https://mcp.apify.com auth --profile personal

# Authenticate with work account
mcpc https://mcp.apify.com auth --profile work

# Create sessions using the different accounts
mcpc https://mcp.apify.com connect --session @apify-personal --profile personal
mcpc https://mcp.apify.com connect --session @apify-work --profile work

# Both sessions work independently with different credentials
mcpc @apify-personal tools-list  # Uses personal account
mcpc @apify-work tools-list      # Uses work account
```

#### OAuth in JSON mode

If `--json` option is used, `mcpc` never asks for interactive user input and fails instead.

### Authentication precedence

When multiple authentication methods are available, `mcpc` uses this precedence order:

1. **Command-line `--header` flag** (highest priority) - Always used if provided
2. **Session's stored credentials** - Bearer tokens or OAuth tokens from profile
3. **Config file headers** - Headers from `--config` file for the server
4. **No authentication** - Attempts unauthenticated connection

Example:

- Config file has: `"headers": {"Authorization": "Bearer ${TOKEN1}"}`
- Session uses profile with different OAuth token
- Command provides: `--header "Authorization: Bearer ${TOKEN2}"`
- Result: Uses `TOKEN2` (command-line flag wins)

### Authentication profiles storage format

By default, the auth profiles are stored in the `~/.mcpc/auth-profiles.json` profile with the following structure:

```json
{
  "profiles": {
    "https://mcp.apify.com": {
      "personal": {
        "name": "personal",
        "serverUrl": "https://mcp.apify.com",
        "authType": "oauth",
        "oauthIssuer": "https://auth.apify.com",
        "scopes": ["tools:read", "tools:write", "resources:read"],
        "authenticatedAt": "2025-12-14T10:00:00Z",
        "expiresAt": "2025-12-15T10:00:00Z",
        "createdAt": "2025-12-14T10:00:00Z",
        "updatedAt": "2025-12-14T10:00:00Z"
      },
      "work": {
        "name": "work",
        "serverUrl": "https://mcp.apify.com",
        "authType": "oauth",
        "oauthIssuer": "https://auth.apify.com",
        "scopes": ["tools:read"],
        "authenticatedAt": "2025-12-10T15:30:00Z",
        "expiresAt": "2025-12-11T15:30:00Z",
        "createdAt": "2025-12-10T15:30:00Z",
        "updatedAt": "2025-12-10T15:30:00Z"
      }
    }
  }
}
```

**OS Keychain entries:**
- OAuth tokens: `mcpc:auth:https://mcp.apify.com:personal:tokens`
- OAuth client info: `mcpc:auth:https://mcp.apify.com:personal:client`
- Bearer tokens (per-session): `mcpc:session:apify:bearer-token`

## Sessions

MCP is a [stateful protocol](https://modelcontextprotocol.io/specification/latest/basic/lifecycle): clients and servers perform an initialization handshake
to negotiate protocol version and capabilities, then communicate within a persistent session.
Each session maintains:
- Negotiated protocol version and capabilities (which tools/resources/prompts/notifications are supported)
- For Streamable HTTP transport: persistent connection with bidirectional streaming, with automatic reconnection
- For stdio transport: persistent bidirectional pipe to subprocess

Instead of forcing every command to reconnect and reinitialize (which is slow and loses state),
`mcpc` uses a lightweight **bridge process** per session that:

- Maintains the MCP session (protocol version, capabilities, connection state)
- For Streamable HTTP: Manages persistent connections with automatic reconnection and resumption
- Multiplexes multiple concurrent requests (up to 10 concurrent, 100 queued)
- Enables piping data between multiple MCP servers simultaneously

`mcpc` saves its state to `~/.mcpc/` directory (unless overriden by `MCP_STATE_DIR`), in the following files:

- `~/.mcpc/sessions.json` - Active sessions with references to auth profiles (file-locked for concurrent access)
- `~/.mcpc/auth-profiles.json` - Authentication profiles (OAuth metadata, scopes, expiry)
- `~/.mcpc/bridges/` - Unix domain socket files for each bridge process
- OS keychain - Sensitive credentials (OAuth tokens, bearer tokens, client secrets)


### Managing sessions

```bash
# Create a persistent session (with default auth profile, if available)
mcpc https://mcp.apify.com connect --session @apify

# Create session with specific auth profile
mcpc https://mcp.apify.com connect --session @apify --profile personal

# List all active sessions and saved auth profiles
mcpc

# Active sessions:
#   @apify → https://mcp.apify.com (http, profile: personal)
#
# Saved authentication profiles:
#   https://mcp.apify.com
#     • personal (authenticated: 2 days ago)
#     • work (authenticated: 1 week ago)

# Use the session
mcpc @apify tools-list
mcpc @apify shell

# Close the session (terminates bridge process, but keeps auth profile)
mcpc @apify close
```

### Piping between sessions

```bash
mcpc --json @apify tools-call search-actors --args query="tiktok scraper" \
  | jq '.data.results[0]' \
  | mcpc @playwright tools-call run-browser
```

### Scripting

`mcpc` is designed to be easily usable in (AI-generated) scripts. To ensure consistency
of your scripts with the current MCP server interface, you can use `--schema <file>` argument
to pass `mcpc` the expected schema. If the MCP server's current schema is incompatible,
the command returns an error.

```bash
# Save tool schema for future validation
mcpc --json @apify tools-schema search-actors > search-actors-schema.json

# Use schema to ensure compatibility (fails if schema changed)
mcpc @apify tools-call search-actors \
  --schema search-actors-schema.json \
  --schema-mode strict \
  --args query="tiktok scraper"
```

**Schema validation modes using the `--schema-mode` parameter:**
- `strict` - Exact schema match required (all fields, types must be identical)
- `compatible` (default) - Backwards compatible (new optional fields OK, required fields and types must match)
- `ignore` - Skip schema validation


## Logging

MCP servers can be instructed to adjust their [logging level](https://modelcontextprotocol.io/specification/latest/server/utilities/logging)
using the `logging/setLevel` command:

```bash
# Set server log level to debug for detailed output
mcpc @apify logging-set-level debug

# Reduce server logging to only errors
mcpc @apify logging-set-level error
```

**Available log levels** (from most to least verbose):
- `debug` - Detailed debugging information
- `info` - General informational messages
- `notice` - Normal but significant events
- `warning` - Warning messages
- `error` - Error messages
- `critical` - Critical conditions
- `alert` - Action must be taken immediately
- `emergency` - System is unusable

**Note:** This sets the logging level on the **server side**. The actual log output depends on the server's implementation. For client-side verbose logging, use the `--verbose` flag.


## Configuration

Configuration can be provided via file, environment variables, or command-line flags.

**Precedence** (highest to lowest):
1. Command-line flags, including config file when specified with `--config`
2. Environment variables
3. Built-in defaults

### MCP server config file

`mcpc` supports the ["standard"](https://gofastmcp.com/integrations/mcp-json-configuration)
MCP server JSON config file, compatible with Claude Desktop, VS Code, and other MCP clients.
You can point to an existing config file with `--config`:

```bash
# One-shot command to an MCP server configured in Visual Studio Code
mcpc --config .vscode/mcp.json apify tools-list

# Open a session to a server specified in the custom config file
mcpc --config .vscode/mcp.json apify connect --session @my-apify
```

**Example MCP server config file:**

```json
{
  "mcpServers": {
    "apify": {
      "url": "https://mcp.apify.com",
      "headers": {
        "Authorization": "Bearer ${APIFY_TOKEN}"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {
        "DEBUG": "mcp:*"
      }
    },
    "local-package": {
      "command": "node",
      "args": ["/path/to/server.js"]
    }
  }
}
```

**Server configuration properties:**

For **HTTP/HTTPS servers:**
- `url` (required) - MCP server endpoint URL
- `headers` (optional) - HTTP headers to include with requests
- `timeout` (optional) - Request timeout in seconds

For **stdio servers:**
- `command` (required) - Command to execute (e.g., `node`, `npx`, `python`)
- `args` (optional) - Array of command arguments
- `env` (optional) - Environment variables for the process

**Using servers from config file:**

When `--config` is provided, you can reference servers by name:

```bash
# With config file, use server names directly
mcpc --config .vscode/mcp.json filesystem resources-list

# Create a named session from server in config
mcpc --config .vscode/mcp.json filesystem connect --session @fs
mcpc @fs tools-call search
```

**Environment variable substitution:**

Config files support environment variable substitution using `${VAR_NAME}` syntax:

```json
{
  "mcpServers": {
    "secure-server": {
      "url": "https://api.example.com",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}",
        "X-User-ID": "${USER_ID}"
      }
    }
  }
}
```

## Environment variables

- `MCPC_STATE_DIR` - Directory for session and auth profiles data (default is `~/.mcpc`)
- `MCPC_VERBOSE` - Enable verbose logging (instead of using `--verbose`, set to `1` or `true`)
- `MCPC_TIMEOUT` - Default timeout in seconds (instead of using `--timeout`, default is `300`)
- `MCPC_JSON` - Enable JSON output (instead of using `--json`, set to `1` or `true`)

## MCP protocol notes

**Protocol initialization:**
- `mcpc` follows the MCP initialization handshake: sends `initialize` request with protocol version and capabilities, receives server capabilities and instructions, then sends `initialized` notification
- Protocol version negotiation: client proposes latest supported version (currently `2025-11-25`), server responds with version to use
- Use `--protocol-version` to force a specific version if auto-negotiation fails

**Transport handling:**
- **Streamable HTTP**: `mcpc` supports only the Streamable HTTP transport (the current standard). The deprecated HTTP with SSE transport is not supported. The bridge manages persistent HTTP connections with bidirectional streaming for server-to-client communication, with automatic reconnection using exponential backoff (1s → 30s max)
  - Includes `MCP-Protocol-Version` header on all HTTP requests (per MCP spec)
  - Handles `MCP-Session-Id` for stateful server sessions
  - Validates `Origin` headers for security (prevents DNS rebinding attacks)
- During reconnection, new requests are queued (fails after 3 minutes of disconnection)
- **Stdio**: Direct bidirectional JSON-RPC communication over standard input/output

**Protocol features:**
- `mcpc` supports all MCP primitives in both Streamable HTTP and stdio transports:
  - **Instructions**: Fetches and stores MCP server-provided `instructions`
  - **Tools**: Executable functions with JSON Schema-validated arguments.
  - **Resources**: Data sources identified by URIs (e.g., `file:///path/to/file`, `https://example.com/data`), with optional subscriptions for change notifications
  - **Prompts**: Reusable message templates with customizable arguments
  - **Completion**: Provides access to Completion API for tools and resources, and offers completions in shell mode
- Supports server logging settings (`logging/setLevel`) and messages (`notifications/message`), and prints them to stderr or stdout based on verbosity level.
- Handles server notifications: progress tracking, logging, and change notifications (`notifications/tools/list_changed`, `notifications/resources/list_changed`, `notifications/prompts/list_changed`)
- Request multiplexing: supports up to 10 concurrent requests, queues up to 100 additional requests
- Pagination: List operations return `nextCursor` when more results are available; use `--cursor` to fetch next page
- Pings: `mcpc` periodically issues a `ping` request to keep the connection alive
- Sampling is not supported as `mcpc` has no access to an LLM.

## Package resolution

When a <target> is identified as a local package, `mcpc` resolves it as follows:

1. Check `./node_modules` (local project dependencies)
2. Check global npm packages (`npm root -g`)
3. Check Bun global packages (if using Bun runtime)

**Package requirements:**
- Package must have executable specified in `package.json` `bin` field or `main` field
- Package should support MCP stdio transport
- Optional: define `mcpServer` field in `package.json` to specify entry point

**Example package usage:**

```bash
# Use locally installed package
npm install @modelcontextprotocol/server-filesystem
mcpc @modelcontextprotocol/server-filesystem resources-list

# Use globally installed package
npm install -g @modelcontextprotocol/server-filesystem
mcpc @modelcontextprotocol/server-filesystem resources-list
```

## Output format

### Human-readable (default)

Default output is formatted for human and AI readability with plain text, colors, and Markdown-like formatting.

### JSON mode (`--json`)

In JSON mode, `mcpc` always emits only a single JSON object to enable scripting.
For MCP commands, the object is always consistent with the MCP protocol specification.
On success, the JSON object is printed to stdout, otherwise to stderr.

Note that in JSON mode `--verbose` option has no effect.

## Security

MCP enables arbitrary tool execution and data access; treat servers like you treat shells:

* Use least-privilege tokens/headers
* Prefer trusted endpoints
* Audit what tools do before running them
* Review server permissions in interactive mode

**Authentication:**
- Credentials stored in OS keychain (encrypted by system)
- Use environment variables for CI/CD: `Authorization: Bearer ${TOKEN}`
- File permissions: `~/.mcpc/sessions.json` is set to `0600` (user-only)
- Bridge sockets in `~/.mcpc/bridges/` are created with `0700` permissions

**Network security:**
- HTTPS enforced for remote servers (HTTP auto-upgraded)
- Certificate validation enabled (use `--insecure` to disable, not recommended)
- Origin header validation to prevent DNS rebinding attacks
- Local servers bind to localhost (127.0.0.1) only
- No credentials logged even in verbose mode

## Error handling

`mcpc` provides clear error messages for common issues:

- **Connection failures**: Displays transport-level errors with retry suggestions
- **Session timeouts**: Automatically attempts to reconnect or prompts for session recreation
- **Invalid commands**: Shows available commands and correct syntax
- **Tool execution errors**: Returns server error messages with context
- **Bridge crashes**: Detects and cleans up orphaned processes, offers restart

Use `--verbose` flag for detailed debugging information (shows JSON-RPC messages, streaming events, and protocol negotiation).

### Exit codes

- `0` - Success
- `1` - Client error (invalid arguments, command not found, etc.)
- `2` - Server error (tool execution failed, resource not found, etc.)
- `3` - Network error (connection failed, timeout, etc.)
- `4` - Authentication error (invalid credentials, forbidden, etc.)

### Retry strategy

- **Network errors**: Automatic retry with exponential backoff (3 attempts)
- **Stream reconnection**: Starts at 1s, doubles to max 30s
- **Bridge restart**: Automatic on crash detection (recreates session on next command)
- **Timeouts**: Configurable per-request timeout (default: 5 minutes)

## Interactive shell

The interactive shell provides a REPL-style interface for MCP servers:

```bash
mcpc @apify shell
```

**Features:**
- Command history (saved to `~/.mcpc/history`, last 1000 commands)
- Tab completion for commands, tool names, and resource URIs
- Multi-line editing with arrow keys
- Prompt shows session name: `mcpc(@apify)> `

**Shell-specific commands:**
- `help` - Show available commands
- `exit` or `quit` or Ctrl+D - Exit shell
- Ctrl+C - Cancel current operation

**Example session:**
```
$ mcpc @apify shell
Connected to apify (https://mcp.apify.com)
MCP version: 2025-11-25

mcpc(@apify)> tools-list
Available tools:
  - search-actors
  - get-actor
  - run-actor

mcpc(@apify)> tools-call search-actors --args query="tiktok scraper"
[results...]

mcpc(@apify)> exit
```

## Implementation details

`mcpc` is under active development. This README contains the final state, but most of the implementation is still missing.
The library is implemented in TypeScript as a single package with internal modules.

### Architecture overview

```
mcpc (single package)
├── src/
│   ├── core/           # Core MCP protocol implementation
│   ├── bridge/         # Bridge process logic
│   ├── cli/            # CLI interface
│   └── lib/            # Shared utilities
├── bin/
│   ├── mcpc            # Main CLI executable
│   └── mcpc-bridge     # Bridge process executable
```

### Core module (runtime-agnostic)

Implemented with minimal dependencies to support both Node.js (≥18.0.0) and Bun (≥1.0.0).

**Core responsibilities:**
- Transport selection and initialization (Streamable HTTP vs stdio)
- MCP protocol implementation and version negotiation
- Session state machine management
- Streamable HTTP connection management (reconnection with exponential backoff)
- Request/response correlation (JSON-RPC style with request IDs)
- Multiplexing concurrent requests (up to 10 concurrent)
- Event emitter for async notifications

**Key dependencies:**
- Native `fetch` API (available in Node.js 18+ and Bun)
- Native process APIs for stdio transport
- Minimal: UUID generation, event emitter abstraction

### Bridge process

Implemented as a separate executable (`mcpc-bridge`) that maintains persistent connections.

**Bridge responsibilities:**
- Session persistence (reads/writes `~/.mcpc/sessions.json` with file locking)
- Process lifecycle management for local package servers
- Stdio framing and protocol handling
- Unix domain socket server for CLI communication
- Heartbeat mechanism for health monitoring
- Orphaned process cleanup on startup

**IPC Protocol:**
- Unix domain sockets (located in `~/.mcpc/bridges/<session-name>.sock`)
- Named pipes on Windows
- JSON-RPC style messages over socket
- Control messages: init, request, cancel, close, health-check

**Bridge Discovery:**
- CLI reads `~/.mcpc/sessions.json` to find socket path and PID
- Validates bridge is alive (connect to socket + health-check)
- Auto-restarts crashed bridges (detected via socket connection failure)
- Cleanup: removes stale socket files for dead processes

**Concurrency Safety:**
- `sessions.json` protected with file locking (`proper-lockfile` package)
- Atomic writes (write to temp file, then rename)
- Lock timeout: 5 seconds (fails if can't acquire lock)

### CLI executable

The main `mcpc` command provides the user interface.

**CLI responsibilities:**
- Argument parsing (using `minimist` or similar)
- Output formatting (human-readable vs `--json`)
- Bridge lifecycle: start/connect/stop
- Communication with bridge via socket
- Interactive shell (REPL using `@inquirer/prompts`)
- Configuration file loading (standard MCP JSON format)
- Credential management (OS keychain via `keytar` package)

**Shell implementation:**
- Built on `@inquirer/prompts` for input handling
- Command history using `~/.mcpc/history`
- Tab completion using inquirer autocomplete and MCP completion API
- Graceful exit handling (cleanup on Ctrl+C/Ctrl+D)

### Session lifecycle

1. User: `mcpc https://mcp.apify.com connect --session @apify`
2. CLI: Atomically creates session entry in `~/.mcpc/sessions.json`
3. CLI: Spawns bridge process (`mcpc-bridge`)
4. Bridge: Creates Unix socket at `~/.mcpc/bridges/apify.sock`
5. Bridge: Performs MCP initialization handshake with server:
   - Sends initialize request with protocol version and capabilities
   - Receives server info, version, and capabilities
   - Sends initialized notification to activate session
6. Bridge: Updates session in sessions.json (adds PID, socket path, protocol version)
7. CLI: Confirms session created

Later...

8. User: mcpc @apify tools-list
9. CLI: Reads sessions.json, finds socket path
10. CLI: Connects to bridge socket
11. CLI: Sends `tools/list` JSON-RPC request via socket
12. Bridge: Forwards to MCP server via Streamable HTTP
13. Bridge: Returns response via socket
14. CLI: Formats and displays to user


### Error recovery

**Bridge crashes:**
1. CLI detects socket connection failure
2. Reads sessions.json for last known config
3. Spawns new bridge process
4. Bridge re-initializes connection to MCP server
5. Continues request

**Network failures:**
1. Bridge detects connection error
2. Begins exponential backoff reconnection
3. Queues incoming requests (up to 100, max 3min)
4. On reconnect: drains queue
5. On timeout: fails queued requests with network error

**Orphaned processes:**
1. On startup, CLI scans `~/.mcpc/bridges/` directory
2. For each socket file, attempts connection
3. If connection fails, reads PID from sessions.json
4. Checks if process exists (via `kill -0` or similar)
5. If dead: removes socket file and session entry
6. If alive but unresponsive: kills process, removes entries

## Testing strategy

**Unit tests:**
- Core protocol implementation (mocked transports)
- Argument parsing and validation
- Output formatting (human and JSON modes)

**Integration tests:**
- Mock MCP server (simple Streamable HTTP + stdio servers)
- Bridge lifecycle (start, connect, restart, cleanup)
- Session management with file locking
- Stream reconnection logic

**E2E tests:**
- Real MCP server implementations
- Cross-runtime (Node.js and Bun)
- Interactive shell workflows

**Test utilities:**
- `examples/test-server/` - Reference MCP server for testing
- `test/mock-keychain.ts` - Mock OS keychain for testing

## Troubleshooting

### Common issues

**"Cannot connect to bridge"**
- Bridge may have crashed. Try: `mcpc <server> connect --session @<session-name>`
- Check bridge is running: `ps aux | grep mcpc-bridge`
- Check socket exists: `ls ~/.mcpc/bridges/`

**"Session not found"**
- Session may have expired. Create new session: `mcpc <target> connect --session @<session-name>`
- List existing sessions: `mcpc`

**"Package not found"**
- Ensure package is installed: `npm list -g <package>` or `npm list <package>`
- Try with full path: `mcpc /path/to/package/bin/server resources-list`

**"Authentication failed"**
- List saved profiles: `mcpc <server> auth-list`
- Re-authenticate: `mcpc <server> auth --profile <name>`
- For bearer tokens: provide `--header "Authorization: Bearer ${TOKEN}"` again

### Debug mode

Enable detailed logging with `--verbose`:

```bash
mcpc --verbose @apify tools-list
```

This shows:
- Protocol negotiation details
- JSON-RPC request/response messages
- Streaming events and reconnection attempts
- Bridge communication (socket messages)
- File locking operations
- Prints server log messages with with severity `debug`, `info`, and `notice` to standard output

### Logs

Bridge processes log to:
- `~/.mcpc/logs/bridge-<session-name>.log`

Log rotation: Keep last 10MB per session, max 5 files.

## Contributing

Contributions are welcome!

### Development setup

```bash
# Clone repository
git clone https://github.com/apify/mcpc.git
cd mcpc

# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build

# Test locally
npm link
mcpc --help
```

### Release process

```bash
# Run tests
npm test

# Build
npm run build

# Bump version
npm version patch|minor|major

# Publish
npm publish

# Push tags
git push --tags
```

Please open an issue or pull request on [GitHub](https://github.com/apify/mcpc).


### References

- [Official MCP documentation](https://modelcontextprotocol.io/llms.txt)
- [Official TypeScript SDK for MCP servers and clients](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector) - CLI client implementation for reference


## License

Apache-2.0 - see [LICENSE](./LICENSE) for details.

