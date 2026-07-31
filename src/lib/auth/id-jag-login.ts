/**
 * Interactive login for enterprise-managed authorization (`--grant id-jag`).
 *
 * Orchestrates the one-time setup of the id_jag grant:
 *   1. discover the MCP server's authorization server and check it accepts ID-JAGs
 *   2. discover the enterprise IdP's OIDC endpoints
 *   3. run browser SSO at the IdP (authorization code + PKCE) to obtain an OIDC
 *      ID token (and, with offline access, an IdP refresh token)
 *   4. validate the full chain by performing a real ID-JAG + jwt-bearer exchange
 *   5. persist the material in the OS keychain and write the auth profile
 *
 * Kept separate from `id-jag.ts` so the bridge never imports the interactive
 * browser/callback-server code.
 */

import { randomBytes, createHash } from 'crypto';
import {
  auth as sdkAuth,
  discoverOAuthProtectedResourceMetadata,
  type FetchLike,
} from '@modelcontextprotocol/client';
import type { AuthProfile, IdJagCredentials } from '../types.js';
import { AuthError } from '../errors.js';
import { proxyFetch } from '../proxy.js';
import { normalizeServerUrl } from '../utils.js';
import { createLogger } from '../logger.js';
import { describeAuthError } from './client-credentials.js';
import {
  createIdJagProvider,
  decodeJwtPayload,
  getJwtExpirySecs,
  ID_JAG_GRANT_PROFILE,
} from './id-jag.js';
import { storeKeychainIdJagCredentials } from './keychain.js';
import { getAuthProfile, saveAuthProfile } from './profiles.js';
import { discoverAuthServerMetadata, getOAuthServerUrl } from './oauth-utils.js';
import { runInteractiveAuthorization, findCallbackPort } from './oauth-flow.js';

const logger = createLogger('id-jag-login');

/**
 * Default OIDC scopes requested at the enterprise IdP: identity claims for the
 * profile display plus offline access so the IdP issues a refresh token and the
 * SSO session survives ID token expiry.
 */
export const DEFAULT_IDP_SCOPE = 'openid profile email offline_access';

/** Options for {@link loginIdJag}, mapped from the `mcpc login` CLI flags. */
export interface IdJagLoginOptions {
  /** Enterprise IdP issuer URL (`--idp`). */
  idpIssuer: string;
  /** Client pre-registered at the IdP (`--idp-client-id`). */
  idpClientId: string;
  /** IdP client secret (`--idp-client-secret`; absent for public IdP clients). */
  idpClientSecret?: string;
  /** Client registered at the MCP authorization server (`--client-id`). */
  mcpClientId: string;
  /** Secret for the MCP authorization server client (`--client-secret`). */
  mcpClientSecret: string;
  /** Space-separated scopes requested for the MCP server (`--scope`). */
  scope?: string;
  /** OIDC scopes for the IdP SSO (`--idp-scope`; default: {@link DEFAULT_IDP_SCOPE}). */
  idpScope?: string;
  callbackPort?: number;
  callbackHost?: string;
}

/** Result of an id-jag login. */
export interface IdJagLoginResult {
  profile: AuthProfile;
  scopes?: string[];
}

/** Identity claims read (unverified, display-only) from the IdP's ID token. */
interface IdTokenClaims {
  sub?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  nonce?: string;
}

/**
 * Check the MCP server's authorization server metadata for ID-JAG support.
 * Forgiving on missing metadata (the validation exchange in step 4 is the real
 * test); hard error only when the server explicitly lists supported grant
 * profiles and ID-JAG is not among them.
 */
async function checkServerSupportsIdJag(serverUrl: string): Promise<void> {
  let grantProfiles: unknown;
  try {
    const prm = await discoverOAuthProtectedResourceMetadata(
      serverUrl,
      {},
      proxyFetch as FetchLike
    );
    const authServerUrl = prm.authorization_servers?.[0] ?? serverUrl;
    const metadata = await discoverAuthServerMetadata(authServerUrl);
    grantProfiles = metadata?.['authorization_grant_profiles_supported'];
  } catch (error) {
    logger.debug(
      `Could not discover authorization server metadata for ${serverUrl}: ` +
        `${(error as Error).message} — continuing, the validation token request will verify support`
    );
    return;
  }

  if (Array.isArray(grantProfiles) && !grantProfiles.includes(ID_JAG_GRANT_PROFILE)) {
    throw new AuthError(
      `${serverUrl} does not advertise support for identity assertion grants ` +
        `(${ID_JAG_GRANT_PROFILE} is not in its authorization_grant_profiles_supported). ` +
        `Enterprise-managed authorization is not available for this server — ` +
        `try the standard interactive login instead: mcpc login ${serverUrl}`
    );
  }
}

/**
 * Run OIDC authorization-code + PKCE SSO at the enterprise IdP and exchange the
 * code for tokens. Returns the ID token and, when granted, the IdP refresh token.
 */
async function performIdpSso(
  opts: IdJagLoginOptions,
  profileName: string
): Promise<{ idToken: string; idpRefreshToken?: string; idpTokenEndpoint: string }> {
  const idpMetadata = await discoverAuthServerMetadata(opts.idpIssuer);
  const authorizationEndpoint = idpMetadata?.['authorization_endpoint'];
  const tokenEndpoint = idpMetadata?.token_endpoint;
  if (typeof authorizationEndpoint !== 'string' || !tokenEndpoint) {
    throw new AuthError(
      `Could not discover OAuth endpoints for the enterprise IdP at ${opts.idpIssuer}. ` +
        `Check that --idp points at the IdP issuer URL (it must serve ` +
        `/.well-known/openid-configuration or /.well-known/oauth-authorization-server).`
    );
  }

  // PKCE (S256) + `state` for CSRF protection + `nonce` echoed into the ID token.
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(16).toString('hex');
  const nonce = randomBytes(16).toString('hex');

  const port = await findCallbackPort(opts.callbackPort);
  const redirectUri = `http://${opts.callbackHost || '127.0.0.1'}:${port}/callback`;

  const authorizationUrl = new URL(authorizationEndpoint);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', opts.idpClientId);
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('scope', opts.idpScope || DEFAULT_IDP_SCOPE);
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('nonce', nonce);
  authorizationUrl.searchParams.set('code_challenge', codeChallenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');

  const callback = await runInteractiveAuthorization(authorizationUrl, port, {
    serverUrl: opts.idpIssuer,
    profileName,
  });
  if (callback.state !== state) {
    throw new AuthError(
      'Enterprise IdP returned a mismatched state parameter — possible CSRF, aborting login'
    );
  }

  // Exchange the authorization code at the IdP token endpoint.
  logger.debug('Exchanging IdP authorization code for tokens...');
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: callback.code,
    redirect_uri: redirectUri,
    client_id: opts.idpClientId,
    code_verifier: codeVerifier,
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (opts.idpClientSecret) {
    const basic = Buffer.from(`${opts.idpClientId}:${opts.idpClientSecret}`).toString('base64');
    headers['Authorization'] = `Basic ${basic}`;
  }
  const response = await proxyFetch(tokenEndpoint, {
    method: 'POST',
    headers,
    body: params.toString(),
  });
  if (!response.ok) {
    const errorText = (await response.text()).slice(0, 400);
    throw new AuthError(
      `Enterprise IdP rejected the authorization code exchange ` +
        `(${response.status}): ${errorText}`
    );
  }
  const tokens = (await response.json()) as { id_token?: string; refresh_token?: string };
  if (!tokens.id_token) {
    throw new AuthError(
      `Enterprise IdP did not return an ID token. Make sure the IdP client is an ` +
        `OpenID Connect client and the requested scope includes "openid" ` +
        `(requested: "${opts.idpScope || DEFAULT_IDP_SCOPE}").`
    );
  }
  const claims = decodeJwtPayload<IdTokenClaims>(tokens.id_token);
  if (claims?.nonce && claims.nonce !== nonce) {
    throw new AuthError('Enterprise IdP returned an ID token with a mismatched nonce — aborting');
  }

  const result: { idToken: string; idpRefreshToken?: string; idpTokenEndpoint: string } = {
    idToken: tokens.id_token,
    idpTokenEndpoint: tokenEndpoint,
  };
  if (tokens.refresh_token) {
    result.idpRefreshToken = tokens.refresh_token;
  } else {
    logger.warn(
      'Enterprise IdP issued no refresh token — sessions will require a new login ' +
        'once the ID token expires'
    );
  }
  return result;
}

/**
 * Log in with the enterprise-managed authorization grant: SSO at the IdP,
 * validate the full ID-JAG chain against the MCP server, persist material in
 * the OS keychain, and write the auth profile.
 */
export async function loginIdJag(
  serverUrl: string,
  profileName: string,
  opts: IdJagLoginOptions
): Promise<IdJagLoginResult> {
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const oauthServerUrl = getOAuthServerUrl(normalizedServerUrl);
  const idpIssuer = normalizeServerUrl(opts.idpIssuer);

  // 1. Fail fast when the server explicitly rules out ID-JAGs.
  await checkServerSupportsIdJag(oauthServerUrl);

  // 2 + 3. IdP endpoint discovery and browser SSO.
  const sso = await performIdpSso({ ...opts, idpIssuer }, profileName);

  const info: IdJagCredentials = {
    idpIssuer,
    idpTokenEndpoint: sso.idpTokenEndpoint,
    idpClientId: opts.idpClientId,
    idToken: sso.idToken,
    mcpClientId: opts.mcpClientId,
    mcpClientSecret: opts.mcpClientSecret,
  };
  if (opts.idpClientSecret) info.idpClientSecret = opts.idpClientSecret;
  if (sso.idpRefreshToken) info.idpRefreshToken = sso.idpRefreshToken;
  if (opts.scope) info.scope = opts.scope;
  const idTokenExpiresAt = getJwtExpirySecs(sso.idToken);
  if (idTokenExpiresAt !== undefined) info.idTokenExpiresAt = idTokenExpiresAt;

  // 4. Validate the full chain with the same provider the bridge uses at runtime:
  // RFC 9728 discovery, RFC 8693 token exchange at the IdP, and the jwt-bearer
  // exchange at the MCP authorization server. A successful login therefore
  // guarantees the session will connect.
  logger.debug('Validating the ID-JAG chain with a real token request...');
  const provider = createIdJagProvider(info, {
    serverUrl: normalizedServerUrl,
    profileName,
  });
  let grantedScope: string | undefined;
  try {
    const result = await sdkAuth(provider, {
      serverUrl: oauthServerUrl,
      ...(opts.scope ? { scope: opts.scope } : {}),
      fetchFn: proxyFetch as FetchLike,
    });
    if (result !== 'AUTHORIZED') {
      // CrossAppAccessProvider never redirects; anything else is unexpected.
      throw new AuthError(`Unexpected authorization result: ${result}`);
    }
    grantedScope = (await provider.tokens())?.scope;
    logger.debug('ID-JAG validation token request succeeded');
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(`Enterprise-managed authentication failed: ${describeAuthError(error)}`);
  }

  // 5. Persist the material in the OS keychain.
  await storeKeychainIdJagCredentials(normalizedServerUrl, profileName, info);

  // Prefer scopes the server actually granted; fall back to what was requested.
  const grantedScopes = grantedScope ? grantedScope.split(' ') : undefined;
  const requestedScopes = opts.scope ? opts.scope.split(' ') : undefined;
  const effectiveScopes =
    grantedScopes && grantedScopes.length > 0 ? grantedScopes : requestedScopes;

  // Write/refresh the profile metadata (preserve original createdAt on re-login).
  const claims = decodeJwtPayload<IdTokenClaims>(sso.idToken);
  const now = new Date().toISOString();
  const existing = await getAuthProfile(normalizedServerUrl, profileName);
  const profile: AuthProfile = {
    name: profileName,
    serverUrl: normalizedServerUrl,
    authType: 'oauth',
    oauthGrant: 'id_jag',
    oauthIssuer: normalizedServerUrl,
    idpIssuer,
    createdAt: existing?.createdAt ?? now,
    authenticatedAt: now,
    ...(effectiveScopes && effectiveScopes.length > 0 ? { scopes: effectiveScopes } : {}),
  };
  if (claims?.email) profile.userEmail = claims.email;
  if (claims?.name) profile.userName = claims.name;
  else if (claims?.preferred_username) profile.userName = claims.preferred_username;
  if (claims?.sub) profile.userSubject = claims.sub;

  await saveAuthProfile(profile);
  logger.debug(`Saved id-jag profile ${profileName} for ${normalizedServerUrl}`);

  const result: IdJagLoginResult = { profile };
  if (effectiveScopes && effectiveScopes.length > 0) result.scopes = effectiveScopes;
  return result;
}
