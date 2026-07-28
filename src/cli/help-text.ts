/**
 * Shared help-text building blocks for the CLI commands defined in index.ts
 *
 * `--help` output is mcpc's primary documentation surface (agents discover the CLI
 * purely by running it), so the text that more than one command needs lives here
 * instead of being repeated — or drifting — across command definitions.
 */

import { jsonHelp } from './output.js';

/** Base URL of the MCP schema reference the `--json` help sections link to */
export const SCHEMA_BASE = 'https://modelcontextprotocol.io/specification/2025-11-25/schema';

/**
 * The one JSON shape every server-details command returns: MCP `InitializeResult`
 * extended with `toolNames` and an `_mcpc` metadata block. `connect` returns an array
 * of these (one per session), the session details screens return a single one.
 */
const SERVER_DETAILS_JSON_SHAPE =
  '{ protocolVersion?, capabilities?, serverInfo?, instructions?, toolNames?, _mcpc: { sessionName, server?, ... } }';

const SERVER_DETAILS_JSON_META = 'extended with `toolNames` and `_mcpc` metadata';

/**
 * The shared description of that output: what a command returns and the shape example
 * for it. Rendered two ways below — as the standard `jsonHelp()` block, or as one inline
 * sentence — so the wording and the example never drift between the two.
 */
function serverDetailsJson(returns: 'object' | 'array'): { subject: string; shape: string } {
  return returns === 'array'
    ? {
        subject: 'Array of `InitializeResult` objects (one per session),',
        shape: `\`[${SERVER_DETAILS_JSON_SHAPE}]\``,
      }
    : { subject: '`InitializeResult` object', shape: `\`${SERVER_DETAILS_JSON_SHAPE}\`` };
}

/**
 * Standard "JSON output (--json):" block for the commands that print server details:
 * `connect` (an array of entries) and `restart` (the details of the restarted session).
 */
export function serverDetailsJsonHelp(returns: 'object' | 'array'): string {
  const { subject, shape } = serverDetailsJson(returns);
  return jsonHelp(
    `${subject} ${SERVER_DETAILS_JSON_META}`,
    shape,
    `${SCHEMA_BASE}#initializeresult`
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
Schema: ${SCHEMA_BASE}#initializeresult
`;
})();
