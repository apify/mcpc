---
name: mcpc
description: Use the mcpc CLI to work with MCP (Model Context Protocol) servers from the shell - connect to a server as a persistent session, then list and call tools, read resources, get prompts, and run async tasks. Use --json for scripting and code mode. Reach for this whenever interacting with MCP servers, calling MCP tools, or accessing MCP resources programmatically.
allowed-tools: Bash(mcpc:*), Read, Grep
---

# mcpc: MCP command-line client

`mcpc` maps every MCP operation to a shell command. For agents this is often more
efficient than function calling: discover the right tool on demand, then generate
shell commands (ideally with `--json`) instead of carrying tool definitions in context.

## Mental model

1. **Connect once** to a server — this creates a persistent, named `@session`. A
   background bridge process keeps the connection (and its state) alive.
2. **Run commands against the `@session`**: list/call tools, read resources, get
   prompts, run async tasks. There is no one-shot `mcpc <url> tools-list` — connect first.
3. **Default output is human-readable**; add `--json` for machine-readable, MCP-spec
   shaped output that composes with `jq` and shell pipelines (code mode).

Everything is self-documenting — when unsure, ask the CLI:

```bash
mcpc --help                       # all commands + global options
mcpc help connect                 # help for one command
mcpc @apify tools-call foo --help # that tool's details + schema
```

## First steps

```bash
mcpc                                   # list sessions + auth profiles (start here)
mcpc connect mcp.apify.com @apify      # connect, create the @apify session
mcpc @apify                            # server info, capabilities, tools overview
mcpc @apify tools-list                 # list tools
mcpc @apify tools-call <tool> q:="hi"  # call a tool
```

## Connecting

Server formats accepted by `connect`:

- `mcp.example.com` — remote HTTP server (`https://` is added automatically)
- `localhost:8080` or `127.0.0.1:8080` — local HTTP server (`http://` is the default for `localhost` and `127.0.0.1`)
- `~/.vscode/mcp.json:filesystem` — a single entry from a config file (`file:entry`)
- `~/.vscode/mcp.json` — connect **every** entry in a config file
- _(no server)_ — auto-discover standard configs and connect all of them

```bash
mcpc connect mcp.apify.com @apify        # remote server, explicit session name
mcpc connect mcp.apify.com               # auto-name the session → @apify
mcpc connect ./.vscode/mcp.json:fs @fs   # one config entry (stdio or http)
mcpc connect                             # discover standard configs + connect everything
```

- `@session` is optional — omit it to auto-generate a name from the server
  (`mcp.apify.com` → `@apify`). A matching session (same server + auth) is reused.
- **Stdio (command-based) entries launch a local process on connect** — only connect
  to configs you trust. Bulk connects skip stdio entries unless you pass `--stdio`.
- `login` / `logout` only accept an MCP server URL (a bare host or full
  `http(s)://` URL) — not config files or auto-discovery.

## Sessions

```bash
mcpc                     # list all sessions and their state
mcpc @apify              # session details, capabilities, tools (also reports the
                         # negotiated protocol version and stateful vs stateless)
mcpc restart @apify      # restart (after server updates, or to recover an 'expired' session)
mcpc close @apify        # tear the session down
```

**Session states:**

- 🟢 **live** — ready to use
- 🟡 **connecting** / **reconnecting** — transient; retry in a moment
- 🟡 **disconnected** — bridge alive but the server has gone quiet; retry to reconnect
- 🟡 **crashed** — bridge process died; auto-restarts on next use
- 🔴 **unauthorized** — auth failed; run `mcpc login <server>` then `mcpc restart @session`
- 🔴 **expired** — server dropped the session; run `mcpc restart @session`

## Discovering and inspecting tools

```bash
mcpc @apify tools-list                  # compact list with inline param signatures
mcpc @apify tools-list --full           # full JSON schemas
mcpc @apify tools-get <tool>            # one tool's details + schema
mcpc @apify tools-call <tool> --help    # shortcut for tools-get: that tool's details + schema

mcpc grep "search"                      # search tools + instructions across ALL sessions
mcpc @apify grep "actor" --resources    # search one session
# grep filters: --tools/--resources/--prompts/--instructions, -E regex, -s case-sensitive, -m <n> max
```

Prefer progressive discovery: `grep` to find the right tool, then `tools-get` for its
schema. This keeps token use low instead of dumping every tool definition.

## Calling tools (passing arguments)

Arguments go after the tool name. Three interchangeable styles:

```bash
# 1) key:=value — values are auto-parsed as JSON, falling back to string
mcpc @apify tools-call search query:="hello world" limit:=10 enabled:=true
mcpc @apify tools-call search config:='{"nested":"value"}' items:='[1,2,3]'
mcpc @apify tools-call search id:='"123"'          # force a string with JSON quotes

# 2) inline JSON — when the first arg starts with { or [
mcpc @apify tools-call search '{"query":"hello","limit":10}'

# 3) stdin — auto-detected when piped and no positional args are given
echo '{"query":"hello"}' | mcpc @apify tools-call search
```

## JSON output (code mode)

Add `--json` for machine-readable output: results on stdout, errors on stderr,
shaped strictly per the MCP spec.

```bash
mcpc --json @apify tools-list | jq -r '.[].name'
mcpc --json @apify tools-call search query:="test" | jq -r '.content[0].text'

# chain tools across calls/sessions
mcpc --json @apify tools-call search-actors keywords:="scraper" \
  | jq -r '.content[0].text | fromjson | .items[0].id' \
  | xargs -I{} mcpc --json @apify tools-call get-actor actorId:="{}"
```

`mcpc --json` with no command returns `{ "sessions": [...], "profiles": [...] }`.

## Resources and prompts

```bash
mcpc @apify resources-list
mcpc @apify resources-read "file:///path/to/file"   # -o <file> to save (binary-safe), --raw to pipe
mcpc @apify resources-templates-list
mcpc @apify resources-subscribe <uri> <file>        # keep local <file> in sync with the resource
mcpc @apify resources-unsubscribe <uri>             # stop syncing, keep the file

mcpc @apify prompts-list
mcpc @apify prompts-get <name> arg1:=value1         # same argument syntax as tools-call (values coerced to strings)
```

## Async tasks (long-running tools)

```bash
mcpc @apify tools-call <tool> --task <args>     # run as a task with a progress spinner; Ctrl+C (or
                                                # ESC) leaves it running and prints the task ID.
                                                # Falls back to a normal sync call if the server has no task support.
mcpc @apify tools-call <tool> --detach <args>   # start and return the task ID immediately
mcpc @apify tasks-list
mcpc @apify tasks-get <taskId>                  # status
mcpc @apify tasks-result <taskId>               # block until the final result is ready
mcpc @apify tasks-cancel <taskId>
```

## Authentication

```bash
# OAuth — interactive browser login, saved as a reusable profile
mcpc login mcp.apify.com                    # "default" profile
mcpc login mcp.apify.com --profile work     # a named profile (multiple accounts per server)
mcpc connect mcp.apify.com @apify --profile work
mcpc logout mcp.apify.com

# Bearer token — not stored as a profile; kept per-session
mcpc connect mcp.apify.com @s -H "Authorization: Bearer $TOKEN"
mcpc @s tools-list
```

With no auth flags, mcpc uses the `default` profile if one exists, otherwise it
connects anonymously. Use `--no-profile` to force an anonymous connection, or
`--profile <name>` to require a specific one.

## Proxy for AI isolation

Expose an authenticated session as a local MCP server, so sandboxed AI code can use it
without ever seeing your real credentials:

```bash
# Human: authenticated session + proxy listening on :8080
mcpc connect mcp.apify.com @ai-proxy --profile ai-access --proxy 8080

# AI in a sandbox limited to localhost: no access to the original tokens
mcpc connect localhost:8080 @sandboxed
mcpc @sandboxed tools-list
```

A proxy does not make an untrusted server safe — stdio servers still touch your system,
and HTTP servers still hold your credentials. Only connect to servers you trust.

## Server-published skills (experimental)

Distinct from this guide: some MCP **servers** publish their own agent skills
(draft MCP extension, SEP-2640). Read them with:

```bash
mcpc @apify skills-list
mcpc @apify skills-get <name> --raw    # print the SKILL.md markdown (pipe to a file or an LLM)
```

(`mcpc help --skill` documents mcpc itself; `skills-list` / `skills-get` fetch skills from the server.)

## Global flags worth knowing

```bash
--json                  # machine-readable, MCP-spec-shaped output (code mode)
--verbose               # protocol-level debug logging (JSON-RPC, transport)
--profile <name>        # OAuth profile to use ("default" if omitted)
--timeout <seconds>     # request timeout in seconds (default: 60)
--max-chars <n>         # truncate human-readable output to n chars (ignored with --json)
--insecure              # skip TLS verification (self-signed certs only)
```

(`--no-profile`, `--stdio`, `--proxy`, and `-H` are options of `connect`, not global flags.)

`mcpc` also has experimental `--x402` auto-payment for paid MCP tools — see `mcpc help x402`.

## Debugging

```bash
mcpc --verbose @apify tools-call <tool>   # protocol-level detail (JSON-RPC, transport)
mcpc @apify logs                          # bridge log; -n <N>, --follow, --since 1h
mcpc @apify ping                          # round-trip health check
mcpc clean                                # tidy stale sessions/logs (also: mcpc clean all)
```

## Exit codes

- `0` — success
- `1` — client error (invalid arguments, unknown command)
- `2` — server error (tool failed, resource not found)
- `3` — network error
- `4` — authentication error
