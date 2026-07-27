/**
 * Unit tests for OAuth utility functions
 */

import type { MockInstance } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  DEFAULT_CLIENT_METADATA_URL,
  discoverAuthServerViaProtectedResource,
  discoverTokenEndpoint,
  getOAuthServerUrl,
  MCPC_OAUTH_CALLBACK_PORTS,
} from '../../../../src/lib/auth/oauth-utils.js';
import * as proxyModule from '../../../../src/lib/proxy.js';

// Helper to create a mock fetch Response
function mockResponse(body: object | null, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
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

describe('discoverTokenEndpoint', () => {
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
