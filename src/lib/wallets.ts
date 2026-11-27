/**
 * Wallet management for x402 payments
 *
 * Stores a single wallet: in the OS keychain when there is one, otherwise in
 * ~/.mcpc/wallets.json (mode 0600). The wallet's private key controls real funds and
 * there is no other copy of it, so it must never live only in a store that can lose it,
 * and a wallet saved in one store must still be found when the other becomes the default
 * (a keyring daemon installed or removed, a login session with or without one).
 */

import { readFile, writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import type { WalletData, WalletsStorage } from './types.js';
import { getWalletsFilePath, fileExists, ensureDir, getMcpcHome, atomicRename } from './utils.js';
import { withFileLock } from './file-lock.js';
import { ClientError } from './errors.js';
import {
  isKeychainAvailable,
  readKeychainX402Wallet,
  storeKeychainX402Wallet,
  removeKeychainX402Wallet,
  readKernelKeyringX402Wallet,
  removeKernelKeyringX402Wallet,
} from './auth/keychain.js';
import { createLogger } from './logger.js';

const logger = createLogger('wallets');

const WALLETS_DEFAULT_CONTENT = JSON.stringify({ version: 1 }, null, 2);

// ---------------------------------------------------------------------------
// Internal read/write (called under file lock)
// ---------------------------------------------------------------------------

async function loadStorageInternal(): Promise<WalletsStorage> {
  const filePath = getWalletsFilePath();

  if (!(await fileExists(filePath))) {
    return { version: 1 };
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    const storage = JSON.parse(content) as WalletsStorage;
    if (!storage.version) {
      return { version: 1 };
    }
    return storage;
  } catch {
    return { version: 1 };
  }
}

async function saveStorageInternal(storage: WalletsStorage): Promise<void> {
  const filePath = getWalletsFilePath();
  await ensureDir(getMcpcHome());

  const tempFile = join(getMcpcHome(), `.wallets-${Date.now()}-${process.pid}.tmp`);
  try {
    await writeFile(tempFile, JSON.stringify(storage, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await atomicRename(tempFile, filePath);
  } catch (error) {
    try {
      await unlink(tempFile);
    } catch {
      /* ignore */
    }
    throw new ClientError(`Failed to save wallet: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Public API (all operations hold file lock)
// ---------------------------------------------------------------------------

/** The wallet in wallets.json, if any. Does not create the file. */
async function readWalletFile(): Promise<WalletData | undefined> {
  const filePath = getWalletsFilePath();
  if (!(await fileExists(filePath))) return undefined;
  return withFileLock(
    filePath,
    async () => (await loadStorageInternal()).wallet,
    WALLETS_DEFAULT_CONTENT
  );
}

export async function getWallet(): Promise<WalletData | undefined> {
  if (await isKeychainAvailable()) {
    const wallet = await readKeychainX402Wallet<WalletData>();
    if (wallet) return wallet;
  }

  // Also when the keychain is available: a wallet created while it was not is still here
  const fromFile = await readWalletFile();
  if (fromFile) return fromFile;

  // An earlier mcpc kept the wallet in the Linux kernel keyring on hosts without a Secret
  // Service. That store is lost on reboot, so move the wallet to its durable place the
  // first time it is found there.
  const fromKernelKeyring = await readKernelKeyringX402Wallet<WalletData>();
  if (fromKernelKeyring?.privateKey && fromKernelKeyring.address) {
    await saveWallet(fromKernelKeyring);
    await removeKernelKeyringX402Wallet();
    logger.warn(
      `Moved the x402 wallet ${fromKernelKeyring.address} out of the kernel keyring, which ` +
        `does not survive a reboot. ${await describeWalletStore()}`
    );
    return fromKernelKeyring;
  }

  return undefined;
}

/** One sentence saying where the wallet's private key is kept, for messages to the user. */
export async function describeWalletStore(): Promise<string> {
  return (await isKeychainAvailable())
    ? 'Its private key is stored in the OS keychain.'
    : `Its private key is stored in ${getWalletsFilePath()} (no OS keychain available); ` +
        `keep that file safe and backed up.`;
}

export async function saveWallet(wallet: WalletData): Promise<void> {
  if (await isKeychainAvailable()) {
    await storeKeychainX402Wallet(wallet);
    return;
  }

  const filePath = getWalletsFilePath();
  await withFileLock(
    filePath,
    async () => {
      const storage = await loadStorageInternal();
      storage.wallet = wallet;
      await saveStorageInternal(storage);
    },
    WALLETS_DEFAULT_CONTENT
  );
}

/**
 * Remove the wallet from every store it may be in, so a copy in the store that is not the
 * current default cannot come back later.
 */
export async function removeWallet(): Promise<boolean> {
  const fromKeychain = (await isKeychainAvailable()) ? await removeKeychainX402Wallet() : false;
  const fromKernelKeyring = await removeKernelKeyringX402Wallet();

  const filePath = getWalletsFilePath();
  const fromFile = (await fileExists(filePath))
    ? await withFileLock(
        filePath,
        async () => {
          const storage = await loadStorageInternal();
          if (!storage.wallet) return false;

          delete storage.wallet;
          await saveStorageInternal(storage);
          return true;
        },
        WALLETS_DEFAULT_CONTENT
      )
    : false;

  return fromKeychain || fromKernelKeyring || fromFile;
}
