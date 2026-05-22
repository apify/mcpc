/**
 * Wallet management for x402 payments
 * Stores a single wallet in ~/.mcpc/wallets.json
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
} from './auth/keychain.js';

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

export async function getWallet(): Promise<WalletData | undefined> {
  if (await isKeychainAvailable()) {
    return readKeychainX402Wallet<WalletData>();
  }

  return withFileLock(
    getWalletsFilePath(),
    async () => {
      const storage = await loadStorageInternal();
      return storage.wallet;
    },
    WALLETS_DEFAULT_CONTENT
  );
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

export async function removeWallet(): Promise<boolean> {
  if (await isKeychainAvailable()) {
    return removeKeychainX402Wallet();
  }

  const filePath = getWalletsFilePath();
  if (!(await fileExists(filePath))) return false;

  return withFileLock(
    filePath,
    async () => {
      const storage = await loadStorageInternal();
      if (!storage.wallet) return false;

      delete storage.wallet;
      await saveStorageInternal(storage);
      return true;
    },
    WALLETS_DEFAULT_CONTENT
  );
}
