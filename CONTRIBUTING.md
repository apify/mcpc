# Contributing to mcpc

`mcpc` is under active development and some things might not work 100% yet. You have been warned.
Contributions are welcome!

## Design principles

- Delightful for humans and AI agents alike (interactive + scripting)
- Avoid unnecessary interaction loops, provide sufficient context, yet be concise (save tokens)
- One clear way to do things (orthogonal commands, no surprises)
- Do not ask for user input (except `shell` and `login`, no unexpected OAuth flows)
- Be forgiving, always help users make progress (great errors + guidance)
- Be consistent with the [MCP specification](https://modelcontextprotocol.io/specification/latest), with `--json` strictly
- Minimal and portable (few deps, cross-platform)
- Keep backwards compatibility as much as possible
- No slop!

## Development setup

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

## Testing

See [`test/README.md`](./test/README.md) for details on running unit and E2E tests.

```bash
npm test                    # Run all tests (unit + e2e)
npm run test:unit           # Run unit tests only
npm run test:e2e            # Run e2e tests only
npm run test:coverage       # Run all tests with coverage
```

## Release process

Use the release script to publish a new version
of the [@apify/mcpc](https://www.npmjs.com/package/@apify/mcpc) package on NPM:

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

## Architecture overview

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
└── test/
    └── e2e/
        └── server/     # Test MCP server for E2E tests
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


## References

- [Official MCP documentation](https://modelcontextprotocol.io/llms.txt)
- [Official TypeScript SDK for MCP servers and clients](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector) - CLI client implementation for reference

## Getting help

Please open an issue or pull request on [GitHub](https://github.com/apify/mcpc).
