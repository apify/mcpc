

- object caching in session!!!

- Ensure we show tool annotations and tasks in text mode too
- Handle MCP errors by failing the command tool, e.g. invalid tool name..

- add "mcpc --close-all" command to clean up old sessions
- logs are not working...


- nit: on server/session info, print also auth info
  - [Using session: apify-docs] => change to show server + transport + version?
    Active MCP sessions:
    @fs → npx (stdio) --- show also args instead of just "npx"
  - 
- nit: If tool response has `structuredContent` and `content:` [ type: 'text', 'text': ... }], print the latter as Markdown in text mode and skip the structuredContent

E2E tests
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
- Can we track test coverage also this way?


Later
- nit: Colorize output, e.g. JSONs in one color. MCP provided data like descriptions and instructions in orange.
- nit: in Readme, explain the MCP commands better


