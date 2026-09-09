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
  readKeychainProxyBearerToken: vi.fn(),
}));

import { getAuthProfile } from '../../../src/lib/auth/profiles.js';
import {
  readKeychainOAuthClientInfo,
  readKeychainOAuthTokenInfo,
} from '../../../src/lib/auth/keychain.js';
import { loadAuthCredentials } from '../../../src/lib/bridge-manager.js';

const SERVER_URL = 'https://mcp.example.com/mcp';

beforeEach(() => {
  vi.mocked(getAuthProfile).mockResolvedValue({
    name: 'default',
    serverUrl: SERVER_URL,
    authType: 'oauth',
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
});
