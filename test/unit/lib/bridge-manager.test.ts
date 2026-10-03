/**
 * Unit tests for the auth credentials the CLI hands to a bridge over IPC
 */

import { vi } from 'vitest';

vi.mock('../../../src/lib/auth/profiles.js', () => ({
  getAuthProfile: vi.fn(),
}));

vi.mock('../../../src/lib/auth/keychain.js', () => ({
  readKeychainOAuthTokenInfo: vi.fn(),
  readKeychainOAuthClientInfo: vi.fn(),
  readKeychainClientCredentials: vi.fn(),
  readKeychainIdJagCredentials: vi.fn(),
  readKeychainSessionHeaders: vi.fn(),
  readKeychainSessionEnv: vi.fn(),
  readKeychainProxyBearerToken: vi.fn(),
}));

import { getAuthProfile } from '../../../src/lib/auth/profiles.js';
import {
  readKeychainOAuthClientInfo,
  readKeychainOAuthTokenInfo,
  readKeychainSessionEnv,
} from '../../../src/lib/auth/keychain.js';
import { loadAuthCredentials, loadSessionEnv } from '../../../src/lib/bridge-manager.js';
import { REDACTED_HEADER_VALUE } from '../../../src/lib/utils.js';
import { ClientError } from '../../../src/lib/errors.js';

const SERVER_URL = 'https://mcp.example.com/mcp';

beforeEach(() => {
  vi.mocked(getAuthProfile).mockResolvedValue({
    name: 'default',
    serverUrl: SERVER_URL,
    authType: 'oauth',
    oauthIssuer: 'https://auth.example.com',
    createdAt: '2026-01-01T00:00:00.000Z',
  } as never);
  vi.mocked(readKeychainOAuthTokenInfo).mockResolvedValue({
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    tokenType: 'Bearer',
  });
});

describe('loadAuthCredentials for the authorization-code grant (#387)', () => {
  it('includes the client secret so the bridge can refresh a confidential client', async () => {
    vi.mocked(readKeychainOAuthClientInfo).mockResolvedValue({
      clientId: 'client-123',
      clientSecret: 'secret-xyz',
    });

    const credentials = await loadAuthCredentials(SERVER_URL, 'default');

    expect(credentials).toMatchObject({
      serverUrl: SERVER_URL,
      profileName: 'default',
      clientId: 'client-123',
      clientSecret: 'secret-xyz',
      refreshToken: 'refresh-1',
      accessToken: 'access-1',
    });
  });

  it('leaves clientSecret unset for public clients', async () => {
    vi.mocked(readKeychainOAuthClientInfo).mockResolvedValue({ clientId: 'client-123' });

    const credentials = await loadAuthCredentials(SERVER_URL, 'default');

    expect(credentials.clientId).toBe('client-123');
    expect(credentials).not.toHaveProperty('clientSecret');
  });

  it('includes the recorded issuer so the bridge pins the refresh to it', async () => {
    vi.mocked(readKeychainOAuthClientInfo).mockResolvedValue({ clientId: 'client-123' });

    const credentials = await loadAuthCredentials(SERVER_URL, 'default');

    expect(credentials.oauthIssuer).toBe('https://auth.example.com');
  });

  it('omits the issuer for a profile written before mcpc recorded it', async () => {
    vi.mocked(getAuthProfile).mockResolvedValue({
      name: 'default',
      serverUrl: SERVER_URL,
      authType: 'oauth',
      oauthIssuer: '',
      createdAt: '2026-01-01T00:00:00.000Z',
    } as never);
    vi.mocked(readKeychainOAuthClientInfo).mockResolvedValue({ clientId: 'client-123' });

    const credentials = await loadAuthCredentials(SERVER_URL, 'default');

    expect(credentials).not.toHaveProperty('oauthIssuer');
  });
});

describe('stdio env delivered over IPC instead of argv', () => {
  it('loadAuthCredentials carries the env alongside headers', async () => {
    const env = { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_secret' };
    const credentials = await loadAuthCredentials('npx', undefined, undefined, undefined, env);

    expect(credentials.env).toEqual(env);
    expect(credentials.headers).toBeUndefined();
    expect(credentials.profileName).toBe('dummy');
  });

  it('loadSessionEnv returns undefined when the server has no env', async () => {
    expect(await loadSessionEnv('@s', undefined)).toBeUndefined();
    expect(await loadSessionEnv('@s', {})).toBeUndefined();
    expect(readKeychainSessionEnv).not.toHaveBeenCalled();
  });

  it('loadSessionEnv restores the values from the keychain', async () => {
    vi.mocked(readKeychainSessionEnv).mockResolvedValue({ TOKEN: 'real', DEBUG: 'mcp:*' });

    const env = await loadSessionEnv('@s', {
      TOKEN: REDACTED_HEADER_VALUE,
      DEBUG: REDACTED_HEADER_VALUE,
    });

    expect(env).toEqual({ TOKEN: 'real', DEBUG: 'mcp:*' });
    expect(readKeychainSessionEnv).toHaveBeenCalledWith('@s');
  });

  it('loadSessionEnv fails clearly when a redacted value is missing from the keychain', async () => {
    vi.mocked(readKeychainSessionEnv).mockResolvedValue({ DEBUG: 'mcp:*' });

    await expect(
      loadSessionEnv('@s', { TOKEN: REDACTED_HEADER_VALUE, DEBUG: REDACTED_HEADER_VALUE })
    ).rejects.toThrow(ClientError);
    await expect(
      loadSessionEnv('@s', { TOKEN: REDACTED_HEADER_VALUE, DEBUG: REDACTED_HEADER_VALUE })
    ).rejects.toThrow(/TOKEN/);
  });

  it('loadSessionEnv keeps a legacy plaintext record working until the session is recreated', async () => {
    vi.mocked(readKeychainSessionEnv).mockResolvedValue(undefined);

    const env = await loadSessionEnv('@s', { TOKEN: 'plaintext-from-0.7', DEBUG: 'mcp:*' });

    expect(env).toEqual({ TOKEN: 'plaintext-from-0.7', DEBUG: 'mcp:*' });
  });

  it('never lets the redaction sentinel reach the server as a value', async () => {
    vi.mocked(readKeychainSessionEnv).mockResolvedValue(undefined);

    await expect(loadSessionEnv('@s', { TOKEN: REDACTED_HEADER_VALUE })).rejects.toThrow(
      ClientError
    );
  });
});
