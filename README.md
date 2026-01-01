# `mcpc`: Universal MCP command-line client

`mcpc` is a CLI for the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/),
which maps MCP operations to intuitive commands for interactive shell use, scripts, and AI coding agents.

`mcpc` can connect to any MCP server over Streamable HTTP or stdio transports,
securely login via OAuth credentials and store credentials,
and keep long-term sessions to multiple servers.
It supports all major MCP features, including tools, resources, prompts, asynchronous tasks, and notifications.

`mcpc` is handy for manual testing of MCP servers, scripting,
and AI coding agents to use MCP in ["code mode"](https://www.anthropic.com/engineering/code-execution-with-mcp),
for better accuracy and lower token compared to traditional tool function calling.
After all, UNIX-compatible shell script is THE most universal coding language, for people and LLMs alike.

Note that `mcpc` does not use LLMs on its own; that's a job for the higher layer.

**Key features**

- 🔌 **Highly compatible** - Works with any MCP server over Streamable HTTP or stdio.
- 🔄 **Persistent sessions** - Keep multiple server connections alive simultaneously.
- 🚀 **Zero setup** - Connect to remote servers instantly with just a URL.
- 🔧 **Full protocol support** - Tools, resources, prompts, dynamic discovery, and async notifications.
- 📊 **JSON output** - Easy integration with `jq`, scripts, and other CLI tools.
- 🤖 **AI-friendly** - Designed for code generation and automated workflows.
- 🔒 **Secure** - OS keychain integration for credentials, encrypted auth storage.


## Table of contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Install](#install)
- [Quickstart](#quickstart)
- [Usage](#usage)
  - [General commands](#general-commands)
  - [MCP commands](#mcp-commands)
    - [Tool/prompt arguments](#toolprompt-arguments)
  - [JSON mode](#json-mode)
- [Sessions](#sessions)
  - [Session management](#session-management)
  - [Session failover](#session-failover)
- [Authentication](#authentication)
  - [Anonymous access](#anonymous-access)
  - [Bearer token authentication](#bearer-token-authentication)
  - [OAuth profiles](#oauth-profiles)
  - [Authentication precedence](#authentication-precedence)
- [Interaction](#interaction)
  - [CLI](#cli)
  - [Interactive shell](#interactive-shell)
  - [Scripting](#scripting)
    - [Schema validation](#schema-validation)
  - [AI agents](#ai-agents)
    - [Claude Code skill](#claude-code-skill)
    - [Sandboxing](#sandboxing)
- [Configuration](#configuration)
  - [MCP server config file](#mcp-server-config-file)
  - [Environment variables](#environment-variables)
  - [Cleanup](#cleanup)
- [MCP protocol notes](#mcp-protocol-notes)
  - [Server logs](#server-logs)
- [Security](#security)
  - [Authentication](#authentication-1)
  - [Credential storage](#credential-storage)
  - [Bridge process authentication](#bridge-process-authentication)
  - [File permissions](#file-permissions)
  - [Network security](#network-security)
- [Error handling](#error-handling)
  - [Exit codes](#exit-codes)
  - [Verbose mode](#verbose-mode)
  - [Logs](#logs)
  - [Troubleshooting common issues](#troubleshooting-common-issues)
- [Development](#development)
- [License](#license)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->


## Install

```bash
npm install -g @apify/mcpc
```

## Quickstart

```bash
# List all active sessions and saved authentication profiles
mcpc

# Login to remote MCP server and save OAuth credentials for future use
mcpc mcp.apify.com login

# Show information about a remote MCP server
mcpc mcp.apify.com

# Use JSON mode for scripting
mcpc mcp.apify.com tools-list --json

# Create and use persistent MCP session
mcpc mcp.apify.com session @test
mcpc @test tools-call search-actors --args keywords="web crawler"
mcpc @test shell

# Interact with a local MCP server package (stdio) referenced from config file
mcpc --config ~/.vscode/mcp.json filesystem tools-list
```

## Usage

```bash
Usage: mcpc [options] <target> [command]

Options:
  -v, --version           Output the version number
  -j, --json              Output in JSON format for scripting
  --verbose               Enable verbose logging
  -c, --config <file>     Path to MCP config JSON file (e.g. ".vscode/mcp.json")
  -H, --header <header>   Add HTTP header (can be repeated)
  --timeout <seconds>     Request timeout in seconds (default: 300)
  --profile <name>        Authentication profile to use (default: "default")
  --schema <file>         Validate tool/prompt schema against expected schema
  --schema-mode <mode>    Schema validation mode: strict, compatible (default), ignore
  --clean[=types]         Clean up mcpc data (types: sessions, logs, profiles, all)
  -h, --help              Display general help

Targets:
  @<session>              Named persistent session (e.g. "@apify")
  <config-entry>          Entry in MCP config file specified by --config (e.g. "fs")
  <server-url>            Remote MCP server URL (e.g. "mcp.apify.com")
 
General commands:
  help                    Show server info, instructions, and capabilities
  shell                   Open interactive shell to run MCP commands)
  login                   Create OAuth profile with credentials to access remote server
  logout                  Remove OAuth profile for remote server
  session @<session>      Connect to server and create named persistent session
  restart @<session>      Kill and restart a session  
  close @<session>        Close a session
  
MCP commands: 
  tools-list
  tools-get <tool-name>  
  tools-call <tool-name> [<args-json> | arg1:=val1 arg2:=val2 ...]
  prompts-list
  prompts-get <prompt-name> [<args-json> | arg1:=val1 arg2:=val2 ...]
  resources
  resources-list
  resources-read <uri>
  resources-subscribe <uri>
  resources-unsubscribe <uri>
  resources-templates-list
  logging-set-level <level>  
```

### General commands

Basic operations not related to any specific MCP server.

```bash
# List all sessions and OAuth profiles (supports also JSON format)
mcpc
mcpc --json

# Show help
mcpc --help

# Show command version
mcpc --version

# Clean expired sessions and old log files
mcpc --clean
```

See also [OAuth profiles](#oauth-profiles) and [Cleanup](#cleanup) commands.

### MCP commands

To interact with an MCP server, you need to specify `<target>`, which can be one of (in this order of precedence):
- **Named entry** in a config file when used with `--config` (e.g. `filesystem`) - see [Configuration](#configuration) for details.
- **Remote MCP server URL** (e.g. `https://mcp.apify.com`)
- **Named session** prefixed with `@` (e.g. `@apify`) - see [Sessions](#sessions)

`mcpc` automatically selects the transport protocol based on the server (stdio or Streamable HTTP).

One-shot commands are useful for simple stateless interaction with MCP server.


#### Tool/prompt arguments

`mcpc` supports multiple ways to pass arguments to `tools-call` and `prompts-get` commands:

```bash
# Inline JSON object (most convenient)
mcpc @fs tools-call <tool-name> '{"query":"hello","count":10}'

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



### JSON mode

By default, `mcpc` prints output in Markdown-ish text format with colors, to make easy to read by both humands and AIs.

With `--json` option, `mcpc` always emits only a single JSON object (or array), to enable scripting.
**For all MCP commands, the returned objects are always consistent with the
[MCP specification](https://modelcontextprotocol.io/specification/latest).**
On success, the JSON object is printed to stdout, on error to stderr.
For details, see [Scripting](#scripting).

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

`mcpc` saves its state to `~/.mcpc/` directory (unless overridden by `MCPC_HOME_DIR`), in the following files:

- `~/.mcpc/sessions.json` - Active sessions with references to authentication profiles (file-locked for concurrent access)
- `~/.mcpc/profiles.json` - Authentication profiles (OAuth metadata, scopes, expiry)
- `~/.mcpc/bridges/` - Unix domain socket files for each bridge process
- `~/.mcpc/logs/bridge-*.log` - Log files for each bridge process
- OS keychain - Sensitive credentials (OAuth tokens, bearer tokens, client secrets)

### Session management

```bash
# Create a persistent session (with default authentication profile, if available)
mcpc mcp.apify.com\?tools=docs session @apify1

# Create session with specific authentication profile
mcpc mcp.apify.com session @apify --profile personal

# List all active sessions and saved authentication profiles
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

# Restart the session (kills and restarts the bridge process)
mcpc @apify restart

# Close the session (terminates bridge process, but keeps authentication profile)
mcpc @apify close
```

### Session failover

`mcpc` bridge process attempts to keep sessions alive by sending periodic ping messages to the MCP server.
But even then, the session can fail for a number of reasons:

- Network disconnects
- Server drops the session for inactivity or other reasons
- Bridge process crashes

Here's how `mcpc` handles these situations:

- If the bridge process is running, it will automatically try to reconnect to the server if the connection fails
  and establish the keep-alive pings.
- If the server response indicates the `MCP-Session-Id` is no longer valid or authentication permanently failed (HTTP error 401 or 402),
  the bridge process will flag the session as **expired** in `~/.mcpc/sessions.json` and terminate.
- If the bridge process crashes, `mcpc` attempts to restart it next time you use the specific session.

Note that `mcpc` never automatically removes sessions from the list, but rather flags the session as **expired**,
and any attempts to use it will fail.
To remove the session from the list, you need to explicitly close it:

```bash
mcpc @apify close
```

or reconnect it using the `session` command (if the session exists but bridge is dead, it will be automatically reconnected):

```bash
mcpc https://mcp.apify.com session @apify
```


## Authentication

`mcpc` supports all standard [MCP authorization methods](https://modelcontextprotocol.io/specification/latest/basic/authorization).

### Anonymous access

For local servers (stdio) or remote servers (Streamable HTTP) which do not require credentials,
`mcpc` can be used without authentication:

```bash
# One-shot command
mcpc mcp.apify.com\?tools=docs tools-list

# Session command
mcpc mcp.apify.com\?tools=docs session @test
mcpc @test tools-list
```

### Bearer token authentication

For remote servers that require a Bearer token (but not OAuth), use the `--header` flag to pass the token.
All headers are stored securely in the OS keychain for the session, but they are **not** saved as reusable
[authentication profiles](#authentication-profiles). This means `--header` needs to be provided whenever
running a one-shot command or connecting new session.

```bash
# One-time command with Bearer token
mcpc --header "Authorization: Bearer ${APIFY_TOKEN}" https://mcp.apify.com tools-list

# Create session with Bearer token (saved to keychain for this session only)
mcpc --header "Authorization: Bearer ${APIFY_TOKEN}" https://mcp.apify.com session @apify

# Use the session (Bearer token is loaded from keychain automatically)
mcpc @apify tools-list
```

### OAuth profiles

For OAuth-enabled remote MCP servers, `mcpc` implements the full OAuth 2.1 flow with PKCE, 
including `WWW-Authenticate` header discovery, server metadata discovery, client ID metadata documents, 
dynamic client registration, and automatic token refresh.

The OAuth authentication **always** needs to be initiated by the user calling the `login` command,
which opens a web browser with login screen. `mcpc` never opens the web browser on its own.

The OAuth credentials to specific servers are securely stored as **authentication profiles** - reusable
credentials that allow you to:
- Authenticate once, use credentials across multiple commands or sessions
- Use different accounts (profiles) with the same server
- Manage credentials independently from sessions

Key concepts:
- **Authentication profile**: Named set of OAuth credentials for a specific server (stored in `~/.mcpc/profiles.json` + OS keychain)
- **Session**: Active connection to a server that may reference an authentication profile (stored in `~/.mcpc/sessions.json`)
- **Default profile**: When `--profile` is not specified, `mcpc` uses the authentication profile named `default`

**Example:**

```bash
# Login to server and save 'default' authentication profile for future use
mcpc mcp.apify.com login

# Use named authentication profile instead of 'default'
mcpc mcp.apify.com login --profile work

# Create two sessions using the two different credentials
mcpc https://mcp.apify.com session @apify-personal
mcpc https://mcp.apify.com session @apify-work --profile work

# Both sessions now work independently
mcpc @apify-personal tools-list  # Uses personal account
mcpc @apify-work tools-list      # Uses work account

# Re-authenticate existing profile (e.g., to refresh or change scopes)
mcpc mcp.apify.com login --profile work

# Delete "default" and "work" authentication profiles
mcpc mcp.apify.com logout
mcpc mcp.apify.com logout --profile work
```

### Authentication precedence

When multiple authentication methods are available, `mcpc` uses this precedence order:

1. **Command-line `--header` flag** (highest priority) - Always used if provided
2. **Saved authentication profiles** - OAuth tokens from saved profile
3. **Config file headers** - Headers from `--config` file for the server
4. **No authentication** - Attempts unauthenticated connection


`mcpc` automatically handles authentication based on whether you specify a profile:

**When `--profile <name>` is specified:**

1. **Profile exists for the server**: Use its stored credentials
   - If authentication succeeds → Continue with command/session
   - If authentication fails (expired/invalid) → Fail with an error
2. **Profile doesn't exist**: Fail with an error

**When no `--profile` is specified:**

1. **`default` profile exists for the server**: Use its stored credentials
   - If authentication succeeds → Continue with command/session
   - If authentication fails (expired/invalid) → Fail with an error
2. **`default` profile doesn't exist**: Attempt unauthenticated connection
   - If server accepts (no auth required) → Continue without creating profile
   - If server rejects with 401 + `WWW-Authenticate` → Fail with an error

On failure, the error message includes instructions on how to login and save the profile, so the users know what to do.

This flow ensures:
- You only authenticate when necessary
- Credentials are never silently mixed up (personal → work) or downgraded (authenticated → unauthenticated)
- You can mix authenticated sessions (with named profiles) and public access on the same server

**Examples:**

```bash
# With specific profile - always authenticated:
# - Uses 'work' if it exists
# - Fails if it doesn't exist
mcpc mcp.apify.com session @apify-work --profile work

# Without profile - opportunistic authentication:
# - Uses 'default' if it exists
# - Tries unauthenticated if 'default' doesn't exist
# - Fails if the server requires authentication
mcpc mcp.apify.com session @apify-personal

# Public server - no authentication needed:
mcpc mcp.apify.com\?tools=docs tools-list
```


## Interaction

`mcpc` is designed to  

### Interactive shell

The interactive shell provides a REPL-style interface for MCP servers:

```bash
# Open shell to server without explicit session
mcpc mcp.apify.com shell

# Use existing session
mcpc @apify shell
```

In shell, you can use the same [MCP commands](#mcp-commands) as in CLI,
and the following additional commands:
- `help` - Show available commands
- `exit` or `quit` or Ctrl+D - Exit shell
- Ctrl+C - Cancel current operation
- Arrow keys for command history navigation (saved to `~/.mcpc/history`, last 1,000 commands)

### Scripting

`mcpc` is designed for us in (AI-generated) scripts.
With the `--json` option, `mcpc` returns a single JSON object (object or array) as follows:

- On success, the JSON object is printed to stdout
- On error, the JSON object is printed to stderr

You can use tools like `jq` to process the output.

Note that `--json` option has no effect on `--help` command,
or if there are invalid arguments, as those take precedence.

For all MCP operations, the **returned JSON is and always will be strictly consistent
with the [MCP specification](https://modelcontextprotocol.io/specification/latest)**,
based to the protocol version negotiated between client and server in the initial handshake.

Additionally, one of the core [design principles](CONTRIBUTING.md#design-principles) of `mcpc` 
is to keep backwards compatibility to maximum extent possible, to ensure the scripts using `mcpc`
will not break over time.

Piping between sessions

```bash
mcpc --json @apify tools-call search-actors --args query="tiktok scraper" \
  | jq '.data.results[0]' \
  | mcpc @playwright tools-call run-browser
```

#### Schema validation

MCP is a fluid protocol, and MCP servers can change operations and their schema at any time.
To ensure your scripts fail fast whenever such schema change occurs, rather than fail silently later,
you can use the `--schema <file>` option to pass `mcpc` the expected operation schema.
If the MCP server's current schema is incompatible, the command returns an error.

```bash
# Save tool schema for future validation
mcpc --json @apify tools-get search-actors > search-actors-schema.json

# Use schema to ensure compatibility (fails if schema changed)
mcpc @apify tools-call search-actors \
  --schema search-actors-schema.json \
  --schema-mode strict \
  --args keywords="tiktok scraper"
```

The `--schema-mode <mode>` parameter determines how `mcpc` validates the schema:

- `compatible` (default) - Backwards compatible (new optional fields OK, types of required
  fields and passed arguments must match, descriptions are ignored). For tools, the output schema
  is ignored.
- `strict` - Exact schema match required (all fields, their types and descriptions must be
  identical). For tools, the output schema must match exactly.
- `ignore` - Skip schema validation altogether


### AI agents

`mcpc` is [designed](CONTRIBUTING.md#design-principles) for AI agent use: 
the commands and messages are consise, intuitive, and avoid unnecessary interaction loops.
You AI coding agents can readily interact with `mcpc` in text mode

#### Code mode

TODO: Explain that scripting can be used for this,
link to https://www.anthropic.com/engineering/code-execution-with-mcp
and https://blog.cloudflare.com/code-mode/ 

#### Claude Code skill

For AI coding agents using [Claude Code](https://claude.ai/code), we provide a skill that teaches Claude how to use mcpc effectively.

**Installation:**
```bash
mkdir -p ~/.claude/skills/mcpc
cp claude-skill/SKILL.md ~/.claude/skills/mcpc/
```

Then restart Claude Code. The skill enables Claude to interact with MCP servers via mcpc commands instead of function calling, which is more efficient and uses fewer tokens.

See [`claude-skill/README.md`](./claude-skill/README.md) for details.


#### Sandboxing

TODO: explain auth profiles need to be created by person before

Future: sharing with 


## Configuration

Configuration can be provided via file, environment variables, or command-line flags.

**Precedence** (highest to lowest):
1. Command-line flags (including `--config` option)
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
mcpc --config .vscode/mcp.json apify session @my-apify
```

**Example MCP config JSON file:**

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
mcpc --config .vscode/mcp.json filesystem session @fs
mcpc @fs tools-call search
```

**Environment variable substitution:**

Config files support environment variable substitution using `${VAR_NAME}` syntax:

```json
{
  "mcpServers": {
    "secure-server": {
      "url": "https://mcp.apify.com",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}",
        "X-User-ID": "${USER_ID}"
      }
    }
  }
}
```

### Environment variables

- `MCPC_HOME_DIR` - Directory for session and authentication profiles data (default is `~/.mcpc`)
- `MCPC_VERBOSE` - Enable verbose logging (set to `1`, `true`, or `yes`, case-insensitive)
- `MCPC_JSON` - Enable JSON output (set to `1`, `true`, or `yes`, case-insensitive)


### Cleanup

You can clean up the `mcpc` state and data using the `--clean` option:

```bash
# Safe non-destructive cleanup: remove expired sessions, delete old orphaned logs
mcpc --clean

# Clean specific resources (comma-separated)
mcpc --clean=sessions      # Kill bridges, delete all sessions
mcpc --clean=profiles      # Delete all authentication profiles
mcpc --clean=logs          # Delete all log files
mcpc --clean=sessions,logs # Clean multiple resource types

# Nuclear option: remove everything
mcpc --clean=all           # Delete all sessions, profiles, logs, and sockets
```

## MCP protocol notes

TODO: explain in detail how MCP concepts work in mcpc

**Protocol initialization:**
- `mcpc` follows the MCP initialization handshake: sends `initialize` request with protocol version and capabilities, receives server capabilities and instructions, then sends `initialized` notification
- Protocol version negotiation: client proposes latest supported version (currently `2025-11-25`), server responds with version to use

**Transport handling:**
- **Streamable HTTP**: `mcpc` supports only the Streamable HTTP transport (the current standard). The deprecated HTTP with SSE transport is not supported. The bridge manages persistent HTTP connections with bidirectional streaming for server-to-client communication, with automatic reconnection using exponential backoff (1s → 30s max)
  - Includes `MCP-Protocol-Version` header on all HTTP requests (per MCP spec)
  - Handles `MCP-Session-Id` for stateful server sessions
- During reconnection, new requests are queued (fails after 3 minutes of disconnection)
- **Stdio**: Direct bidirectional JSON-RPC communication over standard input/output

**Protocol features:**
- `mcpc` supports all MCP primitives in both Streamable HTTP and stdio transports:
  - **Instructions**: Fetches and stores MCP server-provided `instructions`
  - **Tools**: Executable functions with JSON Schema-validated arguments. 
  - **Resources**: Data sources identified by URIs (e.g., `file:///path/to/file`, `https://example.com/data`), with optional subscriptions for change notifications
  - **Prompts**: Reusable message templates with customizable arguments
  - **Completion**: Provides access to Completion API for tools and resources
  - **Asynchronous tasks**: Not implemented yet
  - **Roots**: Not implemented yet
- Supports server logging settings (`logging/setLevel`) and messages (`notifications/message`), and prints them to stderr or stdout based on verbosity level.
- Handles server notifications: progress tracking, logging, and change notifications (`notifications/tools/list_changed`, `notifications/resources/list_changed`, `notifications/prompts/list_changed`)
- Request multiplexing: supports up to 10 concurrent requests, queues up to 100 additional requests
- Pagination: List operations automatically fetch all pages when the server returns paginated results
- Pings: `mcpc` periodically issues the MCP `ping` request to keep the connection alive
- Sampling is not supported as `mcpc` has no access to an LLM


### Server logs

TODO: Move this to MPC features section


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

**Note:** This sets the logging level on the **server side**. The actual log output depends on the server's implementation.


## Security

TODO: Simplify this section

`mcpc` implements the [MCP security best practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices) specification. MCP enables arbitrary tool execution and data access; treat servers like you treat shells:

* Use least-privilege tokens/headers
* Prefer trusted endpoints
* Audit what tools do before running them
* Review server permissions in interactive mode

### Authentication

**OAuth 2.1 with PKCE:**
- Full OAuth 2.1 flow with PKCE (Proof Key for Code Exchange) via the MCP SDK
- OAuth callback server binds to `127.0.0.1` only (not `0.0.0.0`)
- Warning displayed for OAuth over plain HTTP (except localhost)
- Dynamic client registration supported

**Input validation:**
- Session names validated: `^@[a-zA-Z0-9_-]{1,64}$`
- Profile names validated: `^[a-zA-Z0-9_-]{1,64}$`
- URLs normalized and validated (HTTPS enforced, credentials stripped)

### Credential storage

**OS keychain integration:**
- OAuth refresh tokens are stored in the OS keychain (access tokens are kept in memory only)
- OAuth client credentials (client_id, client_secret from dynamic registration) are stored in the keychain
- All HTTP headers from `--header` flags are stored per-session in the keychain (as JSON)
- The `~/.mcpc/profiles.json` file only contains metadata (server URL, scopes, timestamps) - never tokens

**Keychain entries:**
- OAuth tokens: `mcpc:auth-profile:<host>:<profileName>:tokens`
- OAuth client: `mcpc:auth-profile:<host>:<profileName>:client`
- HTTP headers: `mcpc:session:<sessionName>:headers`

### Bridge process authentication

Background bridge processes need access to credentials for making authenticated requests. To maintain security while allowing token refresh:

**For OAuth profiles:**
1. **CLI retrieves refresh token** from OS keychain when creating or restarting a session
2. **CLI sends refresh token to bridge** via Unix socket IPC (not command line arguments)
3. **Bridge stores refresh token in memory only** - never written to disk
4. **Bridge refreshes access tokens** periodically using the refresh token
5. **Access tokens are kept in bridge memory** - never persisted to disk

**For HTTP headers (from `--header` flags):**
1. **All headers are treated as potentially sensitive** - not just `Authorization`
2. **CLI stores all headers in OS keychain** per-session (as JSON)
3. **CLI sends headers to bridge** via Unix socket IPC (not command line arguments)
4. **Bridge stores headers in memory only** - never written to disk
5. **Headers are deleted from keychain** when session is closed
6. **On bridge crash/restart**, CLI retrieves headers from keychain and resends via IPC

This architecture ensures:
- Credentials are never stored in plaintext on disk
- Headers are not visible in process arguments (`ps aux`)
- Bridge processes don't need direct keychain access (which may require user interaction)
- Credentials are securely transmitted via Unix socket (local IPC only)
- Failover works correctly - headers are preserved across bridge restarts

### File permissions

- `~/.mcpc/sessions.json` is created with `0600` permissions (user-only read/write)
- `~/.mcpc/profiles.json` is created with `0600` permissions (user-only read/write)
- Bridge sockets in `~/.mcpc/bridges/` use default umask (typically user-only)
- File locking via `proper-lockfile` prevents race conditions on concurrent access

### Network security

- HTTPS enforced for remote servers (HTTP auto-upgraded when no scheme provided)
- URL normalization removes username, password, and hash from URLs
- Local OAuth callback server binds to `127.0.0.1` only
- No credentials logged even in verbose mode

## Error handling

`mcpc` provides clear error messages for common issues:

- **Connection failures**: Displays transport-level errors with retry suggestions
- **Session timeouts**: Automatically attempts to reconnect or prompts for session recreation
- **Invalid commands**: Shows available commands and correct syntax
- **Tool execution errors**: Returns server error messages with context
- **Bridge crashes**: Detects and cleans up orphaned processes, offers restart

### Exit codes

- `0` - Success
- `1` - Client error (invalid arguments, command not found, etc.)
- `2` - Server error (tool execution failed, resource not found, etc.)
- `3` - Network error (connection failed, timeout, etc.)
- `4` - Authentication error (invalid credentials, forbidden, etc.)

### Verbose mode

To see what's happening, enable detailed logging with `--verbose`.

```bash
mcpc --verbose @apify tools-list
```

This causes `mcpc` to print detailed debug messages to stderr.

### Logs

The background bridge processes log to `~/.mcpc/logs/bridge-<session-name>.log`.
The main `mcpc` process doesn't save log files.

Log rotation: Keep last 10MB per session, max 5 files.

### Troubleshooting common issues

**"Cannot connect to bridge"**
- Bridge may have crashed. Try: `mcpc @<session-name> tools-list` to restart the bridge
- Check bridge is running: `ps aux | grep -e 'mcpc-bridge' -e '[m]cpc/dist/bridge'`
- Check socket exists: `ls ~/.mcpc/bridges/`

**"Session not found"**
- List existing sessions: `mcpc`
- Create new session if expired: `mcpc @<session-name> close` and `mcpc <target> session @<session-name>`

**"Authentication failed"**
- List saved OAuth profiles: `mcpc`
- Re-authenticate: `mcpc <server> login [--profile <name>]`
- For bearer tokens: provide `--header "Authorization: Bearer ${TOKEN}"` again


## Development

`mcpc` was built by [Jan Curn](https://x.com/jancurn) from [Apify](https://apify.com) over the 
2025 Xmas holidays.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, architecture overview, and contribution guidelines.

## License

Apache-2.0 - see [LICENSE](./LICENSE) for details.

