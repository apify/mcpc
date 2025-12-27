
# TODOs


- How about doing skipping "connect" keyword altogether?:
  "mcpc mcp.apify.com [--session|session|connect] @test6" 
  -> would establish session @test6, and print server info
  -> consistent with "mcpc mcp.apify.com"

- Ensure we show tool annotations and tasks in text mode too
- Revise the caching - is it needed, why not use SDK autoRefresh? 

- add "mcpc --reset-all/clean-all/clean:a,b,c" ? command to clean up sessions, kill bridges, etc. It should keep shell-history and logs though.
  - add command to restart bridge process


- "mcpc @apify-docs connect" still doesn't work: it should restart the session, or do nothing if it's already connected.
-  "mcpc @apify-docs connect --session @apify-docs" should auto restart the session


- The bridge and socket management is flakey, we can do better - see TODOs there

- "mcpc" - quickly probe the bridge for status and print it: expired (already known), crashed (if pid is not running), live (pid running, not expired)

## Cosmetic
- nit: on server/session info, print also auth info
  - [Using session: apify-docs] => change to show server + transport + version? + auth info!!!
    Active MCP sessions:
    @fs → npx (stdio) --- show also args instead of just "npx"
  - print PID of bridge process

- Better error handling:
  - "mcpc https://mcp.sentry.dev/mcp" => should hint to use "login"
  - Handle MCP errors by failing the command tool, e.g. invalid tool name..


## E2E tests
- add end-to-end tests e.g. under `test/e2e` - one bash script per test suite , organized in directories, and one master script that runs them all or selected ones (per directory) in parallel
- Invariants:
  - --verbose only adds extra info to stderr, never to stdout
  - --json always returns single JSON object to stdout on success (exit code = 0), or an object or nothing at all on error (exit code != 0)
- We'll need a testing server with all the available features and configurable, for testing.
- Things to test:
  - handling of errors, invalid params, names, etc. 
  - pagination
  - env vars...
  - stdio + filesystem operations,
  - sessions
  - for all commands, tests --verbose doesn't print anything extra to stdout, --json returns json
  - that on session close we send HTTP DELETE https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management
  - Test session failover - e.g. kill the bridge process, and try to access the session again (should be restarted)
  - Test server session aborting - if session is aborted by server, bridge process should exit and set session status to "expired"
  - Test auth profiles work long-term and sessions too
- Can we track test coverage also this way?


## Security
- Double-check the MCP security guidelines
- OAuth issuer - maybe save it and double-check it to ensure domain is not spoofed?


## Later

- nit: Colorize output, e.g. JSONs in one color. MCP provided data like descriptions and instructions in orange.
- nit: in README, explain the MCP commands better in a standlone section, with details how they work
- Add support for MCP elicitations, and potentially for sampling (e.g. via shell interface?)
- docs: add Claude Skills file to /docs, maybe also man page?
- Add `--proxy [HOST:]PORT` feature to `connect` command to enable MCP proxy:
  - `--proxy-bearer-token X` to require auth token for better security
  - `--proxy-capabilities tools:TOOL_NAME,TOOL_NAME2,...,prompts[:...],...` to limit access to selected MCP features and tools
    (what if tools have ":" or "," in their names?)
    In theory, we could add limit of capabilities to normal sessions, but the LLM could still break out of it, so what's the point.
  - Explain this is useful for AI sandboxing!
- Impelled shell completions (e.g. "mcpc @a...")
- nit: Nicer OAuth flow finish web page, add Apify example there.
