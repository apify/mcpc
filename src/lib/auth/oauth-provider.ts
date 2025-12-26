/**
 * OAuth provider implementation for mcpc
 * Implements the OAuthClientProvider interface from MCP SDK
 * Stores tokens securely in OS keychain
 */

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthProfile } from '../types.js';
import { getAuthProfile, saveAuthProfile } from '../auth/auth-profiles.js';
import {
  readKeychainOAuthTokenInfo,
  storeKeychainOAuthTokenInfo,
  readKeychainOAuthClientInfo,
  storeKeychainOAuthClientInfo,
  type OAuthTokenInfo,
} from './keychain.js';
import { createLogger } from '../logger.js';

const logger = createLogger('oauth-provider');

/**
 * OAuth provider that manages authentication for a single server and profile
 * Tokens are stored in OS keychain for security
 */
export class McpcOAuthProvider implements OAuthClientProvider {
  private serverUrl: string;
  private profileName: string;
  private _redirectUrl: string;
  private _authProfile: AuthProfile | undefined;
  private _codeVerifier: string | undefined;
  private _clientInformation: OAuthClientInformationMixed | undefined;
  private _ignoreExistingTokens: boolean;

  constructor(serverUrl: string, profileName: string, redirectUrl: string, ignoreExistingTokens = false) {
    this.serverUrl = serverUrl;
    this.profileName = profileName;
    this._redirectUrl = redirectUrl;
    this._ignoreExistingTokens = ignoreExistingTokens;
  }

  /**
   * Load auth profile from storage (metadata only, tokens are in keychain)
   */
  private async loadProfile(): Promise<AuthProfile | undefined> {
    if (!this._authProfile) {
      this._authProfile = await getAuthProfile(this.serverUrl, this.profileName);
    }
    return this._authProfile;
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
    // Try to load from keychain if not in memory
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
    this._clientInformation = clientInformation;

    // Store in keychain - only include clientSecret if defined
    const clientInfo: Parameters<typeof storeKeychainOAuthClientInfo>[2] = {
      clientId: clientInformation.client_id,
    };
    if (clientInformation.client_secret) {
      clientInfo.clientSecret = clientInformation.client_secret;
    }
    await storeKeychainOAuthClientInfo(this.serverUrl, this.profileName, clientInfo);

    logger.debug('Saved client information to keychain');
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // When forcing re-authentication, pretend no tokens exist
    // This makes the SDK initiate a fresh OAuth flow
    if (this._ignoreExistingTokens) {
      return undefined;
    }

    // Load tokens from keychain
    const storedTokens = await readKeychainOAuthTokenInfo(this.serverUrl, this.profileName);
    if (!storedTokens) {
      return undefined;
    }

    // Convert to SDK format (snake_case per OAuth spec)
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
    logger.debug('Saving OAuth tokens to keychain');

    // Store tokens in keychain (convert from OAuth snake_case to camelCase)
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

    // Update profile metadata (without tokens)
    const now = new Date().toISOString(); // TODO: keep Date not string?
    let profile = await this.loadProfile();

    if (!profile) {
      // Create new profile (metadata only)
      profile = {
        name: this.profileName,
        serverUrl: this.serverUrl,
        authType: 'oauth',
        oauthIssuer: '', // Will be set by caller
        authenticatedAt: now,
        createdAt: now,
        updatedAt: now,
      };

      if (tokens.scope) {
        profile.scopes = tokens.scope.split(' ');
      }
    } else {
      // Update existing profile metadata
      profile.authenticatedAt = now;
      profile.updatedAt = now;

      if (tokens.scope) {
        profile.scopes = tokens.scope.split(' ');
      }
    }

    await saveAuthProfile(profile);
    this._authProfile = profile;

    logger.debug('Tokens saved to keychain, profile metadata updated');
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // This will be implemented in the OAuth flow handler
    // For now, just log the URL
    logger.info(`Authorization URL: ${authorizationUrl.toString()}`);
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

  /**
   * Set the OAuth issuer URL (authorization server)
   * This is called after discovery
   */
  setOAuthIssuer(issuer: string): void {
    if (this._authProfile) {
      this._authProfile.oauthIssuer = issuer;
    }
  }
}
