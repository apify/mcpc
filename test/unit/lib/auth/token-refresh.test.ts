/**
 * Unit tests for the CLI-side token refresh (getValidAccessTokenFromKeychain)
 */

import { vi } from 'vitest';

vi.mock('../../../../src/lib/auth/profiles.js', () => ({
  getAuthProfile: vi.fn(),
  saveAuthProfile: vi.fn(),
}));

vi.mock('../../../../src/lib/auth/keychain.js', () => ({
  readKeychainOAuthTokenInfo: vi.fn(),
  storeKeychainOAuthTokenInfo: vi.fn(),
  readKeychainOAuthClientInfo: vi.fn(),
}));

vi.mock('../../../../src/lib/auth/oauth-utils.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../src/lib/auth/oauth-utils.js')>();
  return { ...original, discoverAndRefreshToken: vi.fn() };
});

import { getAuthProfile } from '../../../../src/lib/auth/profiles.js';
import {
  readKeychainOAuthClientInfo,
  readKeychainOAuthTokenInfo,
} from '../../../../src/lib/auth/keychain.js';
import { discoverAndRefreshToken } from '../../../../src/lib/auth/oauth-utils.js';
import { getValidAccessTokenFromKeychain } from '../../../../src/lib/auth/token-refresh.js';

const SERVER_URL = 'https://mcp.example.com/mcp';

beforeEach(() => {
  vi.mocked(getAuthProfile).mockResolvedValue({
    name: 'default',
    serverUrl: SERVER_URL,
    authType: 'oauth',
    createdAt: '2026-01-01T00:00:00.000Z',
  } as never);
  vi.mocked(readKeychainOAuthTokenInfo).mockResolvedValue({
    accessToken: 'expired-access',
    refreshToken: 'refresh-1',
    tokenType: 'Bearer',
    expiresAt: 1, // long expired → forces a refresh
  });
  vi.mocked(discoverAndRefreshToken).mockReset();
  vi.mocked(discoverAndRefreshToken).mockResolvedValue({
    access_token: 'fresh-access',
    token_type: 'Bearer',
    expires_in: 3600,
  });
});

describe('getValidAccessTokenFromKeychain confidential clients (#387)', () => {
  it('refreshes with the client secret stored at login', async () => {
    vi.mocked(readKeychainOAuthClientInfo).mockResolvedValue({
      clientId: 'client-123',
      clientSecret: 'secret-xyz',
    });

    const token = await getValidAccessTokenFromKeychain(SERVER_URL, 'default');

    expect(token).toBe('fresh-access');
    expect(discoverAndRefreshToken).toHaveBeenCalledWith(
      SERVER_URL,
      'refresh-1',
      'client-123',
      'secret-xyz'
    );
  });

  it('refreshes without a secret for public clients', async () => {
    vi.mocked(readKeychainOAuthClientInfo).mockResolvedValue({ clientId: 'client-123' });

    await getValidAccessTokenFromKeychain(SERVER_URL, 'default');

    expect(discoverAndRefreshToken).toHaveBeenCalledWith(
      SERVER_URL,
      'refresh-1',
      'client-123',
      undefined
    );
  });
});
