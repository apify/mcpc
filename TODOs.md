
- Ensure we show tool annotations and tasks in text mode too
- Handle MCP errors by failing the command tool, e.g. invalid tool name..

authProfiles - prints secrets to JSON now


# Cosmetic
- nit: on server/session info, print also auth info
  - [Using session: apify-docs] => change to show server + transport + version? + auth info!!!
    Active MCP sessions:
    @fs → npx (stdio) --- show also args instead of just "npx"

- add "mcpc --reset-all" commands to clean up everyting 

- docs: add the OAuth command to --help, otherwise people will not find it when they need it

# E2E tests
- add end-to-end tests e.g. under `test/e2e` - one bash script per test suite , organized in directories, and one master script that runs them all or selected ones (per directory) in parallel
- Invariants:
  - --verbose only adds extra info to stderr, never to stdout
  - --json always returns single JSON object to stdout on success (exit code = 0), or an object or nothing at all on error (exit code != 0)
- Things to test:
  - handling of errors, invalid params, names, etc. 
  - pagination
  - env vars...
  - stdio + filesystem operations,
  - sessions
  - for all commands, tests --verbose doesn't print anything extra to stdout, --json returns json
  - that on session close we send HTTP DELETE https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management
- Can we track test coverage also this way?


# Later (nice to have)
- nit: Colorize output, e.g. JSONs in one color. MCP provided data like descriptions and instructions in orange.
- nit: in Readme, explain the MCP commands better
- Add support for MCP elicitations, and potentially for sampling (e.g. via shell interface?)
- better session management - in the list show which sessions are alive/expired/dead 
- docs: add Claude Skills file to /docs, maybe also man page?
