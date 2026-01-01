
# TODOs

## Next

- Simplify README - there are too many top-level sections, and then show just the second level ones
  - in README, explain the MCP commands better in a standalone section, with details how they work
  - Expand --help to use same text as in README, add link to README

- We support "prompts", "tools" etc commands ... do we need to?

- Rename "session" command to "connect"

## MCP features

- Add `--proxy [HOST:]PORT` feature to `connect` command to enable MCP proxy:
  - `--proxy-bearer-token X` for proxy to require auth token for better security
  - `--proxy-capabilities tools:TOOL_NAME,TOOL_NAME2,...,prompts[:...],...` to limit access to selected MCP features and tools
    (what if tools have ":" or "," in their names?)
    In theory, we could add limit of capabilities to normal sessions, but the LLM could still break out of it, so what's the point.
  Explain this is useful for AI sandboxing!
- Implement resources-subscribe/resources-unsubscribe, --o file command properly, --max-size
  automatically update the -o file on changes, without it just keep track of changed files in
  bridge process' cache, and report in resources-list/resources-read operation
- Add support for asynchronous tasks
- Add support for client roots, need to figure how exactly

## Later

- Check how we deal with connection and command timeouts, that --timeout and timeout from config 
  file are obeyed

- Consider adding support for MCP elicitations, and potentially for sampling (e.g. via shell 
  interface?)

- nit: Cooler OAuth flow finish web page with CSS animation, add Apify example there, show mcpc info. E.g. next step - check Apify rather than close
- nit: For auth profiles, fetch the detailed user info via http, ensure the info is up-to-date
- nit: add more shortcuts, e.g. --profile => -p
- later: Add unique Session.id and Profile.id and use it for OS keychain keys, to truly enable using multiple independent mcpc profiles
- nit: Implement typing completions (e.g. "mcpc @a...") - not sure if that's even possible


## E2E test scenarios

- Add unit test the logTarget() doesn't leak serverConfig.headers
- Test that "mcpc <remote-server> --json --header "X-Test: Blah" redacts the header

- Later
- Test auth profiles work long-term and sessions too - basically when running some tests the
  next day they should use old saved auths and sessions.
  We could have some special dir for long-term testing...




TODO: new variant:
tools-call <tool-name> [<args-json> | arg1=val arg2:=json ... | <stdin>]



This error is wrong - we should attempt to connect and only claim auth error if the server 
requires it, otherwise fail with "host not found" or something similar error
> mcpc xxxx tools-list
Error: No authentication profile found for xxxx.

To authenticate, run:
mcpc xxxx login

Then run your command again.



Add logTarget to "shell" command too!
> mcpc @test shell
Welcome to mcpc shell for @test
Type "help" for available commands, "exit" to quit




mcpc mcp.apify.com shell --- do we also open session?
