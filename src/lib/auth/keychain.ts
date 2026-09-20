/**
 * OS Keychain integration for secure credential storage
 * Uses @napi-rs/keyring for cross-platform keychain access.
 * Falls back to ~/.mcpc/credentials.json (mode 0600) when the OS keychain
 * is unavailable (e.g. headless servers, containers, missing libsecret).
 *
 * The @napi-rs/keyring native addon is loaded lazily on first use via a
 * cached import() promise.  If the addon or its shared-library dependency
 * (libsecret on Linux) is not present, file-based fallback is used for the
 * entire session; a warning is shown once, when the fallback file is first
 * created (i.e. when credentials actually get stored outside the keychain).
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import chalk from 'chalk';
import { createLogger, getJsonMode } from '../logger.js';
import { getServerHost, getMcpcHome, fileExists } from '../utils.js';
import { withFileLock } from '../file-lock.js';
import { ClientError } from '../errors.js';
import type { IdJagCredentials } from '../types.js';

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
  // Warn exactly once, at the moment the fallback file gets created — i.e. when
  // credentials first start being stored outside the OS keychain. Reads and
  // subsequent writes stay silent (a debug-level trace is logged on every
  // fallback occurrence in ensureProbed). The existence check must run before
  // withFileLock, which pre-creates the file it locks.
  if (!getJsonMode() && !(await fileExists(credentialsPath()))) {
    logger.warn(
      chalk.red(
        `OS keychain unavailable, ` +
          `falling back to file-based credential storage (${credentialsPath()}). ` +
          `Install a keyring daemon (e.g. gnome-keyring or kwallet) for better security.`
      )
    );
  }
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

// -----------------------------------------------------------------------------
// Long values: split across several keychain entries
//
// Windows Credential Manager caps a credential blob at CRED_MAX_CREDENTIAL_BLOB_SIZE
// (2560 bytes) and the keyring crate stores passwords as UTF-16, so a write is
// rejected once the value exceeds 1280 UTF-16 code units ("Attribute 'password
// encoded as UTF-16' is longer than platform limit of 2560 chars"). OAuth token
// blobs (access + refresh token) routinely exceed that, which made `login` and
// background token refresh fail outright on Windows (#409).
//
// Splitting is a fallback, not the normal path: a write is attempted as it always
// was, and only a value the platform rejects for its size is stored as several
// entries — the account holds a header (`mcpc:chunked:v1:<count>`) and the parts
// live in `<account>#0`, `<account>#1`, ... So a credential that fits (every
// credential on macOS and Linux, and the short ones on Windows) still costs one
// keychain write to store and one read to load, exactly as before, and is stored
// in the same plain layout, so credentials written by earlier versions read back
// unchanged.
// -----------------------------------------------------------------------------

/** Tightest entry size any supported platform allows: 2560 bytes of UTF-16 (Windows). */
const MAX_ENTRY_UTF16_UNITS = 1280;
/** Part size once a value has to be split — just under the tightest platform limit. */
const CHUNK_SIZE_UTF16_UNITS = 1200;
/**
 * Refuse to store a credential larger than this.
 *
 * Splitting turns one value into as many entries as it takes, so without a
 * ceiling a server handing out an absurd token could have mcpc write an
 * unbounded number of credentials into the user's keychain. 50 K characters is
 * far more than any real credential — tokens run to a few KB — and caps a split
 * value at ~43 entries.
 */
const MAX_VALUE_UTF16_UNITS = 50 * 1024;
const CHUNK_HEADER_PREFIX = 'mcpc:chunked:v1:';

const chunkAccount = (account: string, index: number): string => `${account}#${index}`;

/**
 * Accounts this process has seen stored in parts.
 *
 * Writing a value that fits over an account that was split leaves the old parts
 * behind, and finding that out costs a keychain read before every single write.
 * Remembering the accounts we have already read or split keeps the common write
 * path at one keychain call and still cleans up the case that produces stale
 * parts in practice: a token refresh, which reads the stored tokens before it
 * writes the rotated ones. Parts missed that way (a shorter value blindly
 * overwriting a split one in a process that never read it) are removed when the
 * credential is deleted, which always checks.
 */
const splitAccounts = new Set<string>();

/** Reject an implausibly large credential before it reaches either store. */
function assertStorableSize(account: string, value: string): void {
  if (value.length > MAX_VALUE_UTF16_UNITS) {
    throw new ClientError(
      `Refusing to store credential '${account}': ${value.length} characters exceeds the ` +
        `${MAX_VALUE_UTF16_UNITS} character limit. A credential this large is not something ` +
        `mcpc issued — check what the server returned.`
    );
  }
}

/** Number of parts a chunk header announces, or null when the value is a plain one. */
function parseChunkHeader(raw: string | null): number | null {
  if (raw === null || !raw.startsWith(CHUNK_HEADER_PREFIX)) return null;
  const count = Number(raw.slice(CHUNK_HEADER_PREFIX.length));
  return Number.isInteger(count) && count > 0 ? count : null;
}

/** Did the platform reject this write because the value is too big for one entry? */
function isValueTooLongError(error: unknown, value: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/longer than (the )?platform limit|too long/i.test(message)) return true;
  // Belt and braces: a value over the tightest limit any platform imposes is
  // treated as rejected for its size whatever the wording, so a reworded error
  // in some future keyring release cannot bring the Windows failure back.
  return value.length > MAX_ENTRY_UTF16_UNITS;
}

/** Split a value into entry-sized parts, never cutting a surrogate pair in half. */
function splitIntoChunks(value: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + CHUNK_SIZE_UTF16_UNITS, value.length);
    // A lone surrogate would not survive the round-trip through the platform store.
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * Delete the parts from `from` onwards. Parts are numbered contiguously, so the
 * scan stops at the first one that is already gone — which keeps this to a single
 * (cheap, missing-entry) lookup when there is nothing to clean up.
 */
function deleteChunksFrom(EntryClass: EntryConstructor, account: string, from: number): void {
  for (let i = from; ; i++) {
    try {
      if (!new EntryClass(SERVICE_NAME, chunkAccount(account, i)).deletePassword()) return;
    } catch {
      // A leftover part is harmless: it is never read without a header pointing at it.
      return;
    }
  }
}

/** Store a value in numbered parts, replacing whatever the account held before. */
function setChunked(EntryClass: EntryConstructor, account: string, value: string): void {
  const chunks = splitIntoChunks(value);
  chunks.forEach((chunk, i) =>
    new EntryClass(SERVICE_NAME, chunkAccount(account, i)).setPassword(chunk)
  );
  // The header goes last: it is what makes the new parts readable.
  new EntryClass(SERVICE_NAME, account).setPassword(`${CHUNK_HEADER_PREFIX}${chunks.length}`);
  splitAccounts.add(account);
  // Parts of a longer previous value, beyond the ones just overwritten.
  deleteChunksFrom(EntryClass, account, chunks.length);
}

function entrySet(EntryClass: EntryConstructor, account: string, value: string): void {
  // A value that would read back as a header has to be stored in parts, however
  // short it is, so a header never means anything but "this value is in parts".
  if (parseChunkHeader(value) === null) {
    try {
      // Fast path: the single write this has always been.
      new EntryClass(SERVICE_NAME, account).setPassword(value);
      // The value fit, so the account is plain now; drop parts it held before.
      if (splitAccounts.delete(account)) deleteChunksFrom(EntryClass, account, 0);
      return;
    } catch (error) {
      if (!isValueTooLongError(error, value)) throw error;
    }
  }
  setChunked(EntryClass, account, value);
}

function entryGet(EntryClass: EntryConstructor, account: string): string | null {
  const raw = new EntryClass(SERVICE_NAME, account).getPassword() ?? null;
  const count = parseChunkHeader(raw);
  if (count === null) return raw; // one read, as before — the overwhelmingly common case

  splitAccounts.add(account);
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const part = new EntryClass(SERVICE_NAME, chunkAccount(account, i)).getPassword() ?? null;
    if (part === null) {
      logger.warn(
        `Credential '${account}' is incomplete in the OS keychain ` +
          `(part ${i + 1} of ${count} is missing); treating it as absent`
      );
      return null;
    }
    parts.push(part);
  }
  return parts.join('');
}

function entryDelete(EntryClass: EntryConstructor, account: string): boolean {
  // Deleting has to be thorough even in a process that never read the value — a
  // `logout` never does — so this always scans for parts instead of trusting
  // `splitAccounts`. It costs one missing-entry lookup when there are none.
  deleteChunksFrom(EntryClass, account, 0);
  splitAccounts.delete(account);
  return new EntryClass(SERVICE_NAME, account).deletePassword();
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
      if (!keychainAvailable) {
        // Debug-level only: the user-facing warning is emitted once, when the
        // fallback file is first created (see fileSet). Warning on every probe
        // would repeat on every mcpc invocation, since each one is a fresh process.
        logger.debug(`OS keychain unavailable, using file-based credential storage`);
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
  assertStorableSize(account, value);
  return withKeychain(
    (EntryClass) => entrySet(EntryClass, account, value),
    () => fileSet(account, value)
  );
}

function keychainGet(account: string): Promise<string | null> {
  return withKeychain(
    (EntryClass) => entryGet(EntryClass, account),
    () => fileGet(account)
  );
}

function keychainDelete(account: string): Promise<boolean> {
  return withKeychain(
    (EntryClass) => entryDelete(EntryClass, account),
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

/**
 * Client-credentials grant material for a profile (machine-to-machine auth).
 * Stored separately from OAuthClientInfo (which holds DCR/CIMD client registration
 * for the authorization-code flow) so the two grants never clobber each other.
 * Exactly one of `clientSecret` / `privateKeyPem` is set.
 */
export interface OAuthClientCredentialsInfo {
  clientId: string;
  clientSecret?: string; // client_secret_basic variant
  privateKeyPem?: string; // private_key_jwt variant (RFC 7523), PEM-encoded
  keyAlg?: string; // JWT signing algorithm for the private_key_jwt variant
  scope?: string; // space-separated scopes requested by the grant
  tokenEndpoint?: string; // explicit token endpoint (--token-endpoint); skips discovery
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

const oauthClientCredentialsAccount = (serverUrl: string, profileName: string): string =>
  `auth-profile:${getServerHost(serverUrl)}:${profileName}:client-credentials`;

const oauthIdJagAccount = (serverUrl: string, profileName: string): string =>
  `auth-profile:${getServerHost(serverUrl)}:${profileName}:id-jag`;

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
  assertStorableSize(account, value);
  await ensureProbed();
  if (keychainAvailable !== true) throw new Error('Keychain is not available');
  entrySet(await getEntry(), account, value);
}

export async function getKeychainOnly(account: string): Promise<string | null> {
  await ensureProbed();
  if (keychainAvailable !== true) throw new Error('Keychain is not available');
  return entryGet(await getEntry(), account);
}

export async function deleteKeychainOnly(account: string): Promise<boolean> {
  await ensureProbed();
  if (keychainAvailable !== true) throw new Error('Keychain is not available');
  return entryDelete(await getEntry(), account);
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

/** Store client-credentials grant material for an auth profile. */
export async function storeKeychainClientCredentials(
  serverUrl: string,
  profileName: string,
  info: OAuthClientCredentialsInfo
): Promise<void> {
  logger.debug(`Storing client-credentials material for ${profileName} @ ${serverUrl}`);
  await keychainSet(oauthClientCredentialsAccount(serverUrl, profileName), JSON.stringify(info));
}

/** Read client-credentials grant material for an auth profile. */
export async function readKeychainClientCredentials(
  serverUrl: string,
  profileName: string
): Promise<OAuthClientCredentialsInfo | undefined> {
  logger.debug(`Retrieving client-credentials material for ${profileName} @ ${serverUrl}`);
  return keychainGetParsed<OAuthClientCredentialsInfo>(
    oauthClientCredentialsAccount(serverUrl, profileName),
    'client-credentials material'
  );
}

/** Delete client-credentials grant material for an auth profile. */
export async function removeKeychainClientCredentials(
  serverUrl: string,
  profileName: string
): Promise<boolean> {
  logger.debug(`Deleting client-credentials material for ${profileName} @ ${serverUrl}`);
  return keychainDelete(oauthClientCredentialsAccount(serverUrl, profileName));
}

/** Store enterprise-managed authorization (id_jag) material for an auth profile. */
export async function storeKeychainIdJagCredentials(
  serverUrl: string,
  profileName: string,
  info: IdJagCredentials
): Promise<void> {
  logger.debug(`Storing id-jag material for ${profileName} @ ${serverUrl}`);
  await keychainSet(oauthIdJagAccount(serverUrl, profileName), JSON.stringify(info));
}

/** Read enterprise-managed authorization (id_jag) material for an auth profile. */
export async function readKeychainIdJagCredentials(
  serverUrl: string,
  profileName: string
): Promise<IdJagCredentials | undefined> {
  logger.debug(`Retrieving id-jag material for ${profileName} @ ${serverUrl}`);
  return keychainGetParsed<IdJagCredentials>(
    oauthIdJagAccount(serverUrl, profileName),
    'id-jag material'
  );
}

/** Delete enterprise-managed authorization (id_jag) material for an auth profile. */
export async function removeKeychainIdJagCredentials(
  serverUrl: string,
  profileName: string
): Promise<boolean> {
  logger.debug(`Deleting id-jag material for ${profileName} @ ${serverUrl}`);
  return keychainDelete(oauthIdJagAccount(serverUrl, profileName));
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
