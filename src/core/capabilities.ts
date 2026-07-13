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
 * Only capabilities mcpc actually implements are declared. In particular,
 * `sampling` and `roots` are NOT declared: mcpc has no LLM to answer
 * `sampling/createMessage` and registers no `roots/list` handler, so declaring
 * them would invite server requests that can only fail with "Method not found".
 *
 * Kept as a single source of truth so it can evolve per protocol generation:
 * `tasks` will move into the negotiated `extensions` map (a reverse-DNS id) once the SDK
 * exposes the `2026-07-28` Tasks extension — this is the single place to make that switch.
 *
 * Capabilities are declared before the protocol version is negotiated, so this cannot
 * branch on the server's version.
 */
export function buildClientCapabilities(
  options: BuildClientCapabilitiesOptions = {}
): ClientCapabilities {
  return {
    tasks: {
      list: {},
      cancel: {},
    },
    ...(options.clientCredentials
      ? { extensions: { [CLIENT_CREDENTIALS_EXTENSION_KEY]: {} } }
      : {}),
  };
}
