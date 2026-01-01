# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`mcpc` is a universal command-line client for the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/),
which maps MCP to intuitive CLI commands for shell access, scripts, and AI coding agents.

`mcpc` can connect to any MCP server over Streamable HTTP or stdio transports,
securely login via OAuth credentials and store credentials,
and keep long-term sessions to multiple servers in parallel.
It supports all major MCP features, including tools, resources, prompts, asynchronous tasks, and notifications.

`mcpc` is handy for manual testing of MCP servers, scripting,
and AI coding agents to use MCP in ["code mode"](https://www.anthropic.com/engineering/code-execution-with-mcp),
for better accuracy and lower tokens compared to traditional tool function calling.
After all, UNIX-compatible shell script is THE most universal coding language, for both people and LLMs.

**Key capabilities:**
- Universal MCP client - Works with any MCP server over Streamable HTTP or stdio
- Persistent sessions - Keep multiple server connections alive simultaneously
- Zero setup - Connect to remote servers instantly with just a URL
- Full protocol support - Tools, resources, prompts, dynamic discovery, and async notifications
- `--json` output - Easy integration with `jq`, scripts, and other CLI tools
- AI-friendly - Designed for code generation and automated workflows
- Secure - OS keychain integration for credentials, encrypted auth storage

## Build and Development Commands

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test

# Test locally after building
npm link
mcpc --help

# Run linter/formatter (if configured)
npm run lint
npm run format
```

## Quick Start Examples

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
mcpc mcp.apify.com connect @test
mcpc @test tools-call search-actors query:="web crawler"
mcpc @test shell
```

## Design Principles

- Delightful for humans and AI agents alike (interactive + scripting)
- Avoid unnecessary interaction loops, provide sufficient context, yet be concise (save tokens)
- One clear way to do things (orthogonal commands, no surprises)
- Do not ask for user input (except `shell` and `login`, no unexpected OAuth flows)
- Be forgiving, always help users make progress (great errors + guidance)
- Be consistent with the [MCP specification](https://modelcontextprotocol.io/specification/latest), with `--json` strictly
- Minimal and portable (few deps, cross-platform)
- Keep backwards compatibility as much as possible
- No slop!

## Architecture

### High-Level Structure

The project is organized as a single TypeScript package with internal modules:

```
mcpc/
├── src/
│   ├── core/           # Core MCP protocol implementation (runtime-agnostic)
│   ├── bridge/         # Bridge process logic for persistent sessions
│   ├── cli/            # CLI interface and command parsing
│   └── lib/            # Shared utilities
│       ├── auth/       # Authentication management (OAuth, bearer tokens, profiles)
│       └── ...         # Other utilities
├── bin/
│   ├── mcpc            # Main CLI executable
│   └── mcpc-bridge     # Bridge process executable
└── test/
    └── e2e/
        └── server/     # Test MCP server for E2E tests
```

### Core Components

**1. Core Module (`src/core/`)**
- Runtime-agnostic MCP protocol implementation (works with Node.js ≥18 and Bun ≥1)
- Transport abstraction: Streamable HTTP and stdio
- Protocol state machine: initialization handshake, version negotiation, session management
- Request/response correlation using JSON-RPC style with request IDs
- Multiplexing: supports up to 10 concurrent requests, queues up to 100
- Streamable HTTP connection management with reconnection (exponential backoff: 1s → 30s max)
- Event emitter for async notifications (tools/resources/prompts list changes, progress, logging)
- Uses native `fetch` API (no external HTTP libraries needed)
- **Note**: Only supports Streamable HTTP transport (current standard). The deprecated HTTP with SSE transport is not supported.

**2. Bridge Process (`src/bridge/`)**
- Separate executable (`mcpc-bridge`) that maintains persistent MCP connections
- Session persistence via `~/.mcpc/sessions.json` with file locking (`proper-lockfile` package)
- Process lifecycle management for local package servers (stdio transport)
- Unix domain socket server for CLI-to-bridge IPC (named pipes on Windows)
- Socket location: `~/.mcpc/bridges/<session-name>.sock`
- Heartbeat mechanism for health monitoring
- Orphaned process cleanup on startup
- Atomic writes for session file (write to temp, then rename)
- Lock timeout: 5 seconds

**3. CLI Executable (`src/cli/`)**
- Main `mcpc` command providing user interface
- Argument parsing using Commander.js
- Output formatting: human-readable (default, with colors/tables) vs `--json` mode
- Bridge lifecycle: start/connect/stop, auto-restart on crash
- Interactive shell using Node.js `readline` with command history (`~/.mcpc/history`, last 1000 commands)
- Configuration file loading (standard MCP JSON format, compatible with Claude Desktop)
- Credential management via OS keychain (`keytar` package)

**CLI Command Structure:**
- All MCP commands use hyphenated format: `tools-list`, `tools-call`, `resources-read`, etc.
- `mcpc` - List all sessions and authentication profiles
- `mcpc <target>` - Show server info, instructions, and capabilities
- `mcpc @<session>` - Show session info, server capabilities, and authentication details
- `mcpc <target> help` - Alias for `mcpc <target>`
- `mcpc <target> <command>` - Execute MCP command
- Session creation: `mcpc <target> connect @<session-name> [--profile <name>]`
- Authentication: `mcpc <server> login [--profile <name>]` and `mcpc <server> logout [--profile <name>]`

**Target Types:**
- `@<name>` - Named session (e.g., `@apify`) - persistent connection via bridge
- `<url>` - Server URL (e.g., `mcp.apify.com` or `https://mcp.apify.com`) - URL scheme optional, defaults to `https://`
- `<config-entry>` - Config file entry (requires `--config` flag) - local or remote server

**Output Utilities** (`src/cli/output.ts`):
- `logTarget(target, outputMode)` - Shows `[Using session: @name]` prefix (human mode only)
- `formatOutput(data, mode)` - Auto-detects data type and formats appropriately
- `formatJson(data)` - Clean JSON output without wrappers
- `formatTools/Resources/Prompts()` - Specialized table formatting
- `formatSuccess/Error/Warning/Info()` - Styled status messages

### Session Lifecycle

1. User creates session: `mcpc mcp.apify.com connect @apify`
2. CLI creates entry in `sessions.json`, spawns bridge process
3. Bridge creates Unix socket at `~/.mcpc/bridges/apify.sock`
4. Bridge performs MCP initialization:
   - Sends `initialize` request with protocol version and capabilities
   - Receives server info, version, and capabilities
   - Sends `initialized` notification to activate session
5. Bridge updates `sessions.json` with PID, socket path, protocol version
6. For subsequent commands (`mcpc @apify tools-list`):
   - CLI reads `sessions.json`, connects to bridge socket
   - Sends JSON-RPC request via socket
   - Bridge forwards to MCP server, returns response
   - CLI formats and displays output

**Session States:**
- 🟢 **live** - Bridge process running; server might or might not be responding
- 🟡 **crashed** - Bridge process crashed or killed; auto-restarts on next use
- 🔴 **expired** - Server rejected session (auth failed, session ID invalid); requires `close` and reconnect

### Transport Implementation

**Streamable HTTP:**
- Persistent HTTP connection with bidirectional streaming (protocol version 2025-11-25)
- Server and client can send messages in both directions over the same connection
- Automatic reconnection with exponential backoff (1s → 30s max)
- Queues requests during disconnection (fails after 3 minutes)
- **Important**: Only the Streamable HTTP transport is supported (current MCP standard). The deprecated HTTP with SSE transport (2024-11-05) is not implemented.

**Required HTTP Headers:**
- `MCP-Protocol-Version: <version>` - MUST be included on ALL HTTP requests after initialization (e.g., `MCP-Protocol-Version: 2025-11-25`)
- `MCP-Session-Id: <session-id>` - MUST be included if server provides session ID in InitializeResponse
- `Accept: application/json, text/event-stream` - Required on POST requests to support both response types

**Security Requirements:**
- **Origin validation** - Server MUST validate Origin header to prevent DNS rebinding attacks. If Origin is invalid, respond with 403 Forbidden.
- **Local binding** - Servers SHOULD bind to localhost (127.0.0.1) only, not 0.0.0.0
- **Session ID security** - Session IDs must be cryptographically secure (UUIDs, JWTs, cryptographic hashes)

**SSE Stream Management:**
- Event IDs and `Last-Event-ID` header for resumability after disconnection
- `retry` field for client reconnection timing (server sends before closing connection)
- Per-stream message delivery (no broadcasting across multiple streams)
- Client resumes via HTTP GET with `Last-Event-ID` header

**Session Management:**
- Server MAY assign session ID in `MCP-Session-Id` header on InitializeResponse
- Client MUST include session ID on all subsequent requests
- HTTP DELETE to MCP endpoint terminates session (server MAY respond with 405 if not supported)
- Server responds with 404 Not Found for expired sessions (client must re-initialize)

**Stdio:**
- Direct bidirectional JSON-RPC communication over stdin/stdout
- Messages delimited by newlines, MUST NOT contain embedded newlines
- Server MAY write logs to stderr, client MAY ignore stderr output
- Server MUST NOT write anything to stdout except valid MCP messages
- **Clean shutdown sequence:**
  1. Client closes stdin to server process
  2. Wait for server to exit (reasonable timeout)
  3. Send SIGTERM if server hasn't exited
  4. Send SIGKILL if server doesn't respond to SIGTERM
- Server MAY initiate shutdown by closing stdout and exiting

### Error Recovery

**Bridge crashes:**
- CLI detects socket connection failure
- Reads `sessions.json` for last known config
- Spawns new bridge, re-initializes MCP connection
- Continues request

**Network failures:**
- Bridge detects connection error, begins exponential backoff
- Queues incoming requests (max 100, timeout 3 minutes)
- On reconnect: drains queue
- On timeout: fails with network error

### Security Considerations

Implements [MCP security best practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices):

- OAuth 2.1 with PKCE via MCP SDK
- Credentials stored in OS keychain (encrypted by system)
- `sessions.json` and `profiles.json` file permissions: `0600` (user-only)
- Bridge sockets use default umask (typically user-only)
- HTTPS enforced (HTTP auto-upgraded when no scheme provided)
- URL normalization strips username, password, and hash
- OAuth callback server binds to `127.0.0.1` only
- Input validation for session names, profile names, and URLs
- No credentials logged even in verbose mode
- File locking (`proper-lockfile`) for concurrent access safety
- Headers sent to bridge via IPC, not command-line arguments

## MCP Protocol Implementation

**Protocol version:** Current latest is `2025-11-25`

**Initialization sequence:**
1. Client sends `initialize` request with protocol version and client capabilities
2. Server responds with agreed version and server capabilities
3. Client sends `initialized` notification to activate session

**MCP Primitives:**
- **Instructions**: Server-provided instructions fetched and stored
- **Tools**: Executable functions with JSON Schema-validated arguments
- **Resources**: Data sources with URIs (e.g., `file:///`, `https://`), optional subscriptions for change notifications
- **Prompts**: Reusable message templates with customizable arguments
- **Logging**: Server-side logging level control via `logging/setLevel` request

**Notifications:**
- `notifications/tools/list_changed`
- `notifications/resources/list_changed`
- `notifications/prompts/list_changed`
- Progress tracking and logging

**Pagination:**
- List operations automatically fetch all pages when the server returns paginated results
- The CLI transparently handles `nextCursor` and fetches all pages in sequence

**Other Protocol Features:**
- **Pings**: Client periodically issues MCP `ping` request to keep connection alive
- **Sampling**: Not supported (mcpc has no access to an LLM)

**Argument Passing:**

Tools and prompts accept arguments as positional parameters after the tool/prompt name:

1. **Key:=value pairs** (auto-parsed: tries JSON, falls back to string):
   ```bash
   mcpc @apify tools-call search query:=hello limit:=10 enabled:=true
   mcpc @apify tools-call search config:='{"key":"value"}' items:='[1,2,3]'
   ```

2. **Inline JSON** (if first arg starts with `{` or `[`):
   ```bash
   mcpc @apify tools-call search '{"query":"hello","limit":10}'
   ```

3. **Stdin** (when no positional args and input is piped):
   ```bash
   echo '{"query":"hello"}' | mcpc @apify tools-call search
   ```

Auto-parsing rules: Values are parsed as JSON if valid, otherwise treated as string.
- `count:=10` → number `10`
- `enabled:=true` → boolean `true`
- `query:=hello` → string `"hello"` (not valid JSON)
- `id:='"123"'` → string `"123"` (JSON string literal)

## Configuration Format

Uses standard MCP config format (compatible with Claude Desktop):

```json
{
  "mcpServers": {
    "http-server": {
      "url": "https://mcp.apify.com",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}"
      },
      "timeout": 300
    },
    "stdio-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {
        "DEBUG": "mcp:*"
      }
    }
  }
}
```

Environment variable substitution supported: `${VAR_NAME}`

## Testing Strategy

**Unit tests:**
- Core protocol implementation with mocked transports
- Argument parsing and validation
- Output formatting (human and JSON modes)

**Integration tests:**
- Test MCP server (`test/e2e/server/`)
- Bridge lifecycle (start, connect, restart, cleanup)
- Session management with file locking
- Stream reconnection logic

**E2E tests:**
- Real MCP server implementations
- Cross-runtime testing (Node.js and Bun)
- Interactive shell workflows

**Test utilities:**
- `test/e2e/server/` - Test MCP server
- `test/mock-keychain.ts` - Mock OS keychain

## Runtime Requirements

- **Node.js:** ≥18.0.0 (for native `fetch` API)
- **Bun:** ≥1.0.0 (alternative runtime)
- **OS support:** macOS, Linux, Windows
- **Linux dependency:** `libsecret` (for OS keychain access via `keytar`)

## Authentication Architecture

`mcpc` implements the full MCP OAuth 2.1 specification with authentication profiles that separate credentials from sessions.

**Authentication Profiles:**
- Named sets of OAuth credentials for a specific server URL
- Reusable across multiple sessions (authenticate once, use many times)
- Support multiple accounts per server (e.g., `personal`, `work` profiles for same server)
- Default profile name is `default` when `--profile` is not specified

**Storage:**
- `~/.mcpc/profiles.json` - Auth profile metadata (serverUrl, authType, scopes, expiry)
- OS keychain - Sensitive credentials (OAuth tokens, refresh tokens, client secrets, bearer tokens)

**Bearer Token Handling:**
- Bearer tokens passed via `--header "Authorization: Bearer ${TOKEN}"` are NOT stored as profiles
- They are stored in OS keychain per-session (key: `mcpc:session:<name>:bearer-token`)
- Bridge loads them automatically when making requests

**CLI Commands:**
```bash
# Login and save authentication profile
mcpc <server> login [--profile <name>]

# Logout and delete authentication profile
mcpc <server> logout [--profile <name>]

# Create session with specific profile
mcpc <server> connect @<name> --profile <profile>
```

**Authentication Behavior:**

When `--profile <name>` is specified:
1. Profile exists for server → Use its stored credentials; fail with error if expired/invalid
2. Profile doesn't exist → Fail with error

When no `--profile` is specified (uses `default` profile):
1. `default` profile exists for server → Use its credentials; fail with error if expired/invalid
2. `default` profile doesn't exist → Attempt unauthenticated connection; fail with error if server requires auth

On failure, the error message includes instructions on how to login. This ensures:
- Authentication only happens when user explicitly calls `login`
- Credentials are never silently downgraded
- You can mix authenticated sessions and public access on the same server

**OAuth Flow:**
1. User runs `mcpc <server> login --profile personal`
2. CLI discovers OAuth metadata via `WWW-Authenticate` header or well-known URIs
3. CLI creates local HTTP callback server on `http://localhost:<random-port>/callback`
4. CLI opens browser to authorization URL with PKCE challenge
5. User authenticates, browser redirects to callback with authorization code
6. CLI exchanges code for tokens using PKCE verifier
7. Tokens saved to OS keychain, metadata saved to `profiles.json`
8. Profile can now be used by multiple sessions

**Implementation Modules:**
- `src/lib/auth/auth-profiles.ts` - Manage profiles.json (CRUD operations)
- `src/lib/auth/keychain.ts` - OS keychain wrapper (save/load/delete tokens)
- `src/lib/auth/oauth-provider.ts` - Implements `OAuthClientProvider` from MCP SDK
- `src/lib/auth/oauth-flow.ts` - Orchestrates interactive OAuth flow
- `src/lib/auth/oauth-token-manager.ts` - Token validation and refresh
- `src/lib/auth/token-refresh.ts` - Token refresh logic with keychain persistence

**Session-to-Profile Relationship:**
```jsonc
// sessions.json
{
  "apify-personal": {
    "name": "apify-personal",
    "target": "https://mcp.apify.com",
    "transport": "http",
    "profileName": "personal",  // References profile
    "pid": 12345,
    "socketPath": "~/.mcpc/bridges/apify-personal.sock"
  }
}

// profiles.json
{
  "profiles": {
    "https://mcp.apify.com": {
      "personal": {
        "name": "personal",
        "serverUrl": "https://mcp.apify.com",
        "authType": "oauth",
        "oauthIssuer": "https://auth.apify.com",
        "scopes": ["tools:read", "tools:write"],
        "authenticatedAt": "2025-12-14T10:00:00Z",
        "expiresAt": "2025-12-15T10:00:00Z"
      }
    }
  }
}

// OS Keychain
// Key: mcpc:auth:https://mcp.apify.com:personal:tokens
// Value: {"access_token": "...", "refresh_token": "...", "expires_at": ...}
```

## State and Data Storage

All state files are stored in `~/.mcpc/` directory (unless overridden by `MCPC_HOME_DIR` environment variable):

- `~/.mcpc/sessions.json` - Active sessions with references to auth profiles (file-locked for concurrent access)
- `~/.mcpc/profiles.json` - Authentication profiles (OAuth metadata, scopes, expiry)
- `~/.mcpc/bridges/` - Unix domain socket files for bridge processes
- `~/.mcpc/history` - Interactive shell command history (last 1000 commands)
- `~/.mcpc/logs/bridge-<session>.log` - Bridge process logs (max 10MB, 5 files)
- OS keychain - Sensitive credentials (OAuth tokens, bearer tokens, client secrets)

## Key Dependencies

- `@modelcontextprotocol/sdk` - Official MCP SDK for client/server implementation
- `commander` - Command-line argument parsing and CLI framework
- `chalk` - Terminal string styling and colors
- `keytar` - OS keychain integration for secure credential storage
- `proper-lockfile` - File locking for concurrent session access
- `@inquirer/input`, `@inquirer/select` - Interactive prompts for login flows
- `ora` - Spinner animations for progress indication
- `uuid` - Session ID generation

**Minimal dependencies approach:** Core module uses native APIs (`fetch`, process APIs) to support both Node.js and Bun.

## Exit Codes

- `0` - Success
- `1` - Client error (invalid arguments, command not found)
- `2` - Server error (tool execution failed, resource not found)
- `3` - Network error (connection failed, timeout)
- `4` - Authentication error (invalid credentials, forbidden)

## MCP Logging Levels

The `logging/setLevel` request supports these standard syslog severity levels (RFC 5424):

- `debug` - Detailed debugging information (most verbose)
- `info` - General informational messages
- `notice` - Normal but significant events
- `warning` - Warning messages
- `error` - Error messages
- `critical` - Critical conditions
- `alert` - Action must be taken immediately
- `emergency` - System is unusable (least verbose)

Example: `mcpc @apify logging-set-level debug`

**Note:** This sets the server-side logging level. For client-side verbose logging, use the `--verbose` flag.

## Common Implementation Patterns

When implementing features:

1. **Keep core runtime-agnostic** - Use native APIs, avoid runtime-specific dependencies
2. **Error handling** - Provide clear, actionable error messages; use appropriate exit codes
3. **Retry logic** - Use exponential backoff for network operations (3 attempts for requests, 1s→30s for streams)
4. **Concurrent safety** - Use file locking for shared state (`sessions.json`)
5. **Security** - Never log credentials; use OS keychain; enforce HTTPS; validate certificates
6. **Output formatting** - Support both human-readable (default) and JSON (`--json`) modes
7. **Protocol compliance** - Follow MCP specification strictly; handle all notification types
8. **Session management** - Always clean up resources; handle orphaned processes; provide reconnection
9. **Hyphenated commands** - All MCP commands use hyphens: `tools-list`, `resources-read`, `prompts-list`
10. **Target-first syntax** - Commands follow `mcpc <target> <command>` pattern consistently
11. **JSON field naming** - Use consistent field names in JSON output:
    - `sessionName` (not `name`) for session identifiers
    - `server` (not `target`) for server URLs/addresses
    - No `success` wrapper - indicate errors via exit codes
    - No debug prefixes like `[Using target: ...]` in JSON mode

## Debugging

Enable verbose mode: `--verbose` flag shows:
- Protocol negotiation details
- JSON-RPC request/response messages
- Streaming events and reconnection attempts
- Bridge communication (socket messages)
- File locking operations

Bridge logs location: `~/.mcpc/logs/bridge-<session>.log`

## Environment Variables

- `MCPC_HOME_DIR` - Directory for session and auth profiles data (default: `~/.mcpc`)
- `MCPC_VERBOSE` - Enable verbose logging (set to `1`, `true`, or `yes`, case-insensitive)
- `MCPC_JSON` - Enable JSON output (set to `1`, `true`, or `yes`, case-insensitive)

## Current Implementation Status

### ✅ Completed
- **CLI Structure**: Complete command parsing and routing with Commander.js
- **Output Formatting**: Human-readable (tables, colors) and JSON modes
- **Argument Parsing**: Positional args with key:=value (auto-parsed), inline JSON, and stdin support
- **Core MCP Client**: Wrapper around official SDK with error handling
- **Transport Layer**: HTTP and stdio transport creation and management
- **Error Handling**: Typed errors with appropriate exit codes
- **Logging**: Structured logging with verbose mode support, per-session bridge logs with rotation
- **Environment Variables**: MCPC_HOME_DIR, MCPC_VERBOSE, MCPC_JSON support
- **Command Handlers**: All MCP commands fully functional
  - `tools-list`, `tools-get`, `tools-call`
  - `resources-list`, `resources-read`, `resources-subscribe`, `resources-unsubscribe`, `resources-templates-list`
  - `prompts-list`, `prompts-get`
  - `logging-set-level`
  - `ping` (with roundtrip timing)
  - `connect`, `close`, `help` (session management)
  - `login`, `logout` (authentication management)
- **Bridge Process**: Persistent MCP connections with Unix domain socket IPC
- **Session Management**: Complete `sessions.json` persistence with file locking
- **IPC Layer**: Unix socket communication between CLI and bridge (BridgeClient, SessionClient)
- **Target Resolution**: URL/session/config resolution logic (sessions and HTTP servers working)
- **CLI-to-MCP Integration**: Full integration via direct connection and session bridge
- **Caching**: In-memory cache with TTL (5min default), automatic invalidation via server notifications
- **Notification Handling**: Full notification support with forwarding from bridge to clients
  - `tools/list_changed`, `resources/list_changed`, `prompts/list_changed` notifications
  - Automatic cache invalidation on list changes
  - Real-time notification display in interactive shell with timestamps and color coding
- **Interactive Shell**: Complete REPL implementation
  - Command history (saved to `~/.mcpc/history`, last 1000 commands)
  - Real-time notification display during shell sessions
  - Persistent notification listener per shell session
  - Graceful cleanup on exit
- **Error Recovery**: Automatic recovery from failures
  - Bridge crash detection and automatic restart
  - Socket reconnection with preserved session state
  - Automatic retry on network errors (with bridge restart)
  - Clean handling of orphaned processes
- **Config File Loading**: Complete stdio transport support for local packages
- **OAuth Implementation**: Full OAuth 2.1 flow with PKCE
  - Interactive OAuth flow (browser-based)
  - Authentication profiles (reusable credentials)
  - Token refresh with automatic persistence
  - Integration with session management
- **Keychain Integration**: OS keychain via `keytar` for secure credential storage

### 🚧 Deferred / Nice-to-have
- **Package Resolution**: Find and run local MCP packages automatically
- **Tab Completion**: Shell completions for commands, tool names, and resource URIs
- **Resource File Output**: `-o <file>` flag for `resources-read` command

### 📋 Implementation Approach

`mcpc` implements a **hybrid architecture** supporting both direct connections and persistent sessions:

**Direct Connection** (for one-off commands without sessions):
- CLI creates `McpClient` on-demand via `withMcpClient()` helper
- Connect → Execute → Close for each command
- Used when target is a URL or config entry (not a session name)
- Good for ephemeral usage and scripts

**Bridge Process Architecture** (for persistent sessions):
- Persistent bridge maintains MCP connection and state
- CLI communicates via Unix socket IPC
- Supports sessions, notifications, caching, and better performance
- Used when target is a session name (e.g., `@apify`)
- Bridge handles automatic reconnection and error recovery

This hybrid approach provides flexibility: use direct connections for quick one-off commands,
or create sessions for interactive use and long-running workflows.

## References

- [Official MCP documentation](https://modelcontextprotocol.io/llms.txt)
- [Official TypeScript SDK for MCP servers and clients](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector) - CLI client implementation for reference

# Misc

When writing titles of sections in README and code, do not capitalize first letters (e.g. "Session management" instead of "Session Management")

Never add files to git or commit yourself.
