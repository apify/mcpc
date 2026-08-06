# mcpc — a universal MCP CLI client

![mcpc logo](https://apify.github.io/mcpc/client-logo.svg?v=3)

[![npm version](https://img.shields.io/npm/v/@apify/mcpc.svg)](https://www.npmjs.com/package/@apify/mcpc)
[![npm downloads](https://img.shields.io/npm/dm/@apify/mcpc.svg)](https://www.npmjs.com/package/@apify/mcpc)
[![CI](https://github.com/apify/mcpc/actions/workflows/ci.yml/badge.svg)](https://github.com/apify/mcpc/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/@apify/mcpc.svg)](https://github.com/apify/mcpc/blob/main/LICENSE)

`mcpc` is a command-line client for the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
that maps every MCP operation to an intuitive shell command.

Use it to manually inspect and debug MCP servers, to script repeatable MCP workflows in plain shell, or to
give AI agents the full MCP protocol through a single `Bash()` tool call, so they can interact with any MCP
server and its latest capabilities using the most universal programming interface there is: the UNIX shell.

**Key features:**

- 🔧 [**Full MCP support**](#mcp-support) - Tools, prompts, resources, async tasks, skills, notifications, and logging over stdio and Streamable HTTP.
- 🔄 **Persistent sessions** - Keep connections to multiple servers alive in parallel, whether the server protocol is stateful or stateless.
- 🗺️ **Progressive tool discovery** - Find relevant MCP tools on the fly to save tokens and increase accuracy.
- 🔌 **Code mode** - JSON output composes with `jq`, `xargs`, and shell pipelines for MCP workflows as shell scripts.
- 🔒 **Secure** - Full OAuth 2.1 support with CIMD and DCR, uses OS keychain for credentials storage.
- 🤖 **AI sandboxing** - Proxy MCP server connections to protect credentials from AI-generated code.
- 🪶 **Lightweight** - Minimal dependencies, works on Mac/Win/Linux, doesn't use LLMs on its own.
- 💸 **Agentic payments** - Experimental support for the [x402](https://www.x402.org/) protocol on [Base](https://www.base.org/).

![mcpc screenshot](https://raw.githubusercontent.com/apify/mcpc/main/docs/images/mcpc-demo.gif?v=3)

## Table of contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Motivation](#motivation)
- [Install](#install)
- [Quickstart](#quickstart)
- [Usage](#usage)
- [Sessions](#sessions)
- [Authentication](#authentication)
- [MCP proxy](#mcp-proxy)
- [AI agents](#ai-agents)
- [Agentic payments (x402)](#agentic-payments-x402)
- [MCP support](#mcp-support)
- [Configuration](#configuration)
- [Security](#security)
- [Errors](#errors)
- [Development](#development)
- [Related work](#related-work)
- [License](#license)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Motivation

Many AI agents misuse MCP. They treat tools as prompt-time function calls, repeatedly injecting
tool definitions and results into the context. Tokens get wasted, context rots, the
agent gets slower and less reliable — hence the popular conclusion: _"MCP sucks, CLIs are better"_.

`mcpc` challenges that narrative. It maps every MCP operation to an intuitive CLI command that
agents pick up from `--help` alone. Any agent with shell access gets full MCP support without
wiring up dozens of MCP functions. Just one `Bash()` tool, and `mcpc` handles the rest:

```

 ┌──────────┐   Bash()   ┌────────┐    MCP    ┌────────────┐
 │ AI agent │ ─────────► │  mcpc  │ ────────► │ MCP server │
 └──────────┘            └────────┘           └────────────┘
                                     Sessions, OAuth, Tools,
                                     Resources, Prompts,
                                     Tasks, x402, ...
```

CLI is the perfect _local_ interface between agents and MCP, while MCP remains the
standard _remote_ interface for server discovery, authentication, payments, and access control.
The two aren't exclusive – they're complementary.

As a bonus, the same `mcpc` configuration, OAuth profiles, and live sessions can be shared across
many AI agents on the same machine. Authenticate once, reuse everywhere.

## Install

With [Homebrew](https://brew.sh) (macOS and Linux), which brings its own Node.js:

```bash
brew install apify/tap/mcpc
```

Otherwise install the latest [Node.js](https://nodejs.org/en/download) or [Bun](https://bun.sh) first, then:

```bash
npm install -g @apify/mcpc

# Or with Bun
bun install -g @apify/mcpc
```

**Linux:** credentials use the OS keychain via the [Secret Service API](https://specifications.freedesktop.org/secret-service/).
GNOME/KDE desktops work out of the box. On headless/CI systems, `mcpc` falls back to a
file-based store (`~/.mcpc/credentials.json`, mode `0600`).

To force the keychain on headless systems, install `libsecret` + `gnome-keyring`
(via `apt-get`, `dnf`, or `pacman`) and run:

```bash
dbus-run-session -- bash -c "echo -n 'password' | gnome-keyring-daemon --unlock && mcpc ..."
```

## Quickstart

```bash
# List all active sessions and saved authentication profiles
mcpc

# Log in to a remote MCP server and save OAuth credentials for future use
mcpc login mcp.apify.com

# Create a persistent session and interact with it
mcpc connect mcp.apify.com @test
mcpc @test              # show server info and capabilities
mcpc @test tools-list   # list available tools
mcpc @test tools-call search-actors keywords:="website crawler"

# Use JSON mode for scripting
mcpc --json @test tools-list

# Use a local MCP server package (stdio) referenced from a config file
mcpc connect ./.vscode/mcp.json:filesystem @fs
mcpc @fs tools-list
```

## Usage

<!-- AUTO-GENERATED: mcpc --help -->

```
Usage: mcpc [<@session>] [<command>] [options]

Universal command-line client for the Model Context Protocol (MCP).

Commands:
  connect [<server>] [@session]  Connect to an MCP server and start a new named @session
  close <@session>               Close a session
  restart <@session>             Restart a session (losing all state)
  login <server>                 Log in to a server and save an OAuth profile
  logout <server>                Delete an OAuth profile for a server
  clean [resources...]           Clean up mcpc data (sessions, profiles, logs, all)
  grep <pattern>                 Search tools and instructions across all active sessions
  x402 [subcommand] [args...]    Configure an x402 payment wallet (EXPERIMENTAL)
  help [command] [subcommand]    Show help for a command

Options:
  --json                         Output in JSON format for scripting
  --verbose                      Enable debug logging
  --profile <name>               OAuth profile for the server ("default" if not provided)
  --timeout <seconds>            Request timeout in seconds (default: 60)
  --max-chars <n>                Truncate output to n characters (ignored in --json mode)
  --insecure                     Skip TLS certificate verification (for self-signed certs)
  -v, --version                  Output the version number
  -h, --help                     Display help

MCP session commands (after connecting):
  <@session>                     Show MCP server info, capabilities, and tools overview
  <@session> grep <pattern>      Search tools and instructions
  <@session> tools-list          List all server tools
  <@session> tools-get <name>    Get tool details and schema
  <@session> tools-call <name> [arg:=val ... | <json> | <stdin]
  <@session> tasks-list
  <@session> tasks-get <taskId>
  <@session> tasks-result <taskId>
  <@session> tasks-cancel <taskId>
  <@session> prompts-list
  <@session> prompts-get <name> [arg:=val ... | <json> | <stdin]
  <@session> resources-list
  <@session> resources-read <uri> [-o <file> | --raw]
  <@session> resources-subscribe <uri> <file>
  <@session> resources-unsubscribe <uri>
  <@session> resources-templates-list
  <@session> skills-list
  <@session> skills-get <name> [--raw]
  <@session> logging-set-level <level>
  <@session> ping
  <@session> server-discover
  <@session> logs [-n N] [--follow] [--since 1h]

Run "mcpc" without arguments to show active sessions and OAuth profiles.
Run "mcpc --json" to get the same data as `{ sessions: [...], profiles: [...] }`.

Agent guide: mcpc help --skill
```

For the full `--help` output of every command, see [REFERENCE.md](docs/REFERENCE.md)
(also available in your terminal via `mcpc help <command>`).

### General actions

With no arguments, `mcpc` lists all active sessions and saved OAuth profiles:

```bash
# List all sessions and OAuth profiles (also in JSON mode)
mcpc
mcpc --json

# Show command help or version
mcpc --help
mcpc --version

# Clean stale sessions and old log files
mcpc clean
```

### Server formats

The `connect`, `login`, and `logout` commands accept a `<server>` argument in these formats:

- **Remote URL** (e.g. `mcp.apify.com` or `https://mcp.apify.com`) — scheme defaults to `https://`
- **Config file entry** (e.g. `~/.vscode/mcp.json:filesystem`) — `file:entry-name` syntax

`connect` additionally supports two **bulk** forms that connect many servers at once:

- **Config file** without an entry (e.g. `~/.vscode/mcp.json`) — connect every server in the file
- **No argument** (`mcpc connect`) — auto-discover MCP config files in the current directory and
  your home dir (`.mcp.json`, `mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `~/.claude.json`,
  Claude Desktop, Windsurf, Kiro, …) and connect everything found (run `mcpc connect --help` for the
  full list).

```bash
mcpc connect                      # discover standard config files and connect all servers
mcpc connect ~/.vscode/mcp.json   # connect every server in one file
```

Bulk connects auto-generate session names (so they don't take an `@session`) and **skip local
stdio servers by default** — pass `--stdio` to include them. Each discovered config file is listed
with its servers and their status (`● live`, `✗ failed`); files that can't be used are shown as
`(0 servers)` or `(invalid)` with the reason, rather than silently ignored. The command waits for
every handshake to finish (with a progress spinner in human mode); `--json` reports each server's
details. If every server fails to connect, the command exits with a non-zero code.

### MCP commands

All MCP commands go through a named session created with `connect`:

```bash
# Connect to a remote server and create a session
mcpc connect mcp.apify.com @apify
mcpc @apify tools-list
mcpc @apify tools-call search-apify-docs query:="What are Actors?"

# Connect to a local server via config file entry
mcpc connect ~/.vscode/mcp.json:filesystem @fs
mcpc @fs tools-list
mcpc @fs tools-call list_directory path:=/
```

See [MCP feature support](#mcp-feature-support) for details about all supported MCP features and commands.

#### Command arguments

The `tools-call` and `prompts-get` commands accept arguments as positional parameters after the tool/prompt name:

```bash
# Key:=value pairs (auto-parsed: tries JSON, falls back to string)
mcpc @session tools-call <tool-name> greeting:="hello world" count:=10 enabled:=true
mcpc @session tools-call <tool-name> config:='{"key":"value"}' items:='[1,2,3]'

# Force string type with JSON quotes
mcpc @session tools-call <tool-name> id:='"123"' flag:='"true"'

# Inline JSON object (if first arg starts with { or [)
mcpc @session tools-call <tool-name> '{"greeting":"hello world","count":10}'

# Read from stdin (automatic when no positional args and input is piped)
echo '{"greeting":"hello","count":10}' | mcpc @session tools-call <tool-name>
cat args.json | mcpc @session tools-call <tool-name>
```

**Auto-parsing rules** for `key:=value`: valid JSON keeps its type
(`count:=10` → number, `enabled:=true` → boolean, `cfg:='{"k":"v"}'` → object); anything
else is a string (`greeting:=hello` → `"hello"`). Force a string literal with JSON quotes:
`id:='"123"'`. Inline JSON is detected when the first arg starts with `{` or `[`. Stdin is
read when no positional args are given and input is piped.

**Pitfalls:** no spaces around `:=` (use `query:=hello world`, not `query := ...`); quote
the whole argument when it contains shell expansions (`"query:=${VAR}"`). For complex
inputs, prefer piping JSON via stdin.

### Grep (search across sessions)

`mcpc grep` searches tools, resources, and prompts across all active sessions or within a single session:

```bash
# Search tools and server instructions in all active sessions
mcpc grep "search"

# Search within a single session
mcpc @apify grep "actor"

# Search resources and prompts instead of the default tools and instructions
mcpc grep "config" --resources --prompts

# Regex search
mcpc grep "search|find" -E

# Case-sensitive search (default is case-insensitive)
mcpc grep "Search" --case-sensitive

# Limit results
mcpc grep "e" -m 5

# JSON output for scripting
mcpc grep "actor" --json
```

By default, `grep` searches tools and server instructions. Use `--resources` or `--prompts` to
search those types instead (combine with `--tools` or `--instructions` to mix and match). Sessions
that are crashed or unavailable are shown with their status rather than silently skipped. Like
`grep(1)`, the command exits with code 0 when there are matches and 1 when there are none.

The `grep` command is useful for **dynamic tool discovery**,
also called [Tool search tool](https://www.anthropic.com/engineering/advanced-tool-use) by Anthropic
or [Dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery) by Cursor.
Rather than loading all tools into the AI agent's context, the agent can use `grep` to discover the right tool
for the job, and only load the relevant tools into the context when needed to reduce token usage and improve accuracy.

<!-- TODO: explain this more, show diagram -->

### JSON mode

By default, `mcpc` prints output in Markdown-ish text format with colors, making it easy for both humans and AIs to read.

With `--json` option, `mcpc` always emits only a single JSON object (or array), to enable [scripting](#scripting).
**For all MCP commands, the returned objects are always consistent with the
[MCP specification](https://modelcontextprotocol.io/specification/latest).**
On success, the JSON object is printed to stdout, on error to stderr.

Note that `--json` is not available for `mcpc --help`. For `login`, `--json` prints a single
`{ profile, serverUrl, scopes }` object on stdout (interactive prompts go to stderr).

## Sessions

Up to protocol version `2025-11-25`, MCP was a [stateful protocol](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle):
clients and servers negotiate protocol version and capabilities in an `initialize` handshake,
and then communicate within a persistent session. Protocol version `2026-07-28` made MCP
stateless — there is no handshake or server-side session anymore, and every request stands on its own.

`mcpc` keeps one session-based workflow on top of both: you first `connect` a named session,
then interact with the server through it. On stateful servers the session maps directly to the
protocol-level MCP session. On stateless (`2026-07-28`) servers the session abstracts the
protocol away — a lightweight **bridge process** still holds the connection, the negotiated
protocol version, and client-side state, so everything built on "connect first, then interact"
keeps working the same: cached tool listings, [searching across sessions](#grep-search-across-sessions)
with `grep`, server keepalive and status checks by [periodic probing](#ping), change
notifications, resource-to-file syncs, and automatic OAuth token refresh. It is also more
efficient than forcing every MCP command to rediscover the server and reauthenticate.

The protocol version is negotiated automatically (`mcpc @session` shows the result). To pin
one exact version instead, pass `--protocol-version` to `connect` (e.g.
`mcpc connect mcp.apify.com --protocol-version 2025-11-25`) — the connection then fails if the
server does not support that version. Config file entries can set the same via a
`protocolVersion` field.

Sessions are given names prefixed with `@` (e.g. `@apify`),
which then serve as unique references in commands.

```bash
# Create a persistent session
mcpc connect mcp.apify.com @apify

# List all sessions and OAuth profiles
mcpc

# Run MCP commands in the session
mcpc @apify tools-list

# Restart the session (kills and restarts the bridge process)
mcpc @apify restart    # or: mcpc restart @apify

# Close the session (terminates the bridge process)
mcpc @apify close      # or: mcpc close @apify

# ...now the session name "@apify" is forgotten and available for future use
```

### Session lifecycle

Session metadata is saved in `~/.mcpc/sessions.json`, [authentication tokens](#authentication)
in the OS keychain. The bridge process keeps the session alive with periodic [pings](#ping)
(`server/discover` probes on `2026-07-28` servers) and auto-reconnects on network failures
or its own crashes (10s cooldown on failed retries).

**Session states:**

| State            | Meaning                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| 🟢`live`         | Bridge process running and server responding                                                    |
| 🟡`connecting`   | Initial bridge startup in progress (`mcpc connect`)                                             |
| 🟡`reconnecting` | Bridge crashed or lost auth; auto-reconnecting in the background                                |
| 🟡`disconnected` | Bridge process running but server unreachable; auto-recovers when server responds               |
| 🟡`crashed`      | Bridge process crashed or was killed; auto-reconnects in the background                         |
| 🔴`unauthorized` | Server rejected authentication (401/403) or token refresh failed; re-run `login` then `restart` |
| 🔴`expired`      | Server rejected session ID (404, stateful servers only); requires `restart`                     |

`mcpc` never removes sessions automatically — failed ones stay flagged with a recovery hint
in the error message. Use `mcpc @apify restart` to kill the bridge and open a fresh connection
(with a fresh `MCP-Session-Id` on stateful servers), or `mcpc @apify close` to remove the
session entirely.
You can also remove dead sessions by running `mcpc clean`,
and all sessions by running `mcpc clean all` (see [Cleanup](#cleanup)).

## Authentication

`mcpc` supports all standard [MCP authorization methods](https://modelcontextprotocol.io/specification/latest/basic/authorization).

### Anonymous access

For local servers (stdio) or remote servers (Streamable HTTP) which do not require credentials,
`mcpc` can be used without authentication:

```bash
mcpc connect mcp.apify.com @test
mcpc @test tools-list
```

### Bearer token authentication

For remote servers that require a Bearer token (but not OAuth), use the `--header` flag to pass the token.
All headers are stored securely in the OS keychain for the session, but they are **not** saved as reusable
[OAuth profiles](#oauth-profiles). This means `--header` must be provided again
whenever you connect a new session.

```bash
# Create a session with a Bearer token (token saved to keychain for this session only)
mcpc connect https://mcp.apify.com @apify --header "Authorization: Bearer ${APIFY_TOKEN}"

# Use the session (Bearer token is loaded from keychain automatically)
mcpc @apify tools-list
```

### OAuth profiles

For OAuth-enabled remote MCP servers, `mcpc` implements the full OAuth 2.1 flow with PKCE as
mandated by the [MCP authorization spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization):
`WWW-Authenticate` 401 challenges, Protected Resource Metadata and authorization server metadata
discovery, all three [client registration approaches](#client-registration-approaches),
[resource indicators (RFC 8707)](https://www.rfc-editor.org/rfc/rfc8707), and automatic
refresh-token rotation.

The OAuth authentication **always** needs to be initiated by the user calling the `login` command,
which opens a web browser with a login screen. `mcpc` never opens the web browser on its own.

The OAuth credentials for specific servers are securely stored as **authentication profiles** - reusable
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
mcpc login mcp.apify.com

# Use named authentication profile instead of 'default'
mcpc login mcp.apify.com --profile work

# Create two sessions using the two different credentials
mcpc connect mcp.apify.com @apify-personal
mcpc connect mcp.apify.com @apify-work --profile work

# Both sessions now work independently
mcpc @apify-personal tools-list  # Uses personal account
mcpc @apify-work tools-list      # Uses work account

# Re-authenticate existing profile (e.g., to refresh or change scopes)
mcpc login mcp.apify.com --profile work

# Delete "default" and "work" authentication profiles
mcpc logout mcp.apify.com
mcpc logout mcp.apify.com --profile work
```

### Client registration approaches

When logging in, `mcpc` supports all three OAuth client registration approaches defined in the
[MCP authorization spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#client-registration-approaches),
picking the one the authorization server advertises in its OAuth metadata:

| **Approach**                            | **`mcpc login` flags**                              |
| :-------------------------------------- | :-------------------------------------------------- |
| **Pre-registration**                    | `--client-id` (and optional `--client-secret`)      |
| **Client ID Metadata Documents (CIMD)** | default (or `--client-metadata-url <url>`)          |
| **Dynamic Client Registration (DCR)**   | fallback (or force with `--no-client-metadata-url`) |

`mcpc` ships with a hosted [Client ID Metadata Document](https://apify.github.io/mcpc/client-metadata.json)
so every installation presents the same client identity to CIMD-capable authorization servers.
When the authorization server advertises `client_id_metadata_document_supported: true`, the CIMD
URL is used as the `client_id`; otherwise mcpc falls back to Dynamic Client Registration.

```bash
# Default: mcpc's hosted CIMD is used automatically (no flags needed).
mcpc login mcp.apify.com

# Pre-registered OAuth client (public or confidential) — skips CIMD.
mcpc login mcp.example.com --client-id <id> [--client-secret <secret>]

# Pre-registered client whose redirect URI was registered with localhost
# instead of 127.0.0.1 (e.g. http://localhost:3118/callback).
mcpc login mcp.example.com --client-id <id> --callback-host localhost --callback-port 3118

# Custom CIMD: override the default with your own hosted document.
mcpc login mcp.example.com --client-metadata-url https://example.com/my-client.json

# Disable CIMD: force Dynamic Client Registration even if the server supports CIMD.
mcpc login mcp.example.com --no-client-metadata-url
```

See the [MCP authorization spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#client-registration-approaches)
for details on each approach and the format of Client ID Metadata Documents.

### Authentication precedence

When connecting, `mcpc` picks one auth source based on the flags you pass — explicit flags
always win over stored profiles, and credentials are never silently downgraded. If a profile
is missing, expired, or invalid, `mcpc` fails with an error that includes the right
`mcpc login` command to recover.

| Flag                            | Behavior                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--header "Authorization: ..."` | Use explicit header; skip OAuth auto-detection. Cannot combine with `--profile`.                                                                |
| `--profile <name>`              | Require the named profile to exist.                                                                                                             |
| `--no-profile`                  | Connect anonymously even if a `default` profile exists.                                                                                         |
| `--x402 [scheme]`               | Skip OAuth auto-detection; use x402 payments instead. Optional scheme: `auto` (default), `upto`, `exact`. Combine with `--profile` to use both. |
| _(none)_                        | Use `default` profile if it exists; otherwise connect anonymously.                                                                              |

Config file headers (from `--config`) apply to servers loaded from that file.

```bash
# Default: 'default' profile if it exists, else anonymous
mcpc connect mcp.apify.com @apify-personal

# Specific profile (fails if missing)
mcpc connect mcp.apify.com @apify-work --profile work

# Explicit bearer token (no profile)
mcpc connect mcp.apify.com @apify --header "Authorization: Bearer ${APIFY_TOKEN}"

# Skip default profile, connect anonymously
mcpc connect mcp.apify.com @apify-anon --no-profile

# x402 micropayments instead of OAuth
mcpc connect mcp.apify.com @apify --x402
```

## MCP proxy

For stronger isolation, `mcpc` can expose an MCP session as a new local proxy MCP server using the `--proxy` option.
The proxy forwards all MCP requests to the upstream server but **never exposes the original authentication tokens** to the client.
This is useful when you want to give someone or something MCP access without revealing your credentials.
The proxy itself serves protocol `2025-11-25` to its clients, regardless of the protocol
version negotiated with the upstream server. See also [AI sandboxes](#ai-sandboxes).

```bash
# Human authenticates to a remote server
mcpc login mcp.apify.com

# Create authenticated session with proxy server on localhost:8080
mcpc connect mcp.apify.com @open-relay --proxy 8080

# Now any MCP client can connect to proxy like to a regular MCP server
# The client has NO access to the original OAuth tokens or HTTP headers
# Note: localhost/127.0.0.1 URLs default to http:// (no scheme needed)
mcpc connect localhost:8080 @sandboxed
mcpc @sandboxed tools-call search-actors keywords:="web scraper"

# Optionally protect the proxy with a bearer token (stored in the OS keychain)
mcpc connect mcp.apify.com @secure-relay --proxy 8081 --proxy-bearer-token secret123
# To use the proxy, the caller needs to pass the bearer token in the Authorization header
mcpc connect localhost:8081 @sandboxed2 --header "Authorization: Bearer secret123"
```

**Proxy options for `connect` command:**

| Option                         | Description                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------ |
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
mcpc connect mcp.apify.com @relay --proxy 8080

# Bind to all interfaces (allows network access - use with caution!)
mcpc connect mcp.apify.com @relay --proxy 0.0.0.0:8080

# Bind to specific interface
mcpc connect mcp.apify.com @relay --proxy 192.168.1.100:8080
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
but the CLI gives you more flexibility and longer operation timeouts.

```bash
# Discover available tools
mcpc @server tools-list

# Get tool schema
mcpc @server tools-get search

# Call a tool
mcpc @server tools-call search query:="hello world"
```

**Code mode** - Once agents understand the server's capabilities, they can write shell
scripts that compose multiple `mcpc` commands with `--json` output — see
[Scripting](#scripting) below. This can be
[more accurate](https://www.anthropic.com/engineering/code-execution-with-mcp) and use
fewer tokens than tool calling for complex workflows. Pair with
[schema validation](#schema-validation) to catch breaking changes early.

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

The `tools-get` and `tools-call` commands support `--schema` to validate a tool's schema against an expected snapshot. This helps detect breaking changes early in scripts and CI:

```bash
# Save expected schema
mcpc --json @apify tools-get search-actors > expected.json

# Validate without calling (read-only check)
mcpc @apify tools-get search-actors --schema expected.json

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

1. **Human creates authentication profile**: `mcpc login mcp.apify.com --profile ai-access`
2. **Human creates session**: `mcpc connect mcp.apify.com @ai-sandbox --profile ai-access --proxy 8080`
3. **AI runs inside a sandbox**: If the sandbox's access is limited to `localhost:8080`,
   it can only interact with the MCP server through the `@ai-sandbox` session,
   without access to the original OAuth credentials, HTTP headers, or `mcpc` configuration.

This ensures AI agents operate only with pre-authorized credentials, preventing unauthorized access to MCP servers.
The human controls which servers the AI can access and with what permissions (OAuth scopes).

**IMPORTANT:** Beware that MCP proxy will not make an insecure MCP server secure.
Local stdio servers will still have access to your local system, and HTTP servers to provided auth credentials,
and both can easily perform destructive actions or leak credentials on their own, or let MCP clients do such actions.
**Always use only trusted local and remote MCP servers and limit their access to the necessary minimum.**

### Agent skills

`mcpc` ships a built-in agent skill that always matches the installed version:

```bash
mcpc help --skill
```

No setup is needed: `mcpc help` mentions `mcpc help --skill`, so an agent can discover and load
the guide on its own when it needs it.

If you'd rather have the skill installed persistently (e.g. for Claude Code or any agent that
loads `SKILL.md` files), `mcpc help --skill` prints a valid `SKILL.md` — just redirect it into
your skills directory:

```bash
mkdir -p ~/.claude/skills/mcpc
mcpc help --skill > ~/.claude/skills/mcpc/SKILL.md
```

That copy is a snapshot; re-run it after upgrading mcpc to refresh it.

Separately, `mcpc` also acts as a **client for skills served by MCP servers** (experimental,
SEP-2640) — see [Skills](#skills) for the `skills-list` / `skills-get` commands.

## Agentic payments (x402)

> ⚠️ **Experimental.** This feature is under active development and may change.

`mcpc` has experimental support for the [x402 payment protocol](https://www.x402.org/),
which enables AI agents to autonomously pay for MCP tool calls using cryptocurrency.
When an MCP server charges for a tool call (HTTP 402), `mcpc` automatically signs a USDC payment
on the [Base](https://base.org/) blockchain and retries the request — no human intervention needed.

This is entirely **opt-in**: existing functionality is unaffected unless you explicitly pass the `--x402` flag.

### How it works

Two schemes are supported, both signed by your local wallet:

- **`exact`** — EIP-3009 `TransferWithAuthorization`. Settles on-chain at call-time.
- **`upto`** — Permit2 `PermitWitnessTransferFrom`. You sign a max cap; the facilitator settles accumulated usage later. First use auto-grants a one-time `USDC.approve(PERMIT2, MAX_UINT256)` (needs a tiny native ETH float for gas).

Flow: server returns HTTP 402 with a `PAYMENT-REQUIRED` header → `mcpc` picks the best scheme per your preference, signs, and retries with `PAYMENT-SIGNATURE` → server verifies and fulfills. Tools that advertise pricing in `_meta.x402` are signed proactively, skipping the 402 round-trip.

### Wallet setup

`mcpc` stores a single wallet in `~/.mcpc/wallets.json` (file permissions `0600`).
You need to create or import a wallet before using x402 payments.

```bash
# Create a new wallet (generates a random private key)
mcpc x402 init

# Or import an existing wallet from a private key
mcpc x402 import <private-key>

# Show wallet address, balances, and a funding QR code
mcpc x402

# Remove the wallet
mcpc x402 remove
```

After creating a wallet, **fund it with USDC on Base** (mainnet or Sepolia testnet) to enable payments.

### Manual payment signing

You can manually sign a payment from a server's `PAYMENT-REQUIRED` header using `x402 sign`.
This is useful for pre-signing payments or integrating with tools outside of `mcpc`.

```bash
# Sign a payment using the base64-encoded PAYMENT-REQUIRED header
mcpc x402 sign <base64-payment-required>

# Override the amount (in USD, e.g. 2.50 = $2.50)
mcpc x402 sign <base64-payment-required> --amount 2.50

# Override the expiry (in seconds from now)
mcpc x402 sign <base64-payment-required> --expiry 7200

# Combine overrides and use JSON output
mcpc x402 sign <base64-payment-required> --amount 1.00 --expiry 3600 --json
```

**Options:**

| Option               | Description                                                             |
| -------------------- | ----------------------------------------------------------------------- |
| `--amount <usd>`     | Override the payment amount in USD (e.g. `0.50` for $0.50)              |
| `--expiry <seconds>` | Override the payment expiry in seconds from now (e.g. `3600`)           |
| `--scheme <val>`     | Scheme preference: `auto` (default, upto > exact), `upto`, or `exact`   |
| `--no-approve`       | For `upto`, skip checking and auto-approving on-chain Permit2 allowance |

The command outputs the signed `PAYMENT-SIGNATURE` header value and an MCP config snippet
that can be used directly with other MCP clients.

### Using x402 with MCP servers

Pass the `--x402` flag when connecting to a session. It accepts an optional scheme preference
(`auto`, `upto`, or `exact`); bare `--x402` defaults to `auto`.

```bash
# Create a session with x402 payment support (auto picks the best advertised scheme)
mcpc connect mcp.apify.com @apify --x402

# Pin a specific scheme — position doesn't matter, before or after positional args
mcpc connect --x402 upto mcp.apify.com @apify
mcpc connect mcp.apify.com @apify --x402 exact

# The session now automatically handles 402 responses using your preference
mcpc @apify tools-call expensive-tool query:="hello"

# Restart re-uses the saved scheme from sessions.json — no need to repeat the flag
mcpc @apify restart
```

When `--x402` is active, a fetch middleware wraps all HTTP requests to the MCP server.
If any request returns HTTP 402, the middleware transparently signs and retries. Your scheme preference is persisted in `sessions.json` and reused on every reconnect or restart.

### Supported networks

| Network              | Status       |
| -------------------- | ------------ |
| Base Mainnet         | ✅ Supported |
| Base Sepolia testnet | ✅ Supported |

## MCP support

`mcpc` aims to be the most complete MCP client on the command line. It's built on the official
[MCP SDK for TypeScript](https://github.com/modelcontextprotocol/typescript-sdk) and supports all the
major client-facing features of the [MCP specification](https://modelcontextprotocol.io/specification/latest),
from tools, resources, and prompts to the newest additions like async tasks and skills. Each is exposed as
a first-class command with consistent human-readable and `--json` output.

### MCP feature support

Where `mcpc` stands on each part of the MCP specification:

| **Feature**                                          | **Status**                                                       |
|:-----------------------------------------------------|:-----------------------------------------------------------------|
| 📜 **Protocol version**                              | ✅ 2026-07-28 (auto-negotiated), falls back to 2025-11-25 or older |
| 🔌 **Transport**                                     | ✅ stdio and Streamable HTTP                                      |
| 🔑 [**Authorization**](#authentication)              | ✅ Bearer + OAuth 2.1 (client credentials, DCR, CIMD, auth code)  |
| 🔄 [**Sessions**](#sessions)                         | ✅ Supported (with automatic keepalive)                           |
| 📖 [**Server instructions**](#server-instructions)   | ✅ Supported                                                      |
| 🔧 [**Tools**](#tools)                               | ✅ Supported (incl. list changed notifications)                   |
| ⏳ [**Async tasks**](#async-tasks)                   | ✅ Supported (2025-11-25 servers; 2026-07-28 tasks extension planned) |
| 💬 [**Prompts**](#prompts)                           | ✅ Supported (incl. list changed notifications)                   |
| 📦 [**Resources**](#resources)                       | ✅ Supported (incl. subscriptions and list changed notifications) |
| 🧠 [**Skills**](#skills)                             | 🧪 Experimental (SEP-2640)                                       |
| 📝 [**Logging**](#server-logs)                       | ⚠️ Deprecated (removed by MCP 2026-07-28)                         |
| 🔔 [**Notifications**](#list-change-notifications)   | ✅ Supported                                                      |
| 📄 [**Pagination**](#pagination)                     | ✅ Supported                                                      |
| 🏓 [**Ping**](#ping)                                 | ✅ Supported                                                      |
| 🔍 [**Server discovery**](#server-discovery)          | ✅ Supported (`server/discover`, 2026-07-28 servers)               |
| 📁 **Roots**                                         | ❌ Not planned (deprecated by MCP)                                |
| ❓ **Elicitation**                                   | 🚧 Planned                                                       |
| 🔤 **Completion**                                    | 🚧 Planned                                                       |
| 🤖 **Sampling**                                      | ❌ Not applicable (no LLM access)                                 |

Beyond the interactive browser login, the **Authorization** row above also covers the OAuth
**client-credentials** grant (the [`io.modelcontextprotocol/oauth-client-credentials`](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials)
extension) for non-interactive, machine-to-machine use such as CI/CD and daemons — no browser:
`mcpc login <server> --grant client-credentials --client-id <id> --client-secret <secret>`
(or a private-key JWT assertion via `--client-key`, RFC 7523). Access tokens are fetched and
refreshed automatically; pin a non-discoverable token endpoint with `--token-endpoint <url>`.

It also covers **enterprise-managed authorization** (the
[`io.modelcontextprotocol/enterprise-managed-authorization`](https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization)
extension, SEP-990) for organizations that control MCP server access centrally through their
identity provider (e.g. Okta). You sign in once with corporate SSO, and mcpc then obtains MCP
server tokens via identity assertion grants (ID-JAG) — no per-server consent screens:

```bash
mcpc login mcp.example.com --grant id-jag \
  --idp https://acme.okta.com --idp-client-id <idp-client> \
  --client-id <mcp-as-client> --client-secret <secret>
```

Both clients are pre-registered by your IT team: `--idp-client-id` at the enterprise IdP
(add `--idp-client-secret` for confidential clients), `--client-id`/`--client-secret` at the
MCP server's authorization server. The SSO session is kept alive with the IdP's refresh token;
when it expires, affected sessions turn `unauthorized` with a re-login hint.

#### Server instructions

MCP servers can provide instructions describing their capabilities and usage. These are displayed when you connect to a server or show its session overview:

```bash
# Show server info, capabilities, and instructions
mcpc @apify

# JSON mode
mcpc @apify --json
```

In [JSON mode](#json-mode), the resulting object adheres to the schema of the server's
handshake result — [`InitializeResult`](https://modelcontextprotocol.io/specification/2025-11-25/schema#initializeresult)
on `2025-11-25` connections, [`DiscoverResult`](https://modelcontextprotocol.io/specification/2026-07-28/schema#discoverresult)
on `2026-07-28` ones — and includes the `_mcpc` field with relevant server/session metadata.
`protocolVersion` is always the version actually in use, while `supportedVersions` (every
version the server offers) and `_meta` come from `server/discover` and are therefore absent
on `2025-11-25` connections.

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
  "protocolVersion": "2026-07-28",
  "supportedVersions": ["2026-07-28", "2025-11-25"],
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
  "instructions": "Apify is the largest marketplace of tools for web scraping...",
  "_meta": {
    "io.modelcontextprotocol/serverInfo": {
      "name": "apify-mcp-server",
      "version": "1.0.0"
    }
  }
}
```

#### Tools

Tools are the heart of MCP, and `mcpc` gives you the whole toolbox to discover, inspect, validate, and call them:

```bash
# List tools (compact view): names, one-line descriptions, and safety/task hints
mcpc @apify tools-list

# List tools with full input/output schemas and descriptions
mcpc @apify tools-list --full

# Inspect a single tool's schema, annotations, and a ready-to-run example
mcpc @apify tools-get search-actors

# Call a tool with arguments
mcpc @apify tools-call search-actors keywords:="web scraper"

# Pass complex JSON arguments
mcpc @apify tools-call create-task '{"name": "my-task", "options": {"memory": 1024}}'

# Load arguments from stdin
cat data.json | mcpc @apify tools-call bulk-import
```

The compact `tools-list` is built for **[progressive tool discovery](#grep-search-across-sessions)**:
instead of loading every tool's full schema into an agent's context up front, list just names and
summaries, use `mcpc grep` to find the right tool for the task, and pull its full schema with
`tools-get` only when you need it. Fewer tokens, less context rot, better accuracy. And listings never
go stale: the [session](#sessions) bridge handles `tools/list_changed`
[notifications](#list-change-notifications) and refreshes its cache automatically, so you always see the
server's current tools.

`mcpc` surfaces everything modern MCP tools can express:

- **Safety annotations**: `read-only`, `destructive`, `idempotent`, and `open-world` hints are shown
  right next to each tool, so a human or an agent can tell a harmless query from a dangerous mutation
  before calling it.
- **Structured output**: `structuredContent` is pretty-printed as JSON and output schemas are shown
  with `--full`, so scripts can rely on machine-readable results, not just text.
- **Rich result content**: text, images, audio, and [resource links or embedded resources](#resources)
  in tool results are all rendered (binary is summarized, never dumped to your terminal).
- **Async tasks**: long-running tools can run in the background as [async tasks](#async-tasks); each
  tool's task support is flagged as `[task:optional]`, `[task:required]`, or `[task:forbidden]`.
- **Schema validation**: pin a tool's schema with `--schema` to catch breaking changes in CI and
  scripts before they bite (see [Schema validation](#schema-validation)).

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

# Read a resource (pretty view; binary content is summarized, never dumped)
mcpc @apify resources-read "file:///config.json"

# Print just the content for piping
mcpc @apify resources-read "file:///config.json" --raw | jq .

# Save a resource to a local file (binary-safe, decodes base64 blobs)
mcpc @apify resources-read "file:///logo.png" -o logo.png

# List resource templates
mcpc @apify resources-templates-list
```

Subscriptions keep a local file in sync with a server resource. On subscribe, mcpc downloads
the resource to the file; afterwards the session bridge rewrites the file whenever the server
sends a `notifications/resources/updated` notification for the URI (the bridge re-reads the
resource, as the notification carries no content). Requires the server capability
`resources.subscribe`; subscriptions are re-established automatically when the session
reconnects or restarts, and are listed in `mcpc @session` output. On the wire, mcpc uses
`resources/subscribe` on `2025-11-25` servers and a `subscriptions/listen` stream on
`2026-07-28` servers (re-opened automatically if it drops) — the commands are identical.

```bash
# Keep ./config.json in sync with the server resource
mcpc @apify resources-subscribe "file:///config.json" ./config.json

# Stop syncing — the local file is kept as-is
mcpc @apify resources-unsubscribe "file:///config.json"
```

#### Skills

> 🧪 **Experimental.** Implements the draft [MCP skills extension (SEP-2640)](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640).
> The spec is in active iteration; the index shape, recognized entry types, and capability key may change.

[Agent Skills](https://agentskills.io/) are reusable markdown workflow instructions (`SKILL.md` with YAML frontmatter)
that AI agents load on demand. `mcpc` lets you discover and pull skills served by any MCP server that exposes
them under the `skill://` URI convention — no SDK changes required, since skills are just resources:

```bash
# List skills exposed by the server (tries skill://index.json, falls back to scanning skill://*/SKILL.md)
mcpc @apify skills-list

# Read a skill's SKILL.md by bare name, nested path, or full URI
mcpc @apify skills-get git-workflow
mcpc @apify skills-get acme/billing/refunds
mcpc @apify skills-get skill://git-workflow/SKILL.md

# Print just the markdown (no header/fences) — pipe straight to an LLM or a file
mcpc @apify skills-get git-workflow --raw > /tmp/skill.md

# JSON for scripts: [{ name, description, type, url }]
mcpc --json @apify skills-list | jq '.[].name'
```

Recognized index entry types (per SEP-2640): `skill-md` (concrete skill), `mcp-resource-template`
(parameterized namespace), and `archive` (`.tar.gz`/`.zip` bundle — fetch the URL via `resources-read`).
Entries with an unrecognized `type` are silently skipped.

Skills appear under capabilities in `mcpc @session` output when a server advertises the extension
under either `capabilities.extensions["io.modelcontextprotocol/skills"]` (per spec) or
`capabilities.experimental["io.modelcontextprotocol/skills"]` (the SDK-preserved escape hatch some
SDKs still use). Skill content is treated as untrusted input — `mcpc` only reads and prints it; it
never executes hooks, scripts, or other frontmatter-declared behavior.

#### List change notifications

When connected via a [session](#sessions), `mcpc` automatically handles `list_changed`
notifications for tools, resources, and prompts. On `2025-11-25` servers these arrive as
unsolicited notifications; on `2026-07-28` servers (where unsolicited notifications no
longer exist) the session bridge opts in by opening a `subscriptions/listen` stream at
connect and re-opens it automatically if it drops — the behavior is identical from the
outside. As a safety net on `2026-07-28` connections, the bridge's tools cache also
expires after 60 seconds, so a missed notification can never leave `tools-list` or
[`grep`](#grep-search-across-sessions) stale for long.
The bridge process tracks when each notification type was last received.
The timestamps are available in the JSON output of `mcpc @session --json` under the `_mcpc.notifications`
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

> ⚠️ **Deprecated.** MCP `2026-07-28` removed `logging/setLevel`, so `logging-set-level` works
> only on servers using protocol `2025-11-25` or older and will be removed in a future mcpc
> release. Server log messages (`notifications/message`) are still recorded in the bridge log.

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

Protocol version `2026-07-28` removed the `ping` request, so on servers using it `mcpc`
sends a `server/discover` probe instead — same round trip, same liveness signal, and the
command works identically on both protocol versions. The human-readable output says so,
so a `server/discover` entry in the server's access log is not a surprise.

#### Server discovery

On `2026-07-28` connections you can also send that request yourself and see what the server
answers right now — every protocol version it supports, its capabilities, its instructions,
and its `_meta`:

```bash
mcpc @apify server-discover
mcpc @apify server-discover --json    # DiscoverResult, verbatim
```

Unlike [`mcpc @apify`](#server-instructions), which reports what the connection settled on
when it was created, this is a live request. Protocol `2026-07-28` introduced
`server/discover`, so the command fails on `2025-11-25` (and older) connections, where the
`initialize` handshake carries the same information — run `mcpc @apify` there instead.

#### Async tasks

MCP servers can execute tools as [async tasks](https://modelcontextprotocol.io/specification/latest/basic/utilities/tasks)
that run in the background and report progress. `mcpc` supports the full task lifecycle:

```bash
# Call a tool as a task (waits for completion, shows progress spinner)
mcpc @apify tools-call long-running-job input:="data" --task

# Start a task and return immediately with the task ID
mcpc @apify tools-call long-running-job input:="data" --detach

# List active tasks
mcpc @apify tasks-list

# Check task status
mcpc @apify tasks-get <taskId>

# Get the task result (blocks until the task reaches a terminal state)
mcpc @apify tasks-result <taskId>

# Cancel a running task
mcpc @apify tasks-cancel <taskId>
```

With `--task`, the CLI shows a progress spinner with elapsed time, server status messages,
and progress notifications. Press **ESC** during execution to detach and get the task ID
for later retrieval. With `--detach`, the task starts and returns the task ID immediately.
Use `tasks-result <taskId>` to fetch the final `CallToolResult` payload once the task
completes.

`tools-list` and `tools-get` show task support annotations per tool:
`[task:optional]`, `[task:required]`, or `[task:forbidden]`.

Task commands require a server that advertises the tasks capability and uses protocol
`2025-11-25`. In `2026-07-28` tasks moved to the `io.modelcontextprotocol/tasks` extension,
which `mcpc` does not support yet. When either is missing, `--task`/`--detach` and the
`tasks-*` commands fail with an error explaining which of the two it is — they never fall
back to a plain synchronous call, because the flags change the shape of the output and
`--detach` callers would be left parsing a task ID that is not there.

## Configuration

You can configure `mcpc` using a config file, environment variables, or command-line flags.

**Precedence** (highest to lowest):

1. Command-line flags (including `--config` option)
2. Environment variables
3. Built-in defaults

### MCP server config file

`mcpc` supports the ["standard"](https://gofastmcp.com/integrations/mcp-json-configuration)
MCP server JSON config file, compatible with Claude Desktop, VS Code, and other MCP clients.
Use the `file:entry` syntax to reference a server from a config file:

```bash
# Open a session to a server specified in the Visual Studio Code config
mcpc connect .vscode/mcp.json:apify @my-apify
mcpc @my-apify tools-list
```

`mcpc` also finds these files for you: run `mcpc connect` with no arguments to auto-discover config
files in standard locations and connect every server, or pass a file without an entry to connect all
of its servers. See [Server formats](#server-formats).

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

> **Note:** Stdio servers inherit only a minimal env whitelist from the shell
> (`PATH`, `HOME`, `SHELL`, …). Other vars — `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY`,
> `SSL_CERT_FILE`, etc. — must be forwarded explicitly via the `env` block using
> `${VAR_NAME}`. Anything the server writes to stderr is captured to
> `~/.mcpc/logs/bridge-<session>.log` with a `[server stderr]` prefix, and the
> tail is appended to the error message if `mcpc connect` fails, so you can see
> why a stdio server failed to start.

**Environment variable substitution:**

Config files support environment variable substitution using `${VAR_NAME}` syntax:

```json
{
  "mcpServers": {
    "secure-server": {
      "url": "https://mcp.apify.com",
      "headers": {
        "Authorization": "Bearer ${APIFY_TOKEN}",
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
- `~/.mcpc/wallets.json` - x402 wallet data (file permissions `0600`)
- `~/.mcpc/bridges/` - Unix domain socket files for each bridge process
- `~/.mcpc/logs/bridge-*.log` - Log files for each bridge process
- OS keychain - Sensitive credentials (OAuth tokens, bearer tokens, client secrets)

### Environment variables

- `MCPC_HOME_DIR` - Directory for session and authentication profiles data (default is `~/.mcpc`)
- `MCPC_VERBOSE` - Enable verbose logging (set to `1`, `true`, or `yes`, case-insensitive)
- `MCPC_JSON` - Enable JSON output (set to `1`, `true`, or `yes`, case-insensitive)
- `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy` - Proxy URL for outbound connections (e.g. `http://proxy.example.com:8080`); `HTTPS_PROXY` takes precedence
- `NO_PROXY` / `no_proxy` - Comma-separated list of hostnames/IPs to bypass the proxy (e.g. `localhost,127.0.0.1`)

### Cleanup

You can clean up the `mcpc` state and data using the `clean` command:

```bash
# Safe non-destructive cleanup: remove expired sessions, delete old orphaned logs
mcpc clean

# Clean specific resources
mcpc clean sessions    # Kill bridges, delete all sessions
mcpc clean profiles    # Delete all authentication profiles
mcpc clean logs        # Delete all log files

# Nuclear option: remove everything
mcpc clean all         # Delete all sessions, profiles, logs, and sockets
```

## Security

`mcpc` follows [MCP security best practices](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices).
MCP enables arbitrary tool execution and data access - treat servers like you treat shells:

- Use least-privilege tokens/headers
- Only use trusted servers!
- Audit tools before running them

### Credential protection

| What                   | How                                             |
| ---------------------- | ----------------------------------------------- |
| **OAuth tokens**       | Stored in OS keychain (headless fallback: `credentials.json`, `0600`) |
| **HTTP headers**       | Stored in OS keychain per-session               |
| **Bridge credentials** | Passed via Unix socket IPC, kept in memory only |
| **Process arguments**  | No secrets visible in `ps aux`                  |
| **x402 private key**   | Stored in OS keychain (fallback: `wallets.json`, `0600`) |
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

View the bridge log for a session with `mcpc @<session> logs` (run with
`--help` for `--follow`, `-n`, and `--since` options). The underlying file
lives at `~/.mcpc/logs/bridge-@<session>.log` and is rotated automatically
(10MB per file, max 5 files). The main `mcpc` process doesn't save log
files, but supports [verbose mode](#verbose-mode).

### Troubleshooting

**"Cannot connect to bridge"**

- Bridge may have crashed. Try: `mcpc @<session-name> tools-list` to restart the bridge
- Check bridge is running: `ps aux | grep -e 'mcpc-bridge' -e '[m]cpc/dist/bridge'`
- Check socket exists: `ls ~/.mcpc/bridges/`

**"Session not found"**

- List existing sessions: `mcpc`
- Create new session if expired: `mcpc @<session-name> close` and `mcpc connect <server> @<session-name>`

**"Authentication failed"**

- List saved OAuth profiles: `mcpc`
- Re-authenticate: `mcpc login <server> [--profile <name>]`
- For bearer tokens: provide `--header "Authorization: Bearer ${TOKEN}"` again

## Development

The initial version of `mcpc` was developed and [launched by Jan Curn](https://x.com/jancurn/status/2007144080959291756) of [Apify](https://apify.com)
with the help of Claude Code, during late nights over Christmas 2025 in North Beach, San Francisco.

See [CONTRIBUTING](./CONTRIBUTING.md) for development setup, architecture overview, and contribution guidelines.

## Related work

### MCP CLI clients

<!-- Stars, contributors, commits, and activity as of July 2026. -->

| Tool                                                                    | Lang   | Stars | Commits | Contrib | Active | Tools | Resources | Prompts | Tasks | Code mode | Sessions | OAuth | Stdio | HTTP | Tool search | x402 | LLM |
| ----------------------------------------------------------------------- | ------ | ----: | ------: | ------: | ------ | ----- | --------- | ------- | ----- | --------- | -------- | ----- | ----- | ---- | ----------- | ---- | --- |
| **[apify/mcpc](https://github.com/apify/mcpc)**                         | TS     |   720 |     719 |      10 | ✅     | ✅    | ✅        | ✅      | ✅    | ✅        | ✅       | ✅    | ✅    | ✅   | ✅          | ✅   | —   |
| [steipete/mcporter](https://github.com/steipete/mcporter)               | TS     |  4.8k |     743 |      29 | ✅     | ✅    | —         | —       | —     | ✅        | ✅       | ✅    | ✅    | ✅   | —           | —    | —   |
| [knowsuchagency/mcp2cli](https://github.com/knowsuchagency/mcp2cli)     | Python |  2.3k |     105 |      11 | ✅     | ✅    | ✅        | ✅      | —     | ✅        | ✅       | ✅    | ✅    | ✅   | ✅          | —    | —   |
| [IBM/mcp-cli](https://github.com/IBM/mcp-cli)                           | Python |  2.0k |     788 |      24 | ⚠️     | ✅    | ✅        | ✅      | —     | ✅        | ✅       | ✅    | ✅    | ✅   | —           | —    | ✅  |
| [f/mcptools](https://github.com/f/mcptools)                             | Go     |  1.6k |     174 |      15 | ⚠️     | ✅    | ✅        | ✅      | —     | ✅        | —        | —     | ✅    | ✅   | —           | —    | —   |
| [philschmid/mcp-cli](https://github.com/philschmid/mcp-cli)             | TS     |  1.2k |      30 |       3 | ⚠️     | ✅    | —         | —       | —     | ✅        | ✅       | —     | ✅    | ✅   | ✅          | —    | —   |
| [adhikasp/mcp-client-cli](https://github.com/adhikasp/mcp-client-cli)   | Python |   680 |     113 |       6 | ⚠️     | ✅    | ✅        | ✅      | —     | —         | —        | —     | ✅    | —    | —           | —    | ✅  |
| [thellimist/clihub](https://github.com/thellimist/clihub)               | Go     |   670 |      60 |       1 | ⚠️     | ✅    | —         | —       | —     | —         | —        | ✅    | ✅    | ✅   | ✅          | —    | —   |
| [wong2/mcp-cli](https://github.com/wong2/mcp-cli)                       | JS     |   440 |      67 |       4 | ✅     | ✅    | ✅        | ✅      | —     | —         | —        | ✅    | —     | ✅   | —           | —    | —   |
| [mcpshim/mcpshim](https://github.com/mcpshim/mcpshim)                   | Go     |    61 |      13 |       1 | ⚠️     | ✅    | —         | —       | —     | ✅        | ✅       | ✅    | —     | ✅   | ✅          | —    | —   |
| [evantahler/mcpx](https://github.com/evantahler/mcpx)                   | TS     |    32 |     109 |       2 | ✅     | ✅    | ✅        | ✅      | ✅    | ✅        | —        | ✅    | ✅    | ✅   | ✅          | —    | —   |
| [EstebanForge/mcp-cli-ent](https://github.com/EstebanForge/mcp-cli-ent) | Go     |    15 |      56 |       3 | ✅     | ✅    | —         | —       | —     | ✅        | ✅       | —     | ✅    | ✅   | ✅          | —    | —   |
| [domdomegg/call-mcp](https://github.com/domdomegg/call-mcp)             | TS     |     1 |      20 |       2 | ✅     | ✅    | —         | —       | —     | ✅        | —        | ✅    | ✅    | ✅   | —           | —    | —   |

**Legend:** ✅ = supported, ⚠️ = stale (no commits in 3+ months), **Commits** = total commits, **Contrib** = contributors, **Tasks** = [async tasks](https://modelcontextprotocol.io/specification/latest/basic/utilities/tasks), **x402** = [x402 payment protocol](https://www.x402.org/) support, **LLM** = requires/uses an LLM.

**Notes:**

- [thellimist/clihub](https://github.com/thellimist/clihub) is a code generator that compiles MCP tools into standalone CLI binaries, rather than a runtime client ([HN discussion](https://news.ycombinator.com/item?id=47157398)).
- [knowsuchagency/mcp2cli](https://github.com/knowsuchagency/mcp2cli) also supports OpenAPI specs directly and uses a custom TOON encoding for token-efficient tool schemas.
- [IBM/mcp-cli](https://github.com/IBM/mcp-cli) and [mcp-client-cli](https://github.com/adhikasp/mcp-client-cli) integrate an LLM (Ollama, OpenAI, etc.) for chat-style interaction, while the other tools are pure CLI clients.
- [domdomegg/call-mcp](https://github.com/domdomegg/call-mcp) can also call connectors configured in claude.ai by reusing the Claude Code OAuth token, with no separate login.

### Code mode and dynamic tool discovery

These resources describe the "code mode" pattern (replacing many tool definitions with `search` + `execute`) and dynamic tool discovery:

- [Code mode](https://www.anthropic.com/engineering/code-execution-with-mcp) - Anthropic's blog post on code execution with MCP
- [Code mode at Cloudflare](https://blog.cloudflare.com/code-mode/) - Cloudflare's implementation of the code mode pattern
- [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) - Anthropic's engineering post on tool search
  - [Claude tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) - Claude platform docs
- [Dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery) - Cursor's approach to dynamic tool discovery
- [cmcp](https://github.com/assimelha/cmcp) (~29 stars, Rust) - MCP proxy aggregating servers behind `search()` + `execute()`
- [cloudflare-mcp](https://github.com/mattzcarey/cloudflare-mcp) (~129 stars, TS) - MCP server for the Cloudflare API using code mode
- [infinite-mcp](https://github.com/day50-dev/infinite-mcp) (~6 stars, Python) - Meta-MCP server that exposes 1000+ pre-indexed MCP servers via semantic search and dynamic tool discovery

### Other

- [mcpGraph](https://github.com/TeamSparkAI/mcpGraph) - MCP server that orchestrates directed graphs of MCP tool calls

## License

Apache-2.0 - see [LICENSE](./LICENSE) for details.
