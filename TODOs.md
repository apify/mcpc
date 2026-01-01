
# TODOs

## Next

- Rename "mcpc <target> session @test" command to "mcpc <target> connect @test"

- Pass `--timeout` to both connection and command timeout (if MCP supports this). Ensure we obey both --timeout and timeout from config.

## MCP features

- Add `--proxy [HOST:]PORT` feature to `connect` command, to make bridge launch a new MCP server, which will map commands 
  and request 1:1 to the remote or local MCP server, but without having access to original authentication tokens. It will be like a layer of 
  security.
- Once this is done, we could add these enhancements"
  - `--proxy-bearer-token X` for proxy to require auth token for more security
  - `--proxy-capabilities tools:TOOL_NAME,TOOL_NAME2,...,prompts[:...],...` to limit access to selected MCP features and tools
    (what if tools have ":" or "," in their names?)
    In theory, we could add limit of capabilities to normal sessions, but the LLM could still break out of it, so what's the point.
  Explain this is useful for AI sandboxing!
- Implement resources-subscribe/resources-unsubscribe, --o file command properly, --max-size
  automatically update the -o file on changes, without it just keep track of changed files in
  bridge process' cache, and report in resources-list/resources-read operation


## Later

- ux: Be even more forgiving with `args:=x`, when we know from tools/prompt schema the text is compatible with `x` even if the exact type is not - 
  just retype it dynamically to make it work.
- nit: Cooler OAuth flow finish web page with CSS animation, add Apify example there, show mcpc info. E.g. next step - check Apify rather than close
- security: For auth profiles, fetch the detailed user info via http, save to profiles.json and show in 'mcpc', ensure the info is up-to-date
- later: Add unique Session.id and Profile.id and use it for OS keychain keys, to truly enable using multiple independent mcpc profiles
- nit: Implement typing completions (e.g. "mcpc @a...") - not sure if that's even possible


## E2E test scenarios

- Add unit test the logTarget() doesn't leak serverConfig.headers
- Test that "mcpc <remote-server> --json --header "X-Test: Blah" redacts the header

- Later
- Test auth profiles work long-term and sessions too - basically when running some tests the
  next day they should use old saved auths and sessions.
  We could have some special dir for long-term testing...


Now a big change.
I want to get rid of:
--args ...
--args-file ...

And replace it with:
- `mcpc <target> tools-call <tool-name> [<args-json> | arg1:=val arg2:=json ...]`
- `mcpc <target> tools-call <tool-name> < file.txt`

We'll only support `arg1:=val` syntax, not `arg1=val`, to avoid conflict with `--clean=x`.
All JSON parseable values will parsed as respective types, or treated as string if not number, boolean, ...
Another option is to provide full JSON string as ` <args-json>`.
And third option is to support stdin for piping args - the piped object must be JSON.

This means a big rewrite of parsing logic, adding/updating unit and e2e tests. For now, keep the README and command help intact.




When running "shell" command in shell, let's show some easter egg - we can rotate couple of funny messages,
e.g. "Ha, good try!", "Shell in shell, lol", "Good luck with this", "Success-ish", etc.


# Questions
mcpc mcp.apify.com shell --- do we also open session, how does it work? Let's mention this in readme.
