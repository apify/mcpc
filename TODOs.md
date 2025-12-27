
# TODOs


## Bugs
- Seems calling invalid/unknown MCP command in shell (perhaps also normally) causes the bridge to be flagged as expired

- reconnection doesn't work
mcpc @apify session                                                                                                        1 ✘
error: missing required argument 'name'



## Next

- nit: consistent good server and session info, on server/session info, print also auth info
  - [Using session: apify-docs] => change to show server + transport + version? + auth info!!!
    Active MCP sessions:
    @fs → npx (stdio) --- show also args instead of just "npx"
  - print PID of bridge process

Visual examples:

    Xxx/
    ├── run.sh                    # Master runner (parallel by suite)
    ├── lib/
    │   ├── common.sh             # Assertions, temp dirs, cleanup
    │   ├── server.sh             # Start/stop test server helpers
    │   └── mcpc.sh               # Wrapper to invoke mcpc with coverage
    ├── fixtures/
    │   └── configs/              # Test config files
    ├── server/
    │   └── index.ts              # Configurable test MCP server
    │

 * ▐▛███▜▌ *   Claude Code v2.0.75
* ▝▜█████▛▘ *  Opus 4.5 · Claude Team
 *  ▘▘ ▝▝  *   ~/Projects/mcpc


- Better error handling:
  - "mcpc https://mcp.sentry.dev/mcp" with an unknown sever => should hint to use "login"
  - Handle MCP errors by failing the command tool, e.g. invalid tool name..

- implement resources-subscribe/resources-unsubscribe command properly
- > # TODO: automatically update the -o file on changes, without it just keep track of changed files in bridge process' cache, and report in resources-list


## Security
- Double-check the MCP security guidelines
- OAuth issuer - maybe save it and double-check it to ensure domain is not spoofed?


## Later

- nit: Colorize output, e.g. JSONs in one color. MCP provided data like descriptions and instructions in orange.
  -  warnings could be orange, errors red
- - docs: add Claude Skills file to /docs, maybe also man page?
- Add support for MCP elicitations, and potentially for sampling (e.g. via shell interface?)
- Add `--proxy [HOST:]PORT` feature to `connect` command to enable MCP proxy:
  - `--proxy-bearer-token X` to require auth token for better security
  - `--proxy-capabilities tools:TOOL_NAME,TOOL_NAME2,...,prompts[:...],...` to limit access to selected MCP features and tools
    (what if tools have ":" or "," in their names?)
    In theory, we could add limit of capabilities to normal sessions, but the LLM could still break out of it, so what's the point.
  - Explain this is useful for AI sandboxing!
- Implement typing completions (e.g. "mcpc @a...") - not sure how difficult that is
- nit: Nicer OAuth flow finish web page, add Apify example there. E.g. next step - check Apify rather than close
- nit: cooler OAuth web pages "Authentication successful!" - show mcpc info
- audit that on every command, we print next steps as examples
- more shortcuts, e.g. --profile => -p
- nit: in README, explain the MCP commands better in a standlone section, with details how they work



## E2E test scenarios
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
- Text copy can change, but the core texts needs to be shown in both text and JSON mode

