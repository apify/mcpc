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
 * Keychain key types
 */
export type KeychainKeyType = 'oauth-tokens' | 'oauth-client' | 'bearer-token';

/**
 * Build a keychain account name for OAuth credentials
 * Format: auth:<serverUrl>:<profileName>:<type>
 */
function buildOAuthAccountName(serverUrl: string, profileName: string, type: KeychainKeyType): string {
  return `auth:${serverUrl}:${profileName}:${type}`;
}

/**
 * Build a keychain account name for session headers
 * Format: session:<sessionName>:headers
 */
function buildSessionAccountName(sessionName: string): string {
  return `session:${sessionName}:headers`;
}

/**
 * OAuth tokens stored in keychain
 */
export interface KeychainOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresIn?: number;
  expiresAt?: number; // Unix timestamp
  scope?: string;
}

/**
 * OAuth client information stored in keychain (from dynamic registration)
 */
export interface KeychainOAuthClient {
  clientId: string;
  clientSecret?: string;
}

/**
 * Store OAuth tokens in keychain
 */
export async function storeOAuthTokens(
  serverUrl: string,
  profileName: string,
  tokens: KeychainOAuthTokens
): Promise<void> {
  const account = buildOAuthAccountName(serverUrl, profileName, 'oauth-tokens');
  const value = JSON.stringify(tokens);

  logger.debug(`Storing OAuth tokens for ${profileName} @ ${serverUrl}`);
  await keytar.setPassword(SERVICE_NAME, account, value);
}

/**
 * Retrieve OAuth tokens from keychain
 */
export async function getOAuthTokens(
  serverUrl: string,
  profileName: string
): Promise<KeychainOAuthTokens | undefined> {
  const account = buildOAuthAccountName(serverUrl, profileName, 'oauth-tokens');

  logger.debug(`Retrieving OAuth tokens for ${profileName} @ ${serverUrl}`);
  const value = await keytar.getPassword(SERVICE_NAME, account);

  if (!value) {
    return undefined;
  }

  try {
    // TODO: Check schema?
    return JSON.parse(value) as KeychainOAuthTokens;
  } catch (error) {
    logger.error(`Failed to parse OAuth tokens from keychain: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Delete OAuth tokens from keychain
 */
export async function deleteOAuthTokens(
  serverUrl: string,
  profileName: string
): Promise<boolean> {
  const account = buildOAuthAccountName(serverUrl, profileName, 'oauth-tokens');

  logger.debug(`Deleting OAuth tokens for ${profileName} @ ${serverUrl}`);
  return keytar.deletePassword(SERVICE_NAME, account);
}

/**
 * Store OAuth client information in keychain (from dynamic registration)
 */
export async function storeOAuthClient(
  serverUrl: string,
  profileName: string,
  client: KeychainOAuthClient
): Promise<void> {
  const account = buildOAuthAccountName(serverUrl, profileName, 'oauth-client');
  const value = JSON.stringify(client);

  logger.debug(`Storing OAuth client for ${profileName} @ ${serverUrl}`);
  await keytar.setPassword(SERVICE_NAME, account, value);
}

/**
 * Retrieve OAuth client information from keychain
 */
export async function getOAuthClient(
  serverUrl: string,
  profileName: string
): Promise<KeychainOAuthClient | undefined> {
  const account = buildOAuthAccountName(serverUrl, profileName, 'oauth-client');

  logger.debug(`Retrieving OAuth client for ${profileName} @ ${serverUrl}`);
  const value = await keytar.getPassword(SERVICE_NAME, account);

  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as KeychainOAuthClient;
  } catch (error) {
    logger.error(`Failed to parse OAuth client from keychain: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Delete OAuth client information from keychain
 */
export async function deleteOAuthClient(
  serverUrl: string,
  profileName: string
): Promise<boolean> {
  const account = buildOAuthAccountName(serverUrl, profileName, 'oauth-client');

  logger.debug(`Deleting OAuth client for ${profileName} @ ${serverUrl}`);
  return keytar.deletePassword(SERVICE_NAME, account);
}

/**
 * Store HTTP headers for a session in keychain
 * All headers from --header flags are treated as potentially sensitive
 */
export async function storeSessionHeaders(
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
export async function getSessionHeaders(
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
export async function deleteSessionHeaders(
  sessionName: string
): Promise<boolean> {
  const account = buildSessionAccountName(sessionName);

  logger.debug(`Deleting headers for session ${sessionName}`);
  return keytar.deletePassword(SERVICE_NAME, account);
}

/**
 * Delete all credentials for an OAuth profile (tokens and client info)
 */
export async function deleteOAuthProfile(
  serverUrl: string,
  profileName: string
): Promise<void> {
  logger.debug(`Deleting all OAuth credentials for ${profileName} @ ${serverUrl}`);

  await deleteOAuthTokens(serverUrl, profileName);
  await deleteOAuthClient(serverUrl, profileName);
}

/**
 * List all mcpc credentials in keychain (for debugging)
 * Returns account names only, not the actual secrets
 */
export async function listCredentials(): Promise<string[]> {
  const credentials = await keytar.findCredentials(SERVICE_NAME);
  return credentials.map(c => c.account);
}
