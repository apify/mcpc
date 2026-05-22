/**
 * Unit tests for OS keychain integration and file-based fallback
 * (src/lib/auth/keychain.ts)
 *
 * Strategy:
 *   - Mock @napi-rs/keyring with an in-memory store + controllable "throw" flag.
 *   - Point MCPC_HOME_DIR at a temp directory so credentials.json is isolated.
 *   - Call loadKeychain() before each test to get a fresh module instance,
 *     which resets the keychainAvailable flag to null (its initial state).
 */

import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, readFile, rm, stat } from 'fs/promises';

// proper-lockfile registers signal handlers per module instance; raise the
// limit to avoid spurious MaxListenersExceededWarning during tests.
process.setMaxListeners(50);

// ---------------------------------------------------------------------------
// Mock @napi-rs/keyring
//
// The factory is evaluated lazily (when keychain.ts is first imported), so
// keychainStore and keychainThrows are already initialised by then.
// We do NOT statically import keychain.ts; all imports are dynamic (via
// loadKeychain) so the factory never runs before these declarations.
// ---------------------------------------------------------------------------

/** In-memory store that simulates the OS keychain */
const keychainStore = new Map<string, string>();
/** When true, all keychain operations throw to simulate a missing keyring daemon */
let keychainThrows = false;

vi.mock('@napi-rs/keyring', () => ({
  Entry: vi.fn(function (_service: string, account: string) {
    return {
      setPassword(value: string) {
        if (keychainThrows) throw new Error('No keyring daemon');
        keychainStore.set(account, value);
      },
      getPassword(): string | null {
        if (keychainThrows) throw new Error('No keyring daemon');
        return keychainStore.get(account) ?? null;
      },
      deletePassword(): boolean {
        if (keychainThrows) throw new Error('No keyring daemon');
        const had = keychainStore.has(account);
        keychainStore.delete(account);
        return had;
      },
    };
  }),
}));

// ---------------------------------------------------------------------------
// Mock chalk to keep the test runtime untouched by ANSI codes.
// ---------------------------------------------------------------------------

vi.mock('chalk', () => ({
  __esModule: true,
  default: { red: (s: string) => s },
}));

// ---------------------------------------------------------------------------
// Isolated home directory — tests never touch the real ~/.mcpc
// ---------------------------------------------------------------------------

let testHome: string;
const credFile = () => join(testHome, 'credentials.json');

beforeAll(async () => {
  testHome = join(tmpdir(), `mcpc-keychain-test-${Date.now()}`);
  await mkdir(testHome, { recursive: true });
  process.env.MCPC_HOME_DIR = testHome;
});

afterAll(async () => {
  delete process.env.MCPC_HOME_DIR;
  await rm(testHome, { recursive: true, force: true });
});

beforeEach(async () => {
  keychainStore.clear();
  keychainThrows = false;
  await rm(credFile(), { force: true });
});

// ---------------------------------------------------------------------------
// Helper: fresh keychain module instance (keychainAvailable resets to null)
// ---------------------------------------------------------------------------

async function loadKeychain() {
  vi.resetModules();
  return import('../../../../src/lib/auth/keychain.js');
}

// ---------------------------------------------------------------------------
// Tests: normal OS keychain path
// ---------------------------------------------------------------------------

describe('OS keychain available', () => {
  it('stores and retrieves OAuth client info', async () => {
    const { storeKeychainOAuthClientInfo, readKeychainOAuthClientInfo } = await loadKeychain();

    const info = { clientId: 'c-123', clientSecret: 'sec' };
    await storeKeychainOAuthClientInfo('https://example.com', 'default', info);

    expect(keychainStore.size).toBe(1);
    expect(await readKeychainOAuthClientInfo('https://example.com', 'default')).toEqual(info);
  });

  it('returns undefined when account is missing', async () => {
    const { readKeychainOAuthClientInfo } = await loadKeychain();
    expect(await readKeychainOAuthClientInfo('https://example.com', 'default')).toBeUndefined();
  });

  it('deletes OAuth client info and returns true', async () => {
    const { storeKeychainOAuthClientInfo, removeKeychainOAuthClientInfo } = await loadKeychain();

    await storeKeychainOAuthClientInfo('https://example.com', 'default', { clientId: 'c-1' });
    expect(await removeKeychainOAuthClientInfo('https://example.com', 'default')).toBe(true);
    expect(keychainStore.size).toBe(0);
  });

  it('delete returns false when account is missing', async () => {
    const { removeKeychainOAuthClientInfo } = await loadKeychain();
    expect(await removeKeychainOAuthClientInfo('https://example.com', 'default')).toBe(false);
  });

  it('stores and retrieves session headers', async () => {
    const { storeKeychainSessionHeaders, readKeychainSessionHeaders } = await loadKeychain();

    const headers = { Authorization: 'Bearer tok', 'X-Custom': 'v' };
    await storeKeychainSessionHeaders('s', headers);
    expect(await readKeychainSessionHeaders('s')).toEqual(headers);
  });

  it('stores and retrieves proxy bearer token', async () => {
    const { storeKeychainProxyBearerToken, readKeychainProxyBearerToken } = await loadKeychain();

    await storeKeychainProxyBearerToken('s', 'my-token');
    expect(await readKeychainProxyBearerToken('s')).toBe('my-token');
  });

  it('does not create credentials.json', async () => {
    const { storeKeychainProxyBearerToken } = await loadKeychain();
    await storeKeychainProxyBearerToken('s', 'tok');
    await expect(readFile(credFile())).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: file fallback when OS keychain is unavailable
// ---------------------------------------------------------------------------

describe('file fallback when OS keychain unavailable', () => {
  beforeEach(() => {
    keychainThrows = true;
  });

  it('falls back to credentials.json when keychain throws', async () => {
    const { storeKeychainOAuthClientInfo, readKeychainOAuthClientInfo } = await loadKeychain();

    const info = { clientId: 'fallback-client' };
    await storeKeychainOAuthClientInfo('https://example.com', 'default', info);

    const data = JSON.parse(await readFile(credFile(), 'utf8')) as Record<string, string>;
    expect(Object.keys(data)).toHaveLength(1);

    // Read back via the same module instance (keychainAvailable is already false)
    expect(await readKeychainOAuthClientInfo('https://example.com', 'default')).toEqual(info);
  });

  it('writes credentials.json with mode 0600', async () => {
    const { storeKeychainOAuthTokenInfo } = await loadKeychain();
    await storeKeychainOAuthTokenInfo('https://example.com', 'default', {
      accessToken: 'tok',
      tokenType: 'Bearer',
    });

    const { mode } = await stat(credFile());
    expect(mode & 0o777).toBe(0o600);
  });

  it('returns undefined for missing key in credentials.json', async () => {
    const { readKeychainSessionHeaders } = await loadKeychain();
    expect(await readKeychainSessionHeaders('nonexistent')).toBeUndefined();
  });

  it('delete returns false for missing key', async () => {
    const { removeKeychainSessionHeaders } = await loadKeychain();
    expect(await removeKeychainSessionHeaders('nonexistent')).toBe(false);
  });

  it('delete removes key and returns true', async () => {
    const {
      storeKeychainProxyBearerToken,
      removeKeychainProxyBearerToken,
      readKeychainProxyBearerToken,
    } = await loadKeychain();

    await storeKeychainProxyBearerToken('sess', 'bearer-tok');
    expect(await readKeychainProxyBearerToken('sess')).toBe('bearer-tok');

    expect(await removeKeychainProxyBearerToken('sess')).toBe(true);
    expect(await readKeychainProxyBearerToken('sess')).toBeUndefined();
  });

  it('multiple sessions are stored independently', async () => {
    const { storeKeychainSessionHeaders, readKeychainSessionHeaders } = await loadKeychain();

    await storeKeychainSessionHeaders('a', { token: 'aaa' });
    await storeKeychainSessionHeaders('b', { token: 'bbb' });

    expect(await readKeychainSessionHeaders('a')).toEqual({ token: 'aaa' });
    expect(await readKeychainSessionHeaders('b')).toEqual({ token: 'bbb' });
  });

  it('does not retry OS keychain once fallback is active', async () => {
    const { storeKeychainSessionHeaders, readKeychainSessionHeaders } = await loadKeychain();

    // First call: keychain throws → keychainAvailable becomes false, value written to file
    await storeKeychainSessionHeaders('sess', { token: 'file-value' });

    // "Recover" the keychain and plant a different value in the in-memory store.
    // If the keychain were retried, the read would return 'keychain-value'.
    // Correct behaviour: keychainAvailable is already false → stays on file.
    keychainThrows = false;
    keychainStore.set('session:sess:headers', JSON.stringify({ token: 'keychain-value' }));

    expect(await readKeychainSessionHeaders('sess')).toEqual({ token: 'file-value' });
  });
});
