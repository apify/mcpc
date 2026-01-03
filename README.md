# `mcpc`: Universal MCP command-line client

`mcpc` is a CLI for the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
that maps MCP operations to intuitive commands for interactive shell use, scripts, and AI coding agents.

`mcpc` is a Swiss Army knife for MCP. It is useful for inspecting servers, scripting,
and enabling AI coding agents to use MCP ["code mode"](#ai-agents) in shell.
After all, UNIX-compatible shell script is THE most universal coding language.

![mcpc screenshot](https://raw.githubusercontent.com/apify/mcpc/main/docs/images/mcpc-demo.gif)

**Key features:**
- 🌎 **Highly compatible** - Works with any MCP server over Streamable HTTP or stdio.
- 🔄 **Persistent sessions** - Keep multiple server connections alive simultaneously.
- 🚀 **Zero setup** - Connect to remote servers instantly with just a URL.
- 🔧 **Strong MCP support** - Instructions, tools, resources, prompts, dynamic discovery.
- 🔌 **JSON output** - Easy integration with `jq`, scripts, and other CLI tools.
- 🤖 **AI-friendly** - Designed for both function calling and code mode with sandboxing.
- 🔒 **Secure** - Full OAuth 2.1 support, OS keychain for credentials storage.


## Table of contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Install](#install)
- [Quickstart](#quickstart)
- [Usage](#usage)
- [Sessions](#sessions)
- [Authentication](#authentication)
- [MCP proxy](#mcp-proxy)
- [AI agents](#ai-agents)
- [MCP support](#mcp-support)
- [Configuration](#configuration)
- [Security](#security)
- [Errors](#errors)
- [Development](#development)
- [License](#license)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->


## Install

```bash
npm install -g @apify/mcpc
```

**Linux users:** `mcpc` uses the OS keychain for secure credential storage, which requires the [Libsecret](https://wiki.gnome.org/Projects/Libsecret) 
library. Install it with:

```bash
# Debian/Ubuntu
sudo apt-get update
sudo apt-get install libsecret-1-0

# Fedora/RHEL/CentOS
sudo dnf install libsecret

# Arch Linux
sudo pacman -S libsecret
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
mcpc mcp.apify.com connect @test
mcpc @test tools-call search-actors keywords:="website crawler"
mcpc @test shell

# Interact with a local MCP server package (stdio) referenced from config file
mcpc --config ~/.vscode/mcp.json filesystem tools-list
```

## Usage

<!-- AUTO-GENERATED: mcpc --help -->

```
Usage: mcpc [options] <target> [command]

Universal command-line client for the Model Context Protocol (MCP).

Options:
  -j, --json                    Output in JSON format for scripting
  -c, --config <file>           Path to MCP config JSON file (e.g. ".vscode/mcp.json")
  -H, --header <header>         HTTP header for remote MCP server (can be repeated)
  -v, --version                 Output the version number
  --verbose                     Enable debug logging
  --profile <name>              OAuth profile for the server ("default" if skipped)
  --schema <file>               Validate tool/prompt schema against expected schema
  --schema-mode <mode>          Schema validation mode: strict, compatible (default), ignore
  --timeout <seconds>           Request timeout in seconds (default: 300)
  --proxy <[host:]port>         Start proxy MCP server for session (with "connect" command)
  --proxy-bearer-token <token>  Require authentication for access to proxy server
  --clean[=types]               Clean up mcpc data (types: sessions, logs, profiles, all)
  -h, --help                    Display general help

Targets:
  @<session>                    Named persistent session (e.g. "@apify")
  <config-entry>                Entry in MCP config file specified by --config (e.g. "fs")
  <server-url>                  Remote MCP server URL (e.g. "mcp.apify.com")

Management commands (<target> missing):
  login                         Create OAuth profile with credentials to access remote server
  logout                        Remove OAuth profile for remote server
  connect @<session>            Connect to server and create named persistent session
  restart @<session>            Kill and restart a session
  close @<session>              Close a session

MCP commands (<target> provided):
  help                          Show server info ("help" can be omitted)
  shell                         Open interactive shell
  tools-list                    Send "tools/list" MCP request...
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
  ping

```

### Management commands

When `<target>` is missing, `mcpc` provides general management commands.

```bash
# List all sessions and OAuth profiles (also in JSON mode)
mcpc
mcpc --json

# Show command help or version
mcpc --help
mcpc --version

# Clean expired sessions and old log files
mcpc --clean
```

For additional management commands, see [OAuth profiles](#oauth-profiles) and [Cleanup](#cleanup).

### Targets

To connect to an MCP server, you need to specify a `<target>`, which can be one of (in order of precedence):

- **Entry in a config file** (e.g. `--config .vscode/mcp.json filesystem`) - see [Config file](#mcp-server-config-file)
- **Remote MCP server URL** (e.g. `https://mcp.apify.com`)
- **Named session** (e.g. `@apify`) - see [Sessions](#sessions)

`mcpc` automatically selects the transport protocol based on the server (stdio or Streamable HTTP),
connects, and enables you to interact with it.

**URL handling:**
- URLs without a scheme (e.g. `mcp.apify.com`) default to `https://`
- `localhost` and `127.0.0.1` addresses without a scheme default to `http://` (for local dev/proxy servers)
- To override the default, specify the scheme explicitly (e.g. `http://example.com`)

### MCP commands

Examples of sending MCP commands to various targets:

```bash
# Server from config file (stdio)
mcpc --config .vscode/mcp.json fileSystem
mcpc --config .vscode/mcp.json fileSystem tools-list
mcpc --config .vscode/mcp.json fileSystem tools-call list_directory path:=/

# Remote server (Streamable HTTP)
mcpc mcp.apify.com\?tools=docs
mcpc mcp.apify.com\?tools=docs tools-list
mcpc mcp.apify.com\?tools=docs tools-call search-apify-docs query:="What are Actors?"

# Session
mcpc mcp.apify.com\?tools=docs connect @apify
mcpc @apify tools-list
mcpc @apify tools-call search-apify-docs query:="What are Actors?"
```

See [MCP feature support](#mcp-feature-support) for details about all supported MCP features and commands.

#### Command arguments

The `tools-call` and `prompts-get` commands accept arguments as positional parameters after the tool/prompt name:

```bash
# Key:=value pairs (auto-parsed: tries JSON, falls back to string)
mcpc <target> tools-call <tool-name> greeting:="hello world" count:=10 enabled:=true
mcpc <target> tools-call <tool-name> config:='{"key":"value"}' items:='[1,2,3]'

# Force string type with JSON quotes
mcpc <target> tools-call <tool-name> id:='"123"' flag:='"true"'

# Inline JSON object (if first arg starts with { or [)
mcpc <target> tools-call <tool-name> '{"greeting":"hello world","count":10}'

# Read from stdin (automatic when no positional args and input is piped)
echo '{"greeting":"hello","count":10}' | mcpc <target> tools-call <tool-name>
cat args.json | mcpc <target> tools-call <tool-name>
```

**Rules:**
- All arguments use `:=` syntax: `key:=value`
- Values are auto-parsed: valid JSON becomes that type, otherwise treated as string
  - `count:=10` → number `10`
  - `enabled:=true` → boolean `true`
  - `greeting:=hello` → string `"hello"` (not valid JSON, so string)
  - `id:='"123"'` → string `"123"` (JSON string literal)
- Inline JSON: If first argument starts with `{` or `[`, it's parsed as a JSON object/array
- Stdin: When no positional args are provided and input is piped, reads JSON from stdin

**Using shell variables:**

When using shell variables that may contain spaces, use double quotes around the entire argument:

```bash
# Variable with spaces - use double quotes
QUERY="hello world"
mcpc @server tools-call search "query:=${QUERY}"

# Multiple variables
CITY="New York"
TYPE="restaurants"
mcpc @server tools-call search "query:=${CITY} ${TYPE}"

# For complex inputs, consider using JSON via stdin
echo "{\"query\": \"${QUERY}\", \"limit\": 10}" | mcpc @server tools-call search
```

**Common pitfall:** Don't put spaces around `:=` - it won't work:
```bash
# Wrong - spaces around :=
mcpc @server tools-call search query := "hello world"

# Correct - no spaces around :=
mcpc @server tools-call search "query:=hello world"
```

### Interactive shell

`mcpc` provides an interactive shell for discovery and testing of MCP servers.

```bash
mcpc mcp.apify.com shell    # Direct connection
mcpc @apify shell           # Use existing session
```

Shell commands: `help`, `exit`/`quit`/Ctrl+D, Ctrl+C to cancel.
Arrow keys navigate history (saved to `~/.mcpc/history`).

### JSON mode

By default, `mcpc` prints output in Markdown-ish text format with colors, making it easy to read by both humans and AIs.

With `--json` option, `mcpc` always emits only a single JSON object (or array), to enable [scripting](#scripting).
**For all MCP commands, the returned objects are always consistent with the
[MCP specification](https://modelcontextprotocol.io/specification/latest).**
On success, the JSON object is printed to stdout, on error to stderr.

Note that `--json` is not available for `shell`, `login`, and `mcpc --help` commands.

## Sessions

MCP is a [stateful protocol](https://modelcontextprotocol.io/specification/latest/basic/lifecycle):
clients and servers negotiate protocol version and capabilities, and then communicate within a persistent session.
To support these sessions, `mcpc` can start a lightweight **bridge process** that maintains the connection and state.
This is more efficient than forcing every MCP command to reconnect and reinitialize,
and enables long-term stateful sessions.

The sessions are given names prefixed with `@` (e.g. `@apify`),
which then serve as unique reference in commands.

```bash
# Create a persistent session
mcpc mcp.apify.com\?tools=docs connect @apify

# List all sessions and OAuth profiles
mcpc

# Run MCP commands in the session
mcpc @apify tools-list
mcpc @apify shell

# Restart the session (kills and restarts the bridge process)
mcpc @apify restart

# Close the session, terminates bridge process
mcpc @apify close

# ...now session name "@apify" is forgotten and available for future use
```

### Session lifecycle

The sessions are persistent: metadata is saved in `~/.mcpc/sessions.json` file,
[authentication tokens](#authentication) in OS keychain.
The `mcpc` bridge process keeps the session alive by sending periodic [ping messages](#ping) to the MCP server.
Still, sessions can fail due to network disconnects, bridge process crash, or server dropping it.

**Session states:**

| State            | Meaning                                                                                       |
|------------------|-----------------------------------------------------------------------------------------------|
| 🟢 **`live`**    | Bridge process is running; server might or might not be operational                           |
| 🟡 **`crashed`** | Bridge process crashed or was killed; will auto-restart on next use                           |
| 🔴 **`expired`** | Server rejected the session (auth failed, session ID invalid); requires `close` and reconnect |

Here's how `mcpc` handles various bridge process and server connection states:

- While the **bridge process is running**:
  - If **server positively responds** to pings, the session is marked 🟢 **`live`**, and everything is fine.
  - If **server stops responding**, the bridge will keep trying to reconnect in the background.
  - If **server negatively responds** to indicate `MCP-Session-Id` is no longer valid
    or authentication permanently failed (HTTP 401 or 403),
    the bridge process will flag the session as 🔴 **`expired`** and **terminate** to avoid wasting resources.
    Any future attempt to use the session (`mcpc @my-session ...`) will fail.
- If the **bridge process crashes**, `mcpc` will mark the session as 🟡 **`crashed`** on first use.
  Next time you run `mcpc @my-session ...`, it will attempt to restart the bridge process.
  - If bridge **restart succeeds**, everything starts again (see above).
  - If bridge **restart fails**, `mcpc @my-session ...` returns error, and session remains marked 🟡 **`crashed`**.

Note that `mcpc` never automatically removes sessions from the list.
Instead, it keeps them flagged as 🟡 **`crashed`** or 🔴 **`expired`**,
and any future attempts to use them will fail.

To **remove the session from the list**, you need to explicitly close it:

```bash
mcpc @apify close
```

You can restart a session anytime, which kills the bridge process
and opens new connection with new `MCP-Session-Id`, by running:

```bash
mcpc @apify restart
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
mcpc mcp.apify.com\?tools=docs connect @test
mcpc @test tools-list
```

### Bearer token authentication

For remote servers that require a Bearer token (but not OAuth), use the `--header` flag to pass the token.
All headers are stored securely in the OS keychain for the session, but they are **not** saved as reusable
[OAuth profiles](#oauth-profiles). This means `--header` needs to be provided whenever
running a one-shot command or connecting new session.

```bash
# One-time command with Bearer token
mcpc --header "Authorization: Bearer ${APIFY_TOKEN}" https://mcp.apify.com tools-list

# Create session with Bearer token (saved to keychain for this session only)
mcpc --header "Authorization: Bearer ${APIFY_TOKEN}" https://mcp.apify.com connect @apify

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
mcpc https://mcp.apify.com connect @apify-personal
mcpc https://mcp.apify.com connect @apify-work --profile work

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

On failure, the error message includes instructions on how to login and save the profile, so you know what to do.

This flow ensures:
- You only authenticate when necessary
- Credentials are never silently mixed up (personal → work) or downgraded (authenticated → unauthenticated)
- You can mix authenticated sessions (with named profiles) and public access on the same server

**Examples:**

```bash
# With specific profile - always authenticated:
# - Uses 'work' if it exists
# - Fails if it doesn't exist
mcpc mcp.apify.com connect @apify-work --profile work

# Without profile - opportunistic authentication:
# - Uses 'default' if it exists
# - Tries unauthenticated if 'default' doesn't exist
# - Fails if the server requires authentication
mcpc mcp.apify.com connect @apify-personal

# Public server - no authentication needed:
mcpc mcp.apify.com\?tools=docs tools-list
```


## MCP proxy

For stronger isolation, `mcpc` can expose an MCP session under a new local proxy MCP server using the `--proxy` option.
The proxy forwards all MCP requests to the upstream server but **never exposes the original authentication tokens** to the client.
This is useful when you want to give someone or something MCP access without revealing your credentials.
See also [AI sandboxes](#ai-sandboxes).

```bash
# Human authenticates to a remote server
mcpc mcp.apify.com login

# Create authenticated session with proxy server on localhost:8080
mcpc mcp.apify.com connect @open-relay --proxy 8080

# Now any MCP client can connect to proxy like to a regular MCP server
# The client has NO access to the original OAuth tokens or HTTP headers
# Note: localhost/127.0.0.1 URLs default to http:// (no scheme needed)
mcpc localhost:8080 tools-list
mcpc 127.0.0.1:8080 tools-call search-actors keywords:="web scraper"

# Or create a new session from the proxy for convenience
mcpc localhost:8080 connect @sandboxed
mcpc @sandboxed tools-call search-actors keywords:="web scraper"

# Optionally protect proxy with bearer token for better security (stored in OS keychain)
mcpc mcp.apify.com connect @secure-relay --proxy 8081 --proxy-bearer-token secret123
# To use the proxy, caller needs to pass the bearer token in HTTP header
mcpc localhost:8081 connect @sandboxed2 --header "Authorization: Bearer secret123"
```

**Proxy options for `connect` command:**

| Option                         | Description                                                                    |
|--------------------------------|--------------------------------------------------------------------------------|
| `--proxy [host:]port`          | Start proxy MCP server. Default host: `127.0.0.1` (localhost only)             |
| `--proxy-bearer-token <token>` | Requires `Authorization: Bearer <token>` header to access the proxy MCP server |

**Security model:**

- **Localhost by default**: `--proxy 8080` binds to `127.0.0.1` only, preventing network access
- **Tokens hidden**: Original OAuth tokens and/or HTTP headers are never exposed to proxy clients
- **Optional auth**: Use `--proxy-bearer-token` to add another layer of security
- **Explicit opt-in**: Proxy only starts when `--proxy` flag is provided

**Binding to network interfaces:**

```bash
# Localhost only (default, most secure)
mcpc mcp.apify.com connect @relay --proxy 8080

# Bind to all interfaces (allows network access - use with caution!)
mcpc mcp.apify.com connect @relay --proxy 0.0.0.0:8080

# Bind to specific interface
mcpc mcp.apify.com connect @relay --proxy 192.168.1.100:8080
```

When listing sessions, proxy info is displayed prominently:

```bash
mcpc
# @relay → https://mcp.apify.com (HTTP, OAuth: default) [proxy: 127.0.0.1:8080]
```


## AI agents

`mcpc` is designed for CLI-enabled AI agents like Claude Code or Codex CLI, supporting both
interactive **tool calling** and **[code mode](https://www.anthropic.com/engineering/code-execution-with-mcp)**.

**Tool calling mode** - Agents call `mcpc` commands to dynamically explore and interact with MCP servers,
using the default text output. This is similar to how MCP connectors in ChatGPT or Claude work,
but CLI gives you more flexibility and longer operation timeouts.

```bash
# Discover available tools
mcpc @server tools-list

# Get tool schema
mcpc @server tools-get search

# Call a tool
mcpc @server tools-call search query:="hello world"
```

**Code mode** - Once agents understand the server's capabilities, they can write shell scripts
that compose multiple `mcpc` commands with `--json` output. This can be
[more accurate](https://www.anthropic.com/engineering/code-execution-with-mcp)
and use fewer tokens than tool calling for complex workflows.

```bash
# AI-generated script using --json for structured data
mcpc --json @apify tools-call search-actors keywords:="scraper" \
  | jq '.content[0].text | fromjson | .items[0].id' \
  | xargs -I {} mcpc @apify tools-call get-actor actorId:="{}"
```

With [schema validation](#schema-validation), agents can ensure stability of integrations and faster failure recovery.
Agents, make no harm!

See an [example](./docs/examples/company-lookup.sh) of an AI-generated shell script.

### Scripting

Use `--json` for machine-readable output (stdout on success, stderr on error).
JSON output of all MCP commands follows the [MCP specification](https://modelcontextprotocol.io/specification/latest) strictly.

```bash
# Chain tools across sessions
mcpc --json @apify tools-call search-actors keywords:="scraper" \
  | jq '.content[0].text | fromjson | .items[0].id' \
  | xargs -I {} mcpc @apify tools-call get-actor actorId:="{}"

# Batch operations
for tool in $(mcpc --json @server tools-list | jq -r '.[].name'); do
  mcpc --json @server tools-get "$tool" > "schemas/$tool.json"
done
```

For a complete example script, see [`docs/examples/company-lookup.sh`](./docs/examples/company-lookup.sh).

### Schema validation

Validate tool/prompt schemas using the `--schema` option to detect breaking changes early:

```bash
# Save expected schema
mcpc --json @apify tools-get search-actors > expected.json

# Validate before calling (fails if schema changed incompatibly)
mcpc @apify tools-call search-actors --schema expected.json keywords:="test"
```

Available schema validation modes (`--schema-mode`):
- `compatible` (default)
  - Input schema: new optional fields OK, required fields must have the same type.
  - Output schema: new fields OK, removed required fields cause error.
- `strict` - Both input and output schemas must match exactly, including all fields, types, and descriptions
- `ignore` - Skip validation completely (YOLO)

### AI sandboxes

To ensure AI coding agents don't perform destructive actions or leak credentials,
it's always a good idea to run them in a code sandbox with limited access to your resources.

The [proxy MCP server](#mcp-proxy) feature provides a security boundary for AI agents:

1. **Human creates authentication profile**: `mcpc mcp.apify.com login --profile ai-access`
2. **Human creates session**: `mcpc mcp.apify.com connect @ai-sandbox --profile ai-access --proxy 8080`
3. **AI runs inside a sandbox**: If sandbox has access limited to `localhost:8080`,
   it can only interact with the MCP server through the `@ai-sandbox` session,
   without access to the original OAuth credentials, HTTP headers, or `mcpc` configuration.

This ensures AI agents operate only with pre-authorized credentials, preventing unauthorized access to MCP servers.
The human controls which servers the AI can access and with what permissions (OAuth scopes).

**IMPORTANT:** Beware that MCP proxy will not make an insecure MCP server secure.
Local stdio servers will still have access to your local system, and HTTP servers to provided auth credentials,
and both can easily perform destructive actions or leak credentials on their own, or let MCP clients do such actions.
**Always use only trusted local and remote MCP servers and limit their access to the necessary minimum.**

### Agent skills

To help Claude Code use `mcpc`, you can install this [Claude skill](./docs/claude-skill/README.md):

<!-- TODO: Add also AGENTS.md, GitHub skills etc. -->

## MCP support

`mcpc` is built on the official [MCP SDK for TypeScript](https://github.com/modelcontextprotocol/typescript-sdk) and supports most [MCP protocol features](https://modelcontextprotocol.io/specification/latest).

### Transport

- **stdio**: Direct bidirectional JSON-RPC communication over
  stdio server from the [config file](#mcp-server-config-file).
- **Streamable HTTP**: Fully supported.
- **HTTP with SSE** (deprecated): Legacy mode, not supported.

### Authorization

- [Anonymous access](#anonymous-access)
- [HTTP header authorization](#bearer-token-authentication)
- [OAuth 2.1](#oauth-profiles)

### MCP session

The bridge process manages the full MCP session lifecycle:
- Performs initialization handshake (`initialize` → `initialized`)
- Negotiates protocol version and capabilities
- Fetches server-provided `instructions`
- Maintains persistent HTTP connections with bidirectional streaming, or stdio bidirectional pipe to subprocess
- Handles `MCP-Protocol-Version` and `MCP-Session-Id` headers automatically
- Handles multiple concurrent requests
- Recovers transparently from network disconnections and bridge process crashes

### MCP feature support

| **Feature**                                        | **Status**                         |
|:---------------------------------------------------|:-----------------------------------|
| 📖 [**Instructions**](#server-instructions)        | ✅ Supported                        |
| 🔧 [**Tools**](#tools)                             | ✅ Supported                        |
| 💬 [**Prompts**](#prompts)                         | ✅ Supported                        |
| 📦 [**Resources**](#resources)                     | ✅ Supported                        |
| 📝 [**Logging**](#server-logs)                     | ✅ Supported                        |
| 🔔 [**Notifications**](#list-change-notifications) | ✅ Supported                        |
| 📄 [**Pagination**](#pagination)                   | ✅ Supported                        |
| 🏓 [**Ping**](#ping)                               | ✅ Supported                        |
| ⏳ **Async tasks**                                  | 🚧 Planned                         |
| 📁 **Roots**                                       | 🚧 Planned                         |
| ❓ **Elicitation**                                  | 🚧 Planned                         |
| 🔤 **Completion**                                  | 🚧 Planned                         |
| 🤖 **Sampling**                                    | ❌ Not applicable (no LLM access)   |

#### Server instructions

MCP servers can provide instructions describing their capabilities and usage. These are displayed when you connect to a server or run the `help` command:

```bash
# Show server info, capabilities, and instructions (both commands behave the same)
mcpc @apify
mcpc @apify help

# JSON mode
mcpc @apify --json
```

In [JSON mode](#json-mode), the resulting object adheres
to [`InitializeResult`](https://modelcontextprotocol.io/specification/latest/schema#initializeresult) object schema,
and includes the `_mcpc` field with relevant server/session metadata.

```json
{
  "_mcpc": {
    "sessionName": "@apify",
    "profileName": "default",
    "server": {
      "url": "https://mcp.apify.com"
    },
    "notifications": {
      "tools": { "listChangedAt": "2026-01-01T00:42:58.049Z" }
    }
  },
  "protocolVersion": "2025-06-18",
  "capabilities": {
    "logging": {},
    "prompts": {},
    "resources": {},
    "tools": { "listChanged": true }
  },
  "serverInfo": {
    "name": "apify-mcp-server",
    "version": "1.0.0"
  },
  "instructions": "Apify is the largest marketplace of tools for web scraping..."
}
```

#### Tools

List, inspect, and call server-provided tools:

```bash
# List available tools
mcpc @apify tools-list

# Get tool schema details
mcpc @apify tools-get search-actors

# Call a tool with arguments
mcpc @apify tools-call search-actors keywords:="web scraper"

# Pass complex JSON arguments
mcpc @apify tools-call create-task '{"name": "my-task", "options": {"memory": 1024}}'

# Load arguments from stdin
cat data.json | mcpc @apify tools-call bulk-import
```

#### Prompts

List and retrieve server-defined prompt templates:

```bash
# List available prompts
mcpc @apify prompts-list

# Get a prompt with arguments
mcpc @apify prompts-get analyze-website url:=https://example.com
```

<!-- TODO: Add example of prompt templates -->

#### Resources

Access server-provided data sources by URI:

```bash
# List available resources
mcpc @apify resources-list

# Read a resource
mcpc @apify resources-read "file:///config.json"

# Subscribe to resource changes (in shell mode)
mcpc @apify resources-subscribe "https://api.example.com/data"

# List resource templates
mcpc @apify resources-templates-list
```

#### List change notifications

When connected via a [session](#sessions), `mcpc` automatically handles `list_changed`
notifications for tools, resources, and prompts.
The bridge process tracks when each notification type was last received.
In [shell mode](#interactive-shell), notifications are displayed in real-time.
The timestamps are available in JSON output of `mcpc <target> --json` under the `_mcpc.notifications`
field - see [Server instructions](#server-instructions).

#### Server logs

`mcpc` supports server logging settings (`logging/setLevel`) and log messages (`notifications/message`).
Log messages are printed to bridge log or stderr, subject to [verbosity level](#verbose-mode).

You can instruct MCP servers to adjust their [logging level](https://modelcontextprotocol.io/specification/latest/server/utilities/logging)
using the `logging-set-level` command:

```bash
# Set server log level to debug for detailed output
mcpc @apify logging-set-level debug

# Reduce server logging to only errors
mcpc @apify logging-set-level error
```

Note that this sets the logging level on the **server side**.
The actual log output depends on the server's implementation.

#### Pagination

MCP servers may return paginated results for list operations
(`tools-list`, `resources-list`, `prompts-list`, `resources-templates-list`).
`mcpc` handles this automatically and always fetches all available pages using the `nextCursor`
token - you always get the complete list without manual iteration. Keep it simple.

#### Ping

Sessions automatically send periodic pings to keep the [connection alive](#session-lifecycle) and detect failures early.
Send a ping to check if a server connection is alive:

```bash
# Ping a session and measure round-trip time
mcpc @apify ping
mcpc @apify ping --json
```

## Configuration

You can configure `mcpc` using a config file, environment variables, or command-line flags.

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
mcpc --config .vscode/mcp.json apify connect @my-apify
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

For **Streamable HTTP servers:**
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
mcpc --config .vscode/mcp.json filesystem tools-list

# Create a named session from server in config
mcpc --config .vscode/mcp.json filesystem connect @fs
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

### Saved state

`mcpc` saves its state to `~/.mcpc/` directory (unless overridden by `MCPC_HOME_DIR`), in the following files:

- `~/.mcpc/sessions.json` - Active sessions with references to authentication profiles (file-locked for concurrent access)
- `~/.mcpc/profiles.json` - Authentication profiles (OAuth metadata, scopes, expiry)
- `~/.mcpc/bridges/` - Unix domain socket files for each bridge process
- `~/.mcpc/logs/bridge-*.log` - Log files for each bridge process
- OS keychain - Sensitive credentials (OAuth tokens, bearer tokens, client secrets)

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

## Security

`mcpc` follows [MCP security best practices](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices).
MCP enables arbitrary tool execution and data access - treat servers like you treat shells:

- Use least-privilege tokens/headers
- Only use trusted servers!
- Audit tools before running them

### Credential protection

| What                   | How                                             |
|------------------------|-------------------------------------------------|
| **OAuth tokens**       | Stored in OS keychain, never on disk            |
| **HTTP headers**       | Stored in OS keychain per-session               |
| **Bridge credentials** | Passed via Unix socket IPC, kept in memory only |
| **Process arguments**  | No secrets visible in `ps aux`                  |
| **Config files**       | Contain only metadata, never tokens             |
| **File permissions**   | `0600` (user-only) for all config files         |

### Network security

- HTTPS enforced for remote servers (auto-upgraded from HTTP)
- OAuth callback binds to `127.0.0.1` only
- Credentials never logged, even in verbose mode

### AI security

See [AI sandboxes](#ai-sandboxes) for details.

## Errors

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

The background bridge processes log to `~/.mcpc/logs/bridge-@<session>.log`.
The main `mcpc` process doesn't save log files, but supports [verbose mode](#verbose-mode).
`mcpc` automatically rotates log files: keep last 10MB per session, max 5 files.

### Troubleshooting

**"Cannot connect to bridge"**
- Bridge may have crashed. Try: `mcpc @<session-name> tools-list` to restart the bridge
- Check bridge is running: `ps aux | grep -e 'mcpc-bridge' -e '[m]cpc/dist/bridge'`
- Check socket exists: `ls ~/.mcpc/bridges/`

**"Session not found"**
- List existing sessions: `mcpc`
- Create new session if expired: `mcpc @<session-name> close` and `mcpc <target> connect @<session-name>`

**"Authentication failed"**
- List saved OAuth profiles: `mcpc`
- Re-authenticate: `mcpc <server> login [--profile <name>]`
- For bearer tokens: provide `--header "Authorization: Bearer ${TOKEN}"` again


## Development

The initial version of `mcpc` was developed by [Jan Curn](https://x.com/jancurn) of [Apify](https://apify.com)
with the help of Claude Code, during late nights over Christmas 2025 in North Beach, San Francisco.

See [CONTRIBUTING](./CONTRIBUTING.md) for development setup, architecture overview, and contribution guidelines.

## License

Apache-2.0 - see [LICENSE](./LICENSE) for details.

