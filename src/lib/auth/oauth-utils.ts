/**
 * Shared OAuth utilities for token discovery and refresh
 * Used by both CLI (token-refresh.ts) and bridge process
 */

import { createLogger } from '../logger.js';
import { AuthError, ClientError } from '../errors.js';
import { proxyFetch } from '../proxy.js';
import { normalizeServerUrl } from '../utils.js';

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
 * Hosts accepted for the OAuth callback redirect URI (--callback-host).
 * Loopback names only: a non-loopback host in the redirect URI would send
 * the authorization code off-machine. The IP literal is the default per
 * RFC 8252 §8.3; `localhost` exists for pre-registered clients whose
 * redirect URI was registered with the hostname form (#269).
 */
export const MCPC_OAUTH_CALLBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost'] as const;

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
 * Authorization server metadata (RFC 8414 / OpenID Connect discovery). Only the
 * fields mcpc reads are typed; the rest are preserved for pass-through to the SDK.
 */
export interface AuthServerMetadata {
  token_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  [key: string]: unknown;
}

/**
 * Derive the URL used for OAuth operations (metadata discovery, dynamic client
 * registration, authorization, token refresh) from a server URL.
 *
 * A server URL may carry a query string that matters only to the MCP connection
 * itself — e.g. Apify's `?tools=search-actors,...` tool filter. That query is
 * NOT part of the server's OAuth identity. The MCP SDK copies the query onto its
 * well-known discovery requests (`/.well-known/oauth-protected-resource?tools=...`),
 * which makes discovery fail; the SDK then treats the MCP origin as its own
 * authorization server and issues `POST <origin>/register`, which the MCP server
 * has no route for (404). Stripping the query makes OAuth behave identically
 * whether or not a tool filter is present.
 *
 * The path is preserved (path-based discovery is valid); only the query and
 * fragment are removed. Storage keys are unaffected — profiles and keychain key
 * on the host via getServerHost() — so this stays consistent with the URLs used
 * by `login` and `connect`.
 */
export function getOAuthServerUrl(urlString: string): string {
  const url = new URL(normalizeServerUrl(urlString));
  url.search = '';
  url.hash = '';

  let result = url.toString();

  // Match normalizeServerUrl: a bare origin carries no trailing slash.
  if (url.pathname === '/') {
    result = result.slice(0, -1);
  }

  return result;
}

/**
 * Discover OAuth authorization-server metadata from a server.
 * Tries standard well-known endpoints per OAuth 2.0 and OpenID Connect specs.
 * First tries path-based discovery, then falls back to root-based discovery
 * (some servers like Notion host metadata at root instead of path).
 */
export async function discoverAuthServerMetadata(
  serverUrl: string
): Promise<AuthServerMetadata | undefined> {
  // Strip any query string / fragment first: OAuth metadata lives at the
  // server's origin+path, and a query (e.g. Apify's `?tools=` filter) would
  // otherwise be concatenated into the well-known discovery URLs below.
  serverUrl = getOAuthServerUrl(serverUrl).replace(/\/+$/, '');

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
    const metadata = await fetchAuthServerMetadata(url);
    if (metadata) return metadata;
  }

  return undefined;
}

/**
 * Fetch RFC 8414 / OIDC metadata from one candidate URL.
 * Returns undefined unless the response is a JSON document with a token endpoint.
 */
async function fetchAuthServerMetadata(url: string): Promise<AuthServerMetadata | undefined> {
  try {
    logger.debug(`Trying OAuth discovery at: ${url}`);
    const response = await proxyFetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return undefined;

    const metadata = (await response.json()) as AuthServerMetadata;
    if (metadata.token_endpoint) {
      logger.debug(`Found token endpoint: ${metadata.token_endpoint}`);
      return metadata;
    }
  } catch {
    // Unreachable or non-JSON: treat as "not here" and let the caller try the
    // next candidate.
  }
  return undefined;
}

/**
 * Candidate metadata URLs for an authorization server issuer.
 *
 * RFC 8414 §3.1 inserts the well-known segment between host and issuer path
 * (`https://host/.well-known/oauth-authorization-server/tenant1`), while OIDC
 * Discovery appends it (`https://host/tenant1/.well-known/openid-configuration`).
 * Issuers in the wild use either, so try both.
 */
function authServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const base = `${url.protocol}//${url.host}`;
  const path = url.pathname.replace(/\/+$/, '');

  if (!path) {
    return [
      `${base}/.well-known/oauth-authorization-server`,
      `${base}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${base}/.well-known/oauth-authorization-server${path}`,
    `${base}/.well-known/openid-configuration${path}`,
    `${base}${path}/.well-known/openid-configuration`,
  ];
}

/**
 * Discover the authorization server for an MCP server via RFC 9728 protected
 * resource metadata: fetch the PRM document, then read its metadata from the
 * first `authorization_servers` entry.
 *
 * This is the mechanism the MCP spec prescribes, and the only one that works
 * when the authorization server lives on a different origin than the MCP
 * server (`mcp.example.com` protected by `auth.example.com`) — direct
 * well-known probes against the MCP origin cannot find it.
 */
export async function discoverAuthServerViaProtectedResource(
  serverUrl: string
): Promise<AuthServerMetadata | undefined> {
  const normalized = getOAuthServerUrl(serverUrl).replace(/\/+$/, '');
  const url = new URL(normalized);
  const base = `${url.protocol}//${url.host}`;
  const path = url.pathname.replace(/\/+$/, '');

  // Path-scoped document first (RFC 9728 §3.1), then the origin-wide one.
  const prmUrls = [`${base}/.well-known/oauth-protected-resource${path}`];
  if (path) prmUrls.push(`${base}/.well-known/oauth-protected-resource`);

  for (const prmUrl of prmUrls) {
    let issuers: unknown;
    try {
      logger.debug(`Trying protected resource metadata at: ${prmUrl}`);
      const response = await proxyFetch(prmUrl, { headers: { Accept: 'application/json' } });
      if (!response.ok) continue;
      ({ authorization_servers: issuers } = (await response.json()) as {
        authorization_servers?: unknown;
      });
    } catch {
      continue;
    }

    if (!Array.isArray(issuers)) continue;
    for (const issuer of issuers) {
      if (typeof issuer !== 'string' || issuer === '') continue;
      logger.debug(`Protected resource metadata points at issuer: ${issuer}`);
      for (const candidate of authServerMetadataUrls(issuer)) {
        const metadata = await fetchAuthServerMetadata(candidate);
        if (metadata) return metadata;
      }
    }
  }

  return undefined;
}

/**
 * Discover OAuth token endpoint from server.
 * Thin wrapper over discoverAuthServerMetadata() for callers that only need the URL.
 */
export async function discoverTokenEndpoint(serverUrl: string): Promise<string | undefined> {
  return (await discoverAuthServerMetadata(serverUrl))?.token_endpoint;
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
    // Log only a bounded snippet — a non-conforming auth server could echo
    // sensitive or attacker-influenced content into the persisted bridge log.
    const errorText = (await response.text()).slice(0, 400);
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
