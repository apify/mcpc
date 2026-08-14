/**
 * Unit tests for OAuthTokenManager token refresh and persistence callback
 */

import { vi } from 'vitest';
import type { OAuthTokenResponse } from '../../../../src/lib/auth/oauth-utils.js';

vi.mock('../../../../src/lib/auth/oauth-utils.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../src/lib/auth/oauth-utils.js')>();
  return {
    ...original,
    discoverAndRefreshToken: vi.fn(),
  };
});

import { discoverAndRefreshToken } from '../../../../src/lib/auth/oauth-utils.js';
import { OAuthTokenManager } from '../../../../src/lib/auth/oauth-token-manager.js';

const mockRefresh = vi.mocked(discoverAndRefreshToken);

const makeManager = (overrides?: Partial<ConstructorParameters<typeof OAuthTokenManager>[0]>) =>
  new OAuthTokenManager({
    serverUrl: 'https://mcp.example.com',
    profileName: 'default',
    clientId: 'client-123',
    refreshToken: 'original-refresh-token',
    ...overrides,
  });

beforeEach(() => {
  mockRefresh.mockReset();
});

describe('OAuthTokenManager refresh-token persistence (#371)', () => {
  it('passes the previous refresh token to onTokenRefresh when the server omits it', async () => {
    // Non-rotating servers return refresh_token only once, during initial auth
    mockRefresh.mockResolvedValue({
      access_token: 'new-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    const persisted: OAuthTokenResponse[] = [];
    const manager = makeManager({
      onTokenRefresh: (tokens) => {
        persisted.push(tokens);
      },
    });

    await manager.refreshAccessToken();

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.refresh_token).toBe('original-refresh-token');
    expect(persisted[0]?.access_token).toBe('new-access-token');
  });

  it('passes the rotated refresh token to onTokenRefresh when the server rotates it', async () => {
    mockRefresh.mockResolvedValue({
      access_token: 'new-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'rotated-refresh-token',
    });

    const persisted: OAuthTokenResponse[] = [];
    const manager = makeManager({
      onTokenRefresh: (tokens) => {
        persisted.push(tokens);
      },
    });

    await manager.refreshAccessToken();

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.refresh_token).toBe('rotated-refresh-token');
  });

  it('keeps using the preserved refresh token on subsequent refreshes', async () => {
    mockRefresh.mockResolvedValue({
      access_token: 'access-1',
      token_type: 'Bearer',
      // expires_in omitted and no rotation — worst case for state tracking
    });

    const manager = makeManager();
    await manager.refreshAccessToken();
    await manager.refreshAccessToken();

    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(mockRefresh).toHaveBeenNthCalledWith(
      2,
      'https://mcp.example.com',
      'original-refresh-token',
      'client-123'
    );
  });

  it('prefers a refresh token rotated by another process via onBeforeRefresh', async () => {
    mockRefresh.mockResolvedValue({
      access_token: 'new-access-token',
      token_type: 'Bearer',
    });

    const persisted: OAuthTokenResponse[] = [];
    const manager = makeManager({
      onBeforeRefresh: async () => ({ refreshToken: 'externally-rotated-token' }),
      onTokenRefresh: (tokens) => {
        persisted.push(tokens);
      },
    });

    await manager.refreshAccessToken();

    expect(mockRefresh).toHaveBeenCalledWith(
      'https://mcp.example.com',
      'externally-rotated-token',
      'client-123'
    );
    expect(persisted[0]?.refresh_token).toBe('externally-rotated-token');
  });
});
