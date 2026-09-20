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
/** When set, the next setPassword fails with this error (a non-size keychain failure) */
let failNextSetWith: Error | null = null;

/**
 * Windows Credential Manager caps a credential blob at 2560 bytes, and the
 * keyring crate stores passwords as UTF-16 — so 1280 UTF-16 code units is the
 * tightest limit any supported platform imposes (#409). The mock enforces it on
 * every platform so the whole suite guards against writing an oversized entry.
 */
const MAX_UTF16_UNITS = 1280;

/** Keychain calls the code under test made, so tests can assert it stays cheap. */
const keychainCalls = { set: 0, get: 0, delete: 0 };

vi.mock('@napi-rs/keyring', () => ({
  Entry: vi.fn(function (_service: string, account: string) {
    return {
      setPassword(value: string) {
        keychainCalls.set++;
        if (keychainThrows) throw new Error('No keyring daemon');
        if (failNextSetWith) {
          const error = failNextSetWith;
          failNextSetWith = null;
          throw error;
        }
        if (value.length > MAX_UTF16_UNITS) {
          throw new Error(
            "Attribute 'password encoded as UTF-16' is longer than platform limit of 2560 chars"
          );
        }
        keychainStore.set(account, value);
      },
      getPassword(): string | null {
        keychainCalls.get++;
        if (keychainThrows) throw new Error('No keyring daemon');
        return keychainStore.get(account) ?? null;
      },
      deletePassword(): boolean {
        keychainCalls.delete++;
        if (keychainThrows) throw new Error('No keyring daemon');
        const had = keychainStore.has(account);
        keychainStore.delete(account);
        return had;
      },
    };
  }),
}));

/** Zero the counters — call right before the operation a test measures. */
function resetKeychainCalls() {
  keychainCalls.set = 0;
  keychainCalls.get = 0;
  keychainCalls.delete = 0;
}

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
  failNextSetWith = null;
  resetKeychainCalls();
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

  it('stores and retrieves client-credentials material', async () => {
    const { storeKeychainClientCredentials, readKeychainClientCredentials } = await loadKeychain();

    const info = { clientId: 'svc', clientSecret: 's3cr3t', scope: 'read write' };
    await storeKeychainClientCredentials('https://example.com', 'default', info);
    expect(await readKeychainClientCredentials('https://example.com', 'default')).toEqual(info);
  });

  it('deletes client-credentials material', async () => {
    const {
      storeKeychainClientCredentials,
      removeKeychainClientCredentials,
      readKeychainClientCredentials,
    } = await loadKeychain();

    await storeKeychainClientCredentials('https://example.com', 'default', {
      clientId: 'svc',
      privateKeyPem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      keyAlg: 'RS256',
    });
    expect(await removeKeychainClientCredentials('https://example.com', 'default')).toBe(true);
    expect(await readKeychainClientCredentials('https://example.com', 'default')).toBeUndefined();
  });

  it('keeps client-credentials material separate from authorization-code client info', async () => {
    const {
      storeKeychainClientCredentials,
      storeKeychainOAuthClientInfo,
      readKeychainClientCredentials,
      readKeychainOAuthClientInfo,
    } = await loadKeychain();

    await storeKeychainOAuthClientInfo('https://example.com', 'default', { clientId: 'ac-client' });
    await storeKeychainClientCredentials('https://example.com', 'default', {
      clientId: 'cc-client',
      clientSecret: 's',
    });

    // Distinct keychain accounts — neither overwrites the other.
    expect((await readKeychainOAuthClientInfo('https://example.com', 'default'))?.clientId).toBe(
      'ac-client'
    );
    expect((await readKeychainClientCredentials('https://example.com', 'default'))?.clientId).toBe(
      'cc-client'
    );
    expect(keychainStore.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: values too long for a single keychain entry (#409)
// ---------------------------------------------------------------------------

describe('values longer than the platform entry limit', () => {
  /** A token blob of the size real OAuth servers hand out — well over the Windows limit. */
  const longToken = (seed: string) => seed.repeat(Math.ceil(4000 / seed.length)).slice(0, 4000);

  // -------------------------------------------------------------------------
  // Splitting is a fallback: a credential that fits must cost what it always did
  // -------------------------------------------------------------------------

  /**
   * The availability probe writes, reads and deletes once per process. Get it out
   * of the way before counting, so a measurement covers only the call under test.
   */
  async function loadProbedKeychain() {
    const keychain = await loadKeychain();
    await keychain.isKeychainAvailable();
    resetKeychainCalls();
    return keychain;
  }

  it('stores a value that fits in exactly one keychain write', async () => {
    const { storeKeychainProxyBearerToken } = await loadProbedKeychain();

    await storeKeychainProxyBearerToken('s', 'short-token');

    expect(keychainCalls).toEqual({ set: 1, get: 0, delete: 0 });
  });

  it('reads a value that fits in exactly one keychain read', async () => {
    const keychain = await loadProbedKeychain();
    await keychain.storeKeychainProxyBearerToken('s', 'short-token');

    resetKeychainCalls();
    expect(await keychain.readKeychainProxyBearerToken('s')).toBe('short-token');

    expect(keychainCalls).toEqual({ set: 0, get: 1, delete: 0 });
  });

  it('splits only after the platform refuses the write', async () => {
    const { storeKeychainProxyBearerToken } = await loadProbedKeychain();

    await storeKeychainProxyBearerToken('s', longToken('tok-'));

    // One rejected plain write, then 4 parts of 1024 units, then the header.
    expect(keychainCalls.set).toBe(1 + 4 + 1);
    // No read: the write path never looks the account up first.
    expect(keychainCalls.get).toBe(0);
  });

  it('rethrows a keychain failure that is not about the value size', async () => {
    const { setKeychainOnly } = await loadProbedKeychain();

    failNextSetWith = new Error('Access denied');
    await expect(setKeychainOnly('acct', 'short-value')).rejects.toThrow('Access denied');

    // Not mistaken for a size refusal, so nothing was stored in parts.
    expect(keychainStore.size).toBe(0);
    expect(keychainCalls.set).toBe(1);
  });

  it('stores and reads back a token blob larger than a single entry', async () => {
    const { storeKeychainOAuthTokenInfo, readKeychainOAuthTokenInfo } = await loadKeychain();

    const tokens = {
      accessToken: longToken('access-'),
      refreshToken: longToken('refresh-'),
      tokenType: 'Bearer',
    };
    await storeKeychainOAuthTokenInfo('https://example.com', 'default', tokens);

    expect(await readKeychainOAuthTokenInfo('https://example.com', 'default')).toEqual(tokens);

    // Stored as a header entry plus parts, none of which exceeds the platform limit.
    const base = 'auth-profile:example.com:default:tokens';
    expect(keychainStore.get(base)).toMatch(/^mcpc:chunked:v1:\d+$/);
    expect(keychainStore.size).toBeGreaterThan(1);
    for (const value of keychainStore.values()) {
      expect(value.length).toBeLessThanOrEqual(MAX_UTF16_UNITS);
    }
  });

  it('keeps short values in a single plain entry', async () => {
    const { storeKeychainProxyBearerToken } = await loadKeychain();

    await storeKeychainProxyBearerToken('s', 'short-token');
    expect(keychainStore.size).toBe(1);
    expect(keychainStore.get('session:s:proxy-bearer-token')).toBe('short-token');
  });

  it('round-trips a value that looks like a chunk header', async () => {
    const { storeKeychainProxyBearerToken, readKeychainProxyBearerToken } = await loadKeychain();

    await storeKeychainProxyBearerToken('s', 'mcpc:chunked:v1:2');
    expect(await readKeychainProxyBearerToken('s')).toBe('mcpc:chunked:v1:2');
  });

  it('round-trips values containing astral characters', async () => {
    const { storeKeychainSessionHeaders, readKeychainSessionHeaders } = await loadKeychain();

    // Emoji are surrogate pairs; a chunk boundary must never cut one in half.
    const headers = { 'X-Long': '😀'.repeat(2000) };
    await storeKeychainSessionHeaders('s', headers);

    expect(await readKeychainSessionHeaders('s')).toEqual(headers);
  });

  it('removes stale parts when a long value is replaced by a shorter one', async () => {
    const { storeKeychainSessionHeaders, readKeychainSessionHeaders } = await loadKeychain();

    await storeKeychainSessionHeaders('s', { Authorization: longToken('Bearer-') });
    expect(keychainStore.size).toBeGreaterThan(1);

    await storeKeychainSessionHeaders('s', { Authorization: 'Bearer short' });
    expect(keychainStore.size).toBe(1);
    expect(await readKeychainSessionHeaders('s')).toEqual({ Authorization: 'Bearer short' });
  });

  it('deletes every part of a chunked credential', async () => {
    const {
      storeKeychainOAuthTokenInfo,
      removeKeychainOAuthTokenInfo,
      readKeychainOAuthTokenInfo,
    } = await loadKeychain();

    await storeKeychainOAuthTokenInfo('https://example.com', 'default', {
      accessToken: longToken('access-'),
      tokenType: 'Bearer',
    });
    expect(await removeKeychainOAuthTokenInfo('https://example.com', 'default')).toBe(true);

    expect(keychainStore.size).toBe(0);
    expect(await readKeychainOAuthTokenInfo('https://example.com', 'default')).toBeUndefined();
  });

  it('refuses a credential far larger than any real one', async () => {
    const { storeKeychainSessionHeaders } = await loadKeychain();

    // A server handing out an absurd token must not have mcpc write an unbounded
    // number of keychain entries.
    const absurd = { Authorization: 'x'.repeat(60 * 1024) };
    await expect(storeKeychainSessionHeaders('s', absurd)).rejects.toThrow(
      /exceeds the \d+ character limit/
    );
    expect(keychainStore.size).toBe(0);
  });

  it('still stores a credential just under the limit', async () => {
    const { storeKeychainProxyBearerToken, readKeychainProxyBearerToken } = await loadKeychain();

    const big = 'y'.repeat(50 * 1024);
    await storeKeychainProxyBearerToken('s', big);
    expect(await readKeychainProxyBearerToken('s')).toBe(big);
  });

  it('deletes every part from a process that never read the credential', async () => {
    // What `mcpc logout` does: a fresh process removes a credential it has not read.
    const first = await loadKeychain();
    await first.storeKeychainOAuthTokenInfo('https://example.com', 'default', {
      accessToken: longToken('access-'),
      tokenType: 'Bearer',
    });
    expect(keychainStore.size).toBeGreaterThan(1);

    const second = await loadKeychain();
    expect(await second.removeKeychainOAuthTokenInfo('https://example.com', 'default')).toBe(true);
    expect(keychainStore.size).toBe(0);
  });

  it('drops stale parts when a later process shortens a split credential', async () => {
    // What a token refresh does: read the stored tokens, then write the rotated ones.
    const first = await loadKeychain();
    await first.storeKeychainOAuthTokenInfo('https://example.com', 'default', {
      accessToken: longToken('access-'),
      tokenType: 'Bearer',
    });

    const second = await loadKeychain();
    expect(await second.readKeychainOAuthTokenInfo('https://example.com', 'default')).toBeDefined();
    await second.storeKeychainOAuthTokenInfo('https://example.com', 'default', {
      accessToken: 'short',
      tokenType: 'Bearer',
    });

    expect(keychainStore.size).toBe(1);
    expect(await second.readKeychainOAuthTokenInfo('https://example.com', 'default')).toEqual({
      accessToken: 'short',
      tokenType: 'Bearer',
    });
  });

  it('treats a chunked credential with a missing part as absent', async () => {
    const { storeKeychainOAuthTokenInfo, readKeychainOAuthTokenInfo } = await loadKeychain();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await storeKeychainOAuthTokenInfo('https://example.com', 'default', {
        accessToken: longToken('access-'),
        tokenType: 'Bearer',
      });

      // Simulate a partially wiped keychain (e.g. the user deleted one entry).
      keychainStore.delete('auth-profile:example.com:default:tokens#1');

      expect(await readKeychainOAuthTokenInfo('https://example.com', 'default')).toBeUndefined();
      expect(
        errorSpy.mock.calls.filter((call) => String(call[0]).includes('is incomplete'))
      ).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
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

  it('warns once when credentials.json is first created, not on reads', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const countWarnings = () =>
      errorSpy.mock.calls.filter((call) => String(call[0]).includes('OS keychain unavailable'))
        .length;

    try {
      // Read-only fallback: nothing stored yet → no warning
      const first = await loadKeychain();
      expect(await first.readKeychainSessionHeaders('sess')).toBeUndefined();
      expect(countWarnings()).toBe(0);

      // First write creates credentials.json → warning shown once
      await first.storeKeychainSessionHeaders('sess', { token: 'a' });
      expect(countWarnings()).toBe(1);
      await first.storeKeychainSessionHeaders('other', { token: 'b' });
      expect(countWarnings()).toBe(1);

      // New "process" (fresh module instance): file exists → still no warning
      const second = await loadKeychain();
      await second.storeKeychainSessionHeaders('sess', { token: 'c' });
      expect(countWarnings()).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs a debug-level trace on every invocation in verbose mode', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugTraces = () =>
      errorSpy.mock.calls.filter(
        (call) =>
          String(call[0]).includes('OS keychain unavailable') && String(call[0]).includes('[DEBUG]')
      ).length;

    try {
      const keychain = await loadKeychain();
      const { setVerbose } = await import('../../../../src/lib/logger.js');
      setVerbose(true);
      await keychain.readKeychainSessionHeaders('sess');
      expect(debugTraces()).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('warns again when the fallback file is removed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const countWarnings = () =>
      errorSpy.mock.calls.filter((call) => String(call[0]).includes('OS keychain unavailable'))
        .length;

    try {
      const first = await loadKeychain();
      await first.storeKeychainSessionHeaders('sess', { token: 'a' });
      expect(countWarnings()).toBe(1);

      // Fallback file deleted (e.g. user cleaned ~/.mcpc) → next write re-warns
      await rm(credFile(), { force: true });
      const second = await loadKeychain();
      await second.storeKeychainSessionHeaders('sess', { token: 'b' });
      expect(countWarnings()).toBe(2);
    } finally {
      errorSpy.mockRestore();
    }
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
