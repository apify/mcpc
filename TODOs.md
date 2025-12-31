
# TODOs

## Next

- Simplify README - there are too many top-level sections, and then show just the second level ones
-  - nit: in README, explain the MCP commands better in a standlone section, with details how they work

- Expand --help to use same text as in README, add link to README

## MCP features

- Implement resources-subscribe/resources-unsubscribe, --o file command properly, --max-size
  automatically update the -o file on changes, without it just keep track of changed files in bridge process' cache, and report in resources-list
- Add `--proxy [HOST:]PORT` feature to `connect` command to enable MCP proxy:
  - `--proxy-bearer-token X` for proxy to require auth token for better security
  - `--proxy-capabilities tools:TOOL_NAME,TOOL_NAME2,...,prompts[:...],...` to limit access to selected MCP features and tools
    (what if tools have ":" or "," in their names?)
    In theory, we could add limit of capabilities to normal sessions, but the LLM could still break out of it, so what's the point.
  Explain this is useful for AI sandboxing!
- Add support for asynchronous tasks

## Later

- Check how we deal with connection and command timeouts

- Add support for MCP elicitations, and potentially for sampling (e.g. via shell interface?)

- Implement "mcpc @session restart" .. and maybe also "mcpc <server> connect @session" ?

- nit: Cooler OAuth flow finish web page with CSS animation, add Apify example there, show mcpc info. E.g. next step - check Apify rather than close
- nit: For auth profiles, fetch the detailed user info via http, ensure the info is up-to-date
- nit: add more shortcuts, e.g. --profile => -p
- later: Add unique Session.id and Profile.id and use it for OS keychain keys, to truly enable using multiple independent mcpc profiles
- nit: Implement typing completions (e.g. "mcpc @a...") - not sure how difficult that is



## E2E test scenarios

Let's add more tests (some e2e, some unit, some both):
- Test that output from "mcpc @test --json" is consistent with MCP server handshake "results" (see https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) - additional properties are fine
- Test that output from "mcpc @test tools-list --json" and "mcpc @test tools-schema xxx --json" 
  are consistent with MCP tool schema. And same for prompts and resources!
- Add unit tests to ensure that human output for tools, resources, and prompts contain all the 
  important information. Add a simple e2e test that the output works also end to end.
- test env var substitution works for config files (unit +e2e)
- test that all headers for HTTP server do not leak in process list (e.g. use --header to pass 
  something, and ensure it's not present in "ps aux"), and that <redacted> works

Later
- Test auth profiles work long-term and sessions too - basically when running some tests the
  next day they should use old saved auths and sessions.
  We could have some special dir for long-term testing...

- Testing servers we can use:
  - https://mcp.apify.com (for testing real OAuth login, we can create various accounts, both OAuth and API tokens)
  - https://mcp.apify.com/tools=docs (anonymous, no auth needed)
  - https://mcp.sentry.dev/mcp (for testing if no auth profile available)
  - ideally get some on non-standard port, maybe localhost

