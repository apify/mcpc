/**
 * Unit tests for the x402 wallet store (src/lib/wallets.ts) on a host without an OS keychain
 */

import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi } from 'vitest';

const kernelKeyring = vi.hoisted(() => ({ wallet: undefined as unknown }));

vi.mock('../../../src/lib/auth/keychain.js', () => ({
  isKeychainAvailable: () => Promise.resolve(false),
  readKeychainX402Wallet: () => Promise.resolve(undefined),
  storeKeychainX402Wallet: () => Promise.reject(new Error('no keychain')),
  removeKeychainX402Wallet: () => Promise.resolve(false),
  recoverKernelKeyringX402Wallet: (options?: { remove?: boolean }) => {
    const wallet = kernelKeyring.wallet;
    if (options?.remove) kernelKeyring.wallet = undefined;
    return Promise.resolve(options?.remove ? undefined : wallet);
  },
}));

import { getWallet, saveWallet } from '../../../src/lib/wallets.js';

const WALLET = {
  address: '0x1111111111111111111111111111111111111111',
  privateKey: `0x${'22'.repeat(32)}`,
  createdAt: '2026-11-01T00:00:00.000Z',
};

let homeDir: string;
let originalHome: string | undefined;
const walletsFile = (): string => join(homeDir, 'wallets.json');

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'mcpc-wallets-test-'));
  originalHome = process.env.MCPC_HOME_DIR;
  process.env.MCPC_HOME_DIR = homeDir;
  kernelKeyring.wallet = undefined;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.MCPC_HOME_DIR;
  else process.env.MCPC_HOME_DIR = originalHome;
  await rm(homeDir, { recursive: true, force: true });
});

describe('wallet store without an OS keychain', () => {
  it('keeps the wallet in wallets.json with mode 0600', async () => {
    await saveWallet(WALLET);

    expect(await getWallet()).toEqual(WALLET);
    expect((await stat(walletsFile())).mode & 0o777).toBe(0o600);
  });

  // mcpc 0.8.0 kept the wallet in the kernel keyring here, where a reboot loses it.
  it('moves a wallet left in the kernel keyring to wallets.json', async () => {
    kernelKeyring.wallet = WALLET;

    expect(await getWallet()).toEqual(WALLET);

    const stored = JSON.parse(await readFile(walletsFile(), 'utf8')) as { wallet?: unknown };
    expect(stored.wallet).toEqual(WALLET);
    expect(kernelKeyring.wallet).toBeUndefined();
  });

  it('ignores a kernel-keyring entry that is not a wallet', async () => {
    kernelKeyring.wallet = { address: WALLET.address };

    expect(await getWallet()).toBeUndefined();
  });

  it('reports no wallet when there is none', async () => {
    expect(await getWallet()).toBeUndefined();
  });
});
