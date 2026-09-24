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
 * server-declared only) or does not implement (MCP Apps) are absent by construction.
 *
 * Tasks appear twice, once per protocol generation: the top-level `tasks` capability is
 * the 2025-11-25 core feature (a legacy server reads it from `initialize`), and the
 * `io.modelcontextprotocol/tasks` entry in `extensions` is the 2026-07-28 extension (a
 * modern server reads it from every request's `_meta`). Capabilities are declared before
 * the protocol version is negotiated, so this cannot branch on the server's version, and
 * each era ignores the other's spelling.
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
