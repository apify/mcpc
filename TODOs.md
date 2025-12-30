
# TODOs

## Bugs
...


## Next

- Expand --help to use same text as in README, add link to README
- Do not use Markdown formatting

# MCP features

- Implement resources-subscribe/resources-unsubscribe, --o file command properly, --max-size
  automatically update the -o file on changes, without it just keep track of changed files in bridge process' cache, and report in resources-list
- Add `--proxy [HOST:]PORT` feature to `connect` command to enable MCP proxy:
  - `--proxy-bearer-token X` to require auth token for better security
  - `--proxy-capabilities tools:TOOL_NAME,TOOL_NAME2,...,prompts[:...],...` to limit access to selected MCP features and tools
    (what if tools have ":" or "," in their names?)
    In theory, we could add limit of capabilities to normal sessions, but the LLM could still break out of it, so what's the point.
  - Explain this is useful for AI sandboxing!
- Add support for MCP elicitations, and potentially for sampling (e.g. via shell interface?)
- In tools-list, let's show simplified args on tool details view, e.g. read_text_file
   • Tool: `write_file` [destructive, idempotent]
   Input:
     path: string
     tail: number - If provided, returns only the last N lines of the file
     Output: N/A
  Description:
  Text...
  
## Security
- Double-check the MCP security guidelines
- OAuth issuer - maybe save it and double-check it to ensure domain is not spoofed?

## Later


- Implement "mcpc @session restart" .. and maybe also "mcpc <server> connect @session" ?

- nit: Colorize output, e.g. JSONs in one color. MCP provided data like descriptions and instructions in orange.
  -  warnings could be orange, errors red
- nit: Cooler OAuth flow finish web page with CSS animation, add Apify example there, show mcpc info. E.g. next step - check Apify rather than close
- For auth profiles, fetch the detailed user info via http, ensure the info is up-to-date

- audit that on every command, we print next steps as examples
- add more shortcuts, e.g. --profile => -p
- nit: in README, explain the MCP commands better in a standlone section, with details how they work
- Add unique Session.id and Profile.id and use it for OS keychain keys, to truly enable using multiple independent mcpc profiles
- When user runs --clean=profiles, print warning if some sessions were using them 

- nit: Implement typing completions (e.g. "mcpc @a...") - not sure how difficult that is





## E2E test scenarios

- Implement e2e test scenarios:
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
  
