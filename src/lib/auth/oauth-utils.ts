/**
 * Shared OAuth utilities for token discovery and refresh
 * Used by both CLI (token-refresh.ts) and bridge process
 */

import { createLogger } from '../logger.js';
import { AuthError } from '../errors.js';
import * as util from 'node:util';

const logger = createLogger('oauth-utils');

export const DEFAULT_AUTH_PROFILE = 'default';

/**
 * OAuth token endpoint response (per OAuth 2.0 spec - uses snake_case)
 */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * Discover OAuth token endpoint from server
 * Tries standard well-known endpoints per OAuth 2.0 and OpenID Connect specs
 */
export async function discoverTokenEndpoint(serverUrl: string): Promise<string | undefined> {
  const discoveryUrls = [
    `${serverUrl}/.well-known/oauth-authorization-server`,
    `${serverUrl}/.well-known/openid-configuration`,
  ];

  for (const url of discoveryUrls) {
    try {
      logger.debug(`Trying OAuth discovery at: ${url}`);
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
      });

      if (response.ok) {
        const metadata = await response.json() as { token_endpoint?: string };
        if (metadata.token_endpoint) {
          logger.debug(`Found token endpoint: ${metadata.token_endpoint}`);
          return metadata.token_endpoint;
        }
      }
    } catch {
      // Continue to next URL
    }
  }

  return undefined;
}

/**
 * Refresh an access token using a refresh token
 * This is the core refresh logic - callers handle storage and error recovery
 *
 * @param tokenEndpoint - The OAuth token endpoint URL
 * @param refreshToken - The refresh token to use
 * @param clientId - The OAuth client ID (required for public clients)
 * @returns The token response from the server
 * @throws AuthError if the refresh fails
 */
export async function refreshAccessToken(
  tokenEndpoint: string,
  refreshToken: string,
  clientId: string
): Promise<OAuthTokenResponse> {
  logger.debug(`Refreshing token at: ${tokenEndpoint}`);

  // Prepare refresh request (OAuth spec uses snake_case)
  // Public clients (token_endpoint_auth_method: 'none') must include client_id
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(`Token refresh failed: ${response.status} ${errorText}`);

    if (response.status === 400 || response.status === 401) {
      throw new AuthError('Refresh token is invalid or expired');
    }

    throw new AuthError(`Failed to refresh token: ${response.status} ${response.statusText}`);
  }

  const tokenResponse = await response.json() as OAuthTokenResponse;
  return tokenResponse;
}

/**
 * Discover token endpoint and refresh access token in one call
 * Convenience function that combines discovery and refresh
 *
 * @param serverUrl - The MCP server URL
 * @param refreshToken - The refresh token to use
 * @param clientId - The OAuth client ID
 * @returns The token response from the server
 * @throws AuthError if discovery or refresh fails
 */
export async function discoverAndRefreshToken(
  serverUrl: string,
  refreshToken: string,
  clientId: string
): Promise<OAuthTokenResponse> {
  const tokenEndpoint = await discoverTokenEndpoint(serverUrl);
  if (!tokenEndpoint) {
    throw new AuthError(`Could not find OAuth token endpoint for ${serverUrl}`);
  }

  return refreshAccessToken(tokenEndpoint, refreshToken, clientId);
}


/**
 * Create an AuthError with a re-authentication hint
 * Use this for errors that require the user to re-authenticate
 */
export function createReauthError(
  serverUrl: string,
  profileName: string,
  message: string
): AuthError {
  const command =
    profileName === DEFAULT_AUTH_PROFILE
      ? `mcpc ${serverUrl} login`
      : `mcpc ${serverUrl} login --profile ${profileName}`;
  return new AuthError(`${message}. Please re-authenticate with: ${command}`);
}
