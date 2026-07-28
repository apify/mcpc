/**
 * Shared help-text building blocks for the CLI commands defined in index.ts
 *
 * `--help` output is mcpc's primary documentation surface (agents discover the CLI
 * purely by running it), so the text that more than one command needs lives here
 * instead of being repeated — or drifting — across command definitions.
 */

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
 */
const SERVER_DETAILS_JSON_SHAPE =
  '{ protocolVersion?, supportedVersions?, capabilities?, serverInfo?, instructions?, _meta?, toolNames?, _mcpc: { sessionName, server?, ... } }';

const SERVER_DETAILS_JSON_META = 'extended with `toolNames` and `_mcpc` metadata';

/** Which MCP result the shape mirrors, per protocol era. */
const SERVER_DETAILS_JSON_ERAS =
  '`InitializeResult` on MCP 2025-11-25, `DiscoverResult` on 2026-07-28';

/**
 * The shared description of that output: what a command returns and the shape example
 * for it. Rendered two ways below — as the standard `jsonHelp()` block, or as one inline
 * sentence — so the wording and the example never drift between the two.
 */
function serverDetailsJson(returns: 'object' | 'array'): { subject: string; shape: string } {
  return returns === 'array'
    ? {
        subject: `array of server details objects, one per session (${SERVER_DETAILS_JSON_ERAS}),`,
        shape: `\`[${SERVER_DETAILS_JSON_SHAPE}]\``,
      }
    : {
        subject: `server details object (${SERVER_DETAILS_JSON_ERAS})`,
        shape: `\`${SERVER_DETAILS_JSON_SHAPE}\``,
      };
}

/** Both handshake-result schemas, each on the spec page whose anchor resolves. */
const SERVER_DETAILS_SCHEMA_URLS = `${LEGACY_SCHEMA_BASE}#initializeresult (2025-11-25), ${SCHEMA_BASE}#discoverresult (2026-07-28)`;

/**
 * Standard "JSON output (--json):" block for the commands that print server details:
 * `connect` (an array of entries) and `restart` (the details of the restarted session).
 */
export function serverDetailsJsonHelp(returns: 'object' | 'array'): string {
  const { subject, shape } = serverDetailsJson(returns);
  return jsonHelp(
    `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${SERVER_DETAILS_JSON_META}`,
    shape,
    SERVER_DETAILS_SCHEMA_URLS
  );
}

/**
 * Same content as one inline sentence, for the `mcpc @session` help screen. A
 * "JSON output (--json):" heading there would read as if it described every subcommand
 * listed above it, while it only applies to the no-command details output.
 */
export const SERVER_DETAILS_JSON_HELP_INLINE = ((): string => {
  const { subject, shape } = serverDetailsJson('object');
  return `With --json, returns the ${subject} ${SERVER_DETAILS_JSON_META}:
${shape}
Schema: ${SERVER_DETAILS_SCHEMA_URLS}
`;
})();
