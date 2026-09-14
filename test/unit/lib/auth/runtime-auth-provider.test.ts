/**
 * Unit tests for the bridge's bearer-token auth provider (#395): the SDK transport
 * must recover from an HTTP 401 by refreshing the token and retrying once, instead
 * of starting an interactive authorization no background process can finish.
 */

import { vi } from 'vitest';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { OAuthTokenManager } from '../../../../src/lib/auth/oauth-token-manager.js';
import { createRuntimeAuthProvider } from '../../../../src/lib/auth/runtime-auth-provider.js';

vi.mock('../../../../src/lib/auth/oauth-utils.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../src/lib/auth/oauth-utils.js')>();
  return { ...original, discoverAndRefreshToken: vi.fn() };
});

import { discoverAndRefreshToken } from '../../../../src/lib/auth/oauth-utils.js';

const mockRefresh = vi.mocked(discoverAndRefreshToken);

const makeManager = () =>
  new OAuthTokenManager({
    serverUrl: 'https://mcp.example.com/mcp',
    profileName: 'default',
    clientId: 'client-123',
    refreshToken: 'refresh-1',
    accessToken: 'stale',
    accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  });

// A notification the transport does not follow up with an SSE stream (unlike
// notifications/initialized), so the fetch calls are exactly the POST and its retry.
const notification = { jsonrpc: '2.0' as const, method: 'notifications/roots/list_changed' };

beforeEach(() => {
  mockRefresh.mockReset();
});

describe('createRuntimeAuthProvider', () => {
  it('hands the transport the current access token', async () => {
    const provider = createRuntimeAuthProvider(makeManager());

    await expect(provider.token()).resolves.toBe('stale');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('forces a refresh when the server rejected the token', async () => {
    mockRefresh.mockResolvedValue({ access_token: 'fresh', token_type: 'Bearer' });
    const manager = makeManager();
    const provider = createRuntimeAuthProvider(manager);

    await provider.onUnauthorized!({} as never);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    await expect(provider.token()).resolves.toBe('fresh');
  });
});

describe('SDK transport with the runtime auth provider', () => {
  const authorizationOf = (call: unknown[]) =>
    new Headers((call[1] as RequestInit).headers).get('authorization');

  it('refreshes the token and retries once after HTTP 401', async () => {
    mockRefresh.mockResolvedValue({ access_token: 'fresh', token_type: 'Bearer' });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const transport = new StreamableHTTPClientTransport(new URL('https://mcp.example.com/mcp'), {
      authProvider: createRuntimeAuthProvider(makeManager()),
      fetch: fetchMock,
    });

    await transport.send(notification);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authorizationOf(fetchMock.mock.calls[0]!)).toBe('Bearer stale');
    expect(authorizationOf(fetchMock.mock.calls[1]!)).toBe('Bearer fresh');
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('fails as an authentication error when the refreshed token is rejected too', async () => {
    // No interactive flow, no endless loop: one refresh, one retry, then the error
    // the bridge classifies as "unauthorized".
    mockRefresh.mockResolvedValue({ access_token: 'fresh', token_type: 'Bearer' });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    const transport = new StreamableHTTPClientTransport(new URL('https://mcp.example.com/mcp'), {
      authProvider: createRuntimeAuthProvider(makeManager()),
      fetch: fetchMock,
    });

    await expect(transport.send(notification)).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('surfaces the re-login hint when the refresh token is rejected', async () => {
    mockRefresh.mockRejectedValue(new Error('invalid_grant'));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    const transport = new StreamableHTTPClientTransport(new URL('https://mcp.example.com/mcp'), {
      authProvider: createRuntimeAuthProvider(makeManager()),
      fetch: fetchMock,
    });

    await expect(transport.send(notification)).rejects.toThrow(
      /re-authenticate with: mcpc login https:\/\/mcp\.example\.com\/mcp/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
