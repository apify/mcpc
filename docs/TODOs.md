
# TODOs

- "mcpc help tools-call" - show more info how to pass args, including stdio pipe and JSON. Maybe add short examples.
Make "mcpc @apify grep --help" and "mcpc grep --help" more consistent with info what they print.
The former should provide the --json example.

## NEW


- the README could contain command reference, to explain each command,
  show the full options from "mcpc help command",
  with links to the more detailed sections below. Or perhaps it could be a separate file?

- grep - print some snippet not just of server instructions, but also tools

- tools-call help should provide some info what the json output looks like, in human mode provide introduce the results (@apify/tool-xx succeeded 
  and returned:


## Bugs !

...


## UX/AX


- mcpc @apify tools-get fetch-actor-details => should print also "object" properties in human mode

- mcpc @apify tools-call xxx --help  should print tools-get + command info

- mcp-cli inspiration
$ mcpc @github tools-call get_file_contents arg:="yes" # NOW
$ mcpc @github/get_file_contents arg:="yes"  # NEW

Reduce CLI errors:
Syntax errors: mcpc call linear_list_issues instead of mcpc @linear tools-call list_issues. Resolved after mcpc --help.


## Code mode
- Emit tools to dirs ("codegen" variant?) - see https://cursor.com/blog/dynamic-context-discovery - generate skills file too?
- feature: enable generation of TypeScript stubs based on the server schema, with access to session and schema validation, for TS code mode.
  For simplicity they an just "mcpc" command, later we can use IPC for more efficiency.
- Similar for .sh scripts? but is it worth it?


## Nice to have

- $ mcpc @apify tools-call search-apify-docs query:="test"
  Should skip `structuredContent` in results if there is `content` with "type": "text", and print it as text. AI agents can use --json
  Just check we skip JSON formatted "type": "text",

- Unify colors used across all helps and commands for: profile (violet), commands (turqois?), session, tool names, param names

- Add support for "mcpc close @session" and "mcpc restart @session" aliases - add info only to "mcpc help restart" or "mcpc 
  help close", no need to mention this in main --help

- "login" and "logout" commands could work also with file:entry and @session, just use the remote server URL from the config file or session host.
  it would make "connect" and "login" command consistent. Restart of expired OAuth session is too many steps - why not add "mcpc login  
  <session>" to refresh? 

- ux: Be even more forgiving with `args:=x`, when we know from tools/prompt schema the text is compatible with `x` even if the exact type is not - 
  just re-type it dynamically to make it work.
- security: For auth profiles, fetch the detailed user info via http, save to profiles.json and show in 'mcpc', ensure the info is up-to-date
- nit: Implement typing tab-completions (e.g. "mcpc @ap...") - not sure if that's even possible
- Consider adding `--dry-run` https://justin.poehnelt.com/posts/rewrite-your-cli-for-ai-agents/
  For tool call it could return synthetic resutls conforming the schema.
- Show protocolVersion also for stdio in "mcpc --json" - but for that we need to update the SDK to save it! See setProtocolVersion

- consider adding --idle-timeout to "connect" and then automatically disconnect from remote server, to avoid handing infinitely


## Later

- `--capabilities '{"tools":...,"prompts":...}"` to limit access to selected MCP features and tools,
  for both proxy and normal session, for simplicity. The command could work on the fly, to give
  agents less room to wiggle.

- Add unique Session.id and Profile.id and use it for OS keychain keys, to truly enable using multiple independent mcpc profiles.

