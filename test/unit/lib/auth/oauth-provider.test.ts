/**
 * Unit tests for the OAuthProvider (MCP SDK OAuthClientProvider implementation)
 */

import { vi } from 'vitest';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/client';

vi.mock('../../../../src/lib/auth/keychain.js', () => ({
  readKeychainOAuthTokenInfo: vi.fn(),
  storeKeychainOAuthTokenInfo: vi.fn(),
  readKeychainOAuthClientInfo: vi.fn(),
  storeKeychainOAuthClientInfo: vi.fn(),
}));

vi.mock('../../../../src/lib/auth/profiles.js', () => ({
  getAuthProfile: vi.fn(),
  saveAuthProfile: vi.fn(),
}));

import type { AuthProfile } from '../../../../src/lib/types.js';
import { getAuthProfile, saveAuthProfile } from '../../../../src/lib/auth/profiles.js';
import {
  readKeychainOAuthClientInfo,
  storeKeychainOAuthClientInfo,
  storeKeychainOAuthTokenInfo,
} from '../../../../src/lib/auth/keychain.js';
import { OAuthProvider } from '../../../../src/lib/auth/oauth-provider.js';

describe('OAuthProvider discovery state (SEP-2352)', () => {
  const makeProvider = () =>
    new OAuthProvider({
      serverUrl: 'https://mcp.example.com',
      profileName: 'default',
      redirectUrl: 'http://127.0.0.1:13316/callback',
    });

  const discovery: OAuthDiscoveryState = {
    authorizationServerUrl: 'https://auth.example.com',
    resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource',
  };

  it('implements saveDiscoveryState/discoveryState so the SDK can bind the callback leg', () => {
    const provider = makeProvider();
    // The SDK checks for the methods' presence: without them it can only warn
    // that the SEP-2352 authorization-server binding cannot be verified.
    expect(typeof provider.saveDiscoveryState).toBe('function');
    expect(typeof provider.discoveryState).toBe('function');
  });

  it('round-trips discovery state within one provider instance', async () => {
    const provider = makeProvider();
    expect(await provider.discoveryState()).toBeUndefined();

    await provider.saveDiscoveryState(discovery);
    expect(await provider.discoveryState()).toEqual(discovery);
  });

  it('keeps discovery state with the same durability as the code verifier', async () => {
    // Both legs of the login flow share one provider instance in one process,
    // so in-memory storage is the required durability (matches _codeVerifier).
    const provider = makeProvider();
    await provider.saveCodeVerifier('verifier-123');
    await provider.saveDiscoveryState(discovery);

    expect(await provider.codeVerifier()).toBe('verifier-123');
    expect(await provider.discoveryState()).toEqual(discovery);

    // A fresh instance (new process) starts clean — no cross-instance leakage.
    const fresh = makeProvider();
    expect(await fresh.discoveryState()).toBeUndefined();
  });
});

describe('OAuthProvider records the authorization server it logged in at (#387)', () => {
  const makeProvider = () =>
    new OAuthProvider({
      serverUrl: 'https://mcp.example.com',
      profileName: 'default',
      redirectUrl: 'http://127.0.0.1:13316/callback',
    });

  const tokens = { access_token: 'access-1', token_type: 'Bearer', refresh_token: 'refresh-1' };

  beforeEach(() => {
    vi.mocked(getAuthProfile).mockReset();
    vi.mocked(saveAuthProfile).mockReset();
  });

  const savedProfile = () => vi.mocked(saveAuthProfile).mock.calls[0]![0] as AuthProfile;

  it('stores the discovered issuer on a new profile, so the refresh can be pinned to it', async () => {
    vi.mocked(getAuthProfile).mockResolvedValue(undefined as never);

    const provider = makeProvider();
    await provider.saveDiscoveryState({
      authorizationServerUrl: 'https://auth.example.com',
    } as OAuthDiscoveryState);
    await provider.saveTokens(tokens);

    expect(savedProfile().oauthIssuer).toBe('https://auth.example.com');
  });

  it('backfills the issuer on an existing profile that has none', async () => {
    vi.mocked(getAuthProfile).mockResolvedValue({
      name: 'default',
      serverUrl: 'https://mcp.example.com',
      authType: 'oauth',
      oauthIssuer: '',
      createdAt: '2026-01-01T00:00:00.000Z',
    } as never);

    const provider = makeProvider();
    await provider.saveDiscoveryState({
      authorizationServerUrl: 'https://auth.example.com',
    } as OAuthDiscoveryState);
    await provider.saveTokens(tokens);

    expect(savedProfile().oauthIssuer).toBe('https://auth.example.com');
  });

  it('never blanks a stored issuer when there is no discovery state', async () => {
    vi.mocked(getAuthProfile).mockResolvedValue({
      name: 'default',
      serverUrl: 'https://mcp.example.com',
      authType: 'oauth',
      oauthIssuer: 'https://auth.example.com',
      createdAt: '2026-01-01T00:00:00.000Z',
    } as never);

    await makeProvider().saveTokens(tokens);

    expect(savedProfile().oauthIssuer).toBe('https://auth.example.com');
  });
});

describe('OAuthProvider records the resource indicator the login sent (#395)', () => {
  const makeProvider = () =>
    new OAuthProvider({
      serverUrl: 'https://mcp.example.com',
      profileName: 'default',
      redirectUrl: 'http://127.0.0.1:13316/callback',
    });

  const tokens = { access_token: 'access-1', token_type: 'Bearer', refresh_token: 'refresh-1' };

  beforeEach(() => {
    vi.mocked(getAuthProfile).mockReset();
    vi.mocked(saveAuthProfile).mockReset();
  });

  const savedProfile = () => vi.mocked(saveAuthProfile).mock.calls[0]![0] as AuthProfile;

  it('stores the resource the SDK selected, so the refresh can repeat it', async () => {
    vi.mocked(getAuthProfile).mockResolvedValue(undefined as never);

    const provider = makeProvider();
    await provider.saveResourceUrl('https://mcp.example.com/mcp');
    await provider.saveTokens(tokens);

    expect(savedProfile().oauthResource).toBe('https://mcp.example.com/mcp');
    await expect(provider.resourceUrl()).resolves.toBe('https://mcp.example.com/mcp');
  });

  it('drops a stored resource when this login sent none', async () => {
    // The SDK reports no resource when the server publishes no protected resource
    // metadata; the refresh must then send none either, like the login did.
    vi.mocked(getAuthProfile).mockResolvedValue({
      name: 'default',
      serverUrl: 'https://mcp.example.com',
      authType: 'oauth',
      oauthIssuer: 'https://auth.example.com',
      oauthResource: 'https://mcp.example.com/old',
      createdAt: '2026-01-01T00:00:00.000Z',
    } as never);

    await makeProvider().saveTokens(tokens);

    expect(savedProfile().oauthResource).toBeUndefined();
  });

  it('has no runtime mode: a 401 on a live connection is handled by the token manager, not by this class', () => {
    // The SDK would otherwise answer a 401 by starting an interactive authorization
    // that a background bridge can never complete (#395).
    const provider = makeProvider() as unknown as Record<string, unknown>;
    expect(provider.isRuntimeMode).toBeUndefined();
    expect(provider.tokenManager).toBeUndefined();
  });
});

describe('OAuthProvider state parameter (M1)', () => {
  const makeProvider = () =>
    new OAuthProvider({
      serverUrl: 'https://mcp.example.com',
      profileName: 'default',
      redirectUrl: 'http://127.0.0.1:13316/callback',
      forceReauth: true,
    });

  it('generates one random state per login so the SDK sends it and the callback can be matched', async () => {
    const provider = makeProvider();
    const state = await provider.state();
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    // Stable within one login: the authorization URL and the callback check use the same value.
    expect(await provider.state()).toBe(state);
    // Unpredictable across logins.
    expect(await makeProvider().state()).not.toBe(state);
  });
});

describe('OAuthProvider keeps the old client registration until the login succeeds (M2)', () => {
  const tokens = { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt' };

  beforeEach(() => {
    vi.mocked(readKeychainOAuthClientInfo).mockReset();
    vi.mocked(storeKeychainOAuthClientInfo).mockReset();
    vi.mocked(storeKeychainOAuthTokenInfo).mockReset();
    vi.mocked(getAuthProfile).mockReset();
    vi.mocked(saveAuthProfile).mockReset();
    vi.mocked(getAuthProfile).mockResolvedValue(undefined as never);
  });

  it('registers a fresh client on login without consulting the stored one', async () => {
    const provider = new OAuthProvider({
      serverUrl: 'https://mcp.example.com',
      profileName: 'default',
      forceReauth: true,
    });
    vi.mocked(readKeychainOAuthClientInfo).mockResolvedValue({ clientId: 'old-client' } as never);

    expect(await provider.clientInformation()).toBeUndefined();
    expect(readKeychainOAuthClientInfo).not.toHaveBeenCalled();
  });

  it('writes the new registration to the keychain only once tokens arrive, before the tokens', async () => {
    const provider = new OAuthProvider({
      serverUrl: 'https://mcp.example.com',
      profileName: 'default',
      forceReauth: true,
    });
    const calls: string[] = [];
    vi.mocked(storeKeychainOAuthClientInfo).mockImplementation(async () => {
      calls.push('client');
    });
    vi.mocked(storeKeychainOAuthTokenInfo).mockImplementation(async () => {
      calls.push('tokens');
    });

    await provider.saveClientInformation({ client_id: 'new-client', client_secret: 's3cret' });
    // A cancelled or failed login ends here: the old registration is untouched.
    expect(storeKeychainOAuthClientInfo).not.toHaveBeenCalled();
    // The code exchange leg reads the new registration from memory.
    expect(await provider.clientInformation()).toEqual({
      client_id: 'new-client',
      client_secret: 's3cret',
    });

    await provider.saveTokens(tokens);
    expect(storeKeychainOAuthClientInfo).toHaveBeenCalledWith(
      'https://mcp.example.com',
      'default',
      { clientId: 'new-client', clientSecret: 's3cret' }
    );
    expect(calls).toEqual(['client', 'tokens']);
  });

  it('persists command-line client credentials the same way, after the tokens are issued', async () => {
    const provider = new OAuthProvider({
      serverUrl: 'https://mcp.example.com',
      profileName: 'default',
      forceReauth: true,
      clientCredentials: { clientId: 'preset-client' },
    });

    expect(await provider.clientInformation()).toEqual({ client_id: 'preset-client' });
    expect(storeKeychainOAuthClientInfo).not.toHaveBeenCalled();

    await provider.saveTokens(tokens);
    expect(storeKeychainOAuthClientInfo).toHaveBeenCalledWith(
      'https://mcp.example.com',
      'default',
      { clientId: 'preset-client' }
    );
  });

  it('still writes the registration immediately when not re-authenticating', async () => {
    const provider = new OAuthProvider({
      serverUrl: 'https://mcp.example.com',
      profileName: 'default',
    });
    await provider.saveClientInformation({ client_id: 'client' });
    expect(storeKeychainOAuthClientInfo).toHaveBeenCalledTimes(1);
  });
});
