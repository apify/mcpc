# **mcpc** - a command-line MCP client

Wrap any remote or local MCP server as a friendly command-line tool.

`mcpc` is a command-line client for the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
over standard transports (Streamable HTTP and stdio).
It maps MCP concepts to intuitive CLI commands, and uses a bridge process per session,
so you can keep multiple MCP connections alive simultaneously.

`mcpc` is useful for testing and debugging of MCP servers,
as well as for AI coding agents to compose MCP tools using code generation
rather than tool function calling, in order to save tokens and increase accuracy.

## Features

- 🔌 **Universal MCP client** - Works with any MCP server over HTTP or stdio.
- 🔄 **Persistent sessions** - Keep multiple server connections alive simultaneously.
- 🚀 **Zero setup** - Connect to remote servers or run local packages instantly.
- 🔧 **Full protocol support** - Tools, resources, prompts, sampling, dynamic discovery, and async notifications.
- 📊 **JSON output** - Easy integration with jq, scripts, and other CLI tools.
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

# Create a persistent session
mcpc @myserver connect https://mcp.example.com
mcpc @myserver tools-call search --args query=hello

# Interactive shell
mcpc @myserver shell
mcpc https://mcp.example.com shell
```

## Usage

```bash
mcpc [--json] [--config <file>] [-H|--header "K: V"] [-v|--verbose] [--schema <file>]
     [--schema-mode <mode>] [--timeout <seconds>] [--protocol-version <version>]
     <target> <command...>

# MCP commands
mcpc <target> instructions

mcpc <target> tools
mcpc <target> tools-list [--cursor <cursor>]
mcpc <target> tools-get <tool>
mcpc <target> tools-call <tool> [--args key=val key2:=json ...] [--args-file <file>]

mcpc <target> resources
mcpc <target> resources-list [--cursor <cursor>]
mcpc <target> resources-get <uri> [-o <file>] [--raw] [--max-size <bytes>]
mcpc <target> resources-subscribe <uri>
mcpc <target> resources-unsubscribe <uri>

mcpc <target> prompts
mcpc <target> prompts-list [--cursor <cursor>]
mcpc <target> prompts-get <name> [--args key=val key2:=json ...]

# Session management
mcpc <target> connect <server>
mcpc # prints alls sessions
mcpc @<name> <command...>
mcpc @<name> close

# Interactive
mcpc <target> shell
```

where `<target>` can be one of:

- **Named session** prefixed with `@` (e.g. `@apify`) - highest priority
- **Remote MCP endpoint** URL (e.g. `https://mcp.apify.com`)
- **Named entry** in a config file, when used with `--config` (e.g. `linear-mcp`)
- **Local MCP server package** (e.g. `@microsoft/playwright-mcp`)

Target types are resolved in the order listed above. Use explicit format to avoid ambiguity.

Transports are selected automatically: HTTP/HTTPS URLs use the MCP Streamable HTTP transport, local packages are spawned and spoken to over stdio.

### Advanced arguments

**Argument types:**

`mcpc` supports multiple ways to pass arguments to tools and prompts:

```bash
# String values (default) - use = for strings
--args name=value query="hello world"

# JSON literals - use := for JSON types
--args count:=123 enabled:=true value:=null
--args config:='{"key":"value"}' items:='[1,2,3]'

# Mixed strings and JSON
--args query="search term" limit:=10 verbose:=true

# Load all arguments from JSON file
--args-file tool-arguments.json

# Read from stdin (automatic when piped, no flag needed)
echo '{"query":"hello","count":10}' | mcpc @server tools-call my-tool
```

**Rules:**
- Use only one method: `--args`, `--args-file`, or stdin (piped input)
- After `--args`, all `key=value` or `key:=json` pairs are consumed until next flag or end
- `=` assigns as string, `:=` parses as JSON
- Stdin is automatically detected when input is piped (not interactive terminal)

**Global flags:**

- `--json` - Input and output in JSON format for scripting
- `--config <file>` - Use MCP config file (e.g., Claude Desktop config)
- `-H, --header "Key: Value"` - Add HTTP header (can be repeated)
- `-v, --verbose` - Enable verbose logging (shows protocol details)
- `--timeout <seconds>` - Request timeout in seconds (default: 300)
- `--protocol-version <version>` - Force specific MCP protocol version (e.g., `2025-11-25`)
- `--schema <file>` - Validate against expected tool/prompt schema
- `--schema-mode <mode>` - Schema validation mode: `strict`, `compatible`, or `ignore` (default: `compatible`)
- `--insecure` - Disable SSL certificate validation (not recommended)

## Sessions

MCP is a stateful protocol: clients and servers perform an initialization handshake
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

`mcpc` saves its state to `~/.mcpc/` directory, in the following files:

- `~/.mcpc/sessions.json` - a JSON object with all active sessions (file-locked for concurrent access)
- `~/.mcpc/bridges/` - directory containing Unix domain socket files for each bridge process
- OS keychain - authentication tokens (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux)

### Authentication

`mcpc` supports multiple authentication methods for the MCP servers:

- **No authentication** - for local servers (stdio) or remove servers (streamable HTTP) which do not require credentials.
- **HTTP token** - for remote servers that require an access token,
  use the `--header` flag to specify the header name and value (e.g. `--header "Authorization: Bearer YOUR_ACCESS_TOKEN"`).
- **OAuth** - for remote servers that require OAuth authentication,
  the CLI asks the user if it can open a browser window to let the user authenticate.

`mcpc` uses OS keychain to securly store authentication tokens.

### Managing sessions

```bash
# Create a persistent session
mcpc @apify connect https://mcp.apify.com/

# List active sessions
mcpc sessions

# Use the session
mcpc @apify tools list
mcpc @apify shell

# Close the session (terminates bridge process)
mcpc @apify close
```

### Piping between sessions

```bash
mcpc --json @apify tools call search-actors --args query="tiktok scraper" \
  | jq '.data.results[0]' \
  | mcpc @playwright tools call run-browser
```

### Scripting

`mcpc` is designed to be easily usable in (AI-generated) scripts. To ensure consistency
of your scripts with the current MCP server interface, you can use `--schema <file>` argument
to pass `mcpc` the expected schema. If the MCP server's current schema is incompatible,
the command returns an error.

```bash
# Save tool schema for future validation
mcpc --json @apify tools get search-actors > tool-schema.json

# Use schema to ensure compatibility (fails if schema changed)
mcpc @apify tools call search-actors \
  --schema tool-schema.json \
  --schema-mode strict \
  --args query="tiktok scraper"
```

**Schema validation modes:**
- `strict` - Exact schema match required (all fields, types must be identical)
- `compatible` (default) - Backwards compatible (new optional fields OK, required fields and types must match)
- `ignore` - Skip schema validation

## Configuration

Configuration can be provided via file, environment variables, or command-line flags.

**Precedence** (highest to lowest):
1. Command-line flags
2. Environment variables
3. Config file (when specified with `--config`)
4. Built-in defaults

### Config file

`mcpc` uses the standard MCP config file format, compatible with Claude Desktop and other MCP clients. You can point to an existing config file with `--config`:

```bash
# Use Claude Desktop config (macOS)
mcpc --config ~/Library/Application\ Support/Claude/claude_desktop_config.json apify tools list

# Use custom config file
mcpc --config ./mcp-config.json myserver resources list
```

**Standard MCP config format:**

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

**Server configuration options:**

For **HTTP/HTTPS servers:**
- `url` (required) - MCP server endpoint URL
- `headers` (optional) - HTTP headers to include with requests
- `timeout` (optional) - Request timeout in seconds

For **stdio servers:**
- `command` (required) - Command to execute (e.g., `node`, `npx`, `python`)
- `args` (optional) - Array of command arguments
- `env` (optional) - Environment variables for the process

**Using servers from config:**

When `--config` is provided, you can reference servers by name:

```bash
# With config file, use server names directly
mcpc --config mcp-config.json apify tools list
mcpc --config mcp-config.json filesystem resources list

# Create a named session from config
mcpc --config mcp-config.json connect my-apify apify
mcpc @my-apify tools call search
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

### Environment variables

- `MCPC_CONFIG` - Path to the standard MCP server config file (instead of using `--config`)
- `MCPC_SESSION_DIR` - Directory for session data (default is `~/.mcpc`)
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
- During reconnection, new requests are queued (fails after 3 minutes of disconnection)
- **Stdio**: Direct bidirectional JSON-RPC communication over standard input/output

**Protocol features:**
- Supports all MCP primitives:
  - **Instructions**: Fetches and stores MCP server-provided `instructions`
  - **Tools**: Executable functions with JSON Schema-validated arguments.
  - **Resources**: Data sources identified by URIs (e.g., `file:///path/to/file`, `https://example.com/data`), with optional subscriptions for change notifications
  - **Prompts**: Reusable message templates with customizable arguments
- Handles server notifications: progress tracking, logging, and change notifications (`notifications/tools/list_changed`, `notifications/resources/list_changed`, `notifications/prompts/list_changed`)
- Request multiplexing: supports up to 10 concurrent requests, queues up to 100 additional requests
- Pagination: List operations return `nextCursor` when more results are available; use `--cursor` to fetch next page
- Sampling is not supported as `mcpc` has no access to an LLM.

## Package resolution

When a target is identified as a local package, `mcpc` resolves it as follows:

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
mcpc @modelcontextprotocol/server-filesystem resources list

# Use globally installed package
npm install -g @modelcontextprotocol/server-filesystem
mcpc @modelcontextprotocol/server-filesystem resources list
```

## Output format

### Human-readable (default)

Default output is formatted for human readability with colors, tables, and formatting.

### JSON mode (`--json`)

All output follows a JSON schema consistent with the MCP protocol.

**Success response:**
```json
{
  "success": true,
  "data": {
    "//": "Command-specific data"
  },
  "metadata": {
    "session": "myserver",
    "serverInfo": {
      "name": "example-server",
      "version": "1.0.0"
    },
    "protocolVersion": "2025-11-25",
    "timestamp": "2025-12-09T10:30:00Z"
  }
}
```

**Error response:**
```json
{
  "success": false,
  "error": {
    "code": "TOOL_NOT_FOUND",
    "message": "Tool 'search' not found",
    "details": {
      "tool": "search",
      "availableTools": ["list", "get"]
    }
  },
  "metadata": {
    "timestamp": "2025-12-09T10:30:00Z"
  }
}
```

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
- **Bridge restart**: Automatic on crash detection, manual with `mcpc @name reconnect`
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
- `exit` or `quit` - Exit shell (or Ctrl+D)
- Ctrl+C - Cancel current operation
- Ctrl+D - Exit shell

**Example session:**
```
$ mcpc @apify shell
Connected to apify (https://mcp.apify.com)
MCP version: 2025-11-25

mcpc(@apify)> tools list
Available tools:
  - search-actors
  - get-actor
  - run-actor

mcpc(@apify)> tools call search-actors --args query="tiktok scraper"
[results...]

mcpc(@apify)> exit
```

## Implementation details

`mcpc` is under active development.
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

**Shell Implementation:**
- Built on `@inquirer/prompts` for input handling
- Command history using `~/.mcpc/history`
- Tab completion using inquirer autocomplete
- Graceful exit handling (cleanup on Ctrl+C/Ctrl+D)

### Session lifecycle

```
1. User: mcpc connect apify https://mcp.apify.com
2. CLI: Creates session entry in sessions.json
3. CLI: Spawns bridge process (mcpc-bridge)
4. Bridge: Creates Unix socket at ~/.mcpc/bridges/apify.sock
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
11. CLI: Sends "tools/list" JSON-RPC request via socket
12. Bridge: Forwards to MCP server via Streamable HTTP
13. Bridge: Returns response via socket
14. CLI: Formats and displays to user
```

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
- Bridge may have crashed. Try: `mcpc @session reconnect` or `mcpc connect session <target>`
- Check bridge is running: `ps aux | grep mcpc-bridge`
- Check socket exists: `ls ~/.mcpc/bridges/`

**"Session not found"**
- Session may have expired. Create new session: `mcpc connect <name> <target>`
- List existing sessions: `mcpc sessions`

**"Package not found"**
- Ensure package is installed: `npm list -g <package>` or `npm list <package>`
- Try with full path: `mcpc /path/to/package/bin/server resources list`

**"Authentication failed"**
- Check credentials in OS keychain: `mcpc auth list`
- Use environment variable: `Authorization: Bearer ${TOKEN}` in config
- Re-authenticate: `mcpc auth login <server>`

### Debug mode

Enable detailed logging with `--verbose`:

```bash
mcpc --verbose @apify tools list
```

This shows:
- Protocol negotiation details
- JSON-RPC request/response messages
- Streaming events and reconnection attempts
- Bridge communication (socket messages)
- File locking operations

### Logs

Bridge processes log to:
- `~/.mcpc/logs/bridge-<session>.log`

Log rotation: Keep last 10MB per session, max 5 files.

## Contributing

Contributions are welcome! Areas where we'd especially appreciate help:

- Transport compatibility tests (Streamable HTTP + stdio)
- Shell completion scripts (bash, zsh, fish)
- Documentation and examples
- Bug reports and feature requests
- Testing with various MCP servers
- Windows compatibility testing

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

## License

Apache-2.0 - see [LICENSE](./LICENSE) for details.
