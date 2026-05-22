/**
 * Shared OAuth utilities for token discovery and refresh
 * Used by both CLI (token-refresh.ts) and bridge process
 */

import { createLogger } from '../logger.js';
import { AuthError, ClientError } from '../errors.js';
import { proxyFetch } from '../proxy.js';

const logger = createLogger('oauth-utils');

export const DEFAULT_AUTH_PROFILE = 'default';

export const DEFAULT_CLIENT_METADATA_URL = 'https://apify.github.io/mcpc/client-metadata.json';

/**
 * Loopback ports used by mcpc's OAuth callback server. Matches the
 * `redirect_uris` registered in the hosted CIMD document. Tried in order;
 * the first available port is used. Non-contiguous values to reduce the
 * chance that a single unrelated process claims all of them.
 */
export const MCPC_OAUTH_CALLBACK_PORTS: readonly number[] = [13316, 31613, 16133] as const;

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
 * First tries path-based discovery, then falls back to root-based discovery
 * (some servers like Notion host metadata at root instead of path)
 */
export async function discoverTokenEndpoint(serverUrl: string): Promise<string | undefined> {
  serverUrl = serverUrl.replace(/\/+$/, '');

  // Try path-based discovery first (e.g., https://example.com/mcp/.well-known/...)
  const discoveryUrls = [
    `${serverUrl}/.well-known/oauth-authorization-server`,
    `${serverUrl}/.well-known/openid-configuration`,
  ];

  // Add root-based fallback URLs (e.g., https://example.com/.well-known/...)
  // Some servers like Notion host OAuth metadata at the root instead of the path
  const serverUrlObj = new URL(serverUrl);
  const base = `${serverUrlObj.protocol}//${serverUrlObj.host}`;
  if (serverUrl !== base && serverUrl !== `${base}/`) {
    discoveryUrls.push(
      `${base}/.well-known/oauth-authorization-server`,
      `${base}/.well-known/openid-configuration`
    );
  }

  for (const url of discoveryUrls) {
    try {
      logger.debug(`Trying OAuth discovery at: ${url}`);
      const response = await proxyFetch(url, {
        headers: { Accept: 'application/json' },
      });

      if (response.ok) {
        const metadata = (await response.json()) as { token_endpoint?: string };
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

  const response = await proxyFetch(tokenEndpoint, {
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

  const tokenResponse = (await response.json()) as OAuthTokenResponse;
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

/**
 * Validate that a Client ID Metadata Document URL meets the requirements of
 * draft-ietf-oauth-client-id-metadata-document and the MCP authorization spec.
 *
 * Requirements:
 * - MUST use the "https" scheme
 * - MUST contain a path component (not just "/")
 * - MUST NOT contain a fragment component
 * - MUST NOT contain a username or password component
 * - MUST NOT contain single-dot or double-dot path segments
 */
export function validateClientMetadataUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ClientError(
      `Invalid --client-metadata-url: ${url} is not a valid URL. ` +
        `It must be an HTTPS URL pointing to the client metadata JSON document.`
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new ClientError(
      `Invalid --client-metadata-url: ${url} must use the "https" scheme ` +
        `(per OAuth Client ID Metadata Document spec).`
    );
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    throw new ClientError(
      `Invalid --client-metadata-url: ${url} must contain a non-root path component, ` +
        `e.g. https://example.com/client.json`
    );
  }
  if (parsed.hash) {
    throw new ClientError(
      `Invalid --client-metadata-url: ${url} must not contain a fragment component.`
    );
  }
  if (parsed.username || parsed.password) {
    throw new ClientError(
      `Invalid --client-metadata-url: ${url} must not contain a username or password.`
    );
  }
  // Check the raw URL string for dot segments before URL normalization resolves them
  const pathPart = url.replace(/^https:\/\/[^/]*/, '');
  const rawSegments = pathPart.split('/');
  if (rawSegments.some((s) => s === '.' || s === '..')) {
    throw new ClientError(
      `Invalid --client-metadata-url: ${url} must not contain "." or ".." path segments.`
    );
  }
}
