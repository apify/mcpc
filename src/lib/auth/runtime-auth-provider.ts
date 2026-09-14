/**
 * Bearer-token auth provider for the bridge's long-running connections.
 *
 * Wraps an `OAuthTokenManager` in the MCP SDK's minimal `AuthProvider` shape:
 * `token()` hands the transport a valid access token before every request
 * (refreshing it when the local clock says it expired), and `onUnauthorized()`
 * runs when the server rejects a request with HTTP 401 anyway — the transport
 * then retries that request once with the refreshed token.
 *
 * The full `OAuthClientProvider` is deliberately not used here: given one, the
 * SDK answers a 401 with its own `auth()` flow, which either refreshes at
 * whatever authorization server the MCP server's metadata points at today
 * (bypassing the issuer the profile is pinned to) or, without a refresh token
 * in sight, starts an interactive authorization that a background process can
 * never complete (#395). The token manager keeps both decisions in mcpc.
 */

import type { AuthProvider } from '@modelcontextprotocol/client';
import type { OAuthTokenManager } from './oauth-token-manager.js';
import { createLogger } from '../logger.js';

const logger = createLogger('runtime-auth-provider');

export function createRuntimeAuthProvider(tokenManager: OAuthTokenManager): AuthProvider {
  return {
    token: () => tokenManager.getValidAccessToken(),
    onUnauthorized: async () => {
      logger.info('Server rejected the access token (HTTP 401), refreshing it and retrying');
      // Throws an AuthError with a re-login hint when the refresh token is rejected
      // too; the transport surfaces it and the bridge marks the session unauthorized.
      await tokenManager.refreshAccessToken({ force: true });
    },
  };
}
