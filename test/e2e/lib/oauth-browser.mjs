// Private launcher shim for this suite. It follows the real authorization and
// callback redirects; it does not replace mcpc's SDK, verifier, or callback server.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname, join } from 'node:path';

try {
  const filename = process.env.MCPC_E2E_BROWSER_REGISTRY;
  assert.ok(filename, 'Missing private browser registry');
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  const target = new URL(process.argv[2]);
  const issuer = `${manifest.serverUrl}/authorization-server`;
  const redirect = `http://127.0.0.1:${manifest.authorizationCode.callbackPort}/callback`;
  assert.equal(target.origin, manifest.serverUrl, 'Browser target escaped the local fixture');
  assert.equal(target.pathname, '/authorization-server/authorize');
  assert.equal(target.searchParams.get('redirect_uri'), redirect);
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(target.searchParams.get('state'), 'The real login must send OAuth state');
  const state = target.searchParams.get('state');
  const mode = manifest.browserMode;
  if (mode === 'bad-pkce') {
    target.searchParams.set(
      'code_challenge',
      createHash('sha256').update(manifest.wrongSecret).digest('base64url')
    );
  }
  if (mode === 'deny') target.searchParams.set('test_decision', 'deny');

  const authorization = await fetch(target, {
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(authorization.status, 302, 'Authorization server rejected the real login request');
  const callback = new URL(authorization.headers.get('location'));
  assert.equal(`${callback.origin}${callback.pathname}`, redirect);
  assert.ok(callback.searchParams.get('state') === state, 'Authorization server changed state');
  assert.ok(callback.searchParams.get('iss') === issuer, 'Unexpected authorization issuer');
  if (mode === 'bad-issuer') callback.searchParams.set('iss', `${issuer}/wrong`);

  // A hostile Host must not complete or close the real callback listener. Send
  // it before the valid callback and require that the valid login still works.
  const rejectedHost = await new Promise((resolve, reject) => {
    const req = request(
      callback,
      { headers: { Host: 'untrusted.invalid' }, timeout: 5000 },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      }
    );
    req.once('timeout', () => req.destroy(new Error('Callback Host check timed out')));
    req.once('error', reject);
    req.end();
  });
  assert.equal(rejectedHost, 403, 'Callback accepted an unexpected Host');
  const result = await fetch(callback, { signal: AbortSignal.timeout(5000) });
  assert.equal(result.status, mode === 'deny' ? 400 : 200);
  await result.text();
  await appendFile(
    join(dirname(filename), 'oauth-browser.log'),
    `${mode}: S256 challenge, state echoed, Host rejected, callback delivered\n`,
    { mode: 0o600 }
  );
} catch {
  // Never print a URL, authorization code, token, or assertion's actual value.
  console.error('Local OAuth browser/callback assertion failed');
  process.exitCode = 1;
}
