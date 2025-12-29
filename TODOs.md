
# TODOs

## Bugs
...


## Next

- Expand --help to use same text as in README, add link to README

BIG: We need to decide whether to show Markdown-ish or not


- implement resources-subscribe/resources-unsubscribe, --o file command properly, --max-size
- > # TODO: automatically update the -o file on changes, without it just keep track of changed files in bridge process' cache, and report in resources-list
  
  
## Security
- Double-check the MCP security guidelines
- OAuth issuer - maybe save it and double-check it to ensure domain is not spoofed?

## Later

- nit: Print version info to logs, and link to https://github.com/apify/mcpc (to right release tag) - add this also to --help

- Implement "mcpc @session restart" 

- nit: Colorize output, e.g. JSONs in one color. MCP provided data like descriptions and instructions in orange.
  -  warnings could be orange, errors red
- nit: Cooler OAuth flow finish web page with CSS animation, add Apify example there. E.g. next step - check Apify rather than close

- Add `--proxy [HOST:]PORT` feature to `connect` command to enable MCP proxy:
  - `--proxy-bearer-token X` to require auth token for better security
  - `--proxy-capabilities tools:TOOL_NAME,TOOL_NAME2,...,prompts[:...],...` to limit access to selected MCP features and tools
    (what if tools have ":" or "," in their names?)
    In theory, we could add limit of capabilities to normal sessions, but the LLM could still break out of it, so what's the point.
  - Explain this is useful for AI sandboxing!

- For auth profiles, fetch the detailed user info from http, ensure the info is up-to-date
- Add support for MCP elicitations, and potentially for sampling (e.g. via shell interface?)

- nit: cooler OAuth web pages "Authentication successful!" - show mcpc info
- audit that on every command, we print next steps as examples
- more shortcuts, e.g. --profile => -p
- nit: in README, explain the MCP commands better in a standlone section, with details how they work
- Add unique Session.id and Profile.id and use it for OS keychain keys, to truly enable using multiple independent mcpc profiles
- When user runs --clean=profiles, print warning if some sessions were using them 

- nit: Implement typing completions (e.g. "mcpc @a...") - not sure how difficult that is





## E2E test scenarios
- DONE: add end-to-end tests e.g. under `test/e2e` - one bash script per test suite , organized in directories,and one master script that runs them all or selected ones (per directory) in parallel
- Invariants (ideally test this for all commands used in other tests, or is it better just to always test one thing?):
  - --verbose only adds extra info to stderr, never to stdout
  - --json always returns single JSON object to stdout on success (exit code = 0), or an object or nothing at all on error (exit code != 0)
- We'll need a testing server with all the available features and configurable, for testing.
- "npm run test:coverage" doesn't seem to work and cover e2e tests
- Things to test:
  - handling of errors, invalid params, names, etc.
  - pagination
  - env vars...
  - stdio + filesystem operations
  - sessions
  - test stdio transport with fs mcp server
  - test expired session (create fake record in session.json) - ensure attempts to use it will fail with the right error
  - for all commands, tests --verbose doesn't print anything extra to stdout, --json returns json
  - that on session close we send HTTP DELETE https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management
  - Test session failover - e.g. kill the bridge process, and try to access the session again - should be restarted, work, and have same MCP-Session-Id
  - Test auth - if no profile available and server requires OAuth, we need to fail with info what to do! e.g. "mcpc https://mcp.sentry.dev/mcp --verbose"
  - Test server session aborting - if session is aborted by server, bridge process should exit and set session status to "expired"
  - Test auth profiles work long-term and sessions too - basically when running some tests the next day they should use old saved auths and sessions
  - Test "mcpc @test close" and "mcpc <server> session @test" in rapid succession, it should work and use different pid (check sessions.json)
  - Ensure calling invalid/unknown MCP command in shell and normally doesn't causes the bridge to be flagged as expired or dead
- Text copy can change, but the core texts needs to be shown in both text and JSON mode
- Testing servers we can use:
  - https://mcp.apify.com (for testing real OAuth login, we can create various accounts, both OAuth and API tokens)
  - https://mcp.apify.com/tools=docs (anonymous, no auth needed)
  - https://mcp.sentry.dev/mcp (for testing if no auth profile available)
  - ideally get some on non-standard port, maybe localhost
  
