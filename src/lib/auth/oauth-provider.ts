/**
 * Unified OAuth provider for mcpc
 * Implements the OAuthClientProvider interface from MCP SDK
 *
 * Two modes of operation:
 * 1. Auth flow mode: For interactive OAuth authentication (CLI `auth` command)
 *    - Handles full OAuth dance (authorization, code exchange)
 *    - Stores tokens in OS keychain
 *
 * 2. Runtime mode: For automatic token refresh (bridge and CLI direct connections)
 *    - Wraps OAuthTokenManager for automatic refresh
 *    - No keychain I/O during runtime (token manager handles state)
 */

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAuthTokenManager } from './oauth-token-manager.js';
import {
  readKeychainOAuthTokenInfo,
  storeKeychainOAuthTokenInfo,
  readKeychainOAuthClientInfo,
  storeKeychainOAuthClientInfo,
  type OAuthTokenInfo,
} from './keychain.js';
import { getAuthProfile, saveAuthProfile } from './profiles.js';
import type { AuthProfile } from '../types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('oauth-provider');

/**
 * OIDC ID token claims (subset we care about)
 */
interface IdTokenClaims {
  sub?: string; // Subject (unique user identifier)
  email?: string;
  name?: string;
  preferred_username?: string;
}

/**
 * Decode JWT payload without verification (for display purposes only)
 * ID tokens are JWTs with format: header.payload.signature
 */
function decodeJwtPayload(jwt: string): IdTokenClaims | undefined {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) {
      return undefined;
    }
    // Decode base64url payload
    const payload = parts[1]!;
    const decoded = Buffer.from(payload, 'base64url').toString('utf-8');
    return JSON.parse(decoded) as IdTokenClaims;
  } catch {
    // Ignore errors, this is best-effort
    logger.debug('Failed to decode id_token payload');
    return undefined;
  }
}

/**
 * Options for creating an OAuthProvider
 */
export interface OAuthProviderOptions {
  serverUrl: string;
  profileName: string;

  /**
   * Runtime mode: Provide a token manager for automatic token refresh
   * If not provided, operates in auth flow mode (keychain storage)
   */
  tokenManager?: OAuthTokenManager;

  /**
   * Client ID (required for runtime mode)
   */
  clientId?: string;

  /**
   * Redirect URL for OAuth callback (auth flow mode only)
   */
  redirectUrl?: string;

  /**
   * If true, ignore existing tokens and force re-authentication (auth flow mode only)
   */
  forceReauth?: boolean;
}

/**
 * Unified OAuth provider for MCP SDK that handles both auth flow and runtime token refresh
 */
export class OAuthProvider implements OAuthClientProvider {
  private serverUrl: string;
  private profileName: string;
  private tokenManager?: OAuthTokenManager;
  private _clientId?: string;
  private _redirectUrl: string;
  private _forceReauth: boolean;

  // Auth flow state (only used during interactive OAuth)
  private _authProfile?: AuthProfile;
  private _codeVerifier?: string;
  private _clientInformation?: OAuthClientInformationMixed;

  constructor(options: OAuthProviderOptions) {
    this.serverUrl = options.serverUrl;
    this.profileName = options.profileName;
    this._redirectUrl = options.redirectUrl || 'http://localhost/callback';
    this._forceReauth = options.forceReauth || false;

    if (options.tokenManager) {
      this.tokenManager = options.tokenManager;
    }
    if (options.clientId) {
      this._clientId = options.clientId;
    }

    // if (this.tokenManager) {
    //  logger.debug(`OAuthProvider created in runtime mode for ${options.profileName}`);
    // } else {
    //  logger.debug(`OAuthProvider created in auth flow mode for ${options.profileName}`);
    // }
  }

  /**
   * Check if operating in runtime mode ("mcpc <target> <op>") or login mode (mcpc <server> login"
   */
  private isRuntimeMode(): boolean {
    return !!this.tokenManager;
  }

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this._redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // Public client (CLI)
      client_name: 'mcpc',
      client_uri: 'https://github.com/apify/mcpc',
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    // Runtime mode: return client ID from constructor
    if (this.isRuntimeMode() && this._clientId) {
      return { client_id: this._clientId };
    }

    // Auth flow mode: try to load from memory or keychain
    if (!this._clientInformation) {
      const storedClient = await readKeychainOAuthClientInfo(this.serverUrl, this.profileName);
      if (storedClient) {
        this._clientInformation = {
          client_id: storedClient.clientId,
          client_secret: storedClient.clientSecret,
        };
      }
    }
    return this._clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    // Runtime mode: no-op (client info managed by CLI)
    if (this.isRuntimeMode()) {
      return;
    }

    // Auth flow mode: save to keychain
    this._clientInformation = clientInformation;

    const clientInfo: Parameters<typeof storeKeychainOAuthClientInfo>[2] = {
      clientId: clientInformation.client_id,
    };
    if (clientInformation.client_secret) {
      clientInfo.clientSecret = clientInformation.client_secret;
    }
    await storeKeychainOAuthClientInfo(this.serverUrl, this.profileName, clientInfo);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // Runtime mode: use token manager for automatic refresh
    if (this.isRuntimeMode() && this.tokenManager) {
      const accessToken = await this.tokenManager.getValidAccessToken();
      return {
        access_token: accessToken,
        token_type: 'Bearer',
      };
    }

    // Auth flow mode: check keychain
    // If forcing re-auth, pretend no tokens exist
    if (this._forceReauth) {
      return undefined;
    }

    const storedTokens = await readKeychainOAuthTokenInfo(this.serverUrl, this.profileName);
    if (!storedTokens) {
      return undefined;
    }

    // Convert to SDK format
    const result: OAuthTokens = {
      access_token: storedTokens.accessToken,
      token_type: storedTokens.tokenType,
    };

    if (storedTokens.expiresIn !== undefined) {
      result.expires_in = storedTokens.expiresIn;
    }
    if (storedTokens.refreshToken !== undefined) {
      result.refresh_token = storedTokens.refreshToken;
    }
    if (storedTokens.scope !== undefined) {
      result.scope = storedTokens.scope;
    }

    return result;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // Runtime mode: no-op (token manager handles state)
    if (this.isRuntimeMode()) {
      return;
    }

    const tokenInfo: OAuthTokenInfo = {
      accessToken: tokens.access_token,
      tokenType: tokens.token_type,
    };

    if (tokens.expires_in !== undefined) {
      tokenInfo.expiresIn = tokens.expires_in;
      tokenInfo.expiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;
    }
    if (tokens.refresh_token !== undefined) {
      tokenInfo.refreshToken = tokens.refresh_token;
    }
    if (tokens.scope !== undefined) {
      tokenInfo.scope = tokens.scope;
    }

    await storeKeychainOAuthTokenInfo(this.serverUrl, this.profileName, tokenInfo);

    // Update profile metadata
    await this.updateProfileMetadata(tokens);
  }

  /**
   * Update auth profile metadata after saving tokens
   * Extracts user info from OIDC id_token if available
   */
  private async updateProfileMetadata(tokens: OAuthTokens): Promise<void> {
    const now = new Date().toISOString();
    let profile = this._authProfile || (await getAuthProfile(this.serverUrl, this.profileName));

    if (!profile) {
      // Create new profile
      profile = {
        name: this.profileName,
        serverUrl: this.serverUrl,
        authType: 'oauth',
        oauthIssuer: '', // Will be set by caller
        createdAt: now,
        authenticatedAt: now,
      };
    } else {
      // Update existing profile
      profile.authenticatedAt = now;
    }

    if (tokens.scope) {
      profile.scopes = tokens.scope.split(' ');
    }

    // Extract user info from OIDC id_token if present
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idToken = (tokens as any).id_token as string | undefined;
    if (idToken) {
      const claims = decodeJwtPayload(idToken);
      if (claims) {
        logger.debug('Extracted user info from id_token');
        if (claims.email) {
          profile.userEmail = claims.email;
        }
        if (claims.name) {
          profile.userName = claims.name;
        } else if (claims.preferred_username) {
          profile.userName = claims.preferred_username;
        }
        if (claims.sub) {
          profile.userSubject = claims.sub;
        }
      }
    }

    await saveAuthProfile(profile);
    this._authProfile = profile;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Runtime mode: not supported
    if (this.isRuntimeMode()) {
      throw new Error('OAuthProvider in runtime mode does not support authorization flow. Use CLI "login" command first.');
    }

    // Auth flow mode: log the URL (actual redirect handled by oauth-flow.ts)
    logger.warn(`MCP SDK requested redirect to authorization URL (ignoring): ${authorizationUrl.toString()}`);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this._codeVerifier = codeVerifier;
  }

  async codeVerifier(): Promise<string> {
    if (!this._codeVerifier) {
      throw new Error('Code verifier not found');
    }
    return this._codeVerifier;
  }
}
