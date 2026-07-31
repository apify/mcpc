/**
 * Unit tests for the OAuthProvider (MCP SDK OAuthClientProvider implementation)
 */

import type { OAuthDiscoveryState } from '@modelcontextprotocol/client';
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
