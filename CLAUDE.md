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
pnpm install

# Build the project
pnpm run build

# Run tests
pnpm test

# Test locally after building
pnpm link --global
mcpc --help

# Run linter/formatter (if configured)
pnpm run lint
pnpm run format
```

## Quick Start Examples

```bash
# List all active sessions and saved authentication profiles
mcpc

# Login to OAuth-enabled MCP server and save authentication for future use
mcpc login mcp.apify.com

# Create a persistent session
mcpc connect mcp.apify.com @test
mcpc @test                               # show session info
mcpc @test tools-list                    # list available tools
mcpc @test tools-call search-actors query:="web crawler"
mcpc @test shell                         # interactive shell

# Use JSON mode for scripting
mcpc --json @test tools-list

# Use a local server package referenced by MCP config file
mcpc connect ~/.vscode/mcp.json:filesystem @fs
mcpc @fs tools-list
```

## Design Principles

- Delightful for humans and AI agents alike (interactive + scripting)
- Avoid unnecessary interaction loops, provide sufficient context, yet be concise (save tokens)
- One clear way to do things (orthogonal commands, no surprises)
- Do not ask for user input (except `shell` and `login`, no unexpected OAuth flows)
- AI agents must be able to use mcpc without any external agent skills, prompts, or documentation: `--help` output and error messages must provide all the context an agent needs to discover commands, understand arguments, and recover from mistakes
- Be forgiving, always help users make progress (great errors + guidance)
- Be consistent with the [MCP specification](https://modelcontextprotocol.io/specification/latest), with `--json` strictly
- Minimal and portable (few deps, cross-platform)
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
- Credential management via OS keychain (`@napi-rs/keyring` package)

**CLI Command Structure:**

- All MCP commands use hyphenated format: `tools-list`, `tools-call`, `resources-read`, etc.
- `mcpc` - List all sessions and authentication profiles
- `mcpc @<session>` - Show session info, server capabilities, and authentication details
- `mcpc @<session> <command>` - Execute MCP command (e.g., `mcpc @apify tools-list`)
- `mcpc connect <server> @<name>` - Create a named persistent session
- `mcpc login <server> [--profile <name>]` - Login via OAuth and save auth profile
- `mcpc logout <server> [--profile <name>]` - Delete an authentication profile
- `mcpc clean [sessions|profiles|logs|all ...]` - Clean up mcpc data
- `mcpc help [command]` - Show help for a specific command

**Server formats for `connect`, `login`, `logout`:**

- `<url>` - Remote HTTP server (e.g., `mcp.apify.com` or `https://mcp.apify.com`) - scheme optional, defaults to `https://`
- `<file>:<entry>` - Config file entry (e.g., `~/.vscode/mcp.json:filesystem`)

**Output Utilities** (`src/cli/output.ts`):

- `logTarget(target, outputMode)` - Shows `[Using session: @name]` prefix (human mode only)
- `formatOutput(data, mode)` - Auto-detects data type and formats appropriately
- `formatJson(data)` - Clean JSON output without wrappers
- `formatTools/Resources/Prompts()` - Specialized table formatting
- `formatSuccess/Error/Warning/Info()` - Styled status messages

### Session Lifecycle

1. User creates session: `mcpc connect mcp.apify.com @apify`
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

- 🟢 **live** - Bridge process running and server responding (lastSeenAt within 2 minutes)
- 🟡 **connecting** - Initial bridge connection in progress (first `connect`)
- 🟡 **reconnecting** - Bridge crashed and is being automatically reconnected
- 🟡 **disconnected** - Bridge process running but server unreachable (lastSeenAt stale >2min); auto-recovers when server responds
- 🟡 **crashed** - Bridge process crashed or killed; auto-reconnects in the background
- 🔴 **unauthorized** - Server rejected authentication (401/403) or token refresh failed; requires `login` then `restart`
- 🔴 **expired** - Server rejected session ID (404); requires `restart`

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

**Credential protection:**

- Credentials stored in OS keychain (encrypted by system), with `0600` fallback file
- No credentials logged even in verbose mode — only log presence/absence (e.g., `refreshToken: present`)
- Headers sent to bridge via IPC after socket connect, never as command-line arguments (visible in `ps`)
- `sessions.json` and `profiles.json` file permissions: `0600` (user-only)

**Transport security:**

- HTTPS enforced (HTTP auto-upgraded when no scheme provided, except localhost)
- OAuth 2.1 with PKCE via MCP SDK
- OAuth callback server binds to `127.0.0.1` only, validates Host header to prevent DNS rebinding
- Session IDs generated with `crypto.randomUUID()` (cryptographically secure)

**Input validation & output safety:**

- Input validation for session names, profile names, and URLs (strict regex, no path traversal)
- URL normalization strips username, password, and hash
- HTML output in OAuth callback is escaped to prevent XSS
- Browser opening uses `execFile()` (not `exec()`) to avoid shell injection

**Filesystem security:**

- `~/.mcpc/` and subdirectories created with mode `0700` (owner-only) via `ensureDir()`
- File locking (`proper-lockfile`) for concurrent access safety
- Atomic file writes (temp file + rename) to prevent corruption
- IPC buffer size capped at 10 MB to prevent memory exhaustion

**Security development guidelines:**
When making changes, follow these rules to maintain the security posture:

- Never log, print, or include credentials/tokens in error messages — log `present`/`MISSING` instead
- Always use `ensureDir()` for creating directories (defaults to `0700`); use `mode: 0o600` for files containing secrets
- Use `execFile()` (array args) instead of `exec()` (shell string) when spawning processes
- Escape any user-controlled or server-controlled data before embedding in HTML responses
- Send sensitive data (headers, tokens) via IPC socket, never via CLI arguments or environment variables
- Read all keychain values needed to start a bridge in the CLI **before** `spawn()`. After spawn the bridge arms a short IPC-credential timeout; on macOS a Keychain password dialog can block longer than that timeout, so a post-spawn keychain read races the bridge timer and causes ENOENT (#55). The CLI is the only process attached to a TTY and can show the dialog without the user wondering why a background process is asking. Bridge-side keychain access is permitted only on the OAuth refresh path (`oauth-token-manager` callbacks in `src/bridge/index.ts`), where it is needed to persist rotated refresh tokens for long-running sessions
- Validate and sanitize all external input (URLs, session names, profile names) before use
- Default to HTTPS; only allow HTTP for localhost/127.0.0.1
- When adding HTTP servers (even localhost-only), validate the Host header against expected values

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
        "Authorization": "Bearer ${APIFY_TOKEN}"
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
- **Linux dependency:** `libsecret` (for OS keychain access via `@napi-rs/keyring`)

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
mcpc login <server> [--profile <name>]

# Logout and delete authentication profile
mcpc logout <server> [--profile <name>]

# Create session with specific profile
mcpc connect <server> @<name> --profile <profile>
```

**Authentication Behavior:**

When `--header "Authorization: ..."` is provided (without `--profile`):

- Explicit header is used, OAuth profile auto-detection is skipped entirely

When `--profile <name>` is specified:

1. Profile exists for server → Use its stored credentials; fail with error if expired/invalid
2. Profile doesn't exist → Fail with error
3. Cannot be combined with `--header "Authorization: ..."` (returns error)

When `--no-profile` is specified:

- Skip all OAuth profile detection and connect anonymously (or with explicit `--header`)

When no flags are specified (default):

1. `default` profile exists for server → Use its credentials; fail with error if expired/invalid
2. `default` profile doesn't exist → Attempt unauthenticated connection; fail with error if server requires auth

On failure, the error message includes instructions on how to login. This ensures:

- Explicit CLI flags always take precedence over stored profiles
- Authentication only happens when user explicitly calls `login`
- Credentials are never silently downgraded
- You can mix authenticated sessions and public access on the same server

**OAuth Flow:**

1. User runs `mcpc login <server> --profile personal`
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

- `~/.mcpc/sessions.json` - Active sessions with references to auth profiles and active async tasks (file-locked for concurrent access)
- `~/.mcpc/profiles.json` - Authentication profiles (OAuth metadata, scopes, expiry)
- `~/.mcpc/bridges/` - Unix domain socket files for bridge processes
- `~/.mcpc/history` - Interactive shell command history (last 1000 commands)
- `~/.mcpc/logs/bridge-<session>.log` - Bridge process logs (max 10MB, 5 files)
- OS keychain - Sensitive credentials (OAuth tokens, bearer tokens, client secrets)

## Key Dependencies

- `@modelcontextprotocol/sdk` - Official MCP SDK for client/server implementation
- `commander` - Command-line argument parsing and CLI framework
- `chalk` - Terminal string styling and colors
- `@napi-rs/keyring` - OS keychain integration for secure credential storage
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

After making any code changes, always run `pnpm run lint` and fix **all** errors before committing. Do not skip or ignore lint failures. The lint command checks both ESLint rules and Prettier formatting. To auto-fix issues, run `pnpm run lint:fix`. If auto-fix doesn't resolve everything, manually fix the remaining errors. Never commit code that fails `pnpm run lint`. **As the very last step of every task**, run `pnpm run lint` once more and fix any remaining issues before considering the work done.

After lint passes, run `pnpm run build` and fix any TypeScript compilation errors before committing. The CI runs `tsc` with strict settings (including `noUnusedLocals`) that may catch errors not reported by ESLint alone, such as unused imports or type errors. Never commit code that fails `pnpm run build`.

After build passes, run `pnpm run test:unit` and fix any failures before committing. If a test fails due to your changes, update the test or fix the code so all tests pass. Never commit code that fails unit tests.

For any non-trivial change (new feature, bug fix, behaviour change, or notable refactor), add an entry to the `[Unreleased]` section of `CHANGELOG.md` before finishing. Use the appropriate category (`Added`, `Changed`, `Fixed`, `Removed`). Skip purely internal changes such as test-only edits, code style fixes, or minor cosmetic/styling tweaks (e.g. changing colors, adjusting whitespace, renaming labels). The changelog is for **users reading release notes** — only include entries that a user would care about. Do not add entries for: new warnings or deprecation notices on existing commands, minor help text changes, test infrastructure, CI/CD changes, or internal refactors. When in doubt, leave it out.

When opening a pull request, always reference the originating issue or PR in the description (e.g. `Fixes #55`, `Refs #223`, `Supersedes #222`). This anchors the change to its motivation and lets reviewers see prior discussion, alternative fixes that were considered, and the failure mode being addressed. If the change is motivated by a Slack/email/internal thread with no GitHub artifact, open or link an issue first so future readers have a single source of truth. The same applies to commit messages for non-trivial changes: include `Fixes #N` / `Refs #N` in the body.

When implementing features:

1. **Self-documenting CLI** - All features, options, and usage patterns must be documented in command `--help` output (Commander.js `.description()` and `.addHelpText()`), not just in the README. AI agents discover how to use mcpc purely by running `mcpc --help` and `mcpc <command> --help`, so help text is the primary documentation surface. Include examples in help text for non-obvious commands. The README can provide additional context but must not be the only place a feature is documented.
2. **Keep core runtime-agnostic** - Use native APIs, avoid runtime-specific dependencies
3. **Error handling** - Provide clear, actionable error messages; use appropriate exit codes
4. **Retry logic** - Use exponential backoff for network operations (3 attempts for requests, 1s→30s for streams)
5. **Concurrent safety** - Use file locking for shared state (`sessions.json`)
6. **Security** - Never log credentials (log `present`/`MISSING` instead); use OS keychain; enforce HTTPS; use `execFile()` not `exec()`; escape HTML output; validate Host headers on local servers; send secrets via IPC not CLI args; see "Security Considerations" section for full guidelines
7. **Output formatting** - Support both human-readable (default) and JSON (`--json`) modes
8. **Protocol compliance** - Follow MCP specification strictly; handle all notification types
9. **Session management** - Always clean up resources; handle orphaned processes; provide reconnection
10. **Hyphenated commands** - All MCP commands use hyphens: `tools-list`, `resources-read`, `prompts-list`
11. **Command-first syntax** - Top-level commands come first (`connect`, `login`, `clean`); MCP operations always go through a named session (`mcpc @session <command>`)
12. **JSON field naming** - Use consistent field names in JSON output:
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
- **Keychain Integration**: OS keychain via `@napi-rs/keyring` for secure credential storage

### 🚧 Deferred / Nice-to-have

- **Package Resolution**: Find and run local MCP packages automatically
- **Tab Completion**: Shell completions for commands, tool names, and resource URIs
- **Resource File Output**: `-o <file>` flag for `resources-read` command

### 📋 Implementation Approach

All MCP operations go through named sessions. Sessions are persistent bridge processes that maintain the MCP connection.

**Bridge Process Architecture:**

- Persistent bridge maintains MCP connection and state
- CLI communicates via Unix socket IPC
- Supports sessions, notifications, caching, and better performance
- Used when target is a session name (e.g., `@apify`)
- Bridge handles automatic reconnection and error recovery

**Session workflow:**

1. `mcpc connect <server> @name` — creates session and starts bridge
2. `mcpc @name <command>` — all MCP operations routed through the bridge
3. `mcpc @name close` — tears down session and bridge

## References

- [Official MCP documentation](https://modelcontextprotocol.io/llms.txt)
- [Official TypeScript SDK for MCP servers and clients](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector) - CLI client implementation for reference

## Releasing

The release process is automated via GitHub Actions (`release.yml`). The local `pnpm run release` command is a thin wrapper that validates preconditions and triggers the workflow.

Before releasing:

1. **Update CHANGELOG.md** with all changes since the last release
2. Ensure your branch is clean, up-to-date with `origin/main`, and all CI checks pass
3. Run `pnpm run release` (or `pnpm run release:minor` / `pnpm run release:major`)

The script validates preconditions locally, then triggers the `release.yml` GitHub Actions workflow which handles: lint, build, test, version bump, changelog update, README update, git commit/tag/push, npm publish (with provenance), and GitHub release creation.

For pre-releases: `pnpm run release:pre` (or `pnpm run release:pre -- minor`)

Monitor the release progress at the GitHub Actions URL that opens automatically.

### Changelog maintenance

The `CHANGELOG.md` file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. When making changes to the codebase, update the `[Unreleased]` section with your changes.

**Categories to use:**

- `Added` - New features
- `Changed` - Changes in existing functionality
- `Deprecated` - Soon-to-be removed features
- `Removed` - Removed features
- `Fixed` - Bug fixes
- `Security` - Vulnerability fixes

**Example entry:**

```markdown
## [Unreleased]

### Added

- New `--foo` option for the `bar` command

### Fixed

- Fixed crash when server returns empty response
```

**Before each release**, Claude should:

1. Review all commits since the last release: `git log $(git describe --tags --abbrev=0)..HEAD --oneline`
2. Ensure all significant changes are documented in `[Unreleased]`
3. The release script will automatically move `[Unreleased]` entries to the new version section

**Important:** The changelog is for **users reading release notes**. Only include entries that a user would care about. Do not add entries for: new warnings or deprecation notices on existing commands, minor help text or `--help` output changes, test infrastructure (new tests, test refactors), CI/CD workflow changes, internal refactors, or cosmetic tweaks. When in doubt, leave it out.

# Misc

When writing titles of sections in README and code, do not capitalize first letters (e.g. "Session management" instead of "Session Management")

Never add files to git or commit yourself.
