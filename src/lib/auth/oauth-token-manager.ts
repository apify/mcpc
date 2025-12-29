/**
 * OAuth Token Manager
 * Encapsulates all OAuth token lifecycle management including storage, refresh, and expiry checking.
 * Used by both CLI (with keychain persistence) and bridge (in-memory only).
 */

import { createLogger } from '../logger.js';
import { AuthError } from '../errors.js';
import { discoverAndRefreshToken, createReauthError, type OAuthTokenResponse } from './oauth-utils.js';

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
  /** OAuth client ID (required for public clients) */
  clientId: string;
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
  private clientId: string;
  private refreshToken: string;
  private accessToken: string | null = null;
  private accessTokenExpiresAt: number | null = null; // unix timestamp
  private onTokenRefresh?: OnTokenRefreshCallback;

  constructor(options: OAuthTokenManagerOptions) {
    this.serverUrl = options.serverUrl;
    this.profileName = options.profileName;
    this.clientId = options.clientId;
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
   * Get seconds until the access token expires (accounting for buffer)
   * Returns 0 if already expired or no token
   */
  getSecondsUntilExpiry(): number {
    if (!this.accessToken || !this.accessTokenExpiresAt) {
      return 0;
    }
    const secondsUntil = this.accessTokenExpiresAt - EXPIRY_BUFFER_SECONDS - Math.floor(Date.now() / 1000);
    return Math.max(0, secondsUntil);
  }

  /**
   * Refresh the access token using the refresh token
   * @returns The token response from the server
   * @throws AuthError if refresh fails
   */
  async refreshAccessToken(): Promise<OAuthTokenResponse> {
    if (!this.refreshToken) {
      throw createReauthError(
        this.serverUrl,
        this.profileName,
        `No refresh token available for profile ${this.profileName}`
      );
    }

    logger.debug(`Refreshing access token for profile: ${this.profileName}`);

    try {
      const tokenResponse = await discoverAndRefreshToken(this.serverUrl, this.refreshToken, this.clientId);

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

      logger.debug(`Access token refreshed successfully for profile: ${this.profileName}`);

      // Notify callback for persistence
      if (this.onTokenRefresh) {
        await this.onTokenRefresh(tokenResponse);
      }

      return tokenResponse;
    } catch (error) {
      if (error instanceof AuthError) {
        // Add re-authentication hint
        throw createReauthError(this.serverUrl, this.profileName, error.message);
      }
      logger.error(`Token refresh error: ${(error as Error).message}`);
      throw createReauthError(
        this.serverUrl,
        this.profileName,
        `Failed to refresh token: ${(error as Error).message}`
      );
    }
  }

  /**
   * Get a valid access token, refreshing if necessary
   * @returns The current valid access token
   * @throws AuthError if refresh fails
   */
  async getValidAccessToken(): Promise<string> {
    logger.debug('>>> getValidAccessToken() called <<<');
    logger.debug(`  hasAccessToken: ${!!this.accessToken}`);
    logger.debug(`  accessTokenExpiresAt: ${this.accessTokenExpiresAt}`);
    logger.debug(`  isExpired: ${this.isAccessTokenExpired()}`);
    logger.debug(`  secondsUntilExpiry: ${this.getSecondsUntilExpiry()}`);

    if (this.isAccessTokenExpired()) {
      logger.debug('  Token is expired, refreshing...');
      await this.refreshAccessToken();
    } else {
      logger.debug('  Token is still valid, returning cached token');
    }

    if (!this.accessToken) {
      throw new AuthError('No access token available after refresh');
    }

    logger.debug(`  Returning token: ${this.accessToken.substring(0, 20)}...`);
    return this.accessToken;
  }
}
