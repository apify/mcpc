/**
 * Unit tests for the x402 wallet store (src/lib/wallets.ts)
 *
 * The wallet's private key has no other copy, so these tests are about one thing: a wallet
 * saved in one store is still found, and fully removed, whichever store is the default now.
 */

import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi } from 'vitest';

const keychain = vi.hoisted(() => ({
  available: false,
  wallet: undefined as unknown,
  kernelKeyringWallet: undefined as unknown,
}));

vi.mock('../../../src/lib/auth/keychain.js', () => ({
  isKeychainAvailable: () => Promise.resolve(keychain.available),
  readKeychainX402Wallet: () => Promise.resolve(keychain.available ? keychain.wallet : undefined),
  storeKeychainX402Wallet: (wallet: unknown) => {
    keychain.wallet = wallet;
    return Promise.resolve();
  },
  removeKeychainX402Wallet: () => {
    const had = keychain.wallet !== undefined;
    keychain.wallet = undefined;
    return Promise.resolve(had);
  },
  readKernelKeyringX402Wallet: () => Promise.resolve(keychain.kernelKeyringWallet),
  removeKernelKeyringX402Wallet: () => {
    const had = keychain.kernelKeyringWallet !== undefined;
    keychain.kernelKeyringWallet = undefined;
    return Promise.resolve(had);
  },
}));

import { getWallet, removeWallet, saveWallet } from '../../../src/lib/wallets.js';

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
  keychain.available = false;
  keychain.wallet = undefined;
  keychain.kernelKeyringWallet = undefined;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.MCPC_HOME_DIR;
  else process.env.MCPC_HOME_DIR = originalHome;
  await rm(homeDir, { recursive: true, force: true });
});

describe('wallet store', () => {
  it('keeps the wallet in wallets.json (0600) when there is no OS keychain', async () => {
    await saveWallet(WALLET);

    expect(await getWallet()).toEqual(WALLET);
    expect((await stat(walletsFile())).mode & 0o777).toBe(0o600);
    expect(keychain.wallet).toBeUndefined();
  });

  it('keeps the wallet in the OS keychain when there is one', async () => {
    keychain.available = true;

    await saveWallet(WALLET);

    expect(await getWallet()).toEqual(WALLET);
    expect(keychain.wallet).toEqual(WALLET);
  });

  // The wallet used to "disappear" here, inviting the user to create a second one.
  it('still finds a wallet saved to the file once an OS keychain appears', async () => {
    await saveWallet(WALLET);
    keychain.available = true;

    expect(await getWallet()).toEqual(WALLET);
  });

  it('moves a wallet left in the kernel keyring to wallets.json', async () => {
    keychain.kernelKeyringWallet = WALLET;

    expect(await getWallet()).toEqual(WALLET);

    const stored = JSON.parse(await readFile(walletsFile(), 'utf8')) as { wallet?: unknown };
    expect(stored.wallet).toEqual(WALLET);
    expect((await stat(walletsFile())).mode & 0o777).toBe(0o600);
    expect(keychain.kernelKeyringWallet).toBeUndefined();
  });

  it('ignores a kernel-keyring entry that is not a wallet', async () => {
    keychain.kernelKeyringWallet = { address: WALLET.address };

    expect(await getWallet()).toBeUndefined();
    expect(keychain.kernelKeyringWallet).toEqual({ address: WALLET.address });
  });

  it('reports no wallet when there is none anywhere', async () => {
    expect(await getWallet()).toBeUndefined();
    expect(await removeWallet()).toBe(false);
  });

  it('removes the wallet from every store, so no copy can come back', async () => {
    await saveWallet(WALLET); // file
    keychain.available = true;
    await saveWallet(WALLET); // keychain
    keychain.kernelKeyringWallet = WALLET;

    expect(await removeWallet()).toBe(true);

    expect(await getWallet()).toBeUndefined();
    keychain.available = false;
    expect(await getWallet()).toBeUndefined();
  });
});
