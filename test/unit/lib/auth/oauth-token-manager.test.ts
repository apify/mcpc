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
      { clientId: 'client-123' }
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
      { clientId: 'client-123' }
    );
    expect(persisted[0]?.refresh_token).toBe('externally-rotated-token');
  });
});

describe('OAuthTokenManager confidential clients (#387)', () => {
  it('passes the client secret to the refresh request', async () => {
    mockRefresh.mockResolvedValue({ access_token: 'new-access-token', token_type: 'Bearer' });

    const manager = makeManager({ clientSecret: 'secret-xyz' });
    await manager.refreshAccessToken();

    expect(mockRefresh).toHaveBeenCalledWith('https://mcp.example.com', 'original-refresh-token', {
      clientId: 'client-123',
      clientSecret: 'secret-xyz',
    });
  });

  it('refreshes without a secret for public clients', async () => {
    mockRefresh.mockResolvedValue({ access_token: 'new-access-token', token_type: 'Bearer' });

    await makeManager().refreshAccessToken();

    expect(mockRefresh).toHaveBeenCalledWith('https://mcp.example.com', 'original-refresh-token', {
      clientId: 'client-123',
    });
  });

  it('pins the refresh to the issuer the profile authenticated with', async () => {
    mockRefresh.mockResolvedValue({ access_token: 'new-access-token', token_type: 'Bearer' });

    const manager = makeManager({
      clientSecret: 'secret-xyz',
      issuer: 'https://auth.example.com',
    });
    await manager.refreshAccessToken();

    expect(mockRefresh).toHaveBeenCalledWith('https://mcp.example.com', 'original-refresh-token', {
      clientId: 'client-123',
      clientSecret: 'secret-xyz',
      issuer: 'https://auth.example.com',
    });
  });
});

describe('OAuthTokenManager resource indicator (#395)', () => {
  it('passes the resource indicator the login sent to the refresh request', async () => {
    mockRefresh.mockResolvedValue({ access_token: 'new-access-token', token_type: 'Bearer' });

    await makeManager({ resource: 'https://mcp.example.com/mcp' }).refreshAccessToken();

    expect(mockRefresh).toHaveBeenCalledWith('https://mcp.example.com', 'original-refresh-token', {
      clientId: 'client-123',
      resource: 'https://mcp.example.com/mcp',
    });
  });
});

describe('OAuthTokenManager forced refresh after HTTP 401 (#395)', () => {
  const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

  it('refreshes although the current access token has not expired by the local clock', async () => {
    mockRefresh.mockResolvedValue({ access_token: 'fresh', token_type: 'Bearer' });
    const manager = makeManager({ accessToken: 'rejected', accessTokenExpiresAt: inAnHour() });

    const tokens = await manager.refreshAccessToken({ force: true });

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(tokens.access_token).toBe('fresh');
    await expect(manager.getValidAccessToken()).resolves.toBe('fresh');
  });

  it('does not reuse the rejected token just because storage still holds it as valid', async () => {
    // Without `force` this shortcut is right: another process may have refreshed.
    // After a 401 the stored token is the one the server just rejected.
    mockRefresh.mockResolvedValue({ access_token: 'fresh', token_type: 'Bearer' });
    const manager = makeManager({
      accessToken: 'rejected',
      accessTokenExpiresAt: inAnHour(),
      onBeforeRefresh: async () => ({
        refreshToken: 'original-refresh-token',
        accessToken: 'rejected',
        accessTokenExpiresAt: inAnHour(),
      }),
    });

    await expect(manager.refreshAccessToken()).resolves.toMatchObject({
      access_token: 'rejected',
    });
    expect(mockRefresh).not.toHaveBeenCalled();

    await expect(manager.refreshAccessToken({ force: true })).resolves.toMatchObject({
      access_token: 'fresh',
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('adopts a different valid token another process stored instead of refreshing', async () => {
    const manager = makeManager({
      accessToken: 'rejected',
      accessTokenExpiresAt: inAnHour(),
      onBeforeRefresh: async () => ({
        accessToken: 'refreshed-elsewhere',
        accessTokenExpiresAt: inAnHour(),
      }),
    });

    await expect(manager.refreshAccessToken({ force: true })).resolves.toMatchObject({
      access_token: 'refreshed-elsewhere',
    });
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('shares one refresh between concurrent callers', async () => {
    // Several requests can fail with 401 at once; a rotating server would reject
    // the second refresh as a reused refresh token.
    let release!: (tokens: OAuthTokenResponse) => void;
    mockRefresh.mockReturnValue(new Promise<OAuthTokenResponse>((resolve) => (release = resolve)));
    const manager = makeManager({ accessToken: 'rejected', accessTokenExpiresAt: inAnHour() });

    const first = manager.refreshAccessToken({ force: true });
    const second = manager.refreshAccessToken({ force: true });
    release({ access_token: 'fresh', token_type: 'Bearer' });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { access_token: 'fresh', token_type: 'Bearer' },
      { access_token: 'fresh', token_type: 'Bearer' },
    ]);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not refresh again right after a refresh: the retry already carries the new token', async () => {
    mockRefresh.mockResolvedValue({ access_token: 'fresh', token_type: 'Bearer' });
    const manager = makeManager({ accessToken: 'rejected', accessTokenExpiresAt: inAnHour() });

    await manager.refreshAccessToken({ force: true });
    await expect(manager.refreshAccessToken({ force: true })).resolves.toMatchObject({
      access_token: 'fresh',
    });

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('propagates a rejected refresh token with a re-login hint', async () => {
    mockRefresh.mockRejectedValue(new Error('invalid_grant'));
    const manager = makeManager({ accessToken: 'rejected', accessTokenExpiresAt: inAnHour() });

    await expect(manager.refreshAccessToken({ force: true })).rejects.toThrow(
      /re-authenticate with: mcpc login https:\/\/mcp\.example\.com/
    );
  });
});
