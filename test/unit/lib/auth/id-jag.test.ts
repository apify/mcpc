/**
 * Unit tests for enterprise-managed authorization (SEP-990, ID-JAG) helpers
 * (src/lib/auth/id-jag.ts).
 *
 * Covers the IdP-side pieces with a mocked fetch: the exact RFC 8693 token
 * exchange wire format, ID token refresh/rotation, the expiry buffer, and the
 * re-authentication error paths. The full login + browser SSO flow (network,
 * interactive) is out of scope here.
 */

import type { MockInstance } from 'vitest';
import {
  createIdJagProvider,
  decodeJwtPayload,
  getJwtExpirySecs,
  refreshIdpIdToken,
  ID_JAG_GRANT_PROFILE,
} from '../../../../src/lib/auth/id-jag.js';
import type { IdJagCredentials } from '../../../../src/lib/types.js';
import { AuthError } from '../../../../src/lib/errors.js';
import * as proxyModule from '../../../../src/lib/proxy.js';

/** Build an unsigned JWT with the given payload (signature is never verified). */
function makeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(payload)}.sig`;
}

function mockResponse(body: object, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const NOW_SECS = Math.floor(Date.now() / 1000);

function makeCredentials(overrides: Partial<IdJagCredentials> = {}): IdJagCredentials {
  return {
    idpIssuer: 'https://idp.example.com',
    idpTokenEndpoint: 'https://idp.example.com/token',
    idpClientId: 'idp-client',
    idpClientSecret: 'idp-secret',
    idToken: makeJwt({ sub: 'user-1', exp: NOW_SECS + 3600 }),
    idTokenExpiresAt: NOW_SECS + 3600,
    idpRefreshToken: 'idp-refresh-1',
    mcpClientId: 'mcp-client',
    mcpClientSecret: 'mcp-secret',
    scope: 'read write',
    ...overrides,
  };
}

const ID_JAG_RESPONSE = {
  issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
  access_token: 'the-id-jag',
  token_type: 'N_A',
};

describe('decodeJwtPayload / getJwtExpirySecs', () => {
  it('decodes a JWT payload', () => {
    const jwt = makeJwt({ sub: 'u', exp: 1234, email: 'a@b.c' });
    expect(decodeJwtPayload(jwt)).toEqual({ sub: 'u', exp: 1234, email: 'a@b.c' });
    expect(getJwtExpirySecs(jwt)).toBe(1234);
  });

  it('returns undefined for non-JWT input', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeUndefined();
    expect(getJwtExpirySecs('a.b')).toBeUndefined();
    expect(getJwtExpirySecs(makeJwt({ sub: 'no-exp' }))).toBeUndefined();
  });
});

describe('refreshIdpIdToken', () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(proxyModule, 'proxyFetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('posts a refresh_token grant with HTTP Basic client auth and rotates tokens', async () => {
    const newIdToken = makeJwt({ sub: 'user-1', exp: NOW_SECS + 7200 });
    fetchSpy.mockResolvedValue(
      mockResponse({ id_token: newIdToken, refresh_token: 'idp-refresh-2', token_type: 'Bearer' })
    );

    const updated = await refreshIdpIdToken(makeCredentials());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://idp.example.com/token');
    const params = new URLSearchParams(init.body as string);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('idp-refresh-1');
    expect(params.get('client_id')).toBe('idp-client');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(
      `Basic ${Buffer.from('idp-client:idp-secret').toString('base64')}`
    );

    expect(updated.idToken).toBe(newIdToken);
    expect(updated.idTokenExpiresAt).toBe(NOW_SECS + 7200);
    expect(updated.idpRefreshToken).toBe('idp-refresh-2');
  });

  it('omits client auth for public IdP clients and keeps an unrotated refresh token', async () => {
    const newIdToken = makeJwt({ sub: 'user-1', exp: NOW_SECS + 7200 });
    fetchSpy.mockResolvedValue(mockResponse({ id_token: newIdToken, token_type: 'Bearer' }));

    const info = makeCredentials();
    delete info.idpClientSecret;
    const updated = await refreshIdpIdToken(info);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
    expect(updated.idpRefreshToken).toBe('idp-refresh-1');
  });

  it('throws a re-auth AuthError when the IdP rejects the refresh token', async () => {
    fetchSpy.mockResolvedValue(mockResponse({ error: 'invalid_grant' }, 400));
    await expect(refreshIdpIdToken(makeCredentials())).rejects.toThrow(AuthError);
    await expect(refreshIdpIdToken(makeCredentials())).rejects.toThrow(/re-authenticate/i);
  });

  it('throws when the IdP returns no ID token', async () => {
    fetchSpy.mockResolvedValue(mockResponse({ access_token: 'x', token_type: 'Bearer' }));
    await expect(refreshIdpIdToken(makeCredentials())).rejects.toThrow(
      /did not return an ID token/
    );
  });

  it('throws when no refresh token is stored', async () => {
    const info = makeCredentials();
    delete info.idpRefreshToken;
    await expect(refreshIdpIdToken(info)).rejects.toThrow(/no idp refresh token/i);
  });
});

describe('createIdJagProvider', () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(proxyModule, 'proxyFetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const PROVIDER_OPTIONS = { serverUrl: 'https://mcp.example.com', profileName: 'default' };

  /**
   * Drive the provider the way the SDK's auth() does: seed the discovered
   * URLs, then ask it to prepare the token request (which invokes the
   * assertion callback — the RFC 8693 exchange at the IdP).
   */
  async function prepareTokenRequest(
    provider: ReturnType<typeof createIdJagProvider>
  ): Promise<URLSearchParams> {
    (
      provider as unknown as { saveAuthorizationServerUrl(url: string): void }
    ).saveAuthorizationServerUrl('https://auth.mcp.example.com');
    (provider as unknown as { saveResourceUrl(url: string): void }).saveResourceUrl(
      'https://mcp.example.com'
    );
    return (
      provider as unknown as { prepareTokenRequest(scope?: string): Promise<URLSearchParams> }
    ).prepareTokenRequest();
  }

  it('exchanges a fresh ID token for an ID-JAG with the exact RFC 8693 wire format', async () => {
    fetchSpy.mockResolvedValue(mockResponse(ID_JAG_RESPONSE));

    const provider = createIdJagProvider(makeCredentials(), PROVIDER_OPTIONS);
    const tokenRequest = await prepareTokenRequest(provider);

    // One fetch: the token exchange at the IdP (no refresh needed).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [URL | string, RequestInit];
    expect(String(url)).toBe('https://idp.example.com/token');
    const params = new URLSearchParams(init.body as string);
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(params.get('requested_token_type')).toBe('urn:ietf:params:oauth:token-type:id-jag');
    expect(params.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:id_token');
    expect(params.get('subject_token')).toBe(makeCredentials().idToken);
    expect(params.get('audience')).toBe('https://auth.mcp.example.com');
    expect(params.get('resource')).toBe('https://mcp.example.com');
    expect(params.get('client_id')).toBe('idp-client');
    expect(params.get('client_secret')).toBe('idp-secret');
    expect(params.get('scope')).toBe('read write');

    // The provider then presents the ID-JAG as a jwt-bearer assertion.
    expect(tokenRequest.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(tokenRequest.get('assertion')).toBe('the-id-jag');
  });

  it('refreshes an expired ID token first and persists the rotated material', async () => {
    const expiredJwt = makeJwt({ sub: 'user-1', exp: NOW_SECS - 10 });
    const freshJwt = makeJwt({ sub: 'user-1', exp: NOW_SECS + 7200 });
    fetchSpy
      .mockResolvedValueOnce(
        mockResponse({ id_token: freshJwt, refresh_token: 'idp-refresh-2', token_type: 'Bearer' })
      )
      .mockResolvedValueOnce(mockResponse(ID_JAG_RESPONSE));

    const onIdTokenRefresh = vi.fn().mockResolvedValue(undefined);
    const provider = createIdJagProvider(
      makeCredentials({ idToken: expiredJwt, idTokenExpiresAt: NOW_SECS - 10 }),
      { ...PROVIDER_OPTIONS, callbacks: { onIdTokenRefresh } }
    );
    await prepareTokenRequest(provider);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const refreshParams = new URLSearchParams(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string
    );
    expect(refreshParams.get('grant_type')).toBe('refresh_token');
    const exchangeParams = new URLSearchParams(
      (fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as string
    );
    expect(exchangeParams.get('subject_token')).toBe(freshJwt);

    expect(onIdTokenRefresh).toHaveBeenCalledTimes(1);
    const updated = onIdTokenRefresh.mock.calls[0]![0] as IdJagCredentials;
    expect(updated.idToken).toBe(freshJwt);
    expect(updated.idpRefreshToken).toBe('idp-refresh-2');
  });

  it('throws a re-auth AuthError when the ID token expired and no refresh token exists', async () => {
    const expiredJwt = makeJwt({ sub: 'user-1', exp: NOW_SECS - 10 });
    const info = makeCredentials({ idToken: expiredJwt, idTokenExpiresAt: NOW_SECS - 10 });
    delete info.idpRefreshToken;

    const provider = createIdJagProvider(info, PROVIDER_OPTIONS);
    await expect(prepareTokenRequest(provider)).rejects.toThrow(AuthError);
    fetchSpy.mockClear();
    await expect(prepareTokenRequest(provider)).rejects.toThrow(
      /re-authenticate with: mcpc login https:\/\/mcp\.example\.com --grant id-jag/
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('prefers reloaded credentials from the keychain over the initial material', async () => {
    const rotatedJwt = makeJwt({ sub: 'user-1', exp: NOW_SECS + 9000 });
    fetchSpy.mockResolvedValue(mockResponse(ID_JAG_RESPONSE));

    const reloadCredentials = vi
      .fn()
      .mockResolvedValue(
        makeCredentials({ idToken: rotatedJwt, idTokenExpiresAt: NOW_SECS + 9000 })
      );
    const provider = createIdJagProvider(makeCredentials(), {
      ...PROVIDER_OPTIONS,
      callbacks: { reloadCredentials },
    });
    await prepareTokenRequest(provider);

    expect(reloadCredentials).toHaveBeenCalledTimes(1);
    const params = new URLSearchParams(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string
    );
    expect(params.get('subject_token')).toBe(rotatedJwt);
  });

  it('wraps IdP token-exchange rejections in an actionable AuthError', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({ error: 'invalid_grant', error_description: 'policy denies access' }, 400)
    );

    const provider = createIdJagProvider(makeCredentials(), PROVIDER_OPTIONS);
    await expect(prepareTokenRequest(provider)).rejects.toThrow(AuthError);
    await expect(prepareTokenRequest(provider)).rejects.toThrow(
      /refused to issue an identity assertion grant.*policy denies access/s
    );
  });

  it('exports the ID-JAG grant profile identifier', () => {
    expect(ID_JAG_GRANT_PROFILE).toBe('urn:ietf:params:oauth:grant-profile:id-jag');
  });
});
