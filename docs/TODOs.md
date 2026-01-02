
# TODOs


- `--capabilities '{"tools":...,"prompts":...}"` to limit access to selected MCP features and tools,
  for both proxy and normal session, for simplicity.
- Implement resources-subscribe/resources-unsubscribe, --o file command properly, --max-size
  automatically update the -o file on changes, without it just keep track of changed files in
  bridge process' cache, and report in resources-list/resources-read operation
- Store last time of all listChanged notifications on session object, so that users can see it and act on that.

- Ensure "logging-set-level" works well

## Later

- nit: in "login", make profile color consistent with "mcpc"
- nit: show also header / open auth statuses for HTTP servers?
- ux: consider forking "alive" session state to "alive" and "diconnected", to indicate the remove server is not responding but bridge 
  runs fine. We can use lastSeenAt + ping interval info for that, or status of last ping.
- perf: make the libsecret dependency soft - only load it when using keychain, but skip for auth-less (AI sandbox) use
- ux: Be even more forgiving with `args:=x`, when we know from tools/prompt schema the text is compatible with `x` even if the exact type is not - 
  just re-type it dynamically to make it work.
- nit: Cooler OAuth flow finish web page with CSS animation, add Apify example there, show mcpc info. E.g. next step - check Apify rather than close
- security: For auth profiles, fetch the detailed user info via http, save to profiles.json and show in 'mcpc', ensure the info is up-to-date
- later: Add unique Session.id and Profile.id and use it for OS keychain keys, to truly enable using multiple independent mcpc profiles. Use cry
- nit: Implement typing completions (e.g. "mcpc @ap...") - not sure if that's even possible
- later: maybe add --no-color option to disable chalk

## E2E test scenarios

- On "npm run release", make the two skippable OAuth e2e tests mandatory

- Test auth profiles work long-term and sessions too - basically when running some tests the
  next day they should use old saved auths and sessions.
  We could have some special dir for long-term testing...


# Questions

- mcpc mcp.apify.com shell --- do we also open "virtual" session, how does it work exactly? Let's explain this in README.
