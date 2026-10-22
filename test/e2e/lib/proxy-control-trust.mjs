/** Exercise the compiled CLI at its local IPC trust and capability boundary. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const packageDir = resolve(process.env.MCPC_TEST_PACKAGE_DIR ?? process.argv[2]);
const { getSocketPath } = await import(pathToFileURL(join(packageDir, 'dist/lib/utils.js')).href);
const { saveSession } = await import(pathToFileURL(join(packageDir, 'dist/lib/sessions.js')).href);
const homeDir = process.env.MCPC_HOME_DIR;
assert(homeDir);
const sessionName = '@trust-fixture';
const owner = await saveSession(sessionName, {
  server: { url: 'https://upstream.invalid' },
  createdAt: '',
  pid: process.pid,
  bridgeOwner: 'fixture-owner',
  proxy: { host: '127.0.0.1', port: 8181, requireBearerToken: true },
});
const socketPath = getSocketPath(sessionName, process.pid);
const socketDir = dirname(socketPath);
await mkdir(socketDir, { mode: 0o700 });
const tokenFile = join(homeDir, 'fixture-token');
await writeFile(tokenFile, 'must-not-be-delivered\n', { mode: 0o600 });
const sessionsPath = join(homeDir, 'sessions.json');
const before = await readFile(sessionsPath, 'utf8');
const requests = [];
let stale = false;
const sockets = new Set();
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      requests.push(message);
      socket.write(
        JSON.stringify({
          type: 'response',
          id: message.id,
          ...(stale
            ? {
                result: {
                  version: 1,
                  createdAt: owner.createdAt,
                  pid: process.pid,
                  bridgeOwner: 'superseded-owner',
                  ready: true,
                },
              }
            : { error: { code: 1, message: 'Unknown method' } }),
        }) + '\n'
      );
    }
  });
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(socketPath, resolve);
});

async function refused(args, message) {
  const previousCount = requests.length;
  await assert.rejects(
    execute(
      process.execPath,
      [join(packageDir, 'bin/mcpc'), '--json', 'proxy', sessionName, ...args],
      { timeout: 10_000 }
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, message);
      assert(!error.stderr.includes('must-not-be-delivered'));
      return true;
    }
  );
  assert.equal(await readFile(sessionsPath, 'utf8'), before, 'refusal mutated session state');
  assert(requests.slice(previousCount).every((request) => request.method === 'proxy/capabilities'));
  assert(!JSON.stringify(requests).includes('must-not-be-delivered'));
  return requests.length - previousCount;
}

const startArgs = ['--name', 'new', '--listen', '8182', '--bearer-token-file', tokenFile];
try {
  assert.equal(await refused(startArgs, /does not support proxy management/), 1);
  assert.equal(await refused(['--stop', 'legacy'], /does not support proxy management/), 1);
  stale = true;
  assert.equal(await refused(startArgs, /does not support this proxy owner/), 1);
  console.log(
    '# Old and stale bridges reject management using only a read-only capability request.'
  );

  await chmod(socketDir, 0o755);
  try {
    assert.equal(await refused(startArgs, /0700/), 0);
  } finally {
    await chmod(socketDir, 0o700);
  }
  await chmod(homeDir, 0o755);
  try {
    assert.equal(await refused(startArgs, /0700/), 0);
  } finally {
    await chmod(homeDir, 0o700);
  }
  await chmod(sessionsPath, 0o644);
  try {
    assert.equal(await refused(startArgs, /private regular file/), 0);
  } finally {
    await chmod(sessionsPath, 0o600);
  }

  const movedDir = `${socketDir}-owned-original`;
  await rename(socketDir, movedDir);
  await symlink(movedDir, socketDir);
  try {
    assert.equal(await refused(startArgs, /symbolic link/), 0);
  } finally {
    await rm(socketDir);
    await rename(movedDir, socketDir);
  }
  console.log(
    '# Permissive home/socket directories, public metadata and a substituted symlink are refused before IPC.'
  );
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  // This fixture never spawned a bridge or stored a credential.
  await rm(sessionsPath);
}
