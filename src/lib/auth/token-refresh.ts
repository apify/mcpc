/**
 * Token refresh functionality for OAuth profiles
 * Handles automatic refresh of expired access tokens using refresh tokens
 * Tokens are stored securely in OS keychain
 */

import type { AuthProfile, OAuthTokens } from '../types.js';
import { saveAuthProfile } from '../auth/auth-profiles.js';
import { createLogger } from '../logger.js';
import { AuthError } from '../errors.js';
import { getOAuthTokens, storeOAuthTokens, type KeychainOAuthTokens } from './keychain.js';
import { OAuthTokenManager } from './oauth-token-manager.js';

const logger = createLogger('token-refresh');

/**
 * Refresh OAuth tokens using the refresh token from keychain
 * Uses OAuthTokenManager for the refresh logic
 * Returns the new tokens on success, or throws an error on failure
 */
export async function refreshTokens(
  profile: AuthProfile
): Promise<OAuthTokens> {
  // Get refresh token from keychain
  const storedTokens = await getOAuthTokens(profile.serverUrl, profile.name);
  if (!storedTokens?.refreshToken) {
    throw new AuthError(
      `No refresh token available for profile ${profile.name}. ` +
        `Please re-authenticate with: mcpc ${profile.serverUrl} auth --profile ${profile.name}`
    );
  }

  // Use OAuthTokenManager to handle the refresh
  const tokenManager = new OAuthTokenManager({
    serverUrl: profile.serverUrl,
    profileName: profile.name,
    refreshToken: storedTokens.refreshToken,
  });

  const tokenResponse = await tokenManager.refreshAccessToken();

  // Build OAuthTokens object from response
  const newTokens: OAuthTokens = {
    access_token: tokenResponse.access_token,
    token_type: tokenResponse.token_type || 'Bearer',
  };

  if (tokenResponse.expires_in !== undefined) {
    newTokens.expires_in = tokenResponse.expires_in;
    newTokens.expires_at = Math.floor(Date.now() / 1000) + tokenResponse.expires_in;
  }

  // Use new refresh token if provided, otherwise keep the old one
  newTokens.refresh_token = tokenManager.getRefreshToken();

  if (tokenResponse.scope !== undefined) {
    newTokens.scope = tokenResponse.scope;
  }

  logger.info(`Token refreshed successfully for profile: ${profile.name}`);
  return newTokens;
}

/**
 * Refresh tokens and save to keychain
 * Returns the updated profile metadata (tokens are stored in keychain)
 */
export async function refreshAndSaveTokens(
  profile: AuthProfile
): Promise<AuthProfile> {
  const newTokens = await refreshTokens(profile);

  // Store tokens in keychain (convert from OAuth snake_case to camelCase)
  const keychainTokens: KeychainOAuthTokens = {
    accessToken: newTokens.access_token,
    tokenType: newTokens.token_type,
  };
  if (newTokens.expires_in !== undefined) {
    keychainTokens.expiresIn = newTokens.expires_in;
  }
  if (newTokens.expires_at !== undefined) {
    keychainTokens.expiresAt = newTokens.expires_at;
  }
  if (newTokens.refresh_token !== undefined) {
    keychainTokens.refreshToken = newTokens.refresh_token;
  }
  if (newTokens.scope !== undefined) {
    keychainTokens.scope = newTokens.scope;
  }
  await storeOAuthTokens(profile.serverUrl, profile.name, keychainTokens);

  // Update profile metadata (without tokens)
  const now = new Date().toISOString();
  const updatedProfile: AuthProfile = {
    ...profile,
    authenticatedAt: now,
    updatedAt: now,
  };

  // Update expiresAt if we have expiration info
  if (newTokens.expires_at) {
    updatedProfile.expiresAt = new Date(newTokens.expires_at * 1000).toISOString();
  }

  // Update scopes if provided
  if (newTokens.scope) {
    updatedProfile.scopes = newTokens.scope.split(' ');
  }

  // Save updated profile metadata
  await saveAuthProfile(updatedProfile);

  return updatedProfile;
}

/**
 * Check if a token is expired (or about to expire within buffer time)
 */
export function isTokenExpired(profile: AuthProfile, bufferSeconds: number = 60): boolean {
  if (!profile.expiresAt) {
    // No expiration info, assume not expired
    return false;
  }

  const expiresDate = new Date(profile.expiresAt);
  const bufferMs = bufferSeconds * 1000;
  const now = Date.now();

  return expiresDate.getTime() - bufferMs < now;
}

/**
 * Check if a profile has a refresh token in keychain
 */
export async function hasRefreshToken(profile: AuthProfile): Promise<boolean> {
  const tokens = await getOAuthTokens(profile.serverUrl, profile.name);
  return !!tokens?.refreshToken;
}
