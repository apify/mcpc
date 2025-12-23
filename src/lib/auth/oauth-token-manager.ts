/**
 * OAuth Token Manager
 * Encapsulates all OAuth token lifecycle management including storage, refresh, and expiry checking.
 * Used by both CLI (with keychain persistence) and bridge (in-memory only).
 */

import { createLogger } from '../logger.js';
import { AuthError } from '../errors.js';
import { discoverAndRefreshToken, type OAuthTokenResponse } from './oauth-utils.js';

const logger = createLogger('oauth-token-manager');

// Default token expiry if server doesn't specify (1 hour)
const DEFAULT_TOKEN_EXPIRY_SECONDS = 3600;

// Buffer time before expiry to trigger refresh (60 seconds)
const EXPIRY_BUFFER_SECONDS = 60;

/**
 * Callback invoked when tokens are refreshed
 * Allows callers to persist the new tokens (e.g., to keychain)
 */
export type OnTokenRefreshCallback = (tokens: OAuthTokenResponse) => void | Promise<void>;

/**
 * Options for creating an OAuthTokenManager
 */
export interface OAuthTokenManagerOptions {
  serverUrl: string;
  profileName: string;
  /** Initial refresh token */
  refreshToken: string;
  /** Initial access token (optional - will be refreshed if not provided or expired) */
  accessToken?: string;
  /** Unix timestamp when access token expires */
  accessTokenExpiresAt?: number;
  /** Callback when tokens are refreshed (for persistence) */
  onTokenRefresh?: OnTokenRefreshCallback;
}

/**
 * Manages OAuth token lifecycle including automatic refresh
 */
export class OAuthTokenManager {
  private serverUrl: string;
  private profileName: string;
  private refreshToken: string;
  private accessToken: string | null = null;
  private accessTokenExpiresAt: number | null = null; // unix timestamp
  private onTokenRefresh?: OnTokenRefreshCallback;

  constructor(options: OAuthTokenManagerOptions) {
    this.serverUrl = options.serverUrl;
    this.profileName = options.profileName;
    this.refreshToken = options.refreshToken;
    this.accessToken = options.accessToken ?? null;
    this.accessTokenExpiresAt = options.accessTokenExpiresAt ?? null;
    if (options.onTokenRefresh) {
      this.onTokenRefresh = options.onTokenRefresh;
    }
  }

  /**
   * Check if the current access token is expired or about to expire
   */
  isAccessTokenExpired(): boolean {
    if (!this.accessToken || !this.accessTokenExpiresAt) {
      return true;
    }
    return Date.now() / 1000 > this.accessTokenExpiresAt - EXPIRY_BUFFER_SECONDS;
  }

  /**
   * Check if we have credentials to work with
   */
  hasCredentials(): boolean {
    return !!this.refreshToken;
  }

  /**
   * Get the current refresh token
   */
  getRefreshToken(): string {
    return this.refreshToken;
  }

  /**
   * Update the refresh token (e.g., after token rotation)
   */
  setRefreshToken(token: string): void {
    this.refreshToken = token;
  }

  /**
   * Get server URL
   */
  getServerUrl(): string {
    return this.serverUrl;
  }

  /**
   * Get profile name
   */
  getProfileName(): string {
    return this.profileName;
  }

  /**
   * Refresh the access token using the refresh token
   * @returns The token response from the server
   * @throws AuthError if refresh fails
   */
  async refreshAccessToken(): Promise<OAuthTokenResponse> {
    if (!this.refreshToken) {
      throw new AuthError(
        `No refresh token available for profile ${this.profileName}. ` +
          `Please re-authenticate with: mcpc ${this.serverUrl} auth --profile ${this.profileName}`
      );
    }

    logger.info(`Refreshing access token for profile: ${this.profileName}`);

    try {
      const tokenResponse = await discoverAndRefreshToken(this.serverUrl, this.refreshToken);

      // Store new access token
      this.accessToken = tokenResponse.access_token;

      // Calculate expiry time
      const expiresIn = tokenResponse.expires_in ?? DEFAULT_TOKEN_EXPIRY_SECONDS;
      this.accessTokenExpiresAt = Math.floor(Date.now() / 1000) + expiresIn;

      // Update refresh token if a new one was provided (token rotation)
      if (tokenResponse.refresh_token) {
        this.refreshToken = tokenResponse.refresh_token;
        logger.debug('Received new refresh token (token rotation)');
      }

      logger.info(`Access token refreshed successfully for profile: ${this.profileName}`);

      // Notify callback for persistence
      if (this.onTokenRefresh) {
        await this.onTokenRefresh(tokenResponse);
      }

      return tokenResponse;
    } catch (error) {
      if (error instanceof AuthError) {
        // Add re-authentication hint
        throw new AuthError(
          `${error.message}. ` +
            `Please re-authenticate with: mcpc ${this.serverUrl} auth --profile ${this.profileName}`
        );
      }
      logger.error(`Token refresh error: ${(error as Error).message}`);
      throw new AuthError(
        `Failed to refresh token: ${(error as Error).message}. ` +
          `Please re-authenticate with: mcpc ${this.serverUrl} auth --profile ${this.profileName}`
      );
    }
  }

  /**
   * Get a valid access token, refreshing if necessary
   * @returns The current valid access token
   * @throws AuthError if refresh fails
   */
  async getValidAccessToken(): Promise<string> {
    if (this.isAccessTokenExpired()) {
      await this.refreshAccessToken();
    }

    if (!this.accessToken) {
      throw new AuthError('No access token available after refresh');
    }

    return this.accessToken;
  }

  /**
   * Get the current access token without checking expiry or refreshing
   * Returns null if no token is available
   */
  getCurrentAccessToken(): string | null {
    return this.accessToken;
  }

  /**
   * Get the access token expiry timestamp
   */
  getAccessTokenExpiresAt(): number | null {
    return this.accessTokenExpiresAt;
  }
}
