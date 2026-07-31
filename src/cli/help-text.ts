/**
 * Shared help-text building blocks for the CLI commands defined in index.ts
 *
 * `--help` output is mcpc's primary documentation surface (agents discover the CLI
 * purely by running it), so the text that more than one command needs lives here
 * instead of being repeated — or drifting — across command definitions.
 */

import chalk from 'chalk';
import { jsonHelp } from './output.js';

/** Base URL of the MCP schema reference the `--json` help sections link to */
export const SCHEMA_BASE = 'https://modelcontextprotocol.io/specification/2026-07-28/schema';

/**
 * `InitializeResult`, `CreateTaskResult`, and `Task` are 2025-11-25-only concepts: the
 * 2026-07-28 stateless era dropped the `initialize` handshake in favor of `server/discover`
 * (returning `DiscoverResult`, not `InitializeResult`), and moved tasks out to the
 * `io.modelcontextprotocol/tasks` extension, which no longer appears in the core schema.
 * Those anchors only resolve on the legacy schema page, so link there instead of SCHEMA_BASE.
 */
export const LEGACY_SCHEMA_BASE = 'https://modelcontextprotocol.io/specification/2025-11-25/schema';

/**
 * The one JSON shape every server-details command returns: the server's handshake result
 * — MCP `InitializeResult` on 2025-11-25 connections, `DiscoverResult` on 2026-07-28 ones
 * — extended with `toolNames` and an `_mcpc` metadata block. `connect` returns an array of
 * these (one per session), the session details screens return a single one.
 *
 * `supportedVersions` and `_meta` only appear on 2026-07-28 connections (the legacy
 * handshake carries neither); `protocolVersion` is always the version actually in use.
 * `_mcpc` is abbreviated to keep the line short — run the command to see the block.
 */
const SERVER_DETAILS_JSON_SHAPE =
  '{ protocolVersion?, supportedVersions?, capabilities?, serverInfo?, instructions?, _meta?, toolNames?, _mcpc: { ... } }';

const SERVER_DETAILS_JSON_META = 'extended with `toolNames` and `_mcpc`';

/** Both handshake-result schemas, each on the spec page whose anchor resolves. */
const SERVER_DETAILS_SCHEMA_URLS = [
  `${LEGACY_SCHEMA_BASE}#initializeresult`,
  `${SCHEMA_BASE}#discoverresult`,
];

/**
 * Standard "JSON output (--json):" block for every command that prints server details:
 * `connect` (an array of entries), `restart` (the restarted session), and the `mcpc
 * @session` screen below.
 *
 * Which of the two results a caller gets follows from `protocolVersion`, so the eras are
 * named once — not per field and not per schema link. Help output has to stay skimmable.
 */
export function serverDetailsJsonHelp(returns: 'object' | 'array'): string {
  const subject =
    returns === 'array'
      ? 'Array of `InitializeResult` or `DiscoverResult` objects'
      : '`InitializeResult` or `DiscoverResult` object';
  const shape =
    returns === 'array' ? `\`[${SERVER_DETAILS_JSON_SHAPE}]\`` : `\`${SERVER_DETAILS_JSON_SHAPE}\``;
  return jsonHelp(`${subject} ${SERVER_DETAILS_JSON_META}`, shape, SERVER_DETAILS_SCHEMA_URLS);
}

/**
 * Titled "Output:" section describing what a command prints in human mode. Pairs with the
 * "JSON output (--json):" block below it — a loose sentence hanging off the command list
 * reads like a footnote next to a titled section. Pass several lines as an array.
 */
export function outputHelp(text: string | string[]): string {
  return `\n${chalk.bold('Output:')}\n  ${[text].flat().join('\n  ')}\n`;
}

/**
 * Trailing help for the `mcpc @session` screen: what the no-command invocation prints,
 * then the same JSON block every other server-details command shows.
 */
export const SESSION_DETAILS_HELP =
  outputHelp('When no command is given, shows session, server info, capabilities, and tools.') +
  serverDetailsJsonHelp('object');
