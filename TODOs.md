
# TODOs

## Bugs
...


## Next

- Simplify README - there are too many top-level sections, and then show just the second level ones
-  - nit: in README, explain the MCP commands better in a standlone section, with details how they work

- Expand --help to use same text as in README, add link to README
- Do not use Markdown formatting on output

# MCP features

- Implement resources-subscribe/resources-unsubscribe, --o file command properly, --max-size
  automatically update the -o file on changes, without it just keep track of changed files in bridge process' cache, and report in resources-list
- Add `--proxy [HOST:]PORT` feature to `connect` command to enable MCP proxy:
  - `--proxy-bearer-token X` for proxy to require auth token for better security
  - `--proxy-capabilities tools:TOOL_NAME,TOOL_NAME2,...,prompts[:...],...` to limit access to selected MCP features and tools
    (what if tools have ":" or "," in their names?)
    In theory, we could add limit of capabilities to normal sessions, but the LLM could still break out of it, so what's the point.
  - Explain this is useful for AI sandboxing!

- Later: Add support for MCP elicitations, and potentially for sampling (e.g. via shell interface?)


  
## Security
- Double-check the MCP security guidelines
- OAuth issuer - maybe save it and double-check it to ensure domain is not spoofed?

## Later


- When user runs --clean=profiles, print warning if some sessions were using them

- nit: Colorize output, e.g. JSONs in one color. MCP provided data like descriptions and instructions in orange.
  -  warnings could be orange, errors red


- Implement "mcpc @session restart" .. and maybe also "mcpc <server> connect @session" ?

- nit: Cooler OAuth flow finish web page with CSS animation, add Apify example there, show mcpc info. E.g. next step - check Apify rather than close
- nit: For auth profiles, fetch the detailed user info via http, ensure the info is up-to-date

- nit: add more shortcuts, e.g. --profile => -p
- later: Add unique Session.id and Profile.id and use it for OS keychain keys, to truly enable using multiple independent mcpc profiles 

- nit: Implement typing completions (e.g. "mcpc @a...") - not sure how difficult that is





## E2E test scenarios

Let's add more e2e test scenarios:
- Test auth profiles work long-term and sessions too - basically when running some tests the next day they should use old saved auths and sessions
