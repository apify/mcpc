/** Local authorization server: real code/PKCE exchange and single-use refresh tokens. */
import { createHash } from 'node:crypto';
import type http from 'node:http';

interface CodeIdentity {
  tokenPrefix: string;
  refreshPrefix?: string;
}

interface Grant {
  identity: string;
  clientId: string;
  resource: string;
}

interface AuthorizationCode extends Grant {
  redirectUri: string;
  challenge: string;
}

export interface AuthorizationCodeOptions {
  callbackPort: number;
  codePrefix: string;
}

export function createAuthorizationCodeFixture(
  identities: Record<string, CodeIdentity>,
  options: AuthorizationCodeOptions,
  port: number
) {
  for (const identity of Object.values(identities)) {
    if (!identity.refreshPrefix) throw new Error('Missing local refresh-token prefix');
  }
  const origin = `http://localhost:${port}`;
  const issuer = `${origin}/authorization-server`;
  const redirectUri = `http://127.0.0.1:${options.callbackPort}/callback`;
  const clients = new Set<string>();
  const codes = new Map<string, AuthorizationCode>();
  const accessTokens = new Map<string, Grant>();
  const refreshTokens = new Map<string, Grant>();
  const state = Object.fromEntries(
    Object.keys(identities).map((identity) => [
      identity,
      { issued: 0, codeExchanges: 0, refreshRequests: 0, accepted: 0, rejected: 0 },
    ])
  );
  const counters = {
    registrations: 0,
    authorizations: 0,
    tokenRequests: 0,
    invalidAuthorization: 0,
    invalidGrant: 0,
    invalidPkce: 0,
    invalidResource: 0,
  };

  function json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function body(req: http.IncomingMessage): Promise<string> {
    let result = '';
    for await (const chunk of req) {
      result += String(chunk);
      if (result.length > 16384) throw new Error('Oversized local OAuth request');
    }
    return result;
  }

  function issue(res: http.ServerResponse, grant: Grant) {
    const identity = identities[grant.identity]!;
    const generation = ++state[grant.identity]!.issued;
    const accessToken = `${identity.tokenPrefix}-${generation}`;
    const refreshToken = `${identity.refreshPrefix}-${generation}`;
    accessTokens.set(accessToken, grant);
    refreshTokens.set(refreshToken, grant);
    json(res, 200, {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'mcp:tools',
    });
  }

  return async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<boolean> {
    // Entry points also bind to loopback. Controls are never reachable through a
    // developer-selected remote host, proxy, or public interface.
    if (req.headers.host !== `localhost:${port}`) {
      json(res, 403, { error: 'Unexpected host' });
      return true;
    }

    const metadata = /^\/\.well-known\/oauth-protected-resource\/identity\/(alpha|beta)$/.exec(
      url.pathname
    );
    if (metadata && req.method === 'GET') {
      json(res, 200, {
        resource: `${origin}/identity/${metadata[1]}`,
        authorization_servers: [issuer],
        scopes_supported: ['mcp:tools'],
      });
      return true;
    }
    if (
      req.method === 'GET' &&
      [
        '/.well-known/oauth-authorization-server/authorization-server',
        '/authorization-server/.well-known/oauth-authorization-server',
      ].includes(url.pathname)
    ) {
      json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['mcp:tools'],
        authorization_response_iss_parameter_supported: true,
      });
      return true;
    }
    if (url.pathname === '/authorization-server/register' && req.method === 'POST') {
      const registration = JSON.parse(await body(req)) as Record<string, unknown>;
      if (
        !Array.isArray(registration.redirect_uris) ||
        registration.redirect_uris.length !== 1 ||
        registration.redirect_uris[0] !== redirectUri ||
        registration.token_endpoint_auth_method !== 'none'
      ) {
        json(res, 400, { error: 'invalid_client_metadata' });
        return true;
      }
      const clientId = `local-code-client-${++counters.registrations}`;
      clients.add(clientId);
      json(res, 201, { ...registration, client_id: clientId });
      return true;
    }
    if (url.pathname === '/authorization-server/authorize' && req.method === 'GET') {
      const params = url.searchParams;
      const resource = params.get('resource') ?? '';
      const identity = /^\/identity\/(alpha|beta)$/.exec(new URL(resource, origin).pathname)?.[1];
      const clientId = params.get('client_id') ?? '';
      const challenge = params.get('code_challenge') ?? '';
      if (
        !clients.has(clientId) ||
        !identity ||
        resource !== `${origin}/identity/${identity}` ||
        params.get('redirect_uri') !== redirectUri ||
        params.get('response_type') !== 'code' ||
        params.get('scope') !== 'mcp:tools' ||
        !params.get('state') ||
        params.get('code_challenge_method') !== 'S256' ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge)
      ) {
        counters.invalidAuthorization++;
        json(res, 400, { error: 'invalid_request' });
        return true;
      }
      const callback = new URL(redirectUri);
      callback.searchParams.set('state', params.get('state')!);
      callback.searchParams.set('iss', issuer);
      if (params.get('test_decision') === 'deny') {
        callback.searchParams.set('error', 'access_denied');
      } else {
        const code = `${options.codePrefix}-${++counters.authorizations}`;
        codes.set(code, { identity, clientId, resource, redirectUri, challenge });
        callback.searchParams.set('code', code);
      }
      res.writeHead(302, { Location: callback.toString(), 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    if (url.pathname === '/authorization-server/token' && req.method === 'POST') {
      counters.tokenRequests++;
      const params = new URLSearchParams(await body(req));
      const grantType = params.get('grant_type');
      if (grantType === 'authorization_code') {
        const code = params.get('code') ?? '';
        const grant = codes.get(code);
        // A code can be presented once, including a failed redemption attempt.
        codes.delete(code);
        if (
          !grant ||
          params.get('client_id') !== grant.clientId ||
          params.get('redirect_uri') !== grant.redirectUri
        ) {
          counters.invalidGrant++;
          json(res, 400, { error: 'invalid_grant' });
        } else if (params.get('resource') !== grant.resource) {
          counters.invalidResource++;
          json(res, 400, { error: 'invalid_target' });
        } else if (
          !/^[A-Za-z0-9._~-]{43,128}$/.test(params.get('code_verifier') ?? '') ||
          createHash('sha256').update(params.get('code_verifier')!).digest('base64url') !==
            grant.challenge
        ) {
          counters.invalidPkce++;
          json(res, 400, { error: 'invalid_grant' });
        } else {
          state[grant.identity]!.codeExchanges++;
          issue(res, grant);
        }
      } else if (grantType === 'refresh_token') {
        const token = params.get('refresh_token') ?? '';
        const grant = refreshTokens.get(token);
        // Count attempted refreshes by their generated identity prefix even
        // after revocation, so a retry loop cannot masquerade as one attempt.
        const owner = Object.entries(identities).find(([, identity]) =>
          token.startsWith(`${identity.refreshPrefix}-`)
        )?.[0];
        if (owner) state[owner]!.refreshRequests++;
        if (!grant || params.get('client_id') !== grant.clientId) {
          counters.invalidGrant++;
          json(res, 400, { error: 'invalid_grant' });
        } else if (params.get('resource') !== grant.resource) {
          counters.invalidResource++;
          json(res, 400, { error: 'invalid_target' });
        } else {
          refreshTokens.delete(token);
          issue(res, grant);
        }
      } else {
        json(res, 400, { error: 'unsupported_grant_type' });
      }
      return true;
    }
    if (url.pathname === '/oauth-test/stats' && req.method === 'GET') {
      json(res, 200, { ...counters, identities: state });
      return true;
    }
    const control = /^\/oauth-test\/(revoke-access|revoke-refresh)\/(alpha|beta)$/.exec(
      url.pathname
    );
    if (control && req.method === 'POST') {
      const identity = control[2]!;
      const store = control[1] === 'revoke-refresh' ? refreshTokens : accessTokens;
      for (const [token, grant] of store) if (grant.identity === identity) store.delete(token);
      json(res, 200, { ok: true });
      return true;
    }
    const resource = /^\/identity\/(alpha|beta)$/.exec(url.pathname);
    if (resource) {
      const identity = resource[1]!;
      const authorization = req.headers.authorization ?? '';
      const grant = authorization.startsWith('Bearer ')
        ? accessTokens.get(authorization.slice(7))
        : undefined;
      if (!grant) {
        state[identity]!.rejected++;
        res.setHeader(
          'WWW-Authenticate',
          `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/identity/${identity}"`
        );
        json(res, 401, { error: 'invalid_token' });
        return true;
      }
      if (grant.identity !== identity || grant.resource !== `${origin}/identity/${identity}`) {
        state[identity]!.rejected++;
        json(res, 403, { error: 'Identity does not own this resource' });
        return true;
      }
      state[identity]!.accepted++;
      // Authentication is checked here; the selected era's real SDK serves MCP.
      url.pathname = '/mcp';
      req.url = '/mcp';
      return false;
    }
    if (url.pathname === '/' || url.pathname === '/mcp') {
      json(res, 401, { error: 'Use an authenticated identity resource' });
      return true;
    }
    return false;
  };
}
