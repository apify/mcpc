#!/usr/bin/env node

// Exercise the real CLI proxy with the reference server conformance suite.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const homeDir = await mkdtemp(join(tmpdir(), 'mcpc-server-conformance-'));
const session = `@conformance-proxy-${process.pid}`;
const env = { ...process.env, MCPC_HOME_DIR: homeDir, MCPC_JSON: '1' };
const children = new Set();
let interrupted = false;

function stop(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interrupted = true;
    for (const child of children) stop(child);
  });
}

function launch(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    ...options,
  });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

async function run(command, args, timeoutMillis = 180000) {
  const child = launch(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (data) => {
      output += data;
      process.stderr.write(data);
    });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop(child, 'SIGKILL');
  }, timeoutMillis);
  try {
    await new Promise((res, rej) => {
      child.once('error', rej);
      child.once('close', (code, signal) => {
        if (code === 0 && !timedOut) res();
        else
          rej(
            new Error(
              `${command} exited ${code ?? signal}${timedOut ? ' (timeout)' : ''}\n${output}`
            )
          );
      });
    });
  } finally {
    clearTimeout(timer);
  }
}

const mcpc = (args) => run(process.execPath, [join(root, 'bin/mcpc'), ...args], 30000);

// Same reserve-then-release pattern used by test/e2e/lib/framework.sh.
async function availablePort() {
  const server = createServer();
  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', res);
  });
  const port = server.address().port;
  await new Promise((res, rej) => server.close((error) => (error ? rej(error) : res())));
  return port;
}

async function waitHealthy(url, child) {
  const deadlineMillis = Date.now() + 15000;
  while (Date.now() < deadlineMillis) {
    if (interrupted) throw new Error('Conformance interrupted');
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error('Upstream test server exited before becoming ready');
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      const body = await response.text();
      if (response.ok && JSON.parse(body).status === 'ok') return;
    } catch {
      // Retry only readiness, never a conformance result.
    }
    await delay(100);
  }
  throw new Error(`Readiness timed out: ${url}`);
}

let upstream;
try {
  // Port reservations are released before the child binds. Retry a collision
  // once, matching the existing e2e harness's dynamic-port convention.
  for (let attempt = 0; attempt < 2; attempt++) {
    const upstreamPort = await availablePort();
    let serverError;
    let output = '';
    upstream = launch(
      process.execPath,
      [join(root, 'node_modules/tsx/dist/cli.mjs'), 'test/e2e/server/index.ts'],
      {
        env: { ...env, PORT: String(upstreamPort), REQUIRE_AUTH: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    upstream.on('error', (error) => {
      serverError = error;
    });
    for (const stream of [upstream.stdout, upstream.stderr]) {
      stream.on('data', (data) => {
        output += data;
        process.stderr.write(data);
      });
    }
    try {
      await waitHealthy(`http://127.0.0.1:${upstreamPort}/health`, upstream);
      if (serverError) throw serverError;
      const proxyPort = await availablePort();
      await mcpc([
        'connect',
        `http://127.0.0.1:${upstreamPort}/mcp`,
        session,
        '--no-profile',
        '--proxy',
        `127.0.0.1:${proxyPort}`,
      ]);
      await waitHealthy(`http://127.0.0.1:${proxyPort}/health`);
      const version = process.env.CONFORMANCE_PACKAGE_VERSION;
      if (version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error('CONFORMANCE_PACKAGE_VERSION must be a version number');
      }
      const pkg = '@modelcontextprotocol/conformance' + (version ? `@${version}` : '');
      await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
        '-y',
        pkg,
        'server',
        '--url',
        `http://127.0.0.1:${proxyPort}/mcp`,
        '--scenario',
        'dns-rebinding-protection',
        ...process.argv.slice(2),
      ]);
      break;
    } catch (error) {
      if (
        attempt !== 0 ||
        !/EADDRINUSE|Port \d+ is already in use/.test(output + error.message) ||
        interrupted
      )
        throw error;
      stop(upstream);
      await mcpc([session, 'close']).catch(() => {});
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  // Session close also stops its bridge and proxy. A cleanup failure must not
  // turn a failed scenario green or leave a successful lane looking healthy.
  try {
    await mcpc([session, 'close']);
  } catch (error) {
    console.error('Failed to close conformance session:', error.message);
    process.exitCode = 1;
  }
  for (const child of children) stop(child);
  await delay(100);
  for (const child of children) stop(child, 'SIGKILL');
  await rm(homeDir, { recursive: true, force: true });
  if (interrupted) process.exitCode = 1;
}
