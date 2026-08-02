# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- New [REFERENCE.md](docs/REFERENCE.md) with the full `--help` output of every mcpc command, generated from the CLI itself so it always matches the release.
- `mcpc @session` and `server-discover` now show the description and website URL a server advertises about itself, right below its name.

### Fixed

- `mcpc help tools/list` and other MCP method names now show the command's help instead of failing with "Unknown command" — they already worked as aliases everywhere else.

## [0.6.0] - 2026-08-02

### Added

- mcpc can now be installed with Homebrew on macOS and Linux: `brew install apify/tap/mcpc`. The formula brings its own Node.js, so no separate runtime setup is needed.
- New `mcpc login <server> --grant id-jag` for MCP's [Enterprise-Managed Authorization](https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization) extension: sign in once with your corporate SSO (`--idp <issuer>`), and mcpc obtains MCP server tokens via identity assertion grants (ID-JAG) without per-server consent screens.
- Support for MCP protocol version 2026-07-28: mcpc now probes each server with `server/discover` and talks the new stateless protocol when supported, falling back to older protocol versions (2025-11-25 down to 2024-10-07) automatically. Resource subscriptions use the new `subscriptions/listen` stream (with automatic re-listen on drops), and `ping` transparently uses `server/discover` on 2026-07-28 servers. mcpc now uses the official TypeScript SDK v2 (`@modelcontextprotocol/client`).
- `mcpc --json` now reports each session's server `capabilities`, plus `hasInstructions` to tell whether the server provided instructions (read them with `mcpc --json @<session>`).
- New `--protocol-version` option for `mcpc connect` to pin the MCP protocol version (e.g. `--protocol-version 2025-11-25`) instead of auto-negotiating; the connection fails if the server does not support the pinned version. Also supported as a `protocolVersion` field in mcp.json config entries.
- New `mcpc @<session> server-discover` command that sends a `server/discover` request and reports what the server advertises right now: every protocol version it supports, its capabilities, instructions, and `_meta`. Requires a 2026-07-28 connection, where `ping` is also translated into `server/discover` — the ping output now says so.
- Server details from 2026-07-28 servers now include everything their `server/discover` result carries: `supportedVersions` (every protocol version the server offers) and the result's `_meta`. Reported by `connect`, `restart` and `mcpc @session` in `--json`, and kept in `sessions.json`.

### Changed

- Session commands now also accept MCP's JSON-RPC method names (e.g. `tools/list`, `logging/setLevel`) as aliases for the hyphenated CLI form (`tools-list`, `logging-set-level`).
- On servers using MCP 2026-07-28, `logging-set-level` returns an error (the protocol removed `logging/setLevel`) and the task commands (`tasks-list`, `tasks-get`, `tasks-result`, `tasks-cancel`, `tools-call --task/--detach`) report that the new tasks extension is not supported yet — they keep working unchanged on 2025-11-25 servers.
- `mcpc @session` now reports the connection on one line — `MCP: version 2025-11-25 / Streamable HTTP (stateless)` — naming the protocol (the label was just `Protocol:`) and the transport carrying it. `--json` gained the matching `_mcpc.transport` field next to `_mcpc.stateless`.
- `mcpc @session` no longer suggests commands that cannot work on a 2026-07-28 connection: the `logging` and `tasks` capabilities are flagged as era-limited, and `logging-set-level` / `tasks-*` are left out of the suggested commands.
- `tools-call --task/--detach` against a server that does not support task-augmented tool calls now fails instead of printing a warning and running the tool synchronously. The flags change the shape of the output, so the fallback left `--detach` callers parsing a `taskId` that was never there, with exit code 0.
- Updated the MCP TypeScript SDK v2 to the stable `2.0.0` release, which fixes interoperability with 2026-07-28 servers built on the latest SDK (they require the new `Mcp-Method` request header that older clients did not send, and move `serverInfo` into response metadata).

### Fixed

- `mcpc login --grant client-credentials` now finds the authorization server via protected resource metadata (RFC 9728), so it works against servers whose authorization server lives on a different origin. Previously discovery only probed the MCP server's own origin and failed with "Could not find an OAuth token endpoint", forcing you to pass `--token-endpoint` by hand.
- Sessions resumed after a bridge restart (e.g. crash recovery) no longer lose their negotiated protocol version: session details showed `Protocol: unknown` and, worse, requests were sent without the required `MCP-Protocol-Version` header. The stored version is now restored on resumption, and the server name is shown again in session details.
- Resumed sessions also keep their server capabilities and instructions, which previously vanished after a bridge restart: `mcpc @session` showed no capabilities, `grep` no longer found the server instructions, and `resources-subscribe` wrongly refused with "server does not support resource subscriptions".
- `mcpc login` no longer prints the SDK warning about a missing `discoveryState()` implementation. The OAuth provider now records the discovered authorization server between the redirect and the code exchange, enabling the SEP-2352 mix-up attack check (the code is only redeemed at the server that minted it).
- Bridge logs no longer report the spurious `authProvider.tokens() is NOT a function - this is a bug!` error when connecting with OAuth — a stale debug check left over from the SDK v1 era; authentication itself was unaffected.
- `tools-list` now always refetches from the server: against a 2026-07-28 server that sends caching hints, the SDK's response cache could serve a stale tools list. The cached list also honors the server's `ttlMs` hint now, instead of always using mcpc's own freshness window.
- Bridge logs no longer show a scary `Transport error: ... Bad Request: No valid session ID provided` stack trace when connecting to a server without 2026-07-28 support. That HTTP 400 is the server declining the `server/discover` version probe — the expected signal to fall back to the older protocol — and is now logged as a single debug line.

### Deprecated

- The `logging-set-level` command is deprecated and will be removed in a future release: MCP 2026-07-28 removed the underlying `logging/setLevel` request. It keeps working on 2025-11-25 servers during the deprecation window.

### Security

- Releases now verify that every dependency in the lockfile has been published long enough to clear the supply-chain quarantine, and fail if anything is too young. pnpm applied that policy only when resolving new versions, so nothing previously checked it at release time.

## [0.5.1] - 2026-07-28

### Changed

- Updated dependencies, including the MCP TypeScript SDK to 1.30.0.
## [0.5.0] - 2026-07-21

### Changed

- Installing mcpc is now much smaller and faster: the viem library used by the experimental x402 payment feature is bundled into a single ~650 KB tree-shaken file at build time instead of installing its ~70 MB dependency tree, and the npm package no longer ships README media (download shrinks from ~7 MB to ~0.4 MB).
- Commands start much faster (typically ~150 ms instead of ~700 ms): x402/viem, the OAuth login stack, spinners, and the proxy layer are now loaded only when actually used.
- `mcpc x402` (with no subcommand) now shows your wallet info and funding QR code instead of the command help. Run `mcpc help x402` for the full command reference. The `mcpc x402 info` subcommand is deprecated in favor of bare `mcpc x402` and will be removed in a future release.

### Fixed

- The "OS keychain unavailable" warning no longer repeats on every command. It is now shown once, at the moment credentials are first stored in the fallback file (`~/.mcpc/credentials.json`).
- `mcpc login` now explains OAuth client-registration failures with actionable guidance (use `--client-id` or `--client-metadata-url`) instead of surfacing a raw SDK JSON parse error. This affects servers that reject Dynamic Client Registration, such as Figma's remote MCP server, which only accepts an allow-list of approved clients.
- Tool calls are no longer silently re-executed after a bridge crash or IPC timeout — a slow non-idempotent tool (payment, deploy) could previously run twice. The session is still reconnected automatically, and the error now says whether the call may have executed.
- `tools-call` and `tasks-result` now exit with code 2 when the tool result reports an error (`isError`), matching the documented exit codes so shell scripts chaining on `&&` stop on failure.
- `mcpc <@session> tools-call <tool> --help` now prints the tool's parameter schema as intended, instead of the generic command help.
- Fixed the `--proxy` MCP server: it now validates `Host`/`Origin` headers to block DNS-rebinding attacks from web pages, supports multiple client sessions, and actually terminates sessions on HTTP DELETE (previously the second client to connect was locked out until restart).
- Recovering the result of an async task after a bridge crash now returns the tool's real output instead of a placeholder status message.
- A corrupted `sessions.json` is now backed up and reported instead of being silently reset, which permanently deleted all session records on the next save.
- Very large integer arguments (e.g. snowflake IDs like `id:=12345678901234567890`) are now passed as strings instead of silently losing precision.
- Closing a session with a local stdio server now waits for the full shutdown sequence (close stdin → SIGTERM → SIGKILL) instead of abandoning it after 1 second, which could leave orphaned server processes.
- `mcpc login` flag-validation mistakes now exit with code 1 (client error) instead of 4, and JSON-mode errors consistently include the exit `code` field.
- Fixed list pagination to detect repeated cursors from misbehaving servers instead of looping forever.
- A one-off `--timeout` no longer leaks into subsequent requests on the same session.
- Errors from `close` and `restart` are no longer printed twice.

### Security

- mcpc no longer advertises the `sampling` and `roots` MCP capabilities it does not implement, so servers won't send requests that can only fail.
- The fallback bridge socket directory under the system temp dir is now verified to be a real directory owned by the current user before use.

## [0.4.0] - 2026-06-25

### Added

- `mcpc login --grant client-credentials` adds machine-to-machine OAuth (no browser) for headless use such as CI/CD and daemons, implementing the [`io.modelcontextprotocol/oauth-client-credentials` extension](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials). Authenticate with a client secret (`--client-id`/`--client-secret`) or a signed JWT assertion (`--client-key`/`--client-key-alg`); the saved profile then works with `connect` like any other.
- `mcpc login --callback-host <host>` to set the host used in the OAuth callback redirect URI: `127.0.0.1` (default) or `localhost`, for servers whose pre-registered OAuth client only accepts the `localhost` form. The callback server itself still binds only to the loopback IP (#269).
- `resources-read` can now save resources to a local file with `-o <file>` (binary-safe, decodes base64 `blob` content) and print bare content for piping with `--raw`. The default human view shows text content in a fenced block and summarizes binary content instead of dumping it to the terminal.
- `mcpc help --skill` prints a built-in agent skill guide (mental model, workflows, and examples) that ships with the package and always matches the installed version, so agents can learn mcpc without a separate skill file.

### Changed

- mcpc now requires **Node.js 22.12.0 or later**. Support for Node.js 20, which reached end-of-life in April 2026, has been dropped.
- `resources-subscribe <uri> <file>` now keeps a local file in sync with the resource: it downloads the resource to `<file>` and rewrites it whenever the server announces a change. Subscriptions survive session restarts; `resources-unsubscribe` stops the sync and keeps the file. Previously these commands sent the subscribe/unsubscribe requests without acting on the notifications.
- `resources-read --max-size <bytes>` was removed; the option was accepted but never enforced. Use `--max-chars` to limit human-readable output.

### Removed

- The interactive `shell` command (`mcpc shell @<session>` and `mcpc @<session> shell`), deprecated in 0.3.1, has been removed. Run individual `mcpc @<session> <command>` invocations instead. Server log messages (`notifications/message`), previously shown only in the shell, are now written to the bridge log — view them with `mcpc @<session> logs`.

### Fixed

- `mcpc login` now works when the server URL includes a query string (e.g. `https://mcp.apify.com/?tools=search-actors,docs`). The query is a connection-level filter, not part of the server's OAuth identity, so it is no longer sent during OAuth discovery — previously it broke discovery and made login fail with a `404 ... POST /register` error.
- The hosted OAuth Client ID Metadata Document now includes the required `client_id` property, so authorization servers that validate CIMD documents per spec no longer reject `mcpc login` with the default client identity (#271).
- Sessions no longer hang on macOS under the Bun runtime (e.g. when connecting with `--proxy-bearer-token`, or auto-reconnecting a crashed session). The bridge now runs under the same runtime as the CLI, avoiding a cross-binary OS-keychain read that macOS blocks with a password prompt in non-interactive contexts. A Bun user also no longer needs Node installed for the bridge to start.
- OAuth login failures now report the authorization server's actual error (e.g. `invalid_client`) instead of an opaque `[object Response]` message, and no longer crash the process on Windows when a token request is rejected.
- `mcpc <session> restart` now terminates the previous MCP session on the server before reconnecting, so the old session and its resource subscriptions are no longer left orphaned (previously leaked on Windows).

## [0.3.1] - 2026-06-08

### Added

- `mcpc @<session>` now reports the negotiated MCP protocol version and whether the connection is stateful (a stdio process, or an HTTP server that assigned a session id) or stateless (an HTTP server that assigned none — the upcoming `2026-07-28` model). A `stateless` field is exposed under `_mcpc` in the `--json` output of `mcpc @<session>` and `mcpc connect`, and on each session in the session list: `true` when stateless, `false` when stateful, and `null` while the mode is not yet known. Stateless sessions are never marked `expired` on a transient `404` (they hold no session to lose).
- `mcpc @<session> logs` command to show or follow the bridge log file. Supports `-n/--tail <n>` (default 50), `--follow` to stream new lines, and `--since <duration|iso>` (e.g. `1h`, `30m`, `2026-04-28T12:00:00Z`). Transparently spans rotated files (`.log.1` … `.log.5`) when more lines are needed. With `--json`, returns parsed `{ time, level, context?, msg }` records (continuation lines such as stack traces fold into the preceding entry's `msg`; lines that aren't standard log entries become `{ raw }`); combined with `--follow`, output is JSONL. `mcpc @<session> --json` now also exposes `_mcpc.logPath`. Error messages that previously pointed users to a raw log file path now suggest `mcpc @<session> logs` instead (#205).

### Changed

- `mcpc connect` now waits for every connection to finish before reporting status. Bulk and auto-discovery connects (`mcpc connect`, `mcpc connect <file>`) previously returned immediately with an optimistic `connecting` status in human mode; they now behave like single-server connects and `--json`, showing each server as connected or failed (bounded by `--timeout`) with a progress spinner while connecting.

### Deprecated

- The `shell` command (`mcpc shell @<session>` and `mcpc @<session> shell`) is deprecated and will be removed in a future release. It is now hidden from `--help` output and prints a deprecation warning when invoked

### Removed

- `mcpc connect` no longer auto-connects to `mcp.apify.com` as `@apify` when the `APIFY_API_TOKEN` environment variable is set. Connect to it like any other server — `mcpc connect mcp.apify.com` — authenticating with `mcpc login` or `--header "Authorization: Bearer ..."`.

### Fixed

- `--timeout` now bounds the wait while a session connects to its server. The bridge health check that runs as a session starts previously ignored `--timeout`, so connecting to a slow or unreachable server could block for up to the 3-minute default regardless of a shorter `--timeout`.
- `mcpc connect` (with no arguments) no longer silently ignores config files it can't use. Files with an empty servers object are listed as `0 servers`, and files that fail to load — invalid JSON, a project config missing a `mcpServers`/`servers` property, or an unreadable file — are listed as `(invalid)` with the reason, instead of being dropped or misreported as `No MCP config files found`.
- `mcpc connect` now prints config file paths so they can be copy-pasted directly: paths containing spaces (e.g. macOS `Library/Application Support/...`) are quoted instead of being split when pasted into a shell.
- `mcpc connect` no longer fails with `socket file not created within timeout` when the bridge is slow to start (CPU-constrained machines, many parallel connects). The startup window is more generous, and a bridge that crashes on startup now reports its exit code immediately instead of stalling until the timeout
- Sessions no longer fail to start with `Bridge process exited during startup` when the mcpc home directory (or `MCPC_HOME_DIR`) resolves to a deep path — notably macOS temp dirs like `/var/folders/...` — or when a session name is very long. The bridge's Unix socket path was exceeding the operating system limit (104 bytes on macOS, 108 on Linux); such paths now fall back to a short location under the system temp directory
- `mcpc @<session> restart` (and other session startups) no longer intermittently fail with `Failed to connect to bridge: connect ECONNREFUSED` during rapid restarts. The CLI now briefly retries the first connection to a freshly started bridge while it is still (re)creating its socket

## [0.3.0] - 2026-05-20

### Added

- New **[EXPERIMENTAL]** `skills-list` and `skills-get` commands implementing the draft MCP skills extension (`io.modelcontextprotocol/skills`, [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640)). Marked experimental because the spec is still in draft and the index shape, recognized types, and capability key may change. Skills are discovered via the well-known `skill://index.json` resource, falling back to scanning `skill://*/SKILL.md` URIs. Supports all three SEP-2640 index entry types: `skill-md`, `archive` (`.tar.gz`/`.zip` bundles), and `mcp-resource-template`. Entries with unrecognized `type` values are skipped per spec. `skills-get <name>` reads a skill's `SKILL.md`; pass `--raw` to print just the markdown for piping to LLMs or files. The session overview lists `skills` under capabilities when a server advertises the extension under either `capabilities.extensions` (per spec) or `capabilities.experimental` (the SDK-preserved escape hatch). JSON shape: `[{ name, description, type, url }]` for `skills-list`, full `ReadResourceResult` for `skills-get`.
- `mcpc connect` (with no arguments) now auto-discovers standard MCP config files (`.mcp.json`, `mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `~/.claude.json`, Claude Desktop, Windsurf, Kiro, etc.) in the current directory and home directory, and connects every server defined across them. Entries with duplicate session names are deduplicated (project-scoped files win over global ones). VS Code's `"servers"` key is also supported.
- `mcpc connect` auto-connects to `mcp.apify.com` as `@apify` when the `APIFY_API_TOKEN` environment variable is set, using it as a Bearer token. Existing live sessions are reused without restart.
- `mcpc x402 sign` supports the x402 `upto` scheme alongside `exact`. Use `--scheme <auto|upto|exact>` to pick a preference (default `auto` prefers `upto`, falls back to `exact`). The signer auto-grants a one-time `USDC.approve(PERMIT2, MAX_UINT256)` allowance on first upto sign; pass `--no-approve` to skip.
- `mcpc connect --x402 [auto|upto|exact]` enables x402 auto-payment with an optional scheme preference. Bare `--x402` defaults to `auto` (prefer upto, fall back to exact). The choice is persisted to `sessions.json` and reused on `mcpc restart`. Flag position is unrestricted — `mcpc connect --x402 mcp.apify.com @s` and `mcpc connect mcp.apify.com @s --x402` both work.
- Sessions using x402 auto-payment now show a yellow `[x402]` marker in session listings, alongside the existing OAuth and proxy markers.

### Changed

- Stdio (command-based) config entries are now skipped by default when connecting from a config file (`mcpc connect <file>`). Pass `--stdio` to include them. Single-entry connects (`mcpc connect file:entry @session`) are not affected.
- x402 debug logs now announce the selected scheme (`scheme=upto` / `scheme=exact`) up front and print USD amounts with 6-decimal precision (USDC atomic unit). Enable with `--verbose` or `MCPC_VERBOSE=1`.
- **Breaking:** `mcpc connect --json` now always returns an array of `InitializeResult` objects (extended with `toolNames` and `_mcpc` metadata), regardless of whether you connect a single server, a config file, or auto-discover all configs. Skipped/failed entries carry `_mcpc.status` (`created` | `active` | `failed` | `skipped`) and `_mcpc.skipReason` / `_mcpc.error`. The previous wrapper-object shapes (`{configFile, results, skipped}` and `{discovered, results, skipped}`) have been removed.
- `tools-call --task` now prints the task ID and recovery commands when interrupted with Ctrl+C, so you can fetch or cancel the server-side task later
- Human-mode `tools-call` / `tasks-result` output no longer prints the **Structured content** section when **Content** already has at least one visible block. The JSON dump was redundant verbose output (especially for LLMs) whenever a server returned both. The section is still shown when `content` is empty or contains only a JSON-dump duplicate of `structuredContent`; use `--json` to always get the full payload

### Fixed

- `mcpc connect` and `mcpc restart` no longer fail with `ENOENT` when the macOS Keychain prompts for a password. Credentials are now read from the keychain _before_ the bridge process is spawned, so the bridge's IPC startup timer no longer races a foreground password dialog (#55)
- Background auto-reconnect now correctly marks sessions as `unauthorized` when the server returns 401/403, instead of leaving them stuck in `connecting` after the bridge crashed on an unhandled rejection
- Sessions using a static bearer token (via `--header "Authorization: ..."`) no longer flip between `unauthorized` and `connecting` on every `mcpc` invocation — they stay `unauthorized` until you `mcpc login` or reconnect. OAuth-profile sessions still auto-retry because tokens may have been refreshed by another session
- Stdio servers no longer fail silently: the bridge now captures the child's stderr, writes it to `~/.mcpc/logs/bridge-<session>.log`, and appends a tail of the most recent lines to `mcpc connect` errors. This makes it obvious when a stdio server crashes on startup due to e.g. missing TLS trust (`NODE_EXTRA_CA_CERTS`), missing proxy vars, or missing credentials (#195)
- `mcpc connect` now recognizes relative config-file paths with a `:entry` suffix (e.g. `docs/examples/mcp-config.json:fs`). Previously these were misinterpreted as HTTP URLs
- `mcpc login` now sends a random `state` parameter on the OAuth authorization URL. Some authorization servers (e.g. Ubersuggest) reject requests without `state` with a `missing_state` error, which previously made `login` fail before reaching the consent screen (#214)
- `mcpc connect` no longer aborts on Windows with `Failed to save sessions: EPERM: operation not permitted, rename …` when antivirus or another mcpc process briefly holds `sessions.json` open. The atomic rename used to persist `sessions.json`, `profiles.json`, and `wallets.json` now retries transient Windows file-lock errors with a short backoff

### Removed

- **Breaking:** Removed `tools`, `resources`, and `prompts` shorthand commands — use the full names (`tools-list`, `resources-list`, `prompts-list`) instead

### Security

- Migrated the dev/release toolchain to pnpm 10 with a 24-hour package quarantine (`minimumReleaseAge: 1440`) to reduce supply-chain attack risk. End-user installs from npm are unaffected

## [0.2.6] - 2026-04-15

### Added

- New `tasks-result <taskId>` command that fetches the final `CallToolResult` payload of an async task via the MCP `tasks/result` method. Blocks until the task reaches a terminal state, then prints the payload using the same renderer as `tools-call` (`--json` returns the raw result).
- Public [Client ID Metadata Document](https://apify.github.io/mcpc/client-metadata.json) hosted via GitHub Pages, giving every `mcpc` installation a consistent client identity on CIMD-capable authorization servers. `mcpc login` now uses this hosted document by default; override with `--client-metadata-url <url>` or disable with `--no-client-metadata-url` to force Dynamic Client Registration. The OAuth callback uses a fixed loopback port range (13316–13325) to match the registered redirect URIs.

### Changed

- Human-mode `tools-call` / `tasks-result` output now uses a structured layout: **Metadata** (`_meta`), **Content** (each text/resource/image block rendered per type), and **Structured content** (shown as JSON when not already present in a text block). Replaces the raw key-value dump with a cleaner, more readable format.

### Fixed

- `tools-get` "Call example" now wraps JSON values (arrays, objects, strings) in single quotes so they can be copy-pasted into a shell verbatim without being mangled by word-splitting (e.g., `outputFormats:='["markdown"]'` instead of `outputFormats:=["markdown"]`)

## [0.2.5] - 2026-04-15

### Added

- `mcpc connect <config-file>` connects all servers defined in a config file at once, auto-generating session names from entry names (e.g., `mcpc connect ~/.vscode/mcp.json`)
- `connect` auto-generates a session name when `@session` is omitted (e.g., `mcpc connect mcp.apify.com` creates `@apify`), reusing an existing session when auth settings match
- `--max-chars <n>` global option to truncate output to a given number of characters (ignored in `--json` mode)
- "Did you mean?" suggestions for unknown commands, including reversed names (e.g., `list-tools` → `tools-list`)
- `mcpc login --client-metadata-url <https-url>` flag adds support for [OAuth Client ID Metadata Documents (CIMD)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00). When the authorization server advertises `client_id_metadata_document_supported: true`, mcpc uses the URL as the `client_id`; otherwise it falls back to Dynamic Client Registration.

### Changed

- Session info JSON output (`mcpc @session --json`, `mcpc connect --json`) returns `toolNames` (array of strings) instead of full `tools` objects
- `--schema` and `--schema-mode` options scoped to `tools-get` and `tools-call` only (removed from `prompts-get`)

### Fixed

- `connect` now verifies the server responds before reporting success; shows a warning with the actual error when the server is unreachable
- HTTP 404 during initial connect no longer misclassified as "session expired"; error messages now include the actual HTTP error and server URL
- `mcpc login --json` now writes interactive prompts to stderr, so stdout contains only the final JSON result and is safe to pipe to `jq` or redirect to a file

## [0.2.4] - 2026-04-07

### Security

- Fixed XSS vulnerability in OAuth callback server: error messages from query parameters are now HTML-escaped before rendering
- Replaced `exec()` with `execFile()` in browser opening to prevent potential shell injection via crafted OAuth authorization URLs
- Added Host header validation to OAuth callback server to mitigate DNS rebinding attacks
- Set restrictive directory permissions (`0o700`) on `~/.mcpc/` and subdirectories to prevent local privilege escalation on shared systems

### Fixed

- Bridge ignores stored OAuth access token when no refresh token is provided; servers that don't issue refresh tokens now work correctly by using the access token as a static Bearer header
- Session incorrectly marked as `unauthorized` when access token expires but refresh token is still valid; bridge now attempts token refresh before giving up
- "ESC to detach" hint now shows immediately in the spinner when using `--task`, instead of waiting for the server to return a task ID

## [0.2.3] - 2026-03-31

## [0.2.2] - 2026-03-31

## [0.2.1] - 2026-03-30

### Added

- Secure x402 wallet storage using OS keychain integration with fallback to `wallets.json` for compatibility
- QR code display for wallet address in `x402 init`, `x402 import`, and `x402 info` commands, allowing users to scan and fund the wallet directly from the terminal

### Changed

- Auto-reconnect crashed and unauthorized bridge processes in the background when enumerating sessions (`mcpc` or `mcpc grep`), with a 10-second cooldown between reconnection attempts. Unauthorized sessions benefit from OAuth tokens refreshed by other sessions sharing the same profile.

### Fixed

- Fixed expired sessions falsely showing as `live` after auto-reconnect — the bridge now detects when the server did not resume the original MCP session (including when no session ID is returned) and marks the session as `expired`
- Bridge sends first keepalive ping 5 seconds after startup (instead of waiting the full 30-second interval) to detect stale sessions earlier

## [0.2.0] - 2026-03-24

### Added

- New `mcpc grep <pattern>` command to search tools, resources, prompts, and instructions across all active sessions, with regex, type filters, and single-session search support
- New `tasks-list`, `tasks-get`, `tasks-cancel` commands for managing async tasks on the server
- `--task` flag for `tools-call` to opt-in to task execution with progress spinner; `--detach` to start a task and return the task ID immediately; press ESC during `--task` to detach on the fly
- `--insecure` global option to skip TLS certificate verification
- `--client-id` and `--client-secret` options for `mcpc login`, for servers that don't support dynamic client registration
- `--no-profile` option for `connect` to skip OAuth profile auto-detection
- `mcpc login` now falls back to accepting a pasted callback URL when the browser cannot be opened (e.g. headless servers, containers)
- `tools-list` now shows inline parameter signatures (e.g. `read_file(path: string, +4 optional)`) for quick scanning without `--full`
- `mcpc @session` now shows available tools list from bridge cache (no extra server call)

### Changed

- **Breaking:** CLI syntax redesigned to command-first style. All commands now start with a verb; MCP operations require a named session.

  | Before                                        | After                                                      |
  | --------------------------------------------- | ---------------------------------------------------------- |
  | `mcpc <server> tools-list`                    | `mcpc connect <server> @name` then `mcpc @name tools-list` |
  | `mcpc <server> connect @name`                 | `mcpc connect <server> @name`                              |
  | `mcpc <server> login`                         | `mcpc login <server>`                                      |
  | `mcpc <server> logout`                        | `mcpc logout <server>`                                     |
  | `mcpc --clean=sessions`                       | `mcpc clean sessions`                                      |
  | `mcpc --config file.json entry connect @name` | `mcpc connect file.json:entry @name`                       |

  Direct one-shot URL access (e.g. `mcpc mcp.apify.com tools-list`) is removed; create a session first with `mcpc connect`.

- Revised session states: `unauthorized` (401/403), `disconnected` (bridge alive but server unreachable >2min), and `expired` (session ID rejected), each with actionable guidance
- When `--profile` is not specified, only the `default` profile is used; non-default profiles require an explicit `--profile` flag
- `@napi-rs/keyring` native addon is now loaded lazily; falls back to `~/.mcpc/credentials.json` when unavailable
- `--header` / `-H` option is now specific to the `connect` command instead of being a global option
- Tools cache now fetches all pages on startup and on `tools/list_changed` notifications

### Fixed

- HTTP proxy support (`HTTP_PROXY`/`HTTPS_PROXY`) now works for MCP server connections, OAuth token refresh, and x402 payment signing
- Explicit `--header "Authorization: ..."` now takes precedence over auto-detected OAuth profiles
- Fixed auth loss when reconnecting an unauthorized session via `mcpc connect`
- Session restart now auto-detects the `default` OAuth profile created after the session was established
- `--timeout` flag now correctly propagates to MCP requests via session bridge
- `--task` and `--detach` tool calls now correctly send task creation parameters to the server
- Bridge now forwards `logging/message` notifications to connected clients
- IPC buffer between CLI and bridge process is now capped at 10 MB, preventing unbounded memory growth
- Fixed `mcpc help <command>` showing truncated usage line

## [0.1.10] - 2026-03-01

### Added

- Support for `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` / lowercase variants env vars for outbound connections
- CI/CD automated test pipeline

### Changed

- Replaced deprecated `keytar` package with `@napi-rs/keyring` for OS keychain integration
- Temp files now written to `~/.mcpc/` instead of `/tmp/` to avoid cross-device rename errors on Linux
- Improved error messages for invalid server hostnames and mistyped commands (e.g. `mcpc login`)
- Added `prettier` formatting check to lint step

### Fixed

- Fixed `ExperimentalWarning: Importing JSON modules is an experimental feature` on Node.js 22+
- Fixed OAuth token refresh for servers with root-based discovery (`.well-known` at `/`)
- Fixed OAuth errors incorrectly expiring the session instead of failing gracefully

## [0.1.9] - 2026-02-02

### Added

- Added CHANGELOG.md for tracking changes
- Automated GitHub release creation in publish script

### Changed

- `tools-list` now shows a compact summary by default to support dynamic tool discovery
- Added `--full` flag to `tools-list` for detailed tool information
- Publish script now automatically updates CHANGELOG.md version on release

## [0.1.8] - 2026-01-21

### Changed

- Session is now marked as expired (not auto-reconnected) when server rejects MCP session ID
- Users must explicitly run `mcpc @session restart` to recover from expired sessions

### Fixed

- Fixed incorrect flagging of expired sessions as crashed
- Fixed session expiration detection for various error message formats
- Fixed help command output

## [0.1.7] - 2026-01-03

### Changed

- Documentation improvements and updates
- Various cosmetic improvements to CLI output

### Fixed

- Minor bug fixes

## [0.1.6] - 2026-01-02

### Added

- Session notifications with timestamps for tracking list changes (`tools/list_changed`, `resources/list_changed`, `prompts/list_changed`)

### Changed

- Renamed `_meta` to `_mcpc` in JSON output for MCP spec conformance
- Improved formatting of prompts output
- Various cosmetic improvements

### Fixed

- Fixed proxy server issues
- Fixed screenshot URL in README

## [0.1.5] - 2026-01-01

### Added

- Implemented `--proxy` option for exposing sessions as local MCP servers
- Added `mcpc @session restart` command

### Changed

- Renamed `session` command to `connect` for clarity
- Renamed "dead" session status to "crashed" for clarity

### Fixed

- Fixed `--timeout` option handling

## [0.1.4] - 2025-12-31

### Added

- Implemented `--schema` and `--schema-mode` options for tools
- Added `mcpc @session restart` command

### Changed

- Renamed `tools-schema` command to `tools-get`
- Improved formatting for prompts and tools output
- Security review and improvements

## [0.1.3] - 2025-12-29

### Added

- Initial public release
- Support for Streamable HTTP and stdio transports
- Session management with persistent bridge processes
- OAuth 2.1 authentication with PKCE
- Full MCP protocol support: tools, resources, prompts
- Interactive shell mode
- JSON output mode for scripting

[Unreleased]: https://github.com/apify/mcpc/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/apify/mcpc/compare/v0.5.0...v0.6.0
[0.5.1]: https://github.com/apify/mcpc/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/apify/mcpc/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/apify/mcpc/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/apify/mcpc/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/apify/mcpc/compare/v0.2.6...v0.3.0
[0.2.6]: https://github.com/apify/mcpc/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/apify/mcpc/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/apify/mcpc/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/apify/mcpc/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/apify/mcpc/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/apify/mcpc/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/apify/mcpc/compare/v0.1.10...v0.2.0
[0.1.10]: https://github.com/apify/mcpc/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/apify/mcpc/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/apify/mcpc/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/apify/mcpc/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/apify/mcpc/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/apify/mcpc/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/apify/mcpc/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/apify/mcpc/releases/tag/v0.1.3
