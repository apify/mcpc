# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`mcpc` is a command-line client for the Model Context Protocol (MCP). It wraps remote or local MCP servers as friendly command-line tools, mapping MCP concepts (tools, resources, prompts) to intuitive CLI commands.

**Key capabilities:**
- Universal MCP client supporting Streamable HTTP and stdio transports
- Persistent session management with bridge processes
- Zero-setup connection to remote servers or local packages
- AI-friendly design for code generation and automated workflows

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
# Show general help
mcpc --help

# List all sessions
mcpc

# Show server info and capabilities (with mock data)
mcpc https://mcp.example.com
mcpc @apify

# List tools (mock data)
mcpc https://mcp.example.com tools-list
mcpc @apify tools-list --json

# Call a tool with arguments (mock data)
mcpc @apify tools-call search --args '{"query":"hello"}'
mcpc @apify tools-call search --args query=hello limit:=10

# Create a session (not yet functional)
mcpc https://mcp.apify.com connect --session @apify

# Set logging level (mock)
mcpc @apify logging-set-level debug
```

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
├── bin/
│   ├── mcpc            # Main CLI executable
│   └── mcpc-bridge     # Bridge process executable
└── examples/
    └── test-server/    # Reference MCP server for testing
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
- Interactive shell using `@inquirer/prompts` with command history (`~/.mcpc/history`, last 1000 commands)
- Configuration file loading (standard MCP JSON format, compatible with Claude Desktop)
- Credential management via OS keychain (`keytar` package)
- Tab completion for commands, tool names, and resource URIs

**CLI Command Structure:**
- All MCP commands use hyphenated format: `tools-list`, `tools-call`, `resources-get`, etc.
- `mcpc` - List all sessions
- `mcpc <target>` - Show server info, instructions, capabilities, and available commands
- `mcpc <target> help` - Alias for above
- `mcpc <target> <command>` - Execute MCP command
- Session creation: `mcpc <target> connect --session @<session-name>`

**Output Utilities** (`src/cli/output.ts`):
- `logTarget(target, outputMode)` - Shows `[Using session: @name]` prefix (human mode only)
- `formatOutput(data, mode)` - Auto-detects data type and formats appropriately
- `formatJson(data)` - Clean JSON output without wrappers
- `formatTools/Resources/Prompts()` - Specialized table formatting
- `formatSuccess/Error/Warning/Info()` - Styled status messages

### Session Lifecycle

1. User creates session: `mcpc https://mcp.apify.com connect --session @apify`
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

### Transport Implementation

**Streamable HTTP:**
- Persistent HTTP connection with bidirectional streaming
- Server and client can send messages in both directions over the same connection
- Automatic reconnection with exponential backoff (1s → 30s max)
- Queues requests during disconnection (fails after 3 minutes)
- **Important**: Only the Streamable HTTP transport is supported (current MCP standard). The deprecated HTTP with SSE transport is not implemented.

**Stdio:**
- Direct bidirectional JSON-RPC communication over stdin/stdout
- Bridge manages subprocess lifecycle for local packages
- Stdio framing for message boundaries

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

- Credentials stored in OS keychain (encrypted by system)
- `sessions.json` file permissions: `0600` (user-only)
- Bridge socket permissions: `0700`
- HTTPS enforced (HTTP auto-upgraded)
- Certificate validation enabled by default
- No credentials logged even in verbose mode
- File locking (`proper-lockfile`) for concurrent access safety

## MCP Protocol Implementation

**Protocol version:** Current latest is `2025-11-25`

**Initialization sequence:**
1. Client sends `initialize` request with protocol version and client capabilities
2. Server responds with agreed version and server capabilities
3. Client sends `initialized` notification to activate session

**MCP Primitives:**
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
- List operations return `nextCursor` when more results available
- Use `--cursor` flag to fetch next page

**Argument Passing:**

Tools and prompts accept arguments via `--args` flag in three formats:

1. **Inline JSON** (recommended for complex objects):
   ```bash
   mcpc @apify tools-call search --args '{"query":"hello","limit":10}'
   ```

2. **Key=value pairs** (for simple strings):
   ```bash
   mcpc @apify tools-call search --args query=hello limit=world
   ```

3. **Key:=json pairs** (for typed values):
   ```bash
   mcpc @apify tools-call search --args query="hello" limit:=10 enabled:=true
   ```

Detection logic: If first argument starts with `{` or `[`, it's parsed as inline JSON. Otherwise, key=value/key:=json pairs are parsed.

## Package Resolution

When a target is identified as a local package (e.g., `@modelcontextprotocol/server-filesystem`):

1. Check `./node_modules` (local project dependencies)
2. Check global npm packages (`npm root -g`)
3. Check Bun global packages (if using Bun)

Package requirements:
- Must have executable in `package.json` `bin` field or `main` field
- Should support MCP stdio transport
- Optional: `mcpServer` field in `package.json` to specify entry point

## Configuration Format

Uses standard MCP config format (compatible with Claude Desktop):

```json
{
  "mcpServers": {
    "http-server": {
      "url": "https://mcp.example.com",
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
- Mock MCP server (simple Streamable HTTP + stdio servers in `examples/test-server/`)
- Bridge lifecycle (start, connect, restart, cleanup)
- Session management with file locking
- Stream reconnection logic

**E2E tests:**
- Real MCP server implementations
- Cross-runtime testing (Node.js and Bun)
- Interactive shell workflows

**Test utilities:**
- `examples/test-server/` - Reference MCP server
- `test/mock-keychain.ts` - Mock OS keychain

## Runtime Requirements

- **Node.js:** ≥18.0.0 (for native `fetch` API)
- **Bun:** ≥1.0.0 (alternative runtime)
- **OS support:** macOS, Linux, Windows

## State and Data Storage

- `~/.mcpc/sessions.json` - Active sessions (file-locked for concurrent access)
- `~/.mcpc/bridges/` - Unix domain socket files for bridge processes
- `~/.mcpc/history` - Interactive shell command history (last 1000 commands)
- `~/.mcpc/logs/bridge-<session>.log` - Bridge process logs (max 10MB, 5 files)
- OS keychain - Authentication tokens (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux)

## Key Dependencies

- `@modelcontextprotocol/sdk` - Official MCP SDK for client/server implementation
- `commander` - Command-line argument parsing and CLI framework
- `chalk` - Terminal string styling and colors
- `cli-table3` - ASCII table formatting for human-readable output
- `@inquirer/prompts` - Interactive shell (planned)
- `keytar` - OS keychain integration (planned)
- `proper-lockfile` - File locking for concurrent access (planned)

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
9. **Hyphenated commands** - All MCP commands use hyphens: `tools-list`, `resources-get`, `prompts-list`
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

## Current Implementation Status

### ✅ Completed
- **CLI Structure**: Complete command parsing and routing with Commander.js
- **Output Formatting**: Human-readable (tables, colors) and JSON modes
- **Argument Parsing**: Inline JSON, key=value, and key:=json formats
- **Core MCP Client**: Wrapper around official SDK with error handling
- **Transport Layer**: HTTP and stdio transport creation and management
- **Error Handling**: Typed errors with appropriate exit codes
- **Logging**: Structured logging with verbose mode support
- **Command Handlers**: All command stubs with mock data
  - `tools-list`, `tools-get`, `tools-call`
  - `resources-list`, `resources-get`, `resources-subscribe`, `resources-unsubscribe`
  - `prompts-list`, `prompts-get`
  - `logging-set-level`
  - `connect`, `close`, `help`, `shell` (stub)

### 🚧 In Progress / TODO
- **Bridge Process**: Persistent MCP connections (placeholder exists)
- **Session Management**: `sessions.json` persistence with file locking
- **IPC Layer**: Unix socket communication between CLI and bridge
- **Target Resolution**: URL/package/config resolution logic
- **CLI-to-MCP Integration**: Connect command handlers to actual MCP client
- **Interactive Shell**: REPL with command history and tab completion
- **Config File Loading**: Parse and use MCP config files
- **Keychain Integration**: Store credentials securely
- **Package Resolution**: Find and run local MCP packages
- **Notification Handling**: Handle server-sent notifications
- **Error Recovery**: Bridge crash recovery, automatic reconnection

### 📋 Implementation Approach

Two options for connecting CLI commands to MCP:

**Option 1: Direct Connection (Recommended Start)**
- CLI command handlers create `McpClient` on-demand
- Connect → Execute → Close for each command
- Simpler, works immediately, good for ephemeral usage
- No persistent sessions yet

**Option 2: Bridge Process (Full Architecture)**
- Persistent bridge maintains MCP connection
- CLI communicates via Unix socket IPC
- Supports persistent sessions, notifications, better performance
- More complex, implement after Option 1 works

## References

- [Official MCP documentation](https://modelcontextprotocol.io/llms.txt)
- [Official TypeScript SDK for MCP servers and clients](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector) - CLI client implementation for reference
