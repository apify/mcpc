# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Deprecated

- The `shell` command (`mcpc shell @<session>` and `mcpc @<session> shell`) is deprecated and will be removed in a future release. It is now hidden from `--help` output and prints a deprecation warning when invoked

## [0.3.0] - 2026-05-20

### Added

- `mcpc connect` (with no arguments) now auto-discovers standard MCP config files (`.mcp.json`, `mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `~/.claude.json`, Claude Desktop, Windsurf, Kiro, etc.) in the current directory and home directory, and connects every server defined across them. Entries with duplicate session names are deduplicated (project-scoped files win over global ones). VS Code's `"servers"` key is also supported.
- `mcpc connect` auto-connects to `mcp.apify.com` as `@apify` when the `APIFY_API_TOKEN` environment variable is set, using it as a Bearer token. Existing live sessions are reused without restart.
- `mcpc x402 sign` supports the x402 `upto` scheme alongside `exact`. Use `--scheme <auto|upto|exact>` to pick a preference (default `auto` prefers `upto`, falls back to `exact`). The signer auto-grants a one-time `USDC.approve(PERMIT2, MAX_UINT256)` allowance on first upto sign; pass `--no-approve` to skip.
- `mcpc connect --x402 [auto|upto|exact]` enables x402 auto-payment with an optional scheme preference. Bare `--x402` defaults to `auto` (prefer upto, fall back to exact). The choice is persisted to `sessions.json` and reused on `mcpc restart`. Use `--x402=<scheme>` when the flag is followed by positional arguments to avoid Commander's greedy parsing of the next token.
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

[Unreleased]: https://github.com/apify/mcpc/compare/v0.3.0...HEAD
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
