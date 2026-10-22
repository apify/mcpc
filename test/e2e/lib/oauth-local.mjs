// Use the same runtime as the CLI: macOS keychain ACLs are per executable.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as keychain from '../../../dist/lib/auth/keychain.js';
import { initializeAuthorizationCode, runAuthorizationCode } from './oauth-code.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../../dist/cli/index.js', import.meta.url));
const [action, filenameArg, argument] = process.argv.slice(2);
const filename = resolve(filenameArg);
const profileKinds = ['OAuthClientInfo', 'OAuthTokenInfo', 'ClientCredentials', 'IdJagCredentials'];
const sessionKinds = ['SessionHeaders', 'SessionEnv', 'ProxyBearerToken'];
let activeChild;
let interrupted = 0;
let cleaning = false;
let cleanupFailed = false;
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.on(signal, () => {
    interrupted = code;
    if (!activeChild) return;
    const child = activeChild;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  });
}

async function save(manifest) {
  await writeFile(filename, JSON.stringify(manifest), { mode: 0o600 });
}

async function inHome(home, operation) {
  const previous = process.env.MCPC_HOME_DIR;
  process.env.MCPC_HOME_DIR = home;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.MCPC_HOME_DIR;
    else process.env.MCPC_HOME_DIR = previous;
  }
}

function secrets(manifest) {
  return [
    manifest.wrongSecret,
    manifest.sentinelSecret,
    manifest.authorizationCode?.codePrefix,
    ...Object.values(manifest.identities).flatMap((id) => [
      id.clientSecret,
      id.tokenPrefix,
      id.refreshPrefix,
    ]),
  ].filter(Boolean);
}

function assertNoSecrets(manifest, text, description) {
  assert.ok(
    !secrets(manifest).some((secret) => text.includes(secret)),
    `${description} leaked a fixture secret`
  );
}

async function command(manifest, args, home = manifest.home, options = {}) {
  if (interrupted && !cleaning) throw new Error('Local OAuth test interrupted');
  let result;
  const pending = exec(process.execPath, [cli, '--json', ...args], {
    env: { ...process.env, ...options.env, MCPC_HOME_DIR: home },
    timeout: 20000,
    killSignal: 'SIGKILL',
    maxBuffer: 2 * 1024 * 1024,
  });
  activeChild = pending.child;
  try {
    result = {
      ...(await pending),
      code: 0,
    };
  } catch (error) {
    // Timeouts/signals are failures, not acceptable authentication rejections.
    if (typeof error.code !== 'number')
      throw new Error('mcpc command did not finish within its bound');
    result = { stdout: error.stdout, stderr: error.stderr, code: error.code };
  } finally {
    // execFile resolves/rejects only after the child's exit and stdio closure.
    // Cleanup must never race a still-running login writing credential material.
    activeChild = undefined;
  }
  if (interrupted && !cleaning) throw new Error('Local OAuth test interrupted');
  assertNoSecrets(manifest, result.stdout + result.stderr, 'CLI output');
  const safeArgs = args.map((arg) => (secrets(manifest).includes(arg) ? '<redacted>' : arg));
  await appendFile(
    join(dirname(filename), 'oauth-commands.log'),
    `${JSON.stringify(safeArgs)}\nexit=${result.code}\n${result.stdout}${result.stderr}\n`
  );
  return result;
}

async function readCredential(profile) {
  return inHome(profile.home, () =>
    keychain.readKeychainClientCredentials(profile.url, profile.name)
  );
}

async function loginCredentials(
  manifest,
  identity,
  profile,
  secret = manifest.identities[identity].clientSecret
) {
  return command(
    manifest,
    [
      'login',
      profile.url,
      '--grant',
      'client-credentials',
      '--client-id',
      manifest.identities[identity].clientId,
      '--client-secret',
      secret,
      '--scope',
      'mcp:tools',
      '--profile',
      profile.name,
    ],
    profile.home
  );
}

async function verifyBackend(manifest) {
  if (manifest.usesKeychain === undefined) return; // No credential writes yet.
  assert.equal(
    await keychain.isKeychainAvailable(),
    manifest.usesKeychain,
    'Credential backend changed; retain the registry and retry cleanup with the original backend'
  );
  if (!manifest.usesKeychain) return;
  for (const home of new Set(Object.values(manifest.profiles).map((profile) => profile.home))) {
    try {
      assertNoSecrets(
        manifest,
        await readFile(join(home, 'credentials.json'), 'utf8'),
        'Unexpected fallback store while using the OS keychain'
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function assertAbsent(profile) {
  await inHome(profile.home, async () => {
    for (const kind of profileKinds) {
      assert.ok(
        (await keychain[`readKeychain${kind}`](profile.url, profile.name)) === undefined,
        `Test-owned ${kind} credential remains after cleanup (${profile.name})`
      );
    }
  });
}

async function removeProfiles(profiles) {
  const failures = [];
  for (const profile of profiles) {
    await inHome(profile.home, async () => {
      for (const kind of profileKinds) {
        try {
          await keychain[`removeKeychain${kind}`](profile.url, profile.name);
        } catch {
          failures.push(`${profile.name}/${kind}`);
        }
      }
    });
    try {
      await assertAbsent(profile);
    } catch {
      failures.push(`${profile.name}/verification`);
    }
  }
  assert.equal(failures.length, 0, `Exact credential cleanup failed: ${failures.join(', ')}`);
}

async function cleanup(manifest) {
  cleaning = true;
  try {
    await cleanupRegistered(manifest);
  } catch (error) {
    cleanupFailed = true;
    throw error;
  } finally {
    cleaning = false;
  }
}

async function cleanupRegistered(manifest) {
  if (!manifest.serverUrl) return; // Registration happens before any credential write.
  const failures = [];
  for (const session of Object.values(manifest.sessions)) {
    try {
      const result = await command(manifest, [session, 'close']);
      assert.ok(
        result.code === 0 ||
          (result.code === 1 &&
            JSON.parse(result.stderr).error === `Session not found: ${session}`),
        'A test-owned session could not be closed'
      );
    } catch {
      failures.push(`${session}/close`);
    }
  }
  await verifyBackend(manifest);
  try {
    await removeProfiles(Object.values(manifest.profiles));
  } catch {
    failures.push('profiles');
  }
  for (const session of Object.values(manifest.sessions)) {
    await inHome(manifest.home, async () => {
      for (const kind of sessionKinds) {
        try {
          await keychain[`removeKeychain${kind}`](session);
          assert.ok((await keychain[`readKeychain${kind}`](session)) === undefined);
        } catch {
          failures.push(`${session}/${kind}`);
        }
      }
    });
  }
  assert.equal(failures.length, 0, `Cleanup/verification failed: ${failures.join(', ')}`);
}

async function scanFiles(manifest, directory) {
  const excluded = [
    filename,
    ...new Set(
      Object.values(manifest.profiles).map((profile) => join(profile.home, 'credentials.json'))
    ),
  ]; // The legitimate fallback credential store.
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (excluded.includes(path)) continue;
    if (entry.isDirectory()) await scanFiles(manifest, path);
    else if (entry.isFile()) assertNoSecrets(manifest, await readFile(path, 'utf8'), path);
  }
}

async function bridgeArgs(manifest, pid) {
  assert.ok(Number.isInteger(pid) && pid > 0, 'Expected a live bridge PID');
  const { stdout } =
    process.platform === 'win32'
      ? await exec(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
          ],
          { timeout: 5000, killSignal: 'SIGKILL' }
        )
      : await exec('ps', ['-p', String(pid), '-o', 'args='], {
          timeout: 5000,
          killSignal: 'SIGKILL',
        });
  assert.ok(stdout.trim(), 'Could not inspect bridge arguments');
  assertNoSecrets(manifest, stdout, 'Bridge arguments');
}

async function run(manifest) {
  const origin = new URL(argument);
  assert.equal(origin.protocol, 'http:');
  assert.equal(origin.hostname, 'localhost');
  assert.ok(origin.port, 'The fixture must have an explicit local port');
  manifest.serverUrl = origin.origin;
  const url = (identity) => `${origin.origin}/identity/${identity}`;
  // Persist every exact identity before login can store a keychain item. The EXIT
  // trap can use this registry even if this process is interrupted or fails.
  manifest.profiles = Object.fromEntries(
    ['alpha', 'beta', 'bad', 'partial', 'sentinel', 'interrupted'].map((name) => [
      name,
      {
        name: `${manifest.prefix}-${name}`,
        url: url(name === 'beta' ? 'beta' : 'alpha'),
        home: ['partial', 'sentinel'].includes(name) ? manifest.partialHome : manifest.home,
      },
    ])
  );
  await save(manifest);
  const { profiles, sessions, identities } = manifest;
  manifest.usesKeychain = await keychain.isKeychainAvailable();
  await save(manifest);
  const backend = manifest.usesKeychain ? 'OS keychain' : 'file fallback';
  console.log(`# Credential backend: ${backend}`);

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
  async function login(identity, profile, secret = identities[identity].clientSecret) {
    return loginCredentials(manifest, identity, profile, secret);
  }
  async function success(args) {
    const result = await command(manifest, args);
    assert.equal(result.code, 0, `Command failed: ${args.join(' ')}; see oauth-commands.log`);
    return result;
  }
  async function call(identity, message) {
    const result = await success([sessions[identity], 'tools-call', 'echo', `message:=${message}`]);
    assert.ok(result.stdout.includes(message), 'Expected the real MCP tool response');
  }
  async function sessionRecords() {
    return JSON.parse(await readFile(join(manifest.home, 'sessions.json'), 'utf8')).sessions;
  }

  try {
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
    assert.equal((await login('alpha', profiles.bad, manifest.wrongSecret)).code, 4);
    await assertAbsent(profiles.bad);
    assert.equal((await stats()).invalidClients, 1);
    console.log(
      '# Passed: missing/unissued bearer tokens and wrong client credentials are refused'
    );

    for (const identity of ['alpha', 'beta']) {
      assert.equal((await login(identity, profiles[identity])).code, 0);
      const stored = await readCredential(profiles[identity]);
      assert.ok(
        stored?.clientId === identities[identity].clientId &&
          stored?.clientSecret === identities[identity].clientSecret,
        'Profile stored another identity'
      );
      assert.equal((await stats()).identities[identity].issued, 1);
    }
    const metadata = JSON.parse(await readFile(join(manifest.home, 'profiles.json'), 'utf8'));
    for (const identity of ['alpha', 'beta']) {
      const profile = metadata.profiles[origin.host][profiles[identity].name];
      assert.equal(profile.oauthGrant, 'client_credentials');
      assert.equal(profile.oauthIssuer, origin.origin);
      assert.equal(profile.serverUrl, url(identity));
    }
    // An issued alpha token must not authorize beta, even though both are served
    // by the same host and the same authorization server.
    assert.equal(
      (
        await request('/identity/beta', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${identities.alpha.tokenPrefix}-1`,
          },
        })
      ).status,
      403
    );
    for (const identity of ['alpha', 'beta']) {
      await success([
        'connect',
        url(identity),
        sessions[identity],
        '--profile',
        profiles[identity].name,
      ]);
      await call(identity, `own-${identity}`);
    }
    let records = await sessionRecords();
    for (const identity of ['alpha', 'beta']) {
      assert.equal(records[sessions[identity]].profileName, profiles[identity].name);
      assert.equal(records[sessions[identity]].server.url, url(identity));
      await bridgeArgs(manifest, records[sessions[identity]].pid);
    }
    assert.notEqual(records[sessions.alpha].pid, records[sessions.beta].pid);
    const beforeCrossed = await stats();
    assert.equal(
      (
        await command(manifest, [
          'connect',
          url('beta'),
          sessions.cross,
          '--profile',
          profiles.alpha.name,
        ])
      ).code,
      4
    );
    assert.equal(
      (await command(manifest, ['connect', url('alpha'), sessions.anonymous, '--no-profile'])).code,
      4
    );
    const afterCrossed = await stats();
    for (const identity of ['alpha', 'beta']) {
      assert.ok(
        afterCrossed.identities[identity].rejected > beforeCrossed.identities[identity].rejected,
        'Rejected connections must reach the protected resource'
      );
    }
    await call('alpha', 'alpha-after-rejections');
    await call('beta', 'beta-after-rejections');
    console.log(
      '# Passed: two profiles and bridges remain isolated; a crossed profile cannot connect'
    );

    let before = await stats();
    await control('revoke', 'alpha');
    await call('alpha', 'reacquired-alpha');
    let after = await stats();
    assert.equal(
      after.identities.alpha.issued,
      before.identities.alpha.issued + 1,
      'One invalidated access token must cause exactly one client-credentials exchange'
    );
    assert.equal(after.identities.beta.issued, before.identities.beta.issued);
    assert.equal(after.identities.alpha.tokenRequests, before.identities.alpha.tokenRequests + 1);
    assert.equal(after.invalidClients, before.invalidClients);
    assert.ok(after.identities.alpha.rejected > before.identities.alpha.rejected);
    await call('beta', 'unaffected-beta');
    console.log('# Passed: token invalidation reacquires once without touching the other identity');

    before = await stats();
    await control('reject', 'alpha');
    const rejected = await command(manifest, [
      sessions.alpha,
      'tools-call',
      'echo',
      'message:=denied',
    ]);
    // Depending on which legacy transport request sees the rejection first,
    // tools-call surfaces the SDK error or the bridge's classified AuthError.
    // Require an authentication cause; counters below still bound both retries.
    assert.ok([2, 4].includes(rejected.code), 'Expected a classified authentication rejection');
    assert.match(
      JSON.parse(rejected.stderr).error,
      /401 after re-authentication|^Authentication required by server\./
    );
    after = await stats();
    assert.ok(
      after.identities.alpha.issued - before.identities.alpha.issued <= 1,
      'Persistent rejection must not loop token acquisition'
    );
    assert.ok(
      after.identities.alpha.rejected > before.identities.alpha.rejected &&
        after.identities.alpha.rejected - before.identities.alpha.rejected <= 2,
      'Persistent rejection must not loop protected requests'
    );
    assert.ok(after.identities.alpha.tokenRequests - before.identities.alpha.tokenRequests <= 1);
    assert.equal(after.invalidClients, before.invalidClients);
    assert.equal(after.identities.beta.issued, before.identities.beta.issued);
    await call('beta', 'beta-during-denial');
    const oldPid = records[sessions.alpha].pid;
    await control('allow', 'alpha');
    await success([sessions.alpha, 'restart']);
    await call('alpha', 'alpha-after-restart');
    records = await sessionRecords();
    assert.notEqual(records[sessions.alpha].pid, oldPid);
    assert.equal(records[sessions.alpha].profileName, profiles.alpha.name);
    console.log('# Passed: repeated rejection terminates; restart recovers the same profile');

    await success([sessions.alpha, 'close']);
    await success(['logout', url('alpha'), '--profile', profiles.alpha.name]);
    await assertAbsent(profiles.alpha);
    before = await stats();
    assert.notEqual(
      (
        await command(manifest, [
          'connect',
          url('alpha'),
          sessions.alpha,
          '--profile',
          profiles.alpha.name,
        ])
      ).code,
      0
    );
    assert.equal((await stats()).identities.alpha.issued, before.identities.alpha.issued);
    await success([sessions.beta, 'restart']);
    await call('beta', 'beta-after-alpha-logout');
    assert.ok((await readCredential(profiles.beta))?.clientId === identities.beta.clientId);
    await success([sessions.beta, 'close']);
    await success(['logout', url('beta'), '--profile', profiles.beta.name]);
    await assertAbsent(profiles.beta);
    console.log(
      '# Passed: logout deletes the exact profile credentials and preserves the other profile'
    );

    // Hold the real CLI's token response, then interrupt its helper. The helper
    // must stop and await that child before verifying deletion, or releasing the
    // response could cause a late credential write after supposedly safe cleanup.
    before = await stats();
    await control('hold', 'alpha');
    const probe = exec(
      process.execPath,
      [fileURLToPath(import.meta.url), 'interrupt-login', filename],
      { timeout: 10000, killSignal: 'SIGKILL' }
    );
    activeChild = probe.child;
    const outcome = probe.then(
      (result) => ({ ...result, code: 0 }),
      (error) => ({ stdout: error.stdout, stderr: error.stderr, code: error.code })
    );
    try {
      const deadlineMillis = Date.now() + 5000;
      while ((await stats()).identities.alpha.pending !== 1 && Date.now() < deadlineMillis)
        await delay(50);
      assert.equal((await stats()).identities.alpha.pending, 1, 'The real login must be in flight');
      // Windows force-kills on child.kill('SIGTERM'); use the same interrupt
      // handler through stdin there, so the ordered teardown remains testable.
      if (process.platform === 'win32') probe.child.stdin.end('interrupt');
      else probe.child.kill('SIGTERM');
      const result = await outcome;
      assertNoSecrets(manifest, result.stdout + result.stderr, 'Interrupted helper output');
      assert.equal(result.code, 143);
      assert.equal(
        (await stats()).identities.alpha.pending,
        0,
        'The interrupted CLI still owns a token request'
      );
    } finally {
      probe.child.kill('SIGTERM');
      await outcome;
      activeChild = undefined;
      await control('release', 'alpha');
    }
    assert.equal((await stats()).identities.alpha.issued, before.identities.alpha.issued);
    await assertAbsent(profiles.interrupted);
    console.log(
      '# Passed: interruption stops the real login before cleanup, with no late token/credential write'
    );

    // A directory at the metadata filename makes the real login fail AFTER it
    // stores credentials. This is deterministic even when running as root.
    await mkdir(join(manifest.partialHome, 'profiles.json'), { recursive: true, mode: 0o700 });
    await inHome(manifest.partialHome, () =>
      keychain.storeKeychainClientCredentials(profiles.sentinel.url, profiles.sentinel.name, {
        clientId: 'test-owned-sentinel',
        clientSecret: manifest.sentinelSecret,
      })
    );
    assert.notEqual((await login('alpha', profiles.partial)).code, 0);
    assert.ok(
      (await readCredential(profiles.partial))?.clientId === identities.alpha.clientId,
      'Failure injection must reach the credential write'
    );
    assert.ok((await stat(join(manifest.partialHome, 'profiles.json'))).isDirectory());
    await rmdir(join(manifest.partialHome, 'profiles.json'));
    assert.notEqual(
      (
        await command(
          manifest,
          ['logout', url('alpha'), '--profile', profiles.partial.name],
          manifest.partialHome
        )
      ).code,
      0
    );
    // Logout cannot find metadata here. Prove that the absence check detects the
    // orphan before exact registry cleanup removes it; a successful exit is not proof.
    await assert.rejects(() => assertAbsent(profiles.partial), /credential remains/);
    await removeProfiles([profiles.partial]);
    assert.ok(
      (await readCredential(profiles.sentinel))?.clientSecret === manifest.sentinelSecret,
      'Targeted cleanup removed an unrelated test-owned sentinel'
    );
    console.log(
      '# Passed: post-storage login failure is cleaned without metadata or broad deletion'
    );

    await scanFiles(manifest, manifest.home);
    await scanFiles(manifest, dirname(dirname(filename)));
    console.log(
      '# Passed: CLI output, bridge arguments, metadata and logs contain no fixture secrets'
    );
  } finally {
    await cleanup(manifest);
  }
}

try {
  if (action === 'init' || action === 'init-code') {
    const prefix = `oauth-local-${randomBytes(12).toString('hex')}`;
    const manifest = {
      prefix,
      home: resolve(argument),
      partialHome: join(dirname(filename), 'partial-home'),
      wrongSecret: randomBytes(24).toString('hex'),
      sentinelSecret: randomBytes(24).toString('hex'),
      identities: Object.fromEntries(
        ['alpha', 'beta'].map((name) => [
          name,
          {
            clientId: `${prefix}-${name}`,
            clientSecret: randomBytes(24).toString('hex'),
            tokenPrefix: randomBytes(24).toString('hex'),
          },
        ])
      ),
      sessions: Object.fromEntries(
        ['alpha', 'beta', 'cross', 'anonymous'].map((name) => [name, `@${prefix}-${name}`])
      ),
    };
    if (action === 'init-code') await initializeAuthorizationCode(manifest, filename);
    await save(manifest);
  } else {
    const manifest = JSON.parse(await readFile(filename, 'utf8'));
    if (action === 'run') await run(manifest);
    else if (action === 'run-code') {
      await runAuthorizationCode(manifest, argument, {
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
      });
    } else if (action === 'cleanup') await cleanup(manifest);
    else if (action === 'interrupt-login') {
      if (process.platform === 'win32') {
        process.stdin.once('data', () => process.emit('SIGTERM'));
      }
      try {
        await loginCredentials(manifest, 'alpha', manifest.profiles.interrupted);
      } finally {
        await cleanup({
          ...manifest,
          profiles: { interrupted: manifest.profiles.interrupted },
          sessions: {},
        });
        process.stdin.destroy();
      }
    } else throw new Error('Unknown local OAuth test action');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = cleanupFailed ? 1 : interrupted || 1;
}
if (interrupted && !process.exitCode) process.exitCode = interrupted;
