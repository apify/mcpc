# **mcpc**

Wrap any remote or local MCP server as a friendly command-line tool.

`mcpc` is a command-line client for the Model Context Protocol (MCP)
over standard transports (Streamable HTTP and stdio).
It maps MCP concepts to intuitive CLI commands, and uses a bridge process per session,
so you can keep multiple MCP connections alive simultaneously.

`mcpc` is useful for testing and debugging of MCP servers,
as well as for AI coding agents to compose MCP tools using code generation
rather than tool function calling, in order to save tokens and increase accuracy.

## Features

- 🔌 **Universal MCP client** - Works with any MCP server over HTTP or stdio
- 🔄 **Persistent sessions** - Keep multiple server connections alive simultaneously
- 🚀 **Zero setup** - Connect to remote servers or run local packages instantly
- 🔧 **Full protocol support** - Tools, resources, prompts, and async notifications
- 📊 **JSON output** - Easy integration with jq, scripts, and other CLI tools
- 🤖 **AI-friendly** - Designed for code generation and automated workflows

## Install
 
```bash
npm install -g mcpc
```

## Quickstart

```bash
# Connect to a remote MCP server
mcpc https://mcp.example.com tools list

# Run a local MCP server package
mcpc @modelcontextprotocol/server-filesystem tools list

# Create a persistent session
mcpc connect myserver https://mcp.example.com
mcpc @myserver tools call search --arg query="hello"

# Interactive shell
mcpc @myserver shell
mcpc https://mcp.example.com shell
```

## Usage

```bash
mcpc [--json] [--config <file>] [-H|--header "K: V"] [-v|--verbose] <target> <command...>

# MCP commands
mcpc <target> instructions
mcpc <target> tools list
mcpc <target> tools get <tool>
mcpc <target> tools call <tool> [--arg key=val ...]

mcpc <target> resources list
mcpc <target> resources get <uri> [-o <file>]

mcpc <target> prompts list
mcpc <target> prompts get <name> [--arg key=val ...]

mcpc <target> tasks list
mcpc <target> tasks watch <id>
mcpc <target> tasks cancel <id>

# Session management
mcpc connect <name> <target>
mcpc sessions
mcpc @<name> <command...>
mcpc @<name> close

# Interactive
mcpc <target> shell
```

where `<target>` can be one of:

- Remote MCP endpoint URL (e.g. `https://mcp.apify.com`)
- Local MCP server package (e.g. `@microsoft/playwright-mcp`)
- Named entry in a config file, when used with `--config` (e.g. `linear-mcp`)
- Saved session prefixed with `@` (e.g. `@apify`)

Transports are selected automatically: HTTP URLs use the MCP HTTP transport, local packages are spawned and spoken to over stdio.

## Sessions

MCP is a stateful protocol: clients and servers negotiate capabilities during
initialization and then communicate within a session. On HTTP transports,
servers can issue an `MCP-Session-Id`, and can send asynchronous messages
via SSE streams; disconnects are not cancellations and resuming streams uses `Last-Event-ID`.

Instead of forcing every command to reconnect and reinitialize,
`mcpc` can run a lightweight **bridge** that:

- keeps the session warm (incl. session ID and negotiated protocol version),
- manages SSE streams and resumption,
- multiplexes multiple concurrent requests,
- lets you run **many servers at once** and pipe outputs between them.

### Managing sessions

```bash
# Create a persistent session
mcpc connect apify https://mcp.apify.com/

# List active sessions
mcpc sessions

# Use the session
mcpc @apify instructions
mcpc @apify tools list
mcpc @apify shell

# Close the session
mcpc @apify close
```

### Piping between sessions

```bash
mcpc --json @apify tools call search-actors --arg keywords="web scraper" \
  | jq '.results[0]' \
  | mcpc @playwright tools call run-browser --arg input=-
```

## MCP protocol notes

* `mcpc` negotiates protocol version on init; subsequent HTTP requests include the negotiated `MCP-Protocol-Version`.
* For Streamable HTTP, the bridge manages SSE streams, reconnection, and optional `Last-Event-ID` resumption.
* `mcpc` supports MCP server features (tools/resources/prompts)
  and handles server-initiated flows where possible (e.g., progress, logging, change notifications, cancellation).

## Security

MCP enables arbitrary tool execution and data access; treat servers like you treat shells:

* use least-privilege tokens/headers,
* prefer trusted endpoints,
* audit what tools do before running them.

## Error Handling

`mcpc` provides clear error messages for common issues:

- **Connection failures**: Displays transport-level errors with retry suggestions
- **Session timeouts**: Automatically attempts to reconnect or prompts for session recreation
- **Invalid commands**: Shows available commands and correct syntax
- **Tool execution errors**: Returns server error messages with context

Use `--verbose` flag for detailed debugging information.

## Status

`mcpc` is under active development. Current focus areas:

- ✅ Core MCP protocol support (tools, resources, prompts)
- ✅ HTTP and stdio transports
- ✅ Session management and persistence
- 🚧 Shell completion (bash, zsh, fish)
- 🚧 Configuration file enhancements
- 🚧 Secure credential storage

## Contributing

Contributions are welcome! Areas where we'd especially appreciate help:

- Transport compatibility tests (Streamable HTTP + stdio)
- Shell completion scripts
- Documentation and examples
- Bug reports and feature requests

Please open an issue or pull request on [GitHub](https://github.com/jancurn/mcpc).

## License

Apache-2.0 - see [LICENSE](LICENSE) for details.

