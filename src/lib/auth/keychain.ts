/**
 * OS Keychain integration for secure credential storage
 * Uses keytar package for cross-platform keychain access
 */

import keytar from 'keytar';
import { createLogger } from '../logger.js';

const logger = createLogger('keychain');

// Service name for all mcpc credentials in the keychain
const SERVICE_NAME = 'mcpc';

/**
 * OAuth client information (from dynamic registration)
 */
export interface OAuthClientInfo {
  clientId: string;
  clientSecret?: string;
}

/**
 * OAuth tokens
 */
export interface OAuthTokenInfo {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresIn?: number;
  expiresAt?: number; // Unix timestamp
  scope?: string;
}

/**
 * OAuth credentials stored in keychain (client info + tokens)
 */
export type KeychainOAuthInfo = OAuthClientInfo & OAuthTokenInfo;

/**
 * Build a keychain account name for OAuth credentials
 * Format: auth:<serverUrl>:<profileName>
 */
function buildOAuthAccountName(serverUrl: string, profileName: string): string {
  return `auth-profile:${serverUrl}:${profileName}`;
}

/**
 * Build a keychain account name for session headers
 * Format: session:<sessionName>:headers
 */
function buildSessionAccountName(sessionName: string): string {
  return `session:${sessionName}:headers`;
}

/**
 * Store OAuth credentials in keychain
 */
async function storeKeychainOAuthInfo(
  serverUrl: string,
  profileName: string,
  credentials: KeychainOAuthInfo
): Promise<void> {
  const account = buildOAuthAccountName(serverUrl, profileName);
  const value = JSON.stringify(credentials);

  logger.debug(`Storing OAuth credentials for ${profileName} @ ${serverUrl}`);
  await keytar.setPassword(SERVICE_NAME, account, value);
}

/**
 * Retrieve OAuth credentials from keychain
 */
async function getKeychainOAuthInfo(
  serverUrl: string,
  profileName: string
): Promise<KeychainOAuthInfo | undefined> {
  const account = buildOAuthAccountName(serverUrl, profileName);

  logger.debug(`Retrieving OAuth credentials for ${profileName} @ ${serverUrl}`);
  const value = await keytar.getPassword(SERVICE_NAME, account);

  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as KeychainOAuthInfo;
  } catch (error) {
    logger.error(`Failed to parse OAuth credentials from keychain: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Delete OAuth credentials from keychain
 */
export async function deleteKeychainOAuthInfo(
  serverUrl: string,
  profileName: string
): Promise<boolean> {
  const account = buildOAuthAccountName(serverUrl, profileName);

  logger.debug(`Deleting OAuth credentials for ${profileName} @ ${serverUrl}`);
  return keytar.deletePassword(SERVICE_NAME, account);
}

/**
 * Store OAuth client info, preserving existing tokens
 * Used after dynamic client registration (before tokens exist)
 */
export async function saveKeychainOAuthClientInfo(
  serverUrl: string,
  profileName: string,
  client: OAuthClientInfo
): Promise<void> {
  const existing = await getKeychainOAuthInfo(serverUrl, profileName);

  // Build credentials, only including defined values
  const credentials: KeychainOAuthInfo = {
    accessToken: existing?.accessToken ?? '',
    tokenType: existing?.tokenType ?? 'Bearer',
    clientId: client.clientId,
  };

  // Preserve existing token fields if any
  if (existing?.refreshToken) credentials.refreshToken = existing.refreshToken;
  if (existing?.expiresIn !== undefined) credentials.expiresIn = existing.expiresIn;
  if (existing?.expiresAt !== undefined) credentials.expiresAt = existing.expiresAt;
  if (existing?.scope) credentials.scope = existing.scope;

  // Add client secret if provided
  if (client.clientSecret) credentials.clientSecret = client.clientSecret;

  await storeKeychainOAuthInfo(serverUrl, profileName, credentials);
}

/**
 * Get OAuth client info from keychain
 */
export async function getKeychainOAuthClient(
  serverUrl: string,
  profileName: string
): Promise<OAuthClientInfo | undefined> {
  const info = await getKeychainOAuthInfo(serverUrl, profileName);
  if (!info?.clientId) {
    return undefined;
  }
  const result: OAuthClientInfo = {
    clientId: info.clientId,
  };
  if (info.clientSecret) {
    result.clientSecret = info.clientSecret;
  }
  return result;
}

/**
 * Store OAuth tokens, preserving existing client info
 * Used after OAuth flow completes
 */
export async function saveKeychainOAuthTokenInfo(
  serverUrl: string,
  profileName: string,
  tokens: OAuthTokenInfo
): Promise<void> {
  const existing = await getKeychainOAuthInfo(serverUrl, profileName);

  if (!existing?.clientId) {
    throw new Error(`Cannot save tokens without client info for ${profileName} @ ${serverUrl}`);
  }

  // Build credentials, only including defined values
  const credentials: KeychainOAuthInfo = {
    clientId: existing.clientId,
    accessToken: tokens.accessToken,
    tokenType: tokens.tokenType,
  };

  // Preserve client secret if exists
  if (existing.clientSecret) credentials.clientSecret = existing.clientSecret;

  // Add token fields if provided
  if (tokens.refreshToken) credentials.refreshToken = tokens.refreshToken;
  if (tokens.expiresIn !== undefined) credentials.expiresIn = tokens.expiresIn;
  if (tokens.expiresAt !== undefined) credentials.expiresAt = tokens.expiresAt;
  if (tokens.scope) credentials.scope = tokens.scope;

  await storeKeychainOAuthInfo(serverUrl, profileName, credentials);
}

/**
 * Get OAuth tokens from keychain
 */
export async function getKeychainOAuthTokenInfo(
  serverUrl: string,
  profileName: string
): Promise<OAuthTokenInfo | undefined> {
  const info = await getKeychainOAuthInfo(serverUrl, profileName);
  if (!info?.accessToken) {
    return undefined;
  }
  const result: OAuthTokenInfo = {
    accessToken: info.accessToken,
    tokenType: info.tokenType,
  };
  if (info.refreshToken) result.refreshToken = info.refreshToken;
  if (info.expiresIn !== undefined) result.expiresIn = info.expiresIn;
  if (info.expiresAt !== undefined) result.expiresAt = info.expiresAt;
  if (info.scope) result.scope = info.scope;
  return result;
}

/**
 * Store HTTP headers for a session in keychain
 * All headers from --header flags are treated as potentially sensitive
 */
export async function storeKeychainSessionHeaders(
  sessionName: string,
  headers: Record<string, string>
): Promise<void> {
  const account = buildSessionAccountName(sessionName);
  const value = JSON.stringify(headers);

  logger.debug(`Storing headers for session ${sessionName}`);
  await keytar.setPassword(SERVICE_NAME, account, value);
}

/**
 * Retrieve HTTP headers for a session from keychain
 */
export async function getKeychainSessionHeaders(
  sessionName: string
): Promise<Record<string, string> | undefined> {
  const account = buildSessionAccountName(sessionName);

  logger.debug(`Retrieving headers for session ${sessionName}`);
  const value = await keytar.getPassword(SERVICE_NAME, account);

  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as Record<string, string>;
  } catch (error) {
    logger.error(`Failed to parse headers from keychain: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Delete HTTP headers for a session from keychain
 */
export async function deleteKeychainSessionHeaders(sessionName: string): Promise<boolean> {
  const account = buildSessionAccountName(sessionName);

  logger.debug(`Deleting headers for session ${sessionName}`);
  return keytar.deletePassword(SERVICE_NAME, account);
}
