# mcpc: Universal MCP command-line client

`mcpc` is a CLI for the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/),
which maps MCP requests to intuitive commands for shell access, scripts, and AI coding agents.

`mcpc` can connect to any MCP server over Streamable HTTP or stdio transports,
securely login via OAuth credentials and store credentials,
and keep long-term sessions to multiple servers in parallel.
It supports all major MCP features, including tools, resources, prompts, asynchronous tasks, and notifications.

`mcpc` is handy for manual testing of MCP servers, scripting,
and AI coding agents to use MCP in ["code mode"](https://www.anthropic.com/engineering/code-execution-with-mcp),
for better accuracy and lower token compared to traditional tool function calling.
After all, UNIX-compatible shell script is THE most universal coding language, for both people and LLMs.

Note that `mcpc` is deterministic and does not use any LLM on its own; that's for the higher layer to do.

## Table of contents

TODO: Simplify README - there are too many top-level sections, and then show just the second level ones

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN "npm run build:toc" TO UPDATE -->

- [Features](#features)
- [Install](#install)
- [Quickstart](#quickstart)
- [Usage](#usage)
  - [MCP command arguments](#mcp-command-arguments)
- [Global flags](#global-flags)
- [Authentication](#authentication)
  - [No authentication](#no-authentication)
  - [Bearer token authentication](#bearer-token-authentication)
  - [OAuth authentication](#oauth-authentication)
    - [Authentication profiles](#authentication-profiles)
    - [Authentication behavior](#authentication-behavior)
    - [Multiple accounts for the same server](#multiple-accounts-for-the-same-server)
  - [Authentication precedence](#authentication-precedence)
  - [Authentication profiles storage format](#authentication-profiles-storage-format)
- [Sessions](#sessions)
  - [Managing sessions](#managing-sessions)
  - [Piping between sessions](#piping-between-sessions)
  - [Scripting](#scripting)
  - [Session failover](#session-failover)
- [Logging](#logging)
- [Cleanup](#cleanup)
- [Configuration](#configuration)
  - [MCP config JSON file](#mcp-config-json-file)
  - [Environment variables](#environment-variables)
- [MCP protocol notes](#mcp-protocol-notes)
- [Output format](#output-format)
  - [Human-readable (default)](#human-readable-default)
  - [JSON mode (`--json`)](#json-mode---json)
- [Security](#security)
  - [Credential storage](#credential-storage)
  - [Bridge process authentication](#bridge-process-authentication)
  - [File permissions](#file-permissions)
  - [Network security](#network-security)
- [Error handling](#error-handling)
  - [Exit codes](#exit-codes)
  - [Retry strategy](#retry-strategy)
- [Interactive shell](#interactive-shell)
- [Claude Code skill](#claude-code-skill)
- [Implementation](#implementation)
  - [Design principles](#design-principles)
  - [Architecture overview](#architecture-overview)
  - [Core module (runtime-agnostic)](#core-module-runtime-agnostic)
  - [Bridge process](#bridge-process)
  - [CLI executable](#cli-executable)
  - [Session lifecycle](#session-lifecycle)
  - [Error recovery](#error-recovery)
- [Testing strategy](#testing-strategy)
- [Troubleshooting](#troubleshooting)
  - [Common issues](#common-issues)
  - [Debug mode](#debug-mode)
  - [Logs](#logs)
- [Contributing](#contributing)
  - [Development setup](#development-setup)
  - [Release process](#release-process)
  - [References](#references)
- [Authors](#authors)
- [License](#license)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Features

- 🔌 **Universal MCP client** - Works with any MCP server over Streamable HTTP or stdio.
- 🔄 **Persistent sessions** - Keep multiple server connections alive simultaneously.
- 🚀 **Zero setup** - Connect to remote servers instantly with just a URL.
- 🔧 **Full protocol support** - Tools, resources, prompts, dynamic discovery, and async notifications.
- 📊 **`--json` output** - Easy integration with `jq`, scripts, and other CLI tools.
- 🤖 **AI-friendly** - Designed for code generation and automated workflows.
- 🔒 **Secure** - OS keychain integration for credentials, encrypted auth storage.

## Install

```bash
npm install -g @apify/mcpc
```

## Quickstart

```bash
# List all active sessions and saved authentication profiles
mcpc

# Use a local server package referenced by MCP config file
mcpc --config ~/.vscode/mcp.json filesystem tools-list

# Login to OAuth-enabled MCP server and save authentication for future use
mcpc mcp.apify.com login

# Show information about a remote MCP server and open interactive shell
mcpc mcp.apify.com
mcpc mcp.apify.com shell

# Use JSON mode for scripting
mcpc --json mcp.apify.com tools-list

# Create a persistent session (or reconnect if it exists but bridge is dead)
mcpc mcp.apify.com session @test
mcpc @test tools-call search-actors --args query="web crawler"
mcpc @test shell
```

## Usage

```bash
mcpc [--json] [--config <file>] [-H|--header "K: V"] [-v|--verbose]
     [--schema <file>] [--schema-mode <mode>] [--timeout <seconds>] 
     [--clean|--clean=sessions,logs,profiles,all]
     <target> <command...>

# Lists all active sessions and saved authentication profiles
mcpc         

# Shows server or session info, instructions, and capabilities         
mcpc <target>

# MCP commands
mcpc <target> tools
mcpc <target> tools-list
mcpc <target> tools-schema <tool-name>
mcpc <target> tools-call <tool-name> [--args key=val key2:=json ...] [--args-file <file>]

mcpc <target> prompts
mcpc <target> prompts-list
mcpc <target> prompts-get <prompt-name> [--args key=val key2:=json ...] [--args-file <file>]

mcpc <target> resources
mcpc <target> resources-list
mcpc <target> resources-read <uri>
mcpc <target> resources-subscribe <uri>
mcpc <target> resources-unsubscribe <uri>
mcpc <target> resources-templates-list

mcpc <target> logging-set-level <level>

# Interactive MCP shell
mcpc <target> shell

# Persistent sessions
mcpc <server> session @<session-name> [--profile <name>]
mcpc @<session-name> <command...>
mcpc @<session-name> close

# Saved OAuth profiles for remote MCP servers
mcpc <server> login [--profile <name>]
mcpc <server> logout [--profile <name>]
```

where `<target>` can be one of (in this order of precedence):

- **Named session** prefixed with `@` (e.g. `@apify`) - persisted connection via bridge process
- **Named entry** in a config file, when used with `--config` (e.g. `filesystem`) - local or remote server
- **Remote MCP endpoint** URL (e.g. `mcp.apify.com` or `https://mcp.apify.com`) - direct HTTP connection

For local MCP servers (stdio transport), use a config file to specify the command, arguments, and environment variables. See [Configuration](#configuration) below.

`mcpc` automatically selects the transport protocol:
- HTTP/HTTPS URLs use the MCP Streamable HTTP transport (current standard; HTTP with SSE is not supported)
- Config file entries use the transport specified in the config (stdio for local servers, HTTP for remote)

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
- `--config <file>` - Use MCP config JSON file (e.g., `.vscode/mcp.json`)
- `-H, --header "Key: Value"` - Add HTTP header (can be repeated)
- `-v, --verbose` - Enable verbose logging (shows protocol details)
- `--timeout <seconds>` - Request timeout in seconds (default: 300)
- `--schema <file>` - Validate against expected tool/prompt schema
- `--schema-mode <mode>` - Schema validation mode: `strict`, `compatible`, or `ignore` (default: `compatible`)

## Authentication

`mcpc` supports all standard [authentication methods](https://modelcontextprotocol.io/specification/latest/basic/authorization) for MCP servers,
including the `WWW-Authenticate` discovery mechanism and OAuth 2.1 with PKCE.

### No authentication

For local servers (stdio) or remote servers (Streamable HTTP) which do not require credentials,
`mcpc` can be used without authentication:

```bash
# Remote server which enables anonymous access
mcpc https://mcp.apify.com\?tools=docs tools-list
```

### Bearer token authentication

For remote servers that require a bearer token (but not OAuth), use the `--header` flag.
All headers are stored securely in the OS keychain for the session, but **not** saved as a reusable authentication profile:

```bash
# One-time command with bearer token
mcpc --header "Authorization: Bearer ${APIFY_TOKEN}" https://mcp.apify.com tools-list

# Create session with bearer token (saved to keychain for this session only)
mcpc --header "Authorization: Bearer ${APIFY_TOKEN}" https://mcp.apify.com session @apify

# Use the session (token loaded from keychain automatically)
mcpc @apify tools-list
```

### OAuth authentication

For OAuth-enabled remote MCP servers, `mcpc` implements the full OAuth 2.1 flow with PKCE, including:
- `WWW-Authenticate` header discovery
- Authorization server metadata discovery (RFC 8414)
- Client ID metadata documents (SEP-991)
- Dynamic client registration (RFC 7591)
- Automatic token refresh

The OAuth authentication is **always** initiated by the user calling the `login` command,
which opens a web browser with login screen. `mcpc` doesn't open web browser in any other case.

`mcpc` uses OS keychain to securely store OAuth authentication tokens.

#### Authentication profiles

For OAuth-enabled servers, `mcpc` uses **authentication profiles** - reusable credentials that can be shared across multiple sessions.
This allows you to:
- Authenticate once, create multiple sessions
- Use different accounts (profiles) with the same server
- Manage credentials independently from sessions

**Key concepts:**
- **Authentication profile**: Named set of OAuth credentials for a specific server (stored in `~/.mcpc/profiles.json` + OS keychain)
- **Session**: Active connection to a server that may reference an authentication profile (stored in `~/.mcpc/sessions.json`)
- **Default profile**: When `--profile` is not specified, `mcpc` uses the authentication profile named `default`

**Example:**

```bash
# Login to server and save 'default' authentication profile for future use
mcpc https://mcp.apify.com login

# Use named authentication profile instead of 'default'
mcpc https://mcp.apify.com login --profile personal

# Re-authenticate existing profile (e.g., to refresh or change scopes)
mcpc https://mcp.apify.com login --profile personal

# Delete an authentication profile
mcpc https://mcp.apify.com logout --profile personal

```

#### Authentication behavior

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

**This flow ensures:**
- You only authenticate when necessary
- Credentials are never silently mixed up (personal → work) or downgraded (authenticated → unauthenticated)
- You can mix authenticated sessions (with named profiles) and public access on the same server

**Examples:**

```bash
# With specific profile - always authenticated:
# - Uses 'personal' if it exists
# - Fails if it doesn't exist
mcpc https://mcp.apify.com session @apify1 --profile personal

# Without profile - opportunistic authentication:
# - Uses 'default' if it exists
# - Tries unauthenticated if 'default' doesn't exist
# - Fails if the server requires authentication
mcpc https://mcp.apify.com session @apify2

# Public server - no authentication needed:
mcpc https://mcp.apify.com\?tools=docs tools-list
```

#### Multiple accounts for the same server

Authentication profiles enable using multiple accounts with the same MCP server:

```bash
# Authenticate with personal account
mcpc https://mcp.apify.com login --profile personal

# Authenticate with work account
mcpc https://mcp.apify.com login --profile work

# Create sessions using the two different credentials
mcpc https://mcp.apify.com session @apify-personal --profile personal
mcpc https://mcp.apify.com session @apify-work --profile work

# Both sessions work independently
mcpc @apify-personal tools-list  # Uses personal account
mcpc @apify-work tools-list      # Uses work account
```

### Authentication precedence

When multiple authentication methods are available, `mcpc` uses this precedence order:

1. **Command-line `--header` flag** (highest priority) - Always used if provided
2. **Session's stored credentials** - Bearer tokens or OAuth tokens from profile
3. **Config file headers** - Headers from `--config` file for the server
4. **No authentication** - Attempts unauthenticated connection

**Example:**
```bash
# Config file has: "headers": {"Authorization": "Bearer ${TOKEN1}"}
# Session uses profile with different OAuth token
# Command provides: --header "Authorization: Bearer ${TOKEN2}"
# Result: Uses TOKEN2 (command-line flag wins)
```

### Authentication profiles storage format

By default, authentication profiles are stored in the `~/.mcpc/profiles.json` file with the following structure:

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
        "createdAt": "2025-12-14T10:00:00Z",
        "authenticatedAt": "2025-12-14T10:00:00Z"
      },
      "work": {
        "name": "work",
        "serverUrl": "https://mcp.apify.com",
        "authType": "oauth",
        "oauthIssuer": "https://auth.apify.com",
        "scopes": ["tools:read"],
        "createdAt": "2025-12-10T15:30:00Z",
        "authenticatedAt": "2025-12-10T15:30:00Z"
      }
    }
  }
}
```

**OS Keychain entries:**
- OAuth tokens: `mcpc:auth:https://mcp.apify.com:personal:tokens`
- OAuth client info: `mcpc:auth:https://mcp.apify.com:personal:client`
- HTTP headers (per-session): `mcpc:session:apify:headers`

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

### Managing sessions

```bash
# Create a persistent session (with default authentication profile, if available)
mcpc https://mcp.apify.com session @apify

# Create session with specific authentication profile
mcpc https://mcp.apify.com session @apify --profile personal

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

# Close the session (terminates bridge process, but keeps authentication profile)
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

## Logging

The background bridge process logs to `~/.mcpc/logs/bridge-<session-name>.log`.
The main `mcpc` process doesn't save log files, but you can use `--verbose` flag to print all logs to stderr.

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


## Cleanup

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

## Configuration

Configuration can be provided via file, environment variables, or command-line flags.

**Precedence** (highest to lowest):
1. Command-line flags (including `--config` option)
2. Environment variables
3. Built-in defaults

### MCP config JSON file

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

## MCP protocol notes

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
- Supports server logging settings (`logging/setLevel`) and messages (`notifications/message`), and prints them to stderr or stdout based on verbosity level.
- Handles server notifications: progress tracking, logging, and change notifications (`notifications/tools/list_changed`, `notifications/resources/list_changed`, `notifications/prompts/list_changed`)
- Request multiplexing: supports up to 10 concurrent requests, queues up to 100 additional requests
- Pagination: List operations automatically fetch all pages when the server returns paginated results
- Pings: `mcpc` periodically issues the MCP `ping` request to keep the connection alive
- Sampling is not supported as `mcpc` has no access to an LLM

## Output format

### Human-readable (default)

Default output is formatted for human and AI readability with plain text, colors, and Markdown-like formatting.

### JSON mode (`--json`)

In JSON mode, `mcpc` always emits only a single JSON object to enable scripting.
For MCP commands, the object is always consistent with the MCP protocol specification.
On success, the JSON object is printed to stdout, otherwise to stderr.

## Security

MCP enables arbitrary tool execution and data access; treat servers like you treat shells:

* Use least-privilege tokens/headers
* Prefer trusted endpoints
* Audit what tools do before running them
* Review server permissions in interactive mode

### Credential storage

**OS keychain integration:**
- OAuth refresh tokens are stored in the OS keychain (access tokens are kept in memory only)
- OAuth client credentials (client_id, client_secret from dynamic registration) are stored in the keychain
- All HTTP headers from `--header` flags are stored per-session in the keychain (as JSON)
- The `~/.mcpc/profiles.json` file only contains metadata (server URL, scopes, timestamps) - never tokens

**Keychain entries:**
- OAuth tokens: `mcpc:auth:<serverUrl>:<profileName>:oauth-tokens`
- OAuth client: `mcpc:auth:<serverUrl>:<profileName>:oauth-client`
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

- `~/.mcpc/sessions.json` is set to `0600` (user-only read/write)
- `~/.mcpc/profiles.json` is set to `0600` (user-only read/write)
- Bridge sockets in `~/.mcpc/bridges/` are created with `0700` permissions
- Log files in `~/.mcpc/logs/` are created with `0600` permissions

### Network security

- HTTPS enforced for remote servers (HTTP auto-upgraded)
- `Origin` header validation to prevent DNS rebinding attacks
- Local servers bind to localhost (127.0.0.1) only
- No credentials logged even in verbose mode

## Error handling

`mcpc` provides clear error messages for common issues:

- **Connection failures**: Displays transport-level errors with retry suggestions
- **Session timeouts**: Automatically attempts to reconnect or prompts for session recreation
- **Invalid commands**: Shows available commands and correct syntax
- **Tool execution errors**: Returns server error messages with context
- **Bridge crashes**: Detects and cleans up orphaned processes, offers restart

Use `--verbose` to print detailed debugging information to stderr (includes JSON-RPC messages, streaming events, and protocol negotiation).

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
- Command history with arrow key navigation (saved to `~/.mcpc/history`, last 1000 commands)
- Real-time server notifications displayed during session
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

## Claude Code skill

For AI coding agents using [Claude Code](https://claude.ai/code), we provide a skill that teaches Claude how to use mcpc effectively.

**Installation:**
```bash
mkdir -p ~/.claude/skills/mcpc
cp claude-skill/SKILL.md ~/.claude/skills/mcpc/
```

Then restart Claude Code. The skill enables Claude to interact with MCP servers via mcpc commands instead of function calling, which is more efficient and uses fewer tokens.

See [`claude-skill/README.md`](./claude-skill/README.md) for details.

## Implementation

`mcpc` is under active development and some things might not work 100% yet. You have been warned.

### Design principles

- Delightful for humans and AI agents alike (interactive + scripting)
- One clear way to do things (orthogonal commands, no surprises, saving tokens)
- Do not ask for user input (except `shell` and `login`)
- Be forgiving, always help users make forward progress (great errors + guidance)
- JSON strictly consistency with the MCP specification
- Minimal and portable (few deps, cross-platform)
- No slop!

### Architecture overview

```
TODO: add interaction diagram
mcpc ──> cli ├──> bridge (UNIX socket) ──> MCP server (stdio/HTTP)
             ├──> MCP server (stdio/HTTP)

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

**IPC protocol:**
- Unix domain sockets (located in `~/.mcpc/bridges/<session-name>.sock`)
- Named pipes on Windows
- JSON-RPC style messages over socket
- Control messages: init, request, cancel, close, health-check

**Bridge discovery:**
- CLI reads `~/.mcpc/sessions.json` to find socket path and PID
- Validates bridge is alive (connect to socket + health-check)
- Auto-restarts crashed bridges (detected via socket connection failure)
- Cleanup: removes stale socket files for dead processes

**Concurrency safety:**
- `~/.mcpc/sessions.json` protected with file locking (`proper-lockfile` package)
- Atomic writes (write to temp file, then rename)
- Lock timeout: 5 seconds (fails if can't acquire lock)

### CLI executable

The main `mcpc` command provides the user interface.

**CLI responsibilities:**
- Argument parsing using Commander.js
- Output formatting (human-readable vs `--json`)
- Bridge lifecycle: start/connect/stop
- Communication with bridge via socket
- Interactive shell (REPL using Node.js `readline`)
- Configuration file loading (standard MCP JSON format)
- Credential management (OS keychain via `keytar` package)

**Shell implementation:**
- Built on Node.js `readline` module for input handling with history support
- Command history using `~/.mcpc/history` (last 1000 commands)
- Real-time notification display during shell sessions
- Graceful exit handling (cleanup on Ctrl+C/Ctrl+D)

### Session lifecycle

1. User: `mcpc https://mcp.apify.com session @apify`
2. CLI: Atomically creates session entry in `~/.mcpc/sessions.json`
3. CLI: Spawns bridge process (`mcpc-bridge`)
4. Bridge: Creates Unix socket at `~/.mcpc/bridges/apify.sock`
5. Bridge: Performs MCP initialization handshake with server:
   - Sends initialize request with protocol version and capabilities
   - Receives server info, version, and capabilities
   - Sends initialized notification to activate session
6. Bridge: Updates session in `~/.mcpc/sessions.json` (adds PID, socket path, protocol version)
7. CLI: Confirms session created

Later...

8. User: mcpc @apify tools-list
9. CLI: Reads `~/.mcpc/sessions.json`, finds socket path
10. CLI: Connects to bridge socket
11. CLI: Sends `tools/list` JSON-RPC request via socket
12. Bridge: Forwards to MCP server via Streamable HTTP
13. Bridge: Returns response via socket
14. CLI: Formats and displays to user


### Error recovery

**Bridge crashes:**
1. CLI detects socket connection failure
2. Reads `~/.mcpc/sessions.json` for last known config
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
- Bridge may have crashed. Try: `mcpc <server> session @<session-name>`
- Check bridge is running: `ps aux | grep -e 'mcpc-bridge' -e '[m]cpc/dist/bridge'`
- Check socket exists: `ls ~/.mcpc/bridges/`

**"Session not found"**
- Session may have expired. Create new session: `mcpc <target> session @<session-name>`
- List existing sessions: `mcpc`

**"Authentication failed"**
- List saved profiles: `mcpc`
- Re-authenticate: `mcpc <server> login [--profile <name>]`
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
- Prints server log messages with severity `debug`, `info`, and `notice` to standard output

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

Use the release script to publish a new version (must be on `main` branch):

```bash
npm run release          # patch version bump (0.1.2 → 0.1.3)
npm run release:minor    # minor version bump (0.1.2 → 0.2.0)
npm run release:major    # major version bump (0.1.2 → 1.0.0)
```

The script automatically:
- Ensures you're on `main` branch
- Ensures working directory is clean (no uncommitted changes)
- Ensures branch is up-to-date with remote
- Runs lint, build, and tests
- Bumps the version in package.json
- Creates a git commit and annotated tag (`v{version}`)
- Pushes the commit and tag to origin
- Publishes to npm

After publishing, create a GitHub release at the provided link.

Please open an issue or pull request on [GitHub](https://github.com/apify/mcpc).


### References

- [Official MCP documentation](https://modelcontextprotocol.io/llms.txt)
- [Official TypeScript SDK for MCP servers and clients](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector) - CLI client implementation for reference

## Authors

Built by [Jan Curn](https://x.com/jancurn), [Apify](https://apify.com), and contributors welcome.

## License

Apache-2.0 - see [LICENSE](./LICENSE) for details.

