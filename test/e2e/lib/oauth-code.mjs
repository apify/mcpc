import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rmdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function initializeAuthorizationCode(manifest, filename) {
  const callbackPort = await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
  manifest.authorizationCode = { callbackPort, codePrefix: randomBytes(24).toString('hex') };
  for (const identity of Object.values(manifest.identities)) {
    identity.refreshPrefix = randomBytes(24).toString('hex');
  }
  manifest.browserBin = join(dirname(filename), 'browser-bin');
  await mkdir(manifest.browserBin, { recursive: true, mode: 0o700 });
  const driver = fileURLToPath(new URL('./oauth-browser.mjs', import.meta.url));
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  const launcher = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(driver)} "$@"\n`;
  for (const name of ['open', 'xdg-open']) {
    await writeFile(join(manifest.browserBin, name), launcher, { mode: 0o700 });
  }
}

export async function runAuthorizationCode(manifest, serverUrl, harness) {
  const {
    filename,
    keychain,
    save,
    inHome,
    command,
    verifyBackend,
    assertAbsent,
    removeProfiles,
    cleanup,
    scanFiles,
    bridgeArgs,
  } = harness;
  const origin = new URL(serverUrl);
  assert.equal(origin.protocol, 'http:');
  assert.equal(origin.hostname, 'localhost');
  assert.ok(origin.port, 'The fixture must use a dedicated local port');
  manifest.serverUrl = origin.origin;
  const issuer = `${origin.origin}/authorization-server`;
  const resource = (identity) => `${origin.origin}/identity/${identity}`;
  // Register all keys before DCR or login can write anything. Profile metadata
  // is deliberately absent in several failure cases and cannot drive cleanup.
  manifest.profiles = Object.fromEntries(
    ['alpha', 'beta', 'bad-pkce', 'bad-issuer', 'denied', 'partial', 'sentinel'].map((name) => [
      name,
      {
        name: `${manifest.prefix}-${name}`,
        url: resource(name === 'beta' ? 'beta' : 'alpha'),
        home: ['partial', 'sentinel'].includes(name) ? manifest.partialHome : manifest.home,
      },
    ])
  );
  await save(manifest);
  manifest.usesKeychain = await keychain.isKeychainAvailable();
  await save(manifest);
  console.log(`# Credential backend: ${manifest.usesKeychain ? 'OS keychain' : 'file fallback'}`);
  const { profiles, sessions, identities } = manifest;

  async function request(path, options) {
    const response = await fetch(`${origin.origin}${path}`, {
      ...options,
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.json() };
  }
  async function stats() {
    const response = await request('/oauth-test/stats');
    assert.equal(response.status, 200);
    return response.body;
  }
  async function control(action, identity) {
    assert.equal(
      (await request(`/oauth-test/${action}/${identity}`, { method: 'POST' })).status,
      200
    );
  }
  async function tokens(profile) {
    return inHome(profile.home, () =>
      keychain.readKeychainOAuthTokenInfo(profile.url, profile.name)
    );
  }
  async function client(profile) {
    return inHome(profile.home, () =>
      keychain.readKeychainOAuthClientInfo(profile.url, profile.name)
    );
  }
  async function login(profile, mode = 'normal') {
    manifest.browserMode = mode;
    await save(manifest);
    return command(
      manifest,
      [
        'login',
        profile.url,
        '--profile',
        profile.name,
        '--scope',
        'mcp:tools',
        '--callback-port',
        String(manifest.authorizationCode.callbackPort),
      ],
      profile.home,
      {
        env: {
          PATH: `${manifest.browserBin}${delimiter}${process.env.PATH}`,
          MCPC_E2E_BROWSER_REGISTRY: filename,
        },
      }
    );
  }
  async function success(args) {
    const result = await command(manifest, args);
    assert.equal(result.code, 0, `Command failed: ${args.join(' ')}; see oauth-commands.log`);
    return result;
  }
  async function call(identity, message) {
    const result = await success([sessions[identity], 'tools-call', 'echo', `message:=${message}`]);
    assert.ok(result.stdout.includes(message), 'Expected the actual MCP tool response');
  }
  async function refreshRequest(token, clientId, target) {
    return request('/authorization-server/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token,
        client_id: clientId,
        resource: target,
      }),
    });
  }
  async function sentinelSurvives() {
    assert.ok(
      (await client(profiles.sentinel))?.clientSecret === manifest.sentinelSecret,
      'Targeted cleanup removed an unrelated test-owned credential'
    );
  }

  try {
    await inHome(manifest.partialHome, () =>
      keychain.storeKeychainOAuthClientInfo(profiles.sentinel.url, profiles.sentinel.name, {
        clientId: 'test-owned-oauth-sentinel',
        clientSecret: manifest.sentinelSecret,
      })
    );
    assert.equal((await request('/identity/alpha', { method: 'POST' })).status, 401);
    assert.equal(
      (
        await request('/identity/alpha', {
          method: 'POST',
          headers: { Authorization: 'Bearer unissued-token' },
        })
      ).status,
      401
    );

    let before = await stats();
    assert.notEqual((await login(profiles['bad-pkce'], 'bad-pkce')).code, 0);
    let after = await stats();
    assert.equal(after.invalidPkce, before.invalidPkce + 1);
    assert.equal(after.identities.alpha.codeExchanges, before.identities.alpha.codeExchanges);
    assert.ok(await client(profiles['bad-pkce']), 'Failed exchange must follow actual DCR');
    assert.ok(!(await tokens(profiles['bad-pkce'])), 'Failed PKCE exchange stored tokens');

    before = await stats();
    assert.notEqual((await login(profiles['bad-issuer'], 'bad-issuer')).code, 0);
    after = await stats();
    assert.equal(after.authorizations, before.authorizations + 1);
    assert.equal(after.tokenRequests, before.tokenRequests, 'Wrong issuer reached token exchange');
    assert.ok(!(await tokens(profiles['bad-issuer'])));

    before = await stats();
    assert.notEqual((await login(profiles.denied, 'deny')).code, 0);
    assert.equal((await stats()).tokenRequests, before.tokenRequests);
    assert.ok(
      await client(profiles.denied),
      'Denied authorization must leave its registered client'
    );
    assert.ok(!(await tokens(profiles.denied)));
    // Logout has no metadata to find. Independently detect and remove only the
    // registered keys, proving a failed login cannot escape test teardown.
    await assert.rejects(() => assertAbsent(profiles.denied), /credential remains/);
    await removeProfiles([profiles['bad-pkce'], profiles['bad-issuer'], profiles.denied]);
    await sentinelSurvives();
    console.log(
      '# Passed: real PKCE and issuer rejection, DCR cancellation and exact orphan cleanup'
    );

    for (const identity of ['alpha', 'beta']) {
      assert.equal((await login(profiles[identity])).code, 0, 'Interactive login failed');
      const stored = await tokens(profiles[identity]);
      assert.ok(stored?.accessToken === `${identities[identity].tokenPrefix}-1`);
      assert.ok(stored?.refreshToken === `${identities[identity].refreshPrefix}-1`);
      assert.equal((await stats()).identities[identity].codeExchanges, 1);
    }
    const alphaClient = await client(profiles.alpha);
    const betaClient = await client(profiles.beta);
    assert.notEqual(alphaClient.clientId, betaClient.clientId);
    const metadata = JSON.parse(await readFile(join(manifest.home, 'profiles.json'), 'utf8'));
    for (const identity of ['alpha', 'beta']) {
      const profile = metadata.profiles[origin.host][profiles[identity].name];
      assert.equal(profile.oauthIssuer, issuer);
      assert.equal(profile.oauthResource, resource(identity));
      assert.equal(profile.serverUrl, resource(identity));
    }
    // The AS refuses omitted state rather than accepting any authorization
    // request. mcpc itself intentionally relies on PKCE for CSRF protection;
    // this suite verifies state is sent/echoed, not a nonexistent callback check.
    const authorization = new URLSearchParams({
      client_id: alphaClient.clientId,
      redirect_uri: `http://127.0.0.1:${manifest.authorizationCode.callbackPort}/callback`,
      response_type: 'code',
      resource: resource('alpha'),
      scope: 'mcp:tools',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(manifest.wrongSecret).digest('base64url'),
    });
    assert.equal(
      (await request(`/authorization-server/authorize?${authorization.toString()}`)).status,
      400
    );
    assert.equal(
      (
        await request('/identity/beta', {
          method: 'POST',
          headers: { Authorization: `Bearer ${identities.alpha.tokenPrefix}-1` },
        })
      ).status,
      403
    );
    for (const identity of ['alpha', 'beta']) {
      await success([
        'connect',
        resource(identity),
        sessions[identity],
        '--profile',
        profiles[identity].name,
      ]);
      await success([sessions[identity], 'tools-list']);
      await call(identity, `code-${identity}`);
    }
    const records = JSON.parse(
      await readFile(join(manifest.home, 'sessions.json'), 'utf8')
    ).sessions;
    for (const identity of ['alpha', 'beta']) {
      assert.equal(records[sessions[identity]].profileName, profiles[identity].name);
      await bridgeArgs(manifest, records[sessions[identity]].pid);
    }
    assert.equal(
      (
        await command(manifest, [
          'connect',
          resource('beta'),
          sessions.cross,
          '--profile',
          profiles.alpha.name,
        ])
      ).code,
      4
    );
    assert.equal(
      (await command(manifest, ['connect', resource('alpha'), sessions.anonymous, '--no-profile']))
        .code,
      4
    );
    console.log(
      '# Passed: DCR, real browser/callback exchange and two isolated authenticated sessions'
    );

    before = await stats();
    const initial = await tokens(profiles.alpha);
    await control('revoke-access', 'alpha');
    await call('alpha', 'rotated-alpha');
    after = await stats();
    assert.equal(
      after.identities.alpha.refreshRequests,
      before.identities.alpha.refreshRequests + 1
    );
    assert.equal(after.identities.alpha.issued, before.identities.alpha.issued + 1);
    assert.equal(after.identities.beta.issued, before.identities.beta.issued);
    const rotated = await tokens(profiles.alpha);
    assert.ok(rotated?.refreshToken !== initial.refreshToken, 'Refresh token did not rotate');
    assert.ok(rotated?.accessToken === `${identities.alpha.tokenPrefix}-2`);
    assert.ok(rotated?.refreshToken === `${identities.alpha.refreshPrefix}-2`);
    assert.equal(
      (await refreshRequest(initial.refreshToken, alphaClient.clientId, resource('alpha'))).status,
      400,
      'A rotated refresh token could be replayed'
    );
    assert.equal(
      (await refreshRequest(rotated.refreshToken, alphaClient.clientId, resource('beta'))).status,
      400,
      'Refresh accepted the wrong resource'
    );
    await success([sessions.alpha, 'restart']);
    before = await stats();
    await control('revoke-access', 'alpha');
    await call('alpha', 'rotated-after-restart');
    after = await stats();
    assert.equal(
      after.identities.alpha.refreshRequests,
      before.identities.alpha.refreshRequests + 1
    );
    assert.ok(
      (await tokens(profiles.alpha))?.refreshToken === `${identities.alpha.refreshPrefix}-3`
    );
    await call('beta', 'beta-unaffected-by-rotation');
    console.log(
      '# Passed: bounded refresh rotation persists and works after an actual bridge restart'
    );

    // Start a fresh manager before the rejection case. A manager that just
    // refreshed deliberately deduplicates forced refreshes for five seconds;
    // restarting avoids sleeps and makes this case exercise invalid_grant itself.
    await success([sessions.alpha, 'restart']);
    await control('revoke-refresh', 'alpha');
    await control('revoke-access', 'alpha');
    before = await stats();
    const rejected = await command(manifest, [
      sessions.alpha,
      'tools-call',
      'echo',
      'message:=denied',
    ]);
    assert.notEqual(rejected.code, 0);
    assert.match(JSON.parse(rejected.stderr).error, /refresh|invalid_grant|401/i);
    after = await stats();
    assert.equal(
      after.identities.alpha.refreshRequests,
      before.identities.alpha.refreshRequests + 1
    );
    assert.equal(after.identities.alpha.issued, before.identities.alpha.issued);
    await call('beta', 'beta-after-alpha-refresh-rejection');
    assert.equal((await login(profiles.alpha)).code, 0);
    await success([sessions.alpha, 'restart']);
    await call('alpha', 'reauthorized-alpha');
    console.log(
      '# Passed: unusable refresh is bounded, preserves beta, and recovers through real login'
    );

    await success([sessions.alpha, 'close']);
    await success(['logout', resource('alpha'), '--profile', profiles.alpha.name]);
    await assertAbsent(profiles.alpha);
    assert.notEqual(
      (
        await command(manifest, [
          'connect',
          resource('alpha'),
          sessions.alpha,
          '--profile',
          profiles.alpha.name,
        ])
      ).code,
      0
    );
    await success([sessions.beta, 'restart']);
    await call('beta', 'beta-after-alpha-logout');
    await success([sessions.beta, 'close']);
    await success(['logout', resource('beta'), '--profile', profiles.beta.name]);
    await assertAbsent(profiles.beta);

    await mkdir(join(manifest.partialHome, 'profiles.json'), { recursive: true, mode: 0o700 });
    assert.notEqual((await login(profiles.partial)).code, 0);
    assert.ok(
      await client(profiles.partial),
      'Partial login did not persist its registered client'
    );
    assert.ok(
      await tokens(profiles.partial),
      'Partial login did not reach the token credential write'
    );
    assert.ok((await stat(join(manifest.partialHome, 'profiles.json'))).isDirectory());
    await rmdir(join(manifest.partialHome, 'profiles.json'));
    await assert.rejects(() => assertAbsent(profiles.partial), /credential remains/);
    await removeProfiles([profiles.partial]);
    await sentinelSurvives();
    await verifyBackend(manifest);
    const browserEvidence = await readFile(join(dirname(filename), 'oauth-browser.log'), 'utf8');
    for (const mode of ['normal', 'bad-pkce', 'bad-issuer', 'deny']) {
      assert.ok(browserEvidence.includes(`${mode}: S256 challenge, state echoed, Host rejected`));
    }
    await scanFiles(manifest, manifest.home);
    await scanFiles(manifest, dirname(dirname(filename)));
    console.log(
      '# Passed: logout, post-token metadata failure, exact cleanup and secret-free artifacts'
    );
  } finally {
    await cleanup(manifest);
  }
}
