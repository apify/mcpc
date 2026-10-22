/** Strict, opt-in client-credentials fixture shared by both MCP protocol eras. */
import { readFileSync } from 'node:fs';
import type http from 'node:http';

interface Identity {
  clientId: string;
  clientSecret: string;
  tokenPrefix: string;
}

export function createLocalOAuthFixture(filename: string | undefined, port: number) {
  if (!filename) return undefined;
  const { identities } = JSON.parse(readFileSync(filename, 'utf8')) as {
    identities: Record<string, Identity>;
  };
  const origin = `http://localhost:${port}`;
  const state = Object.fromEntries(
    Object.keys(identities).map((name) => [
      name,
      {
        issued: 0,
        accepted: 0,
        rejected: 0,
        tokenRequests: 0,
        deny: false,
        hold: false,
        pending: 0,
      },
    ])
  );
  const tokens = new Map<string, string>();
  const heldResponses = new Map<string, Set<() => void>>();
  let invalidClients = 0;

  function json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  return async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<boolean> {
    // This fixture contains local-only controls. Reject unexpected Host values as
    // well as binding the listener to loopback in the server entry points.
    if (req.headers.host !== `localhost:${port}`) {
      json(res, 403, { error: 'Unexpected host' });
      return true;
    }

    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      const resourcePath = url.pathname.slice('/.well-known/oauth-protected-resource'.length);
      if (req.method === 'GET' && /^\/identity\/(alpha|beta)$/.test(resourcePath)) {
        json(res, 200, {
          resource: `${origin}${resourcePath}`,
          authorization_servers: [origin],
          scopes_supported: ['mcp:tools'],
        });
      } else {
        json(res, 404, { error: 'Unknown resource' });
      }
      return true;
    }

    if (url.pathname === '/.well-known/oauth-authorization-server') {
      json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['client_credentials'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
      return true;
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const params = new URLSearchParams(body);
      if (params.get('grant_type') !== 'client_credentials') {
        json(res, 400, { error: 'unsupported_grant_type' });
        return true;
      }
      let clientId = '';
      let clientSecret = '';
      try {
        const auth = req.headers.authorization ?? '';
        if (auth.startsWith('Basic ')) {
          const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
          const separator = decoded.indexOf(':');
          if (separator >= 0) {
            clientId = decodeURIComponent(decoded.slice(0, separator));
            clientSecret = decodeURIComponent(decoded.slice(separator + 1));
          }
        }
      } catch {
        // Malformed Basic credentials are an invalid client, never a bypass.
      }
      const entry = Object.entries(identities).find(([, id]) => id.clientId === clientId);
      if (entry) state[entry[0]]!.tokenRequests++;
      if (!entry || entry[1].clientSecret !== clientSecret) {
        invalidClients++;
        json(res, 401, { error: 'invalid_client' });
        return true;
      }
      const [name, identity] = entry;
      if (state[name]!.hold) {
        const waiting = heldResponses.get(name) ?? new Set<() => void>();
        heldResponses.set(name, waiting);
        state[name]!.pending++;
        const connected = await new Promise<boolean>((resolve) => {
          const release = () => finish(true);
          const disconnected = () => finish(false);
          const finish = (value: boolean) => {
            waiting.delete(release);
            res.off('close', disconnected);
            resolve(value);
          };
          waiting.add(release);
          res.once('close', disconnected);
        });
        state[name]!.pending--;
        if (!connected) return true;
      }
      const generation = ++state[name]!.issued;
      const token = `${identity.tokenPrefix}-${generation}`;
      tokens.set(token, name);
      json(res, 200, {
        access_token: token,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'mcp:tools',
      });
      return true;
    }

    if (url.pathname === '/oauth-test/stats' && req.method === 'GET') {
      json(res, 200, { identities: state, invalidClients });
      return true;
    }
    const control = /^\/oauth-test\/(revoke|reject|allow|hold|release)\/(alpha|beta)$/.exec(
      url.pathname
    );
    if (control && req.method === 'POST') {
      const action = control[1]!;
      const name = control[2]!;
      if (action === 'revoke') {
        for (const [token, owner] of tokens) if (owner === name) tokens.delete(token);
      } else if (action === 'hold' || action === 'release') {
        state[name]!.hold = action === 'hold';
        if (action === 'release') for (const release of heldResponses.get(name) ?? []) release();
      } else {
        state[name]!.deny = action === 'reject';
      }
      json(res, 200, { ok: true });
      return true;
    }

    const resource = /^\/identity\/(alpha|beta)$/.exec(url.pathname);
    if (resource) {
      const name = resource[1]!;
      const owner = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!owner || state[name]!.deny) {
        state[name]!.rejected++;
        res.setHeader(
          'WWW-Authenticate',
          `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/identity/${name}"`
        );
        json(res, 401, { error: 'invalid_token' });
        return true;
      }
      if (owner !== name || !req.headers.authorization?.startsWith('Bearer ')) {
        state[name]!.rejected++;
        json(res, 403, { error: 'Identity does not own this resource' });
        return true;
      }
      state[name]!.accepted++;
      // The real MCP SDK still handles the authenticated request. Only route
      // selection changes; tokens and identity are never passed to tool handlers.
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
