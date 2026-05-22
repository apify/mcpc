/**
 * Unit tests for OAuth utility functions
 */

import type { MockInstance } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  discoverTokenEndpoint,
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

describe('MCPC_OAUTH_CALLBACK_PORTS / client-metadata.json consistency', () => {
  const PROJECT_ROOT = resolve(__dirname, '../../../..');
  const metadata = JSON.parse(
    readFileSync(resolve(PROJECT_ROOT, 'client-metadata.json'), 'utf-8')
  ) as { redirect_uris: string[] };

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
