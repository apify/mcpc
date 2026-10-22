import { vi } from 'vitest';
import { chmod, chown, mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { createServer, type Server } from 'net';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  assertProxyControlPlatform,
  verifyBridgeEndpoint,
  verifyBridgeNamespace,
  verifyProxyHome,
} from '../../../src/lib/bridge-trust.js';

const posix = process.platform !== 'win32';
let homeDir: string;
let socketPath: string;
let previousHome: string | undefined;
let server: Server | undefined;

describe.skipIf(!posix)('real POSIX proxy namespace trust', () => {
  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpc-trust-'));
    previousHome = process.env.MCPC_HOME_DIR;
    process.env.MCPC_HOME_DIR = homeDir;
    socketPath = join(homeDir, 'bridges', 'bridge.sock');
    await writeFile(join(homeDir, 'sessions.json'), '{"sessions":{}}', { mode: 0o600 });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
    if (previousHome === undefined) delete process.env.MCPC_HOME_DIR;
    else process.env.MCPC_HOME_DIR = previousHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  async function listen(): Promise<void> {
    await verifyBridgeNamespace(socketPath, true);
    server = createServer((socket) => socket.end());
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(socketPath, resolve);
    });
  }

  it('accepts an owned private home and real owned endpoint', async () => {
    await listen();
    await expect(verifyBridgeEndpoint(socketPath)).resolves.toBeUndefined();
  });

  it('refuses a permissive existing namespace before creating an endpoint', async () => {
    await mkdir(join(homeDir, 'bridges'), { mode: 0o755 });
    await expect(verifyBridgeNamespace(socketPath)).rejects.toThrow('0700');
    await chmod(join(homeDir, 'bridges'), 0o700);
    await chmod(homeDir, 0o777);
    await expect(verifyProxyHome()).rejects.toThrow('writable by another user');
  });

  it('refuses a socket symlink, ordinary substituted file and session-file symlink', async () => {
    await verifyBridgeNamespace(socketPath, true);
    await writeFile(socketPath, 'substituted endpoint', { mode: 0o600 });
    await expect(verifyBridgeEndpoint(socketPath)).rejects.toThrow('socket owner or type');
    await rm(socketPath);
    await symlink(join(homeDir, 'sessions.json'), socketPath);
    await expect(verifyBridgeEndpoint(socketPath)).rejects.toThrow('socket owner or type');
    await rm(join(homeDir, 'sessions.json'));
    await writeFile(join(homeDir, 'other.json'), '{}', { mode: 0o600 });
    await symlink(join(homeDir, 'other.json'), join(homeDir, 'sessions.json'));
    await expect(verifyProxyHome()).rejects.toThrow('private regular file');
  });

  it('rejects a private leaf underneath a writable ancestor or user-created alias', async () => {
    const parent = join(homeDir, 'unsafe');
    await mkdir(parent, { mode: 0o777 });
    await chmod(parent, 0o777);
    await mkdir(join(parent, 'private'), { mode: 0o700 });
    process.env.MCPC_HOME_DIR = join(parent, 'private');
    await expect(verifyProxyHome()).rejects.toThrow('writable by another user');
    await chmod(parent, 0o700);
    await symlink(parent, join(homeDir, 'alias'));
    process.env.MCPC_HOME_DIR = join(homeDir, 'alias', 'private');
    await expect(verifyProxyHome()).rejects.toThrow('symbolic link');
  });

  it('validates the fallback namespace independently of a safe home', async () => {
    const fallback = await mkdtemp(join(tmpdir(), 'mcpc-trust-fallback-'));
    try {
      const path = join(fallback, 'bridge.sock');
      await expect(verifyBridgeNamespace(path)).resolves.toBeUndefined();
      await chmod(fallback, 0o777);
      await expect(verifyBridgeNamespace(path)).rejects.toThrow('writable by another user');
    } finally {
      await rm(fallback, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() !== 0)(
    'rejects a directory owned by a different real UID',
    async () => {
      await mkdir(join(homeDir, 'bridges'), { mode: 0o700 });
      await chown(join(homeDir, 'bridges'), 65534, 65534);
      await expect(verifyBridgeNamespace(socketPath)).rejects.toThrow('untrusted owner');
    }
  );

  it.skipIf(process.getuid?.() !== 0)(
    'blocks a real different-UID process from the endpoint while allowing the owning UID',
    async () => {
      await listen();
      const probe = (uid: number) =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              '-e',
              `
        const socket = require('net').connect(process.argv[1]);
        const timer = setTimeout(() => process.exit(2), 3000);
        socket.on('connect', () => { clearTimeout(timer); process.stdout.write('connected'); socket.end(); });
        socket.on('error', error => { clearTimeout(timer); process.stdout.write(error.code); });
      `,
              socketPath,
            ],
            { uid, gid: uid, stdio: ['ignore', 'pipe', 'pipe'] }
          );
          let output = '';
          child.stdout.on('data', (data) => {
            output += data;
          });
          child.once('error', reject);
          child.once('close', (code) =>
            code === 0 ? resolve(output) : reject(new Error(`Trust probe exited ${code}`))
          );
        });
      expect(await probe(0)).toBe('connected');
      expect(await probe(65534)).toBe('EACCES');
    }
  );
});

it('refuses new Windows management before any endpoint or credential access', () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  try {
    expect(() => assertProxyControlPlatform()).toThrow('not supported');
  } finally {
    platform.mockRestore();
  }
});
