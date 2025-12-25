/**
 * Token refresh functionality for OAuth profiles
 * Handles automatic refresh of expired access tokens using refresh tokens
 * Tokens are stored securely in OS keychain
 */

import type { AuthProfile } from '../types.js';
import { getAuthProfile, saveAuthProfile } from '../auth/auth-profiles.js';
import { createLogger } from '../logger.js';
import { createReauthError, DEFAULT_AUTH_PROFILE } from './oauth-utils.js';
import { getKeychainOAuthTokenInfo, saveKeychainOAuthTokenInfo, type OAuthTokenInfo } from './keychain.js';
import { OAuthTokenManager, type OnTokenRefreshCallback } from './oauth-token-manager.js';

const logger = createLogger('token-refresh');

/**
 * Create a persistence callback for OAuthTokenManager that saves tokens to keychain
 */
function createPersistenceCallback(
  serverUrl: string,
  profileName: string,
  profile: AuthProfile
): OnTokenRefreshCallback {
  return async (newTokens) => {
    // Store tokens in keychain
    const tokenInfo: OAuthTokenInfo = {
      accessToken: newTokens.access_token,
      tokenType: newTokens.token_type,
    };
    if (newTokens.expires_in !== undefined) {
      tokenInfo.expiresIn = newTokens.expires_in;
      tokenInfo.expiresAt = Math.floor(Date.now() / 1000) + newTokens.expires_in;
    }
    if (newTokens.refresh_token !== undefined) {
      tokenInfo.refreshToken = newTokens.refresh_token;
    }
    if (newTokens.scope !== undefined) {
      tokenInfo.scope = newTokens.scope;
    }
    await saveKeychainOAuthTokenInfo(serverUrl, profileName, tokenInfo);

    // Update profile metadata
    const now = new Date().toISOString();
    const updatedProfile: AuthProfile = {
      ...profile,
      authenticatedAt: now,
      updatedAt: now,
    };
    if (newTokens.scope) {
      updatedProfile.scopes = newTokens.scope.split(' ');
    }
    await saveAuthProfile(updatedProfile);

    logger.info(`Token refreshed and saved for profile: ${profileName}`);
  };
}

/**
 * Get a valid access token for a profile, refreshing if necessary
 * Tokens are loaded from and saved to OS keychain automatically
 *
 * @returns The access token, or undefined if no profile/tokens exist
 * @throws AuthError if token is expired and cannot be refreshed
 */
export async function getValidAccessTokenFromKeychain(
  serverUrl: string,
  profileName: string = DEFAULT_AUTH_PROFILE
): Promise<string | undefined> {
  // Load profile metadata
  const profile = await getAuthProfile(serverUrl, profileName);
  if (!profile) {
    logger.debug(`No auth profile found for ${serverUrl} (profile: ${profileName})`);
    return undefined;
  }

  // Load tokens from keychain
  const tokens = await getKeychainOAuthTokenInfo(serverUrl, profileName);
  if (!tokens?.accessToken) {
    logger.warn(`Auth profile exists but has no access token in keychain: ${profileName}`);
    return undefined;
  }

  // If no refresh token, check if current token is still valid
  if (!tokens.refreshToken) {
    if (tokens.expiresAt && Date.now() / 1000 > tokens.expiresAt - 60) {
      throw createReauthError(
        serverUrl,
        profileName,
        'Authentication token expired and no refresh token available'
      );
    }
    // Token is still valid (or no expiry info)
    logger.debug(`Using auth profile: ${profileName}`);
    return tokens.accessToken;
  }

  // Create token manager with persistence callback
  const tokenManager = new OAuthTokenManager({
    serverUrl,
    profileName,
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    ...(tokens.expiresAt !== undefined && { accessTokenExpiresAt: tokens.expiresAt }),
    onTokenRefresh: createPersistenceCallback(serverUrl, profileName, profile),
  });

  // Get valid token (will refresh and persist if expired)
  logger.debug(`Using auth profile: ${profileName}`);
  return await tokenManager.getValidAccessToken();
}
