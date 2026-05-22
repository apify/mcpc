/**
 * OS Keychain integration for secure credential storage
 * Uses @napi-rs/keyring for cross-platform keychain access.
 * Falls back to ~/.mcpc/credentials.json (mode 0600) when the OS keychain
 * is unavailable (e.g. headless servers, containers, missing libsecret).
 *
 * The @napi-rs/keyring native addon is loaded lazily on first use via a
 * cached import() promise.  If the addon or its shared-library dependency
 * (libsecret on Linux) is not present, a one-time warning is emitted and
 * file-based fallback is used for the entire session.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import chalk from 'chalk';
import { createLogger, getJsonMode } from '../logger.js';
import { getServerHost, getMcpcHome } from '../utils.js';
import { withFileLock } from '../file-lock.js';

const logger = createLogger('keychain');
const SERVICE_NAME = 'mcpc';

// =============================================================================
// File-based fallback store
// =============================================================================

const credentialsPath = (): string => join(getMcpcHome(), 'credentials.json');

async function fileGet(account: string): Promise<string | null> {
  try {
    const data = JSON.parse(await readFile(credentialsPath(), 'utf8')) as Record<string, string>;
    return data[account] ?? null;
  } catch {
    return null;
  }
}

async function fileSet(account: string, value: string): Promise<void> {
  await withFileLock(credentialsPath(), async () => {
    const raw = await readFile(credentialsPath(), 'utf8').catch(() => '{}');
    const data = { ...(JSON.parse(raw) as Record<string, string>), [account]: value };
    await writeFile(credentialsPath(), JSON.stringify(data), { mode: 0o600 });
  });
}

async function fileDelete(account: string): Promise<boolean> {
  return withFileLock(credentialsPath(), async () => {
    const raw = await readFile(credentialsPath(), 'utf8').catch(() => '{}');
    const data = JSON.parse(raw) as Record<string, string>;
    if (!(account in data)) return false;
    delete data[account];
    await writeFile(credentialsPath(), JSON.stringify(data), { mode: 0o600 });
    return true;
  });
}

// =============================================================================
// Keychain wrappers with automatic file fallback
// =============================================================================

// Typed structurally to avoid a hard import-time dependency on the package.
type EntryLike = {
  setPassword(value: string): void;
  getPassword(): string | null;
  deletePassword(): boolean;
};
type EntryConstructor = new (service: string, account: string) => EntryLike;

let keychainAvailable: boolean | null = null; // null = untested

// Cache the import() result so the native addon is attempted only once per
// module instance. Using a promise (not top-level await) avoids forcing every
// consumer (including test runners) into top-level-await territory.
// Rejects if the addon or its shared-library dependency (libsecret) is absent.
let _entryPromise: Promise<EntryConstructor> | null = null;

function getEntry(): Promise<EntryConstructor> {
  if (_entryPromise === null) {
    _entryPromise = import('@napi-rs/keyring').then((m) => m.Entry as unknown as EntryConstructor);
  }
  return _entryPromise;
}

/** Probe the OS keychain by performing a write, read-back, and delete. */
async function probeKeychain(EntryClass: EntryConstructor): Promise<boolean> {
  const probeAccount = `__mcpc_probe_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
  try {
    const entry = new EntryClass(SERVICE_NAME, probeAccount);
    const probeValue = `probe-${Date.now()}`;
    entry.setPassword(probeValue);
    const readBack = entry.getPassword();
    entry.deletePassword();
    return readBack === probeValue;
  } catch {
    return false;
  }
}

// Serialise the one-time probe so concurrent callers don't race.
let _probePromise: Promise<void> | null = null;

async function ensureProbed(): Promise<void> {
  if (keychainAvailable !== null) return;
  if (_probePromise === null) {
    _probePromise = (async () => {
      try {
        const EntryClass = await getEntry();
        keychainAvailable = await probeKeychain(EntryClass);
      } catch {
        // import() itself failed (missing native addon / libsecret)
        keychainAvailable = false;
      }
      if (!keychainAvailable && !getJsonMode()) {
        logger.warn(
          chalk.red(
            `OS keychain unavailable, ` +
              `falling back to file-based credential storage (${credentialsPath()}). ` +
              `Install a keyring daemon (e.g. gnome-keyring or kwallet) for better security.`
          )
        );
      }
    })();
  }
  return _probePromise;
}

async function withKeychain<T>(
  keychainOp: (EntryClass: EntryConstructor) => T,
  fallback: () => Promise<T>
): Promise<T> {
  await ensureProbed();
  if (keychainAvailable === false) return fallback();

  const EntryClass = await getEntry();
  return keychainOp(EntryClass);
}

function keychainSet(account: string, value: string): Promise<void> {
  return withKeychain(
    (EntryClass) => {
      new EntryClass(SERVICE_NAME, account).setPassword(value);
    },
    () => fileSet(account, value)
  );
}

function keychainGet(account: string): Promise<string | null> {
  return withKeychain(
    (EntryClass) => new EntryClass(SERVICE_NAME, account).getPassword() ?? null,
    () => fileGet(account)
  );
}

function keychainDelete(account: string): Promise<boolean> {
  return withKeychain(
    (EntryClass) => new EntryClass(SERVICE_NAME, account).deletePassword(),
    () => fileDelete(account)
  );
}

async function keychainGetParsed<T>(account: string, label: string): Promise<T | undefined> {
  const raw = await keychainGet(account);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    logger.error(`Failed to parse ${label}: ${(error as Error).message}`);
    return undefined;
  }
}

// =============================================================================
// Types
// =============================================================================

export interface OAuthClientInfo {
  clientId: string;
  clientSecret?: string;
}

export interface OAuthTokenInfo {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresIn?: number;
  expiresAt?: number; // Unix timestamp
  scope?: string;
}

// =============================================================================
// Account name builders
// =============================================================================

const oauthClientAccount = (serverUrl: string, profileName: string): string =>
  `auth-profile:${getServerHost(serverUrl)}:${profileName}:client`;

const oauthTokensAccount = (serverUrl: string, profileName: string): string =>
  `auth-profile:${getServerHost(serverUrl)}:${profileName}:tokens`;

const sessionHeadersAccount = (sessionName: string): string => `session:${sessionName}:headers`;

const proxyBearerTokenAccount = (sessionName: string): string =>
  `session:${sessionName}:proxy-bearer-token`;

const x402WalletAccount = (): string => `x402-wallet`;

// =============================================================================
// Public API
// =============================================================================

export async function isKeychainAvailable(): Promise<boolean> {
  await ensureProbed();
  return keychainAvailable === true;
}

export async function setKeychainOnly(account: string, value: string): Promise<void> {
  await ensureProbed();
  if (keychainAvailable !== true) throw new Error('Keychain is not available');
  const EntryClass = await getEntry();
  new EntryClass(SERVICE_NAME, account).setPassword(value);
}

export async function getKeychainOnly(account: string): Promise<string | null> {
  await ensureProbed();
  if (keychainAvailable !== true) throw new Error('Keychain is not available');
  const EntryClass = await getEntry();
  return new EntryClass(SERVICE_NAME, account).getPassword() ?? null;
}

export async function deleteKeychainOnly(account: string): Promise<boolean> {
  await ensureProbed();
  if (keychainAvailable !== true) throw new Error('Keychain is not available');
  const EntryClass = await getEntry();
  return new EntryClass(SERVICE_NAME, account).deletePassword();
}

/** Store OAuth client registration info for an auth profile. */
export async function storeKeychainOAuthClientInfo(
  serverUrl: string,
  profileName: string,
  client: OAuthClientInfo
): Promise<void> {
  logger.debug(`Storing OAuth client info for ${profileName} @ ${serverUrl}`);
  await keychainSet(oauthClientAccount(serverUrl, profileName), JSON.stringify(client));
}

/** Read OAuth client registration info for an auth profile. */
export async function readKeychainOAuthClientInfo(
  serverUrl: string,
  profileName: string
): Promise<OAuthClientInfo | undefined> {
  logger.debug(`Retrieving OAuth client info for ${profileName} @ ${serverUrl}`);
  return keychainGetParsed<OAuthClientInfo>(
    oauthClientAccount(serverUrl, profileName),
    'OAuth client info'
  );
}

/** Delete OAuth client registration info for an auth profile. */
export async function removeKeychainOAuthClientInfo(
  serverUrl: string,
  profileName: string
): Promise<boolean> {
  logger.debug(`Deleting OAuth client info for ${profileName} @ ${serverUrl}`);
  return keychainDelete(oauthClientAccount(serverUrl, profileName));
}

/** Store OAuth tokens for an auth profile. */
export async function storeKeychainOAuthTokenInfo(
  serverUrl: string,
  profileName: string,
  tokens: OAuthTokenInfo
): Promise<void> {
  logger.debug(`Storing OAuth tokens for ${profileName} @ ${serverUrl}`);
  await keychainSet(oauthTokensAccount(serverUrl, profileName), JSON.stringify(tokens));
}

/** Read OAuth tokens for an auth profile. */
export async function readKeychainOAuthTokenInfo(
  serverUrl: string,
  profileName: string
): Promise<OAuthTokenInfo | undefined> {
  logger.debug(`Retrieving OAuth tokens for ${profileName} @ ${serverUrl}`);
  return keychainGetParsed<OAuthTokenInfo>(
    oauthTokensAccount(serverUrl, profileName),
    'OAuth tokens'
  );
}

/** Delete OAuth tokens for an auth profile. */
export async function removeKeychainOAuthTokenInfo(
  serverUrl: string,
  profileName: string
): Promise<boolean> {
  logger.debug(`Deleting OAuth tokens for ${profileName} @ ${serverUrl}`);
  return keychainDelete(oauthTokensAccount(serverUrl, profileName));
}

/** Store custom HTTP headers for a session. */
export async function storeKeychainSessionHeaders(
  sessionName: string,
  headers: Record<string, string>
): Promise<void> {
  logger.debug(`Storing headers for session ${sessionName}`);
  await keychainSet(sessionHeadersAccount(sessionName), JSON.stringify(headers));
}

/** Read custom HTTP headers for a session. */
export async function readKeychainSessionHeaders(
  sessionName: string
): Promise<Record<string, string> | undefined> {
  logger.debug(`Retrieving headers for session ${sessionName}`);
  return keychainGetParsed<Record<string, string>>(
    sessionHeadersAccount(sessionName),
    'session headers'
  );
}

/** Delete custom HTTP headers for a session. */
export async function removeKeychainSessionHeaders(sessionName: string): Promise<boolean> {
  logger.debug(`Deleting headers for session ${sessionName}`);
  return keychainDelete(sessionHeadersAccount(sessionName));
}

/** Store the bearer token used to authenticate requests to the proxy server. */
export async function storeKeychainProxyBearerToken(
  sessionName: string,
  token: string
): Promise<void> {
  logger.debug(`Storing proxy bearer token for session ${sessionName}`);
  await keychainSet(proxyBearerTokenAccount(sessionName), token);
}

/** Read the bearer token used to authenticate requests to the proxy server. */
export async function readKeychainProxyBearerToken(
  sessionName: string
): Promise<string | undefined> {
  logger.debug(`Retrieving proxy bearer token for session ${sessionName}`);
  return (await keychainGet(proxyBearerTokenAccount(sessionName))) ?? undefined;
}

/** Delete the bearer token used to authenticate requests to the proxy server. */
export async function removeKeychainProxyBearerToken(sessionName: string): Promise<boolean> {
  logger.debug(`Deleting proxy bearer token for session ${sessionName}`);
  return keychainDelete(proxyBearerTokenAccount(sessionName));
}

/** Store the x402 wallet data. */
export async function storeKeychainX402Wallet<T>(wallet: T): Promise<void> {
  logger.debug(`Storing x402 wallet in OS keychain`);
  await setKeychainOnly(x402WalletAccount(), JSON.stringify(wallet));
}

/** Read the x402 wallet data. */
export async function readKeychainX402Wallet<T>(): Promise<T | undefined> {
  logger.debug(`Retrieving x402 wallet from OS keychain`);
  try {
    const raw = await getKeychainOnly(x402WalletAccount());
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as Error).message === 'Keychain is not available') return undefined;
    logger.error(`Failed to parse x402 wallet: ${(error as Error).message}`);
    return undefined;
  }
}

/** Delete the x402 wallet data. */
export async function removeKeychainX402Wallet(): Promise<boolean> {
  logger.debug(`Deleting x402 wallet from OS keychain`);
  try {
    return await deleteKeychainOnly(x402WalletAccount());
  } catch (error) {
    if ((error as Error).message === 'Keychain is not available') return false;
    throw error;
  }
}
