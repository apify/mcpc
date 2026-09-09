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
