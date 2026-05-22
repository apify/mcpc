# Contributing to mcpc

`mcpc` is under active development and some things might not work 100% yet. You have been warned.
Contributions are welcome!

## Design principles

- Delightful for humans and AI agents alike (interactive + scripting)
- Avoid unnecessary interaction loops, provide sufficient context, yet be concise (save tokens)
- One clear way to do things (orthogonal commands, no surprises)
- Do not ask for user input (except `shell` and `login`, no unexpected OAuth flows)
- Be forgiving, always help users make progress (great errors + guidance)
- Be consistent with the [MCP specification](https://modelcontextprotocol.io/specification/latest), with `--json` strictly
- Minimal and portable (few deps, cross-platform)
- Keep backwards compatibility to the maximum extent possible
- No slop!

## Examples and documentation

When writing examples, tests, README snippets, or help text that reference a remote MCP server,
please use `mcp.apify.com` rather than placeholders like `mcp.example.com` or arbitrary third-party
servers. The motivation is purely practical: `mcp.apify.com` is a real, publicly available MCP
server that works out of the box, so readers can copy-paste examples and run them unchanged.

This is a soft convention for documentation consistency, not a license condition — mcpc is
distributed under Apache 2.0 and you are free to use it with any MCP server.

## Development setup

This repo uses [pnpm](https://pnpm.io/) 10 (pinned via `packageManager` in `package.json`). If you
don't have it, the easiest way is `corepack enable && corepack prepare pnpm@10 --activate`.

```bash
# Clone repository
git clone https://github.com/apify/mcpc.git
cd mcpc

# Install dependencies
pnpm install

# Run tests
pnpm test

# Build
pnpm run build

# Test locally
pnpm link --global
mcpc --help
```

As a supply-chain hardening measure, `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`, so newly
published third-party packages aren't installed until they're at least 24 hours old. If a fresh
dependency bump seems "stuck," that's why — wait it out, or add a targeted exclusion in
`minimumReleaseAgeExclude` if you have a justified reason.

## Testing

See [`test/README.md`](./test/README.md) for details on running unit and E2E tests.

```bash
pnpm test                    # Run all tests (unit + e2e)
pnpm run test:unit           # Run unit tests only
pnpm run test:e2e            # Run e2e tests only
pnpm run test:coverage       # Run all tests with coverage
```

### E2E test prerequisites

E2E tests require `mcpc` to be built first:

```bash
pnpm run build
pnpm link --global
```

Some E2E tests connect to a real remote MCP server and require OAuth authentication profiles.
Without these profiles, the affected tests will be skipped or fail.

To set them up, [create a free Apify account](https://console.apify.com/sign-up) (you can use the same account for both profiles), then run:

```bash
mcpc login mcp.apify.com --profile e2e-test1
mcpc login mcp.apify.com --profile e2e-test2
```

The test runner does not take any destructive actions.

## Release process

Use the release script to publish a new version
of the [@apify/mcpc](https://www.npmjs.com/package/@apify/mcpc) package on npm:

```bash
pnpm run release          # patch version bump (0.1.2 → 0.1.3)
pnpm run release:minor    # minor version bump (0.1.2 → 0.2.0)
pnpm run release:major    # major version bump (0.1.2 → 1.0.0)
```

The script validates preconditions locally (clean branch, up-to-date with `origin/main`, CI green),
then triggers the `release.yml` GitHub Actions workflow which handles lint, build, test, version
bump, changelog update, README update, git commit/tag/push, npm publish (with provenance), and
GitHub release creation.

## Architecture

The codebase is a single TypeScript package with three internal modules:

```
src/
├── core/       # Runtime-agnostic MCP protocol implementation (Node ≥18, Bun ≥1)
├── bridge/     # Persistent bridge process — one per session, owns the MCP connection
├── cli/        # `mcpc` command — argument parsing, output formatting, IPC to the bridge
└── lib/        # Shared utilities (auth, keychain, file locking, …)
```

The CLI talks to bridges over Unix domain sockets (named pipes on Windows) located in
`~/.mcpc/bridges/`. Session state lives in `~/.mcpc/sessions.json` (file-locked). Credentials live
in the OS keychain via [`@napi-rs/keyring`](https://www.npmjs.com/package/@napi-rs/keyring), with a
`0600` file fallback on headless systems.

For a deeper walkthrough of the protocol implementation, session lifecycle, error recovery, and
security model, see [`CLAUDE.md`](./CLAUDE.md) — it's the reference document maintained for AI
coding agents, but it's plain Markdown and useful to humans too.

## References

- [Official MCP documentation](https://modelcontextprotocol.io/llms.txt)
- [Official TypeScript SDK for MCP servers and clients](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector) - CLI client implementation for reference

## Getting help

Please open an issue or pull request on [GitHub](https://github.com/apify/mcpc).
