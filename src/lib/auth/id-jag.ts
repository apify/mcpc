/**
 * Enterprise-managed authorization (SEP-990, ID-JAG).
 *
 * Implements the MCP extension `io.modelcontextprotocol/enterprise-managed-authorization`:
 * the user signs in once at the enterprise IdP (OIDC SSO, handled by `id-jag-login.ts`),
 * and mcpc then obtains MCP-server access tokens without any further user interaction by
 * exchanging the stored OIDC ID token at the IdP for an Identity Assertion JWT
 * Authorization Grant (ID-JAG, RFC 8693 token exchange), and the ID-JAG at the MCP
 * authorization server for an access token (RFC 7523 jwt-bearer grant).
 *
 * The SDK's `CrossAppAccessProvider` drives the jwt-bearer exchange and token caching;
 * this module supplies its assertion callback (the IdP side) and keeps the stored ID
 * token fresh via the IdP refresh token. Kept free of any interactive/browser code so
 * the bridge can import it.
 */

import {
  CrossAppAccessProvider,
  requestJwtAuthorizationGrant,
  type OAuthClientProvider,
} from '@modelcontextprotocol/client';
import type { IdJagCredentials } from '../types.js';
import { AuthError } from '../errors.js';
import { proxyFetch } from '../proxy.js';
import { createLogger } from '../logger.js';
import { describeAuthError } from './client-credentials.js';
import type { OAuthTokenResponse } from './oauth-utils.js';

const logger = createLogger('id-jag');

/** Client name advertised in token request metadata. */
const CLIENT_NAME = 'mcpc';

/**
 * OAuth grant profile identifier advertised by authorization servers that accept
 * ID-JAGs, in the `authorization_grant_profiles_supported` metadata field.
 */
export const ID_JAG_GRANT_PROFILE = 'urn:ietf:params:oauth:grant-profile:id-jag';

/** Refresh the ID token when it expires within this window (matches OAuthTokenManager). */
const ID_TOKEN_EXPIRY_BUFFER_SECS = 60;

/**
 * Decode a JWT payload without verifying the signature (for expiry checks and
 * display-only identity claims). Returns undefined when not a decodable JWT.
 */
export function decodeJwtPayload<T = Record<string, unknown>>(jwt: string): T | undefined {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return undefined;
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as T;
  } catch {
    return undefined;
  }
}

/**
 * Decode the `exp` claim (unix seconds) from a JWT without verifying it.
 * Returns undefined when the token is not a decodable JWT.
 */
export function getJwtExpirySecs(jwt: string): number | undefined {
  const exp = decodeJwtPayload<{ exp?: number }>(jwt)?.exp;
  return typeof exp === 'number' ? exp : undefined;
}

/**
 * Renew the OIDC ID token at the enterprise IdP using the stored refresh token
 * (plain `grant_type=refresh_token`; client secret sent via HTTP Basic when present).
 * Returns the updated credentials — callers persist them.
 */
export async function refreshIdpIdToken(info: IdJagCredentials): Promise<IdJagCredentials> {
  if (!info.idpRefreshToken) {
    throw new AuthError('No IdP refresh token available to renew the enterprise SSO ID token');
  }
  logger.debug(`Refreshing IdP ID token at: ${info.idpTokenEndpoint}`);

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: info.idpRefreshToken,
    client_id: info.idpClientId,
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (info.idpClientSecret) {
    const basic = Buffer.from(`${info.idpClientId}:${info.idpClientSecret}`).toString('base64');
    headers['Authorization'] = `Basic ${basic}`;
  }

  const response = await proxyFetch(info.idpTokenEndpoint, {
    method: 'POST',
    headers,
    body: params.toString(),
  });

  if (!response.ok) {
    // Log only a bounded snippet — the response could echo attacker-influenced content.
    const errorText = (await response.text()).slice(0, 400);
    logger.error(`IdP ID token refresh failed: ${response.status} ${errorText}`);
    if (response.status === 400 || response.status === 401) {
      throw new AuthError(
        'Enterprise IdP refresh token is invalid or expired. Please re-authenticate.'
      );
    }
    throw new AuthError(
      `Failed to refresh enterprise SSO ID token: ${response.status} ${response.statusText}`
    );
  }

  const tokens = (await response.json()) as OAuthTokenResponse & { id_token?: string };
  if (!tokens.id_token) {
    throw new AuthError(
      'Enterprise IdP did not return an ID token on refresh. Please re-authenticate.'
    );
  }

  const updated: IdJagCredentials = { ...info, idToken: tokens.id_token };
  const expiresAt = getJwtExpirySecs(tokens.id_token);
  if (expiresAt !== undefined) {
    updated.idTokenExpiresAt = expiresAt;
  } else {
    delete updated.idTokenExpiresAt;
  }
  if (tokens.refresh_token) {
    updated.idpRefreshToken = tokens.refresh_token; // rotated by the IdP
  }
  logger.debug('IdP ID token refreshed');
  return updated;
}

/** Callbacks for keeping stored id-jag material in sync across processes. */
export interface IdJagProviderCallbacks {
  /**
   * Re-read the latest stored material before each use (another process may have
   * rotated the IdP refresh token). Return undefined to keep the current material.
   */
  reloadCredentials?: () => Promise<IdJagCredentials | undefined>;
  /** Persist rotated IdP tokens after a successful ID token refresh. */
  onIdTokenRefresh?: (updated: IdJagCredentials) => Promise<void>;
}

/** Options for {@link createIdJagProvider}. */
export interface CreateIdJagProviderOptions {
  /** Normalized MCP server URL (used in re-authentication hints). */
  serverUrl: string;
  /** Auth profile name (used in re-authentication hints). */
  profileName: string;
  callbacks?: IdJagProviderCallbacks;
}

/** Build the `mcpc login` hint for a dead enterprise SSO session. */
function buildReloginHint(serverUrl: string, profileName: string): string {
  const profileFlag = profileName === 'default' ? '' : ` --profile ${profileName}`;
  return (
    `Please re-authenticate with: mcpc login ${serverUrl} --grant id-jag${profileFlag} ` +
    `(plus the --idp/--client flags used originally; see: mcpc help login)`
  );
}

/**
 * Build the SDK OAuthClientProvider for the enterprise-managed authorization
 * (id_jag) grant. The SDK transport drives discovery, the jwt-bearer exchange,
 * and access token caching through this provider automatically; the assertion
 * callback below supplies the ID-JAG from the enterprise IdP, refreshing the
 * stored ID token first when it has expired.
 */
export function createIdJagProvider(
  info: IdJagCredentials,
  options: CreateIdJagProviderOptions
): OAuthClientProvider {
  const { serverUrl, profileName, callbacks } = options;
  let current = info;

  const getValidIdToken = async (): Promise<string> => {
    const expiresAt = current.idTokenExpiresAt ?? getJwtExpirySecs(current.idToken);
    const nowSecs = Math.floor(Date.now() / 1000);
    if (expiresAt === undefined || expiresAt - nowSecs > ID_TOKEN_EXPIRY_BUFFER_SECS) {
      return current.idToken;
    }

    logger.debug('Enterprise SSO ID token expired or expiring soon');
    if (!current.idpRefreshToken) {
      throw new AuthError(
        `Enterprise SSO session has expired and the IdP issued no refresh token. ` +
          buildReloginHint(serverUrl, profileName)
      );
    }
    try {
      current = await refreshIdpIdToken(current);
    } catch (error) {
      throw new AuthError(
        `Could not renew the enterprise SSO session: ${describeAuthError(error)}. ` +
          buildReloginHint(serverUrl, profileName)
      );
    }
    await callbacks?.onIdTokenRefresh?.(current);
    return current.idToken;
  };

  return new CrossAppAccessProvider({
    assertion: async (ctx) => {
      if (callbacks?.reloadCredentials) {
        const reloaded = await callbacks.reloadCredentials();
        if (reloaded) current = reloaded;
      }
      const idToken = await getValidIdToken();
      const scope = ctx.scope ?? current.scope;
      logger.debug(
        `Requesting ID-JAG from IdP (audience: ${ctx.authorizationServerUrl}, ` +
          `resource: ${ctx.resourceUrl})`
      );
      try {
        const result = await requestJwtAuthorizationGrant({
          tokenEndpoint: current.idpTokenEndpoint,
          audience: ctx.authorizationServerUrl,
          resource: ctx.resourceUrl,
          idToken,
          clientId: current.idpClientId,
          ...(current.idpClientSecret ? { clientSecret: current.idpClientSecret } : {}),
          ...(scope ? { scope } : {}),
          fetchFn: ctx.fetchFn,
        });
        logger.debug('ID-JAG obtained from IdP');
        return result.jwtAuthGrant;
      } catch (error) {
        if (error instanceof AuthError) throw error;
        // The IdP refused the exchange: policy denies access, the ID token is no
        // longer accepted, or the IdP client may not use the token-exchange grant.
        throw new AuthError(
          `Enterprise IdP refused to issue an identity assertion grant (ID-JAG): ` +
            `${describeAuthError(error)}. ` +
            `Check that your organization allows this MCP server and that the IdP client ` +
            `is permitted the token-exchange grant. ` +
            buildReloginHint(serverUrl, profileName)
        );
      }
    },
    clientId: info.mcpClientId,
    clientSecret: info.mcpClientSecret,
    clientName: CLIENT_NAME,
    fetchFn: proxyFetch,
  });
}
