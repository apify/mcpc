
# TODOs



## MCP features

- `--capabilities '{"tools":...,"prompts":...}"` to limit access to selected MCP features and tools,
  for both proxy and normal session, for simplicity.
- Implement resources-subscribe/resources-unsubscribe, --o file command properly, --max-size
  automatically update the -o file on changes, without it just keep track of changed files in
  bridge process' cache, and report in resources-list/resources-read operation


## Later

- perf: make the libsecret dependency soft - only load it when using keychain, but skip
  for auth-less (AI sandbox) use
- ux: Be even more forgiving with `args:=x`, when we know from tools/prompt schema the text is compatible with `x` even if the exact type is not - 
  just re-type it dynamically to make it work.
- nit: Cooler OAuth flow finish web page with CSS animation, add Apify example there, show mcpc info. E.g. next step - check Apify rather than close
- security: For auth profiles, fetch the detailed user info via http, save to profiles.json and show in 'mcpc', ensure the info is up-to-date
- later: Add unique Session.id and Profile.id and use it for OS keychain keys, to truly enable using multiple independent mcpc profiles. Use cry
- nit: Implement typing completions (e.g. "mcpc @a...") - not sure if that's even possible


## E2E test scenarios

- Test that "mcpc <remote-server> --json --header "X-Test: Blah" redacts the header in --verbose

- Test auth profiles work long-term and sessions too - basically when running some tests the
  next day they should use old saved auths and sessions.
  We could have some special dir for long-term testing...


When I run "mcpc mcp.apify.com\?tools=docs tools-list" on new system, it fails even though it should work - the server is open and doesn't require OAuth. Add unit test for that, in isolated home dir to ensure we don't interfere
with local auth profiles. Here's the error I got:



# Questions

mcpc mcp.apify.com shell --- do we also open session, how does it work? Let's mention this in readme.
