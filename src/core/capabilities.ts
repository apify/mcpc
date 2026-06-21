/**
 * Client capabilities advertised by mcpc during connection.
 */

import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';

/**
 * Capability key advertising client-credentials auth support, per the MCP extension
 * `io.modelcontextprotocol/oauth-client-credentials`.
 */
export const CLIENT_CREDENTIALS_EXTENSION_KEY = 'io.modelcontextprotocol/oauth-client-credentials';

/** Options influencing the advertised client capabilities for a given connection. */
export interface BuildClientCapabilitiesOptions {
  /**
   * Declare the `io.modelcontextprotocol/oauth-client-credentials` extension. Set
   * only for connections that authenticate with the client-credentials grant, so we
   * don't claim machine-to-machine auth on connections that don't use it.
   */
  clientCredentials?: boolean;
}

/**
 * Build the MCP client capabilities mcpc advertises to servers.
 *
 * Kept as a single source of truth so it can evolve per protocol generation:
 * - `roots` and `sampling` (and server-side `logging`) are deprecated as of `2026-07-28`
 *   (SEP-2577) but remain functional through at least 2027-07-28 and are still required by
 *   legacy servers, so we keep declaring them. Servers ignore capabilities they don't
 *   understand, so over-declaring against a newer server is harmless.
 * - `tasks` will move into the negotiated `extensions` map (a reverse-DNS id) once the SDK
 *   exposes the `2026-07-28` Tasks extension — this is the single place to make that switch.
 *
 * Capabilities are declared before the protocol version is negotiated, so this cannot
 * branch on the server's version.
 */
export function buildClientCapabilities(
  options: BuildClientCapabilitiesOptions = {}
): ClientCapabilities {
  return {
    roots: { listChanged: true },
    sampling: {},
    tasks: {
      list: {},
      cancel: {},
      requests: {
        sampling: { createMessage: {} },
      },
    },
    ...(options.clientCredentials
      ? { extensions: { [CLIENT_CREDENTIALS_EXTENSION_KEY]: {} } }
      : {}),
  };
}
