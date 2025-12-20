

- nit: If tool response has `structuredContent` and `content:` [ type: 'text', 'text': ... }], print the latter as Markdown in text mode
- on server/session info, print also auth info
- validate new session name
- nit: Colorize output, e.g. JSONs in one color. MCP provided data like descriptions and instructions in orange.
- Check if we show tool annotations

- [Using session: apify-docs] => change to show server + transport + version?

- add "mcpc --close-all" command to clean up old sessions

- add end-to-end tests e.g. under `test/e2e` - one bash script per test suite , organized in directories, and one master script that runs them all or selected ones (per directory) in parallel
  - pagination
  - stdio + filesystem operations,
  - sessions
  - for all commands, tests --verbose doesn't print anything extra to stdout, --json returns json
