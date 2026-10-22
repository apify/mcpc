/** Real CLI/HTTP exercise; also accepts an extracted package via MCPC_TEST_PACKAGE_DIR. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const packageDir = resolve(process.env.MCPC_TEST_PACKAGE_DIR ?? process.argv[2]);
const sessionName = process.argv[3];
assert(process.env.MCPC_HOME_DIR && process.env.TEST_TMP && process.env.TEST_SERVER_URL);
const cli = join(packageDir, 'bin/mcpc');
const importBuilt = (name) => import(pathToFileURL(join(packageDir, 'dist/lib', name)).href);
const { getSession, updateSession } = await importBuilt('sessions.js');
const { isProcessAlive } = await importBuilt('utils.js');
const {
  readKeychainProxyListenerToken,
  removeKeychainProxyListenerToken,
  storeKeychainProxyListenerToken,
} = await importBuilt('auth/keychain.js');
const tokens = ['alpha', 'beta', 'replacement'].map((name) => `${name}-${randomUUID()}`);
const sentinel = randomUUID();
const tokenPaths = await Promise.all(
  tokens.map(async (token, index) => {
    const path = join(process.env.TEST_TMP, `proxy-token-${index}.txt`);
    await writeFile(path, `${token}\n`, { mode: 0o600 });
    return path;
  })
);
let blocker;
let stopped = false;

async function command(args, expectedSuccess = true) {
  let result;
  try {
    result = await execute(process.execPath, [cli, '--json', ...args], {
      timeout: 30_000,
      maxBuffer: 2_000_000,
    });
  } catch (error) {
    if (expectedSuccess)
      throw new Error(`mcpc ${args[0]} failed: ${error.stderr}`, { cause: error });
    return { error: JSON.parse(error.stderr), stdout: error.stdout };
  }
  assert(expectedSuccess, `mcpc ${args[0]} unexpectedly succeeded`);
  for (const token of tokens)
    assert(!`${result.stdout}\n${result.stderr}`.includes(token), 'token leaked in CLI output');
  return JSON.parse(result.stdout);
}

async function waitFor(predicate, message, timeoutMillis = 8_000) {
  const deadlineMillis = Date.now() + timeoutMillis;
  while (Date.now() < deadlineMillis) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function bind(port = 0) {
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

async function closeServer(server) {
  if (server)
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
}

async function freePort() {
  const server = await bind();
  const port = server.address().port;
  await closeServer(server);
  return port;
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    await response.text();
    return response.ok;
  } catch {
    return false;
  }
}

function parseRpc(text) {
  return JSON.parse(
    text.startsWith('event:')
      ? text
          .split('\n')
          .find((line) => line.startsWith('data:'))
          .slice(5)
      : text
  );
}

async function rpc(port, token, payload, mcpSessionId) {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    signal: AbortSignal.timeout(5_000),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(mcpSessionId && { 'Mcp-Session-Id': mcpSessionId, 'MCP-Protocol-Version': '2025-11-25' }),
    },
    body: JSON.stringify(payload),
  });
  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id'),
    body: await response.text(),
  };
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'proxy-lifecycle-e2e', version: '1' },
  },
};

async function accepts(port, token) {
  const result = await rpc(port, token, initialize);
  assert.equal(result.status, 200);
  assert(parseRpc(result.body).result.serverInfo);
  return result.sessionId;
}

async function echo(port, token) {
  const id = await accepts(port, token);
  await rpc(port, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, id);
  const result = await rpc(
    port,
    token,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'echo', arguments: { message: 'independent-proxy' } },
    },
    id
  );
  assert.equal(result.status, 200);
  assert(JSON.stringify(parseRpc(result.body).result).includes('independent-proxy'));
}

const start = (name, port, tokenIndex) =>
  command([
    'proxy',
    sessionName,
    '--name',
    name,
    '--listen',
    String(port),
    ...(tokenIndex === undefined ? ['--no-auth'] : ['--bearer-token-file', tokenPaths[tokenIndex]]),
  ]);
const list = () => command(['proxy', sessionName]);
const stop = (name) => command(['proxy', sessionName, '--stop', name]);
const current = () => getSession(sessionName);
const milestone = (message) => console.log(`# ${message}`);

try {
  await storeKeychainProxyListenerToken(sentinel, 'unrelated-owned-sentinel');
  await command(['connect', process.env.TEST_SERVER_URL, sessionName, '--header', 'X-Test: true']);
  const original = await current();
  assert.equal((await list()).listeners.length, 0);
  const [alphaPort, betaPort] = await Promise.all([freePort(), freePort()]);
  await Promise.all([start('alpha', alphaPort, 0), start('beta', betaPort, 1)]);
  const attached = await current();
  assert.equal(attached.pid, original.pid);
  assert.equal(attached.createdAt, original.createdAt);
  assert.equal(attached.bridgeOwner, original.bridgeOwner);
  assert.equal(attached.mcpSessionId, original.mcpSessionId);
  assert.equal(
    (await list()).listeners.filter((entry) => entry.observedState === 'running').length,
    2
  );
  const firstAlphaId = attached.proxyListeners.find((entry) => entry.name === 'alpha').id;
  const betaId = attached.proxyListeners.find((entry) => entry.name === 'beta').id;
  assert.equal(await readKeychainProxyListenerToken(firstAlphaId), tokens[0]);
  assert.equal(await readKeychainProxyListenerToken(betaId), tokens[1]);
  for (const [port, own, other] of [
    [alphaPort, tokens[0], tokens[1]],
    [betaPort, tokens[1], tokens[0]],
  ]) {
    assert.equal((await rpc(port, undefined, initialize)).status, 401);
    assert.equal((await rpc(port, 'wrong', initialize)).status, 403);
    assert.equal((await rpc(port, other, initialize)).status, 403);
    await echo(port, own);
  }
  milestone(
    'Two independently authenticated listeners share the original upstream; cross/missing/wrong tokens fail.'
  );

  for (const phase of ['before-write', 'after-write']) {
    const crashName = `crash-${phase}`;
    const crashPort = await freePort();
    await assert.rejects(
      execute(
        process.execPath,
        [
          join(process.argv[2], 'test/e2e/lib/proxy-credential-crash.mjs'),
          packageDir,
          sessionName,
          crashName,
          String(crashPort),
          tokenPaths[0],
          phase,
        ],
        { timeout: 10_000 }
      ),
      (error) => error.code === 73
    );
    const pending = (await current()).proxyListeners.find((entry) => entry.name === crashName);
    assert.equal(pending.state, 'pending');
    assert.equal(isProcessAlive(pending.credentialWriterPid), false);
    assert.equal(
      await readKeychainProxyListenerToken(pending.id),
      phase === 'before-write' ? undefined : tokens[0]
    );
    await command([sessionName, 'restart']);
    assert.equal(await health(crashPort), false);
    assert.equal(
      (await list()).listeners.find((entry) => entry.name === crashName).desiredState,
      'pending'
    );
    await stop(crashName);
    assert.equal(await readKeychainProxyListenerToken(pending.id), undefined);
    assert(!(await current()).proxyListeners.some((entry) => entry.id === pending.id));
  }
  milestone(
    'Real creator exits before/after credential storage leave pending receipts, never listeners; stop cleans their exact UUIDs.'
  );

  await command([sessionName, 'restart']);
  await Promise.all([echo(alphaPort, tokens[0]), echo(betaPort, tokens[1])]);
  assert.notEqual((await current()).pid, original.pid);
  assert.equal((await stop('alpha')).stopped.closed, true);
  await waitFor(async () => !(await health(alphaPort)), 'Stopped alpha still listens');
  await echo(betaPort, tokens[1]);
  assert.equal(await readKeychainProxyListenerToken(firstAlphaId), undefined);
  await start('alpha', alphaPort, 2);
  const replacementId = (await current()).proxyListeners.find((entry) => entry.name === 'alpha').id;
  assert.notEqual(replacementId, firstAlphaId);
  assert.equal((await rpc(alphaPort, tokens[0], initialize)).status, 403);
  await echo(alphaPort, tokens[2]);
  milestone(
    'Restart restores both; stopping and reusing one name leaves the sibling and its credential intact.'
  );

  await removeKeychainProxyListenerToken(replacementId);
  await command([sessionName, 'restart']);
  const missing = (await list()).listeners.find((entry) => entry.name === 'alpha');
  assert.equal(missing.observedState, 'failed');
  assert.match(missing.error, /token is missing/);
  assert.equal(await health(alphaPort), false);
  await echo(betaPort, tokens[1]);
  await stop('alpha');
  milestone(
    'A missing saved credential never restores an unauthenticated listener; sibling remains usable.'
  );

  blocker = await bind();
  const blockedPort = blocker.address().port;
  const failed = await command(
    [
      'proxy',
      sessionName,
      '--name',
      'blocked',
      '--listen',
      String(blockedPort),
      '--bearer-token-file',
      tokenPaths[0],
    ],
    false
  );
  assert.match(JSON.stringify(failed.error), /already in use/);
  assert(!(await current()).proxyListeners.some((entry) => entry.name === 'blocked'));
  await closeServer(blocker);
  blocker = undefined;
  milestone('Failed bind rolls back its reserved listener and leaves existing listeners usable.');

  const beforeCrash = await current();
  process.kill(beforeCrash.pid, 'SIGKILL');
  await waitFor(() => !isProcessAlive(beforeCrash.pid), 'Crashed bridge did not exit');
  blocker = await bind(betaPort);
  await command([sessionName, 'restart']);
  await command([sessionName, 'ping']);
  assert.equal(
    (await list()).listeners.find((entry) => entry.name === 'beta').observedState,
    'failed'
  );
  await closeServer(blocker);
  blocker = undefined;
  await command([sessionName, 'restart']);
  await echo(betaPort, tokens[1]);
  milestone(
    'Restore bind failure is visible without disabling the upstream; explicit restart recovers it.'
  );

  // Exercise management independently of MCP readiness, without triggering session recovery.
  const beforeExpired = await current();
  await updateSession(sessionName, { status: 'expired' });
  assert.equal((await list()).bridge, 'connected');
  assert.equal((await stop('beta')).stopped.closed, true);
  assert.equal((await current()).pid, beforeExpired.pid);
  assert.equal((await current()).status, 'expired');
  await command([sessionName, 'restart']);
  await start('offline', betaPort, 1);
  const offline = await current();
  process.kill(offline.pid, 'SIGKILL');
  await waitFor(() => !isProcessAlive(offline.pid), 'Offline bridge did not exit');
  await updateSession(sessionName, { status: 'unauthorized' });
  assert.equal((await list()).bridge, 'offline');
  assert.equal((await stop('offline')).stopped.closed, true);
  const afterOffline = await current();
  assert.equal(afterOffline.pid, offline.pid);
  assert.equal(afterOffline.bridgeOwner, offline.bridgeOwner);
  assert.equal(afterOffline.status, 'unauthorized');
  assert.equal(await health(betaPort), false);
  assert.equal(afterOffline.proxyListeners.length, 0);
  milestone(
    'Expired and offline unauthorized sessions can list/stop without reconnecting the upstream.'
  );

  await command([sessionName, 'restart']);
  await start('public', alphaPort);
  await accepts(alphaPort);
  const sessionsText = await readFile(join(process.env.MCPC_HOME_DIR, 'sessions.json'), 'utf8');
  const logNames = await readdir(join(process.env.MCPC_HOME_DIR, 'logs'));
  const logs = await Promise.all(
    logNames.map((name) => readFile(join(process.env.MCPC_HOME_DIR, 'logs', name), 'utf8'))
  );
  for (const token of tokens)
    assert(
      ![sessionsText, ...logs].some((text) => text.includes(token)),
      'token leaked in metadata/logs'
    );
  await command([sessionName, 'close']);
  stopped = true;
  assert.equal(await current(), undefined);
  assert.equal(await health(alphaPort), false);
  assert.equal(await readKeychainProxyListenerToken(betaId), undefined);
  assert.equal(await readKeychainProxyListenerToken(sentinel), 'unrelated-owned-sentinel');
  milestone(
    'Explicit unauthenticated mode works; close removes live listeners and owned secrets, preserving the sentinel.'
  );
} finally {
  await closeServer(blocker);
  if (!stopped && (await current())) {
    try {
      await command([sessionName, 'close']);
    } catch (error) {
      const session = await current();
      if (session?.pid && isProcessAlive(session.pid)) process.kill(session.pid, 'SIGKILL');
      console.error('Cleanup requires attention:', error.message);
      process.exitCode = 1;
    }
  }
  await removeKeychainProxyListenerToken(sentinel);
}
