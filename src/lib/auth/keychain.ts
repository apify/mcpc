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
 * Get a keychain account name for OAuth client info
 */
function buildOAuthClientAccountName(serverUrl: string, profileName: string): string {
  return `auth-profile:${serverUrl}:${profileName}:client`;
}

/**
 * Get a keychain account name for OAuth tokens
 */
function buildOAuthTokensAccountName(serverUrl: string, profileName: string): string {
  return `auth-profile:${serverUrl}:${profileName}:tokens`;
}

/**
 * Get a keychain account name for session headers
 */
function buildSessionAccountName(sessionName: string): string {
  return `session:${sessionName}:headers`;
}

/**
 * Store OAuth client info in keychain
 */
export async function storeKeychainOAuthClientInfo(
  serverUrl: string,
  profileName: string,
  client: OAuthClientInfo
): Promise<void> {
  const account = buildOAuthClientAccountName(serverUrl, profileName);
  const value = JSON.stringify(client);

  logger.debug(`Storing OAuth client info for ${profileName} @ ${serverUrl}`);
  await keytar.setPassword(SERVICE_NAME, account, value);
}

/**
 * Get OAuth client info from keychain
 */
export async function readKeychainOAuthClientInfo(
  serverUrl: string,
  profileName: string
): Promise<OAuthClientInfo | undefined> {
  const account = buildOAuthClientAccountName(serverUrl, profileName);

  logger.debug(`Retrieving OAuth client info for ${profileName} @ ${serverUrl}`);
  const value = await keytar.getPassword(SERVICE_NAME, account);

  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as OAuthClientInfo;
  } catch (error) {
    logger.error(`Failed to parse OAuth client info from keychain: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Delete OAuth client info from keychain
 */
export async function removeKeychainOAuthClientInfo(
  serverUrl: string,
  profileName: string
): Promise<boolean> {
  const account = buildOAuthClientAccountName(serverUrl, profileName);

  logger.debug(`Deleting OAuth client info for ${profileName} @ ${serverUrl}`);
  return keytar.deletePassword(SERVICE_NAME, account);
}

/**
 * Store OAuth tokens in keychain
 */
export async function storeKeychainOAuthTokenInfo(
  serverUrl: string,
  profileName: string,
  tokens: OAuthTokenInfo
): Promise<void> {
  const account = buildOAuthTokensAccountName(serverUrl, profileName);
  const value = JSON.stringify(tokens);

  logger.debug(`Storing OAuth tokens for ${profileName} @ ${serverUrl}`);
  await keytar.setPassword(SERVICE_NAME, account, value);
}

/**
 * Get OAuth tokens from keychain
 */
export async function readKeychainOAuthTokenInfo(
  serverUrl: string,
  profileName: string
): Promise<OAuthTokenInfo | undefined> {
  const account = buildOAuthTokensAccountName(serverUrl, profileName);

  logger.debug(`Retrieving OAuth tokens for ${profileName} @ ${serverUrl}`);
  const value = await keytar.getPassword(SERVICE_NAME, account);

  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as OAuthTokenInfo;
  } catch (error) {
    logger.error(`Failed to parse OAuth tokens from keychain: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Delete OAuth tokens from keychain
 */
export async function removeKeychainOAuthTokenInfo(
  serverUrl: string,
  profileName: string
): Promise<boolean> {
  const account = buildOAuthTokensAccountName(serverUrl, profileName);

  logger.debug(`Deleting OAuth tokens for ${profileName} @ ${serverUrl}`);
  return keytar.deletePassword(SERVICE_NAME, account);
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
export async function readKeychainSessionHeaders(
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
export async function removeKeychainSessionHeaders(sessionName: string): Promise<boolean> {
  const account = buildSessionAccountName(sessionName);

  logger.debug(`Deleting headers for session ${sessionName}`);
  return keytar.deletePassword(SERVICE_NAME, account);
}
