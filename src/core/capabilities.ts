/**
 * Client capabilities advertised by mcpc during connection.
 */

import type { ClientCapabilities } from '@modelcontextprotocol/client';
import { clientExtensionDeclarations } from './extensions.js';

/**
 * Build the MCP client capabilities mcpc advertises to servers.
 *
 * Only capabilities mcpc actually implements are declared. In particular,
 * `sampling` and `roots` are NOT declared: mcpc has no LLM to answer
 * `sampling/createMessage` and registers no `roots/list` handler, so declaring
 * them would invite server requests that can only fail with "Method not found".
 *
 * The `extensions` map comes from `src/core/extensions.ts`, which tracks every official
 * MCP extension and mcpc's support for it. Extensions a client cannot declare (skills is
 * server-declared only) or does not implement (MCP Apps, the 2026-07-28 tasks extension)
 * are absent by construction.
 *
 * Kept as a single source of truth so it can evolve per protocol generation:
 * `tasks` will move into the negotiated `extensions` map once the SDK exposes the
 * `2026-07-28` Tasks extension — this is the single place to make that switch.
 *
 * Capabilities are declared before the protocol version is negotiated, so this cannot
 * branch on the server's version.
 */
export function buildClientCapabilities(): ClientCapabilities {
  return {
    tasks: {
      list: {},
      cancel: {},
    },
    extensions: clientExtensionDeclarations(),
  };
}
