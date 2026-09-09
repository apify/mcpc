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
 * Fetch an authorization server's metadata from its issuer identifier, trying the
 * RFC 8414 and OIDC Discovery URL shapes in turn.
 */
async function fetchIssuerMetadata(issuer: string): Promise<AuthServerMetadata | undefined> {
  for (const candidate of authServerMetadataUrls(issuer)) {
    const metadata = await fetchAuthServerMetadata(candidate);
    if (metadata) return metadata;
  }
  return undefined;
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
      const metadata = await fetchIssuerMetadata(issuer);
      if (metadata) return metadata;
    }
  }

  return undefined;
}

/**
 * Client authentication method used at the token endpoint.
 *
 * Mirrors the MCP SDK's `ClientAuthMethod`: mcpc's own refresh must authenticate
 * the same way the SDK-driven login did, or a server that accepts only one of the
 * two secret methods rejects the refresh with `invalid_client`.
 */
export type ClientAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

/**
 * Pick the client authentication method for a token request, following the same
 * priority the MCP SDK's `selectClientAuthMethod()` applies during login:
 * `client_secret_basic` > `client_secret_post` > `none`.
 *
 * RFC 6749 §2.3.1 makes HTTP Basic the mandatory-to-implement method and the body
 * form optional, and RFC 8414 §2 defaults to `client_secret_basic` when the server
 * advertises no `token_endpoint_auth_methods_supported`, so a confidential client
 * starts with Basic. `refreshAccessToken()` retries with the other method if the
 * server answers `invalid_client`, which covers servers that advertise nothing and
 * accept only the body form.
 */
export function selectClientAuthMethod(
  metadata: AuthServerMetadata | undefined,
  hasClientSecret: boolean
): ClientAuthMethod {
  if (!hasClientSecret) return 'none';

  const supported = metadata?.token_endpoint_auth_methods_supported;
  if (!Array.isArray(supported) || supported.length === 0) return 'client_secret_basic';
  if (supported.includes('client_secret_basic')) return 'client_secret_basic';
  if (supported.includes('client_secret_post')) return 'client_secret_post';
  return 'client_secret_post';
}

/**
 * The client half of a refresh request.
 */
export interface RefreshClient {
  /** OAuth client ID */
  clientId: string;
  /**
   * OAuth client secret, for confidential clients (pre-registered or issued by
   * dynamic client registration). Servers such as Asana reject the refresh with
   * `invalid_client` without it.
   */
  clientSecret?: string;
  /**
   * How to present the credentials. Defaults to `selectClientAuthMethod()` with no
   * metadata, i.e. Basic for a confidential client and `none` for a public one.
   */
  authMethod?: ClientAuthMethod;
}

/**
 * Apply client authentication to a token request, mirroring the MCP SDK's
 * `applyClientAuthentication()`: Basic puts the credentials in the header and
 * nothing in the body, the body form and public clients put `client_id` in the body.
 */
function applyClientAuth(
  method: ClientAuthMethod,
  client: RefreshClient,
  headers: Record<string, string>,
  params: URLSearchParams
): void {
  if (method === 'client_secret_basic' && client.clientSecret) {
    const credentials = Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64');
    headers.Authorization = `Basic ${credentials}`;
    return;
  }

  params.set('client_id', client.clientId);
  if (method === 'client_secret_post' && client.clientSecret) {
    params.set('client_secret', client.clientSecret);
  }
}

/**
 * Read the OAuth error code (RFC 6749 §5.2) out of a token error response body.
 * Returns undefined for a non-JSON or non-conforming body.
 */
function parseOAuthErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reject a plaintext token endpoint. The refresh token and, for a confidential
 * client, the client secret travel in this request body, so the transport must be
 * encrypted — the MCP SDK asserts the same thing at login
 * (`assertSecureTokenEndpoint`). Loopback stays allowed for local development.
 */
function assertSecureTokenEndpoint(tokenEndpoint: string): void {
  const { protocol, hostname } = new URL(tokenEndpoint);
  if (protocol === 'https:') return;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return;

  throw new AuthError(
    `Refusing to send credentials to a non-HTTPS token endpoint: ${tokenEndpoint}`
  );
}

/**
 * Refresh an access token using a refresh token
 * This is the core refresh logic - callers handle storage and error recovery
 *
 * A confidential client whose method the server rejects with `invalid_client` is
 * retried once with the other secret method: servers that advertise no
 * `token_endpoint_auth_methods_supported` accept one form or the other, and there
 * is no way to tell which from metadata alone.
 *
 * @param tokenEndpoint - The OAuth token endpoint URL
 * @param refreshToken - The refresh token to use
 * @param client - Client ID, optional secret, and how to present them
 * @returns The token response from the server
 * @throws AuthError if the refresh fails
 */
export async function refreshAccessToken(
  tokenEndpoint: string,
  refreshToken: string,
  client: RefreshClient
): Promise<OAuthTokenResponse> {
  assertSecureTokenEndpoint(tokenEndpoint);

  const method = client.authMethod ?? selectClientAuthMethod(undefined, !!client.clientSecret);

  try {
    return await postRefreshRequest(tokenEndpoint, refreshToken, client, method);
  } catch (error) {
    const alternate =
      method === 'client_secret_basic'
        ? 'client_secret_post'
        : method === 'client_secret_post'
          ? 'client_secret_basic'
          : undefined;

    if (!client.clientSecret || !alternate || !isInvalidClientError(error)) {
      throw error;
    }

    logger.debug(`Client authentication with ${method} was rejected, retrying with ${alternate}`);
    return postRefreshRequest(tokenEndpoint, refreshToken, client, alternate);
  }
}

/**
 * AuthError raised for an `invalid_client` token error, as thrown by
 * postRefreshRequest() (the code travels in `details`).
 */
function isInvalidClientError(error: unknown): boolean {
  return error instanceof AuthError && error.details === 'invalid_client';
}

/**
 * POST one `grant_type=refresh_token` request with the given client authentication.
 */
async function postRefreshRequest(
  tokenEndpoint: string,
  refreshToken: string,
  client: RefreshClient,
  method: ClientAuthMethod
): Promise<OAuthTokenResponse> {
  logger.debug(`Refreshing token at: ${tokenEndpoint} (client auth: ${method})`);

  // Prepare refresh request (OAuth spec uses snake_case)
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  applyClientAuth(method, client, headers, params);

  const response = await proxyFetch(tokenEndpoint, {
    method: 'POST',
    headers,
    body: params.toString(),
  });

  if (!response.ok) {
    // Log only a bounded snippet — a non-conforming auth server could echo
    // sensitive or attacker-influenced content into the persisted bridge log.
    const errorBody = await response.text();
    logger.error(`Token refresh failed: ${response.status} ${errorBody.slice(0, 400)}`);
    const errorCode = parseOAuthErrorCode(errorBody);

    if (response.status === 400 || response.status === 401) {
      throw new AuthError('Refresh token is invalid or expired', errorCode);
    }

    throw new AuthError(
      `Failed to refresh token: ${response.status} ${response.statusText}`,
      errorCode
    );
  }

  const tokenResponse = (await response.json()) as OAuthTokenResponse;
  return tokenResponse;
}

/**
 * Discover the token endpoint and refresh an access token in one call.
 *
 * `issuer` is the authorization server login recorded in the profile
 * (`AuthProfile.oauthIssuer`). When set, its metadata is the only source for the
 * token endpoint: the refresh token and client secret then travel to the server
 * that issued them, instead of wherever the MCP server's metadata points today.
 * Profiles written before mcpc recorded the issuer have none, and fall back to
 * discovery — RFC 9728 protected resource metadata first, because the
 * authorization server often lives on another origin than the MCP server
 * (Asana: `mcp.asana.com` vs `app.asana.com`), and only then the MCP origin's own
 * well-known documents.
 *
 * @param serverUrl - The MCP server URL
 * @param refreshToken - The refresh token to use
 * @param client - Client ID and optional secret; the auth method is resolved from
 *   the discovered metadata unless the caller pins one
 * @returns The token response from the server
 * @throws AuthError if discovery or refresh fails
 */
export async function discoverAndRefreshToken(
  serverUrl: string,
  refreshToken: string,
  client: RefreshClient & { issuer?: string }
): Promise<OAuthTokenResponse> {
  const metadata = client.issuer
    ? await fetchIssuerMetadata(client.issuer)
    : ((await discoverAuthServerViaProtectedResource(serverUrl)) ??
      (await discoverAuthServerMetadata(serverUrl)));

  const tokenEndpoint = metadata?.token_endpoint;
  if (!tokenEndpoint) {
    if (client.issuer) {
      throw new AuthError(
        `Could not find OAuth metadata at ${client.issuer}, the authorization server ` +
          `this profile logged in at`
      );
    }
    throw new AuthError(`Could not find OAuth token endpoint for ${serverUrl}`);
  }

  return refreshAccessToken(tokenEndpoint, refreshToken, {
    ...client,
    authMethod: client.authMethod ?? selectClientAuthMethod(metadata, !!client.clientSecret),
  });
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
