# **mcpc**

Wrap any remote or local MCP server as a friendly command-line tool.

`mcpc` is command-line client for the Model Context Protocol (MCP)
over standard transports (Streamable HTTP and stdio).
It maps MCP concepts to intuitive CLI commands, and uses a bridge process per session,
so you can keep multiple MCP connections alive simultaneously.

`mcpc` is useful for test and debugging of MCP servers,
as well as for AI coding agents to compose MCP tools using code generation
rather than tool function calling, in order to save tokens and increase accuracy.

## Install
 
`npm i -g mcpc`

## Quickstart

TODO

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


### Sessions

MCP is stateful protocol: clients and servers negotiate capabilities during
initialization and then communicate within a session. On HTTP transports,
servers can issue an `MCP-Session-Id`, and can send asynchronous messages
via SSE streams; disconnects are not cancellations and resuming streams uses `Last-Event-ID`.

So instead of forcing every command to reconnect and reinitialize,
`mcpc` can run a lightweight **bridge** that:

- keeps the session warm (incl. session ID and negotiated protocol version),
- manages SSE streams and resumption,
- multiplexes multiple concurrent requests,
- lets you run **many servers at once** and pipe outputs between them.

## Long-term sessions

```
mcpc connect apify https://mcp.apify.com/
mcpc sessions
mcpc @apify instructions
mcpc @apify tools list
mcpc @apify shell
mcpc @apify close
```

### Interacting with multiple sessions

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

## Status

`mcpc` is under active development. Contributions welcome:

* transport compatibility tests (Streamable HTTP \+ stdio),
* UX polish (completion, help output),
* session persistence and secure credential storage.

