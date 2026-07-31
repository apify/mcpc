/**
 * OAuth 2.0 client-credentials grant (machine-to-machine authentication).
 *
 * Implements the MCP extension `io.modelcontextprotocol/oauth-client-credentials`:
 * the client authenticates directly to the authorization server — with a client
 * secret (`client_secret_basic`) or a signed JWT assertion (RFC 7523,
 * `private_key_jwt`) — and receives an access token without any browser redirect
 * or user interaction.
 *
 * The actual token fetch + refresh is done by the SDK's ready-made providers
 * (`ClientCredentialsProvider` / `PrivateKeyJwtProvider`), which implement
 * `OAuthClientProvider`. This module builds the right provider from stored
 * credentials (used by the bridge at runtime) and validates credentials at
 * `login` time by performing a single token request.
 */

import { readFile } from 'fs/promises';
import {
  ClientCredentialsProvider,
  PrivateKeyJwtProvider,
  fetchToken,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type AuthorizationServerMetadata,
  type FetchLike,
} from '@modelcontextprotocol/client';
import type { AuthProfile } from '../types.js';
import { AuthError, ClientError } from '../errors.js';
import { proxyFetch } from '../proxy.js';
import { normalizeServerUrl } from '../utils.js';
import { createLogger } from '../logger.js';
import type { OAuthClientCredentialsInfo } from './keychain.js';
import { storeKeychainClientCredentials } from './keychain.js';
import { getAuthProfile, saveAuthProfile } from './profiles.js';
import {
  discoverAuthServerMetadata,
  discoverAuthServerViaProtectedResource,
  type AuthServerMetadata,
} from './oauth-utils.js';

const logger = createLogger('client-credentials');

/** Client name advertised in the token request metadata. */
const CLIENT_NAME = 'mcpc';

/** Default JWT signing algorithm for the private_key_jwt variant. */
export const DEFAULT_KEY_ALGORITHM = 'RS256';

/** JWT signing algorithms accepted for the private_key_jwt variant (RFC 7518). */
const SUPPORTED_KEY_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;

/**
 * Validate a JWT signing algorithm passed via --client-key-alg.
 * Throws ClientError with the list of supported algorithms on mismatch.
 */
export function validateKeyAlgorithm(alg: string): void {
  if (!(SUPPORTED_KEY_ALGORITHMS as readonly string[]).includes(alg)) {
    throw new ClientError(
      `Invalid --client-key-alg "${alg}". Supported algorithms: ${SUPPORTED_KEY_ALGORITHMS.join(', ')}.`
    );
  }
}

/**
 * Resolve a --client-key value to PEM text. A value beginning with "-----BEGIN"
 * is treated as a literal PEM; anything else is treated as a path to a key file.
 */
export async function resolvePrivateKeyPem(keyValue: string): Promise<string> {
  if (keyValue.trimStart().startsWith('-----BEGIN')) {
    return keyValue;
  }
  try {
    return await readFile(keyValue, 'utf-8');
  } catch (error) {
    throw new ClientError(
      `Could not read private key file "${keyValue}": ${(error as Error).message}`
    );
  }
}

/**
 * Build an SDK OAuthClientProvider for the client-credentials grant from stored
 * material. Used by the bridge at runtime — the SDK transport then drives the
 * token fetch and refresh through this provider automatically.
 */
export function createClientCredentialsProvider(
  info: OAuthClientCredentialsInfo
): OAuthClientProvider {
  let provider: OAuthClientProvider;
  if (info.privateKeyPem) {
    provider = new PrivateKeyJwtProvider({
      clientId: info.clientId,
      privateKey: info.privateKeyPem,
      algorithm: info.keyAlg || DEFAULT_KEY_ALGORITHM,
      clientName: CLIENT_NAME,
      ...(info.scope ? { scope: info.scope } : {}),
    });
  } else if (info.clientSecret) {
    provider = new ClientCredentialsProvider({
      clientId: info.clientId,
      clientSecret: info.clientSecret,
      clientName: CLIENT_NAME,
      ...(info.scope ? { scope: info.scope } : {}),
    });
  } else {
    throw new ClientError(
      'Client-credentials profile is missing both a client secret and a private key.'
    );
  }

  // When the token endpoint is pinned (--token-endpoint), supply it as OAuth discovery
  // state so the SDK's auth() skips metadata discovery and posts straight to it. This is
  // the only thing that works for servers without discoverable authorization-server metadata.
  const tokenEndpoint = info.tokenEndpoint;
  if (tokenEndpoint) {
    provider.discoveryState = () => buildPinnedDiscoveryState(tokenEndpoint);
  }

  return provider;
}

/**
 * Build OAuth discovery state that pins a known token endpoint, bypassing RFC 9728 /
 * RFC 8414 discovery. The authorization_endpoint / response_types_supported fields are
 * unused by the client-credentials grant but are required by the SDK's metadata validation.
 */
function buildPinnedDiscoveryState(tokenEndpoint: string): OAuthDiscoveryState {
  const origin = new URL(tokenEndpoint).origin;
  return {
    authorizationServerUrl: origin,
    authorizationServerMetadata: {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: tokenEndpoint,
      response_types_supported: ['code'],
      grant_types_supported: ['client_credentials'],
      token_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
        'private_key_jwt',
      ],
    } as AuthorizationServerMetadata,
  };
}

/**
 * Build a human-readable reason from an error thrown by the SDK's token request.
 *
 * OAuth failures from the authorization server (e.g. a wrong client secret) arrive
 * as an OAuthError carrying a machine-readable `code` such as `invalid_client`
 * (named `errorCode` in SDK v1, still checked for compatibility). When the server
 * omits `error_description` the SDK leaves `error.message` empty, so fall back to
 * that code rather than reporting a bare, empty reason. Non-OAuth errors fall back
 * to their message or string form.
 */
export function describeAuthError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message) {
      return message;
    }
    const code = (error as { code?: unknown }).code ?? (error as { errorCode?: unknown }).errorCode;
    if (typeof code === 'string' && code) {
      return code;
    }
    return error.name;
  }
  return String(error);
}

/**
 * Perform a one-off client-credentials token request to validate the supplied
 * material and learn the granted scopes. Uses the same SDK provider the bridge
 * uses at runtime, so a successful validation guarantees the session will connect.
 */
async function validateClientCredentials(
  serverUrl: string,
  info: OAuthClientCredentialsInfo
): Promise<string[] | undefined> {
  let metadata: AuthServerMetadata | undefined;
  if (info.tokenEndpoint) {
    // Token endpoint pinned via --token-endpoint: skip discovery entirely.
    metadata = { token_endpoint: info.tokenEndpoint };
  } else {
    // RFC 9728 first: it is the mechanism the MCP spec prescribes and the only
    // one that finds an authorization server hosted on a different origin than
    // the MCP server. Fall back to probing the MCP origin directly for servers
    // that publish authorization-server metadata but no protected-resource
    // document.
    metadata =
      (await discoverAuthServerViaProtectedResource(serverUrl)) ??
      (await discoverAuthServerMetadata(serverUrl));
    if (!metadata?.token_endpoint) {
      throw new AuthError(
        `Could not find an OAuth token endpoint for ${serverUrl}. ` +
          `The server does not appear to expose OAuth authorization-server metadata. ` +
          `Pass --token-endpoint <url> to specify it explicitly.`
      );
    }
  }

  const provider = createClientCredentialsProvider(info);
  try {
    const tokens = await fetchToken(provider, serverUrl, {
      metadata: metadata as unknown as AuthorizationServerMetadata,
      fetchFn: proxyFetch as FetchLike,
    });
    logger.debug('Client-credentials validation token request succeeded');
    return tokens.scope ? tokens.scope.split(' ') : undefined;
  } catch (error) {
    throw new AuthError(`Client-credentials authentication failed: ${describeAuthError(error)}`);
  }
}

/** Result of a client-credentials login. */
export interface ClientCredentialsLoginResult {
  scopes?: string[];
}

/**
 * Log in with the client-credentials grant: validate the material against the
 * server, persist it in the OS keychain, and write/update the auth profile.
 * No browser and no user interaction.
 */
export async function loginClientCredentials(
  serverUrl: string,
  profileName: string,
  info: OAuthClientCredentialsInfo
): Promise<ClientCredentialsLoginResult> {
  const normalizedServerUrl = normalizeServerUrl(serverUrl);

  // Validate by performing a real token request (also yields granted scopes).
  const grantedScopes = await validateClientCredentials(normalizedServerUrl, info);

  // Persist the credentials material in the OS keychain.
  await storeKeychainClientCredentials(normalizedServerUrl, profileName, info);

  // Prefer scopes the server actually granted; fall back to what was requested.
  const requestedScopes = info.scope ? info.scope.split(' ') : undefined;
  const effectiveScopes =
    grantedScopes && grantedScopes.length > 0 ? grantedScopes : requestedScopes;

  // Write/refresh the profile metadata (preserve original createdAt on re-login).
  const now = new Date().toISOString();
  const existing = await getAuthProfile(normalizedServerUrl, profileName);
  const profile: AuthProfile = {
    name: profileName,
    serverUrl: normalizedServerUrl,
    authType: 'oauth',
    oauthGrant: 'client_credentials',
    oauthIssuer: normalizedServerUrl,
    createdAt: existing?.createdAt ?? now,
    authenticatedAt: now,
    ...(effectiveScopes && effectiveScopes.length > 0 ? { scopes: effectiveScopes } : {}),
  };
  await saveAuthProfile(profile);
  logger.debug(`Saved client-credentials profile ${profileName} for ${normalizedServerUrl}`);

  return effectiveScopes && effectiveScopes.length > 0 ? { scopes: effectiveScopes } : {};
}
