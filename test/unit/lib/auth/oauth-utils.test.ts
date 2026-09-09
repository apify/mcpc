/**
 * Unit tests for OAuth utility functions
 */

import type { MockInstance } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  DEFAULT_CLIENT_METADATA_URL,
  discoverAuthServerMetadata,
  discoverAuthServerViaProtectedResource,
  getOAuthServerUrl,
  MCPC_OAUTH_CALLBACK_PORTS,
  discoverAndRefreshToken,
  refreshAccessToken,
  selectClientAuthMethod,
} from '../../../../src/lib/auth/oauth-utils.js';
import * as proxyModule from '../../../../src/lib/proxy.js';

// Helper to create a mock fetch Response
function mockResponse(body: object | null, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// Helper to create a mock token-endpoint error Response (read via text())
function mockErrorResponse(status: number, body: object): Response {
  return {
    ok: false,
    status,
    statusText: 'Unauthorized',
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('getOAuthServerUrl', () => {
  it('should strip the query string (tool filter) but keep the rest', () => {
    // The reported bug: ?tools=... broke OAuth login on mcp.apify.com
    expect(
      getOAuthServerUrl('https://mcp.apify.com/?tools=search-actors,fetch-actor-details,docs')
    ).toBe('https://mcp.apify.com');
    expect(getOAuthServerUrl('https://example.com/?test=1')).toBe('https://example.com');
    expect(getOAuthServerUrl('https://example.com/mcp?tools=a,b')).toBe('https://example.com/mcp');
  });

  it('should produce the same result with or without a query string', () => {
    expect(getOAuthServerUrl('https://mcp.apify.com/?tools=docs')).toBe(
      getOAuthServerUrl('https://mcp.apify.com/')
    );
    expect(getOAuthServerUrl('https://mcp.apify.com')).toBe('https://mcp.apify.com');
  });

  it('should preserve the path for path-based discovery', () => {
    expect(getOAuthServerUrl('https://example.com/mcp')).toBe('https://example.com/mcp');
    expect(getOAuthServerUrl('https://example.com/mcp/')).toBe('https://example.com/mcp/');
  });

  it('should strip the fragment as well', () => {
    expect(getOAuthServerUrl('https://example.com/?test=1#frag')).toBe('https://example.com');
    expect(getOAuthServerUrl('https://example.com/path#frag')).toBe('https://example.com/path');
  });

  it('should normalize scheme, host, port and credentials like normalizeServerUrl', () => {
    expect(getOAuthServerUrl('mcp.apify.com?tools=docs')).toBe('https://mcp.apify.com');
    expect(getOAuthServerUrl('https://EXAMPLE.COM:443/?a=1')).toBe('https://example.com');
    expect(getOAuthServerUrl('https://example.com:8443/?a=1')).toBe('https://example.com:8443');
    expect(getOAuthServerUrl('https://user:pass@example.com/?a=1')).toBe('https://example.com');
    expect(getOAuthServerUrl('localhost:3000?x=1')).toBe('http://localhost:3000');
  });

  it('should throw on invalid URLs', () => {
    expect(() => getOAuthServerUrl('not a url at all')).toThrow('Invalid MCP server URL');
  });
});

// `discoverTokenEndpoint()` was a one-line wrapper over discoverAuthServerMetadata()
// and went away with the refresh rewrite; these tests still pin the discovery URL
// order, which the refresh falls back to for profiles with no recorded issuer.
const discoverTokenEndpoint = async (serverUrl: string) =>
  (await discoverAuthServerMetadata(serverUrl))?.token_endpoint;

describe('discoverAuthServerMetadata discovery URLs', () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(proxyModule, 'proxyFetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns token endpoint from path-based oauth-authorization-server', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url === 'https://example.com/mcp/.well-known/oauth-authorization-server') {
        return Promise.resolve(mockResponse({ token_endpoint: 'https://example.com/token' }));
      }
      return Promise.resolve(mockResponse(null, false));
    });

    const result = await discoverTokenEndpoint('https://example.com/mcp');
    expect(result).toBe('https://example.com/token');
  });

  it('falls back to path-based openid-configuration when oauth-authorization-server has no token_endpoint', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(mockResponse({})); // no token_endpoint
      }
      if (url === 'https://example.com/.well-known/openid-configuration') {
        return Promise.resolve(mockResponse({ token_endpoint: 'https://example.com/oidc/token' }));
      }
      return Promise.resolve(mockResponse(null, false));
    });

    const result = await discoverTokenEndpoint('https://example.com');
    expect(result).toBe('https://example.com/oidc/token');
  });

  it('falls back to root-based discovery when path-based URLs return no token_endpoint', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url === 'https://example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(mockResponse({ token_endpoint: 'https://example.com/token' }));
      }
      return Promise.resolve(mockResponse(null, false));
    });

    const result = await discoverTokenEndpoint('https://example.com/mcp');
    expect(result).toBe('https://example.com/token');
  });

  it('returns undefined when no discovery URL returns a token endpoint', async () => {
    fetchSpy.mockResolvedValue(mockResponse(null, false));

    const result = await discoverTokenEndpoint('https://example.com/mcp');
    expect(result).toBeUndefined();
  });

  it('handles fetch errors gracefully and continues to next URL', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url === 'https://example.com/mcp/.well-known/oauth-authorization-server') {
        return Promise.reject(new Error('Network error'));
      }
      if (url === 'https://example.com/mcp/.well-known/openid-configuration') {
        return Promise.resolve(mockResponse({ token_endpoint: 'https://example.com/token' }));
      }
      return Promise.resolve(mockResponse(null, false));
    });

    const result = await discoverTokenEndpoint('https://example.com/mcp');
    expect(result).toBe('https://example.com/token');
  });

  it('trims trailing slashes from serverUrl before building discovery URLs', async () => {
    const expectedUrls = [
      'https://example.com/mcp/.well-known/oauth-authorization-server',
      'https://example.com/mcp/.well-known/openid-configuration',
      'https://example.com/.well-known/oauth-authorization-server',
      'https://example.com/.well-known/openid-configuration',
    ];

    for (const trailingSlashes of ['/', '///']) {
      const calledUrls: string[] = [];
      fetchSpy.mockImplementation((url: string) => {
        calledUrls.push(url);
        return Promise.resolve(mockResponse(null, false));
      });

      await discoverTokenEndpoint(`https://example.com/mcp${trailingSlashes}`);
      expect(calledUrls).toEqual(expectedUrls);
    }
  });

  it('strips the query string from serverUrl before building discovery URLs', async () => {
    // Regression: a `?tools=` filter on the URL must not leak into the
    // well-known discovery requests, otherwise discovery fails and OAuth
    // falls back to POST <origin>/register.
    const calledUrls: string[] = [];
    fetchSpy.mockImplementation((url: string) => {
      calledUrls.push(url);
      return Promise.resolve(mockResponse(null, false));
    });

    await discoverTokenEndpoint(
      'https://mcp.apify.com/?tools=search-actors,fetch-actor-details,docs'
    );
    expect(calledUrls).toEqual([
      'https://mcp.apify.com/.well-known/oauth-authorization-server',
      'https://mcp.apify.com/.well-known/openid-configuration',
    ]);
    expect(calledUrls.some((u) => u.includes('tools='))).toBe(false);
  });

  it('does not add duplicate root-based URLs when serverUrl is already root', async () => {
    const calledUrls: string[] = [];
    fetchSpy.mockImplementation((url: string) => {
      calledUrls.push(url);
      return Promise.resolve(mockResponse(null, false));
    });

    await discoverTokenEndpoint('https://example.com');
    expect(calledUrls).toHaveLength(2);
    expect(calledUrls).toEqual([
      'https://example.com/.well-known/oauth-authorization-server',
      'https://example.com/.well-known/openid-configuration',
    ]);
  });

  it('does not add duplicate root-based URLs when serverUrl has trailing slash only', async () => {
    const calledUrls: string[] = [];
    fetchSpy.mockImplementation((url: string) => {
      calledUrls.push(url);
      return Promise.resolve(mockResponse(null, false));
    });

    await discoverTokenEndpoint('https://example.com/');
    expect(calledUrls).toHaveLength(2);
  });

  it('tries all 4 discovery URLs for a path-based serverUrl', async () => {
    const calledUrls: string[] = [];
    fetchSpy.mockImplementation((url: string) => {
      calledUrls.push(url);
      return Promise.resolve(mockResponse(null, false));
    });

    await discoverTokenEndpoint('https://example.com/mcp');
    expect(calledUrls).toEqual([
      'https://example.com/mcp/.well-known/oauth-authorization-server',
      'https://example.com/mcp/.well-known/openid-configuration',
      'https://example.com/.well-known/oauth-authorization-server',
      'https://example.com/.well-known/openid-configuration',
    ]);
  });
});

describe('selectClientAuthMethod', () => {
  it('prefers Basic for a confidential client, matching the SDK login path', () => {
    // The SDK's selectClientAuthMethod() picks client_secret_basic first, and
    // RFC 8414 §2 defaults to it when the server advertises no methods.
    expect(selectClientAuthMethod(undefined, true)).toBe('client_secret_basic');
    expect(selectClientAuthMethod({}, true)).toBe('client_secret_basic');
    expect(selectClientAuthMethod({ token_endpoint_auth_methods_supported: [] }, true)).toBe(
      'client_secret_basic'
    );
  });

  it('honors the advertised method when the server supports only one', () => {
    expect(
      selectClientAuthMethod(
        { token_endpoint_auth_methods_supported: ['client_secret_post'] },
        true
      )
    ).toBe('client_secret_post');
    expect(
      selectClientAuthMethod(
        { token_endpoint_auth_methods_supported: ['client_secret_basic'] },
        true
      )
    ).toBe('client_secret_basic');
  });

  it('is none for a public client whatever the server advertises', () => {
    expect(selectClientAuthMethod(undefined, false)).toBe('none');
    expect(
      selectClientAuthMethod(
        { token_endpoint_auth_methods_supported: ['client_secret_post'] },
        false
      )
    ).toBe('none');
  });
});

describe('refreshAccessToken client authentication (#387)', () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(proxyModule, 'proxyFetch');
    fetchSpy.mockResolvedValue(
      mockResponse({ access_token: 'new-access', token_type: 'Bearer', expires_in: 3600 })
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function sentRequest(call = 0): { headers: Record<string, string>; params: URLSearchParams } {
    const init = fetchSpy.mock.calls[call]![1] as RequestInit;
    return {
      headers: init.headers as Record<string, string>,
      params: new URLSearchParams(init.body as string),
    };
  }

  it('authenticates a confidential client with HTTP Basic by default', async () => {
    await refreshAccessToken('https://example.com/token', 'refresh-1', {
      clientId: 'client-123',
      clientSecret: 'secret-xyz',
    });

    const { headers, params } = sentRequest();
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('refresh-1');
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('client-123:secret-xyz').toString('base64')}`
    );
    // Basic puts nothing in the body, like the SDK's applyBasicAuth()
    expect(params.has('client_secret')).toBe(false);
  });

  it('sends the secret in the body when the caller pins client_secret_post', async () => {
    // Asana (and any server enforcing client auth on refresh_token) rejects the
    // refresh with invalid_client when the pre-registered secret is missing.
    await refreshAccessToken('https://example.com/token', 'refresh-1', {
      clientId: 'client-123',
      clientSecret: 'secret-xyz',
      authMethod: 'client_secret_post',
    });

    const { headers, params } = sentRequest();
    expect(params.get('client_id')).toBe('client-123');
    expect(params.get('client_secret')).toBe('secret-xyz');
    expect(headers.Authorization).toBeUndefined();
  });

  it('sends only client_id for public clients', async () => {
    await refreshAccessToken('https://example.com/token', 'refresh-1', {
      clientId: 'client-123',
    });

    const { headers, params } = sentRequest();
    expect(params.get('client_id')).toBe('client-123');
    expect(params.has('client_secret')).toBe(false);
    expect(headers.Authorization).toBeUndefined();
  });

  it('retries with the body form when the server rejects Basic with invalid_client', async () => {
    // A server that advertises no token_endpoint_auth_methods_supported and accepts
    // only client_secret_post cannot be told apart from metadata alone.
    fetchSpy.mockImplementation(() => {
      if (fetchSpy.mock.calls.length === 1) {
        return Promise.resolve(
          mockErrorResponse(401, { error: 'invalid_client', error_description: 'Client not found' })
        );
      }
      return Promise.resolve(mockResponse({ access_token: 'fresh', token_type: 'Bearer' }));
    });

    const tokens = await refreshAccessToken('https://example.com/token', 'refresh-1', {
      clientId: 'client-123',
      clientSecret: 'secret-xyz',
    });

    expect(tokens.access_token).toBe('fresh');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(sentRequest(0).headers.Authorization).toBeDefined();
    expect(sentRequest(1).params.get('client_secret')).toBe('secret-xyz');
  });

  it('does not retry when the refresh token itself is rejected', async () => {
    // invalid_grant is a dead refresh token: retrying with other client
    // credentials cannot help and would only double the request.
    fetchSpy.mockResolvedValue(mockErrorResponse(400, { error: 'invalid_grant' }));

    await expect(
      refreshAccessToken('https://example.com/token', 'refresh-1', {
        clientId: 'client-123',
        clientSecret: 'secret-xyz',
      })
    ).rejects.toThrow('Refresh token is invalid or expired');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses to send credentials over plaintext HTTP', async () => {
    // The refresh token (and the client secret) are in this request body.
    await expect(
      refreshAccessToken('http://auth.example.com/token', 'refresh-1', {
        clientId: 'client-123',
        clientSecret: 'secret-xyz',
      })
    ).rejects.toThrow('non-HTTPS token endpoint');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows a loopback token endpoint over HTTP for local development', async () => {
    await refreshAccessToken('http://127.0.0.1:9000/token', 'refresh-1', {
      clientId: 'client-123',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry for a public client', async () => {
    fetchSpy.mockResolvedValue(mockErrorResponse(401, { error: 'invalid_client' }));

    await expect(
      refreshAccessToken('https://example.com/token', 'refresh-1', { clientId: 'client-123' })
    ).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('discoverAndRefreshToken authorization server resolution (#387)', () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(proxyModule, 'proxyFetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  /** Mock an MCP server whose PRM delegates to auth.example.com. */
  function mockAsanaShapedServer(posted: string[]): void {
    fetchSpy.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted.push(url);
        return Promise.resolve(
          mockResponse({ access_token: 'fresh', token_type: 'Bearer', expires_in: 3600 })
        );
      }
      if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
        return Promise.resolve(
          mockResponse({ authorization_servers: ['https://auth.example.com'] })
        );
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(mockResponse({ token_endpoint: 'https://auth.example.com/token' }));
      }
      if (url === 'https://mcp.example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(mockResponse({ token_endpoint: 'https://mcp.example.com/token' }));
      }
      return Promise.resolve(mockResponse(null, false));
    });
  }

  it('refreshes at the issuer recorded in the profile, ignoring the MCP server metadata', async () => {
    // The pin: a server that changes its protected resource metadata cannot
    // redirect the refresh token and client secret to another authorization server.
    const posted: string[] = [];
    const requested: string[] = [];
    fetchSpy.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted.push(url);
        return Promise.resolve(mockResponse({ access_token: 'fresh', token_type: 'Bearer' }));
      }
      requested.push(url);
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(mockResponse({ token_endpoint: 'https://auth.example.com/token' }));
      }
      return Promise.resolve(mockResponse(null, false));
    });

    await discoverAndRefreshToken('https://mcp.example.com/mcp', 'refresh-1', {
      clientId: 'c',
      issuer: 'https://auth.example.com',
    });

    expect(posted).toEqual(['https://auth.example.com/token']);
    // No protected resource metadata probe at all: the issuer is already known.
    expect(requested.some((u) => u.includes('oauth-protected-resource'))).toBe(false);
  });

  it('fails with a re-authentication hint when the recorded issuer has no metadata', async () => {
    // Falling back to discovery here would defeat the pin, so this is a hard stop.
    const posted: string[] = [];
    mockAsanaShapedServer(posted);

    await expect(
      discoverAndRefreshToken('https://mcp.example.com/mcp', 'refresh-1', {
        clientId: 'c',
        issuer: 'https://moved.example.com',
      })
    ).rejects.toThrow('the authorization server this profile logged in at');
    expect(posted).toEqual([]);
  });

  it('falls back to protected resource metadata when the profile has no issuer', async () => {
    // Asana: mcp.asana.com serves its own (legacy) authorization-server metadata,
    // but the MCP server's RFC 9728 document delegates to app.asana.com, which is
    // where login registered the client. Refreshing at the wrong server yields
    // invalid_client.
    const posted: string[] = [];
    mockAsanaShapedServer(posted);

    const tokens = await discoverAndRefreshToken('https://mcp.example.com/mcp', 'refresh-1', {
      clientId: 'c',
    });

    expect(tokens.access_token).toBe('fresh');
    expect(posted).toEqual(['https://auth.example.com/token']);
  });

  it('falls back to well-known probes on the MCP origin without protected resource metadata', async () => {
    const posted: string[] = [];
    fetchSpy.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted.push(url);
        return Promise.resolve(mockResponse({ access_token: 'fresh', token_type: 'Bearer' }));
      }
      if (url === 'https://mcp.example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(mockResponse({ token_endpoint: 'https://mcp.example.com/token' }));
      }
      return Promise.resolve(mockResponse(null, false));
    });

    await discoverAndRefreshToken('https://mcp.example.com/mcp', 'refresh-1', { clientId: 'c' });

    expect(posted).toEqual(['https://mcp.example.com/token']);
  });

  it('picks the client authentication method the authorization server advertises', async () => {
    // The server declares client_secret_post only, so Basic is never attempted.
    const bodies: string[] = [];
    fetchSpy.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        bodies.push(init.body as string);
        return Promise.resolve(mockResponse({ access_token: 'fresh', token_type: 'Bearer' }));
      }
      if (url === 'https://mcp.example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(
          mockResponse({
            token_endpoint: 'https://mcp.example.com/token',
            token_endpoint_auth_methods_supported: ['client_secret_post'],
          })
        );
      }
      return Promise.resolve(mockResponse(null, false));
    });

    await discoverAndRefreshToken('https://mcp.example.com/mcp', 'refresh-1', {
      clientId: 'c',
      clientSecret: 'secret-xyz',
    });

    expect(bodies).toHaveLength(1);
    expect(new URLSearchParams(bodies[0]!).get('client_secret')).toBe('secret-xyz');
  });
});

describe('discoverAuthServerViaProtectedResource', () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(proxyModule, 'proxyFetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('follows protected resource metadata to an authorization server on another origin', async () => {
    // The case direct well-known probes against the MCP origin cannot solve.
    fetchSpy.mockImplementation((url: string) => {
      if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
        return Promise.resolve(
          mockResponse({ authorization_servers: ['https://auth.example.com'] })
        );
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(mockResponse({ token_endpoint: 'https://auth.example.com/token' }));
      }
      return Promise.resolve(mockResponse(null, false));
    });

    const metadata = await discoverAuthServerViaProtectedResource('https://mcp.example.com/mcp');
    expect(metadata?.token_endpoint).toBe('https://auth.example.com/token');
  });

  it('falls back to the origin-wide protected resource document', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource') {
        return Promise.resolve(
          mockResponse({ authorization_servers: ['https://auth.example.com'] })
        );
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(mockResponse({ token_endpoint: 'https://auth.example.com/token' }));
      }
      return Promise.resolve(mockResponse(null, false));
    });

    const metadata = await discoverAuthServerViaProtectedResource('https://mcp.example.com/mcp');
    expect(metadata?.token_endpoint).toBe('https://auth.example.com/token');
  });

  it('inserts the well-known segment before an issuer path (RFC 8414)', async () => {
    const calledUrls: string[] = [];
    fetchSpy.mockImplementation((url: string) => {
      calledUrls.push(url);
      if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
        return Promise.resolve(
          mockResponse({ authorization_servers: ['https://auth.example.com/tenant1'] })
        );
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server/tenant1') {
        return Promise.resolve(mockResponse({ token_endpoint: 'https://auth.example.com/token' }));
      }
      return Promise.resolve(mockResponse(null, false));
    });

    const metadata = await discoverAuthServerViaProtectedResource('https://mcp.example.com/mcp');
    expect(metadata?.token_endpoint).toBe('https://auth.example.com/token');
    expect(calledUrls).toContain(
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1'
    );
  });

  it('tries the next issuer when the first exposes no token endpoint', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
        return Promise.resolve(
          mockResponse({
            authorization_servers: ['https://broken.example.com', 'https://auth.example.com'],
          })
        );
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return Promise.resolve(mockResponse({ token_endpoint: 'https://auth.example.com/token' }));
      }
      return Promise.resolve(mockResponse(null, false));
    });

    const metadata = await discoverAuthServerViaProtectedResource('https://mcp.example.com/mcp');
    expect(metadata?.token_endpoint).toBe('https://auth.example.com/token');
  });

  it('returns undefined when no protected resource document exists', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(mockResponse(null, false)));
    expect(
      await discoverAuthServerViaProtectedResource('https://mcp.example.com/mcp')
    ).toBeUndefined();
  });

  it('ignores a malformed authorization_servers value', async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (url.includes('oauth-protected-resource')) {
        return Promise.resolve(mockResponse({ authorization_servers: 'https://auth.example.com' }));
      }
      return Promise.resolve(mockResponse(null, false));
    });

    expect(
      await discoverAuthServerViaProtectedResource('https://mcp.example.com/mcp')
    ).toBeUndefined();
  });
});

describe('MCPC_OAUTH_CALLBACK_PORTS / client-metadata.json consistency', () => {
  const PROJECT_ROOT = resolve(__dirname, '../../../..');
  const metadata = JSON.parse(
    readFileSync(resolve(PROJECT_ROOT, 'client-metadata.json'), 'utf-8')
  ) as { client_id: string; redirect_uris: string[] };

  it('client_id matches the hosted document URL (required by CIMD spec)', () => {
    expect(metadata.client_id).toBe(DEFAULT_CLIENT_METADATA_URL);
  });

  it('every callback port has a matching loopback redirect_uri in client-metadata.json', () => {
    const expectedUris = MCPC_OAUTH_CALLBACK_PORTS.map(
      (port) => `http://127.0.0.1:${port}/callback`
    );
    for (const uri of expectedUris) {
      expect(metadata.redirect_uris).toContain(uri);
    }
  });

  it('every redirect_uri in client-metadata.json corresponds to a callback port', () => {
    const allowedUris = new Set(
      MCPC_OAUTH_CALLBACK_PORTS.map((port) => `http://127.0.0.1:${port}/callback`)
    );
    for (const uri of metadata.redirect_uris) {
      expect(allowedUris.has(uri)).toBe(true);
    }
  });

  it('the count of redirect_uris matches the count of callback ports', () => {
    expect(metadata.redirect_uris.length).toBe(MCPC_OAUTH_CALLBACK_PORTS.length);
  });

  it('callback ports are unique', () => {
    const unique = new Set(MCPC_OAUTH_CALLBACK_PORTS);
    expect(unique.size).toBe(MCPC_OAUTH_CALLBACK_PORTS.length);
  });
});
