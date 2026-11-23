import { vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { createServer, type Server, type Socket } from 'net';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import type { BridgeOwner, IpcMessage } from '../../../src/lib/types.js';

vi.mock('../../../src/lib/auth/keychain.js', () => ({
  storeKeychainProxyListenerToken: vi.fn(async () => {}),
  removeKeychainProxyListenerToken: vi.fn(async () => true),
}));

import { manageProxy } from '../../../src/cli/commands/proxy.js';
import { getSession, saveSession } from '../../../src/lib/sessions.js';
import {
  activateProxyListener,
  reserveProxyListener,
  finishProxyCredentialWrite,
} from '../../../src/lib/proxy-listeners.js';
import { getSocketPath } from '../../../src/lib/utils.js';
import {
  storeKeychainProxyListenerToken,
  removeKeychainProxyListenerToken,
} from '../../../src/lib/auth/keychain.js';

describe.skipIf(process.platform === 'win32')('POSIX proxy control', () => {
  let homeDir: string;
  let originalHome: string | undefined;
  let server: Server;
  let owner: BridgeOwner;
  let tokenFile: string;
  let socketPath: string;
  let output: string[];
  let requests: IpcMessage[];
  const sockets = new Set<Socket>();
  const name = '@control';
  let handle: (request: IpcMessage, socket: Socket) => Promise<void>;

  function reply(socket: Socket, request: IpcMessage, result: unknown): void {
    socket.write(JSON.stringify({ type: 'response', id: request.id, result }) + '\n');
  }

  function reject(socket: Socket, request: IpcMessage, code = 1): void {
    socket.write(
      JSON.stringify({
        type: 'response',
        id: request.id,
        error: { code, message: 'controlled refusal' },
      }) + '\n'
    );
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    homeDir = await mkdtemp(join(tmpdir(), 'mcpc-ctl-'));
    originalHome = process.env.MCPC_HOME_DIR;
    process.env.MCPC_HOME_DIR = homeDir;
    const session = await saveSession(name, {
      server: { url: 'https://example.test' },
      createdAt: '',
      pid: process.pid,
      bridgeOwner: 'owner',
    });
    owner = { createdAt: session.createdAt, pid: process.pid, bridgeOwner: 'owner' };
    tokenFile = join(homeDir, 'token.txt');
    await writeFile(tokenFile, 'controlled-listener-token\n', { mode: 0o600 });
    output = [];
    vi.spyOn(console, 'log').mockImplementation((value) => {
      output.push(String(value));
    });
    requests = [];
    handle = async (request, socket) => {
      if (request.method === 'proxy/capabilities')
        reply(socket, request, { version: 1, ...owner, ready: true });
      else if (request.method === 'proxy/list') reply(socket, request, { listeners: [] });
      else reply(socket, request, {});
    };
    socketPath = getSocketPath(name, process.pid);
    await mkdir(dirname(socketPath), { mode: 0o700 });
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      let buffer = '';
      socket.on('data', (data) => {
        buffer += data.toString();
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const request = JSON.parse(buffer.slice(0, newline)) as IpcMessage;
          buffer = buffer.slice(newline + 1);
          requests.push(request);
          void handle(request, socket).catch((error) => socket.destroy(error as Error));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalHome === undefined) delete process.env.MCPC_HOME_DIR;
    else process.env.MCPC_HOME_DIR = originalHome;
    vi.restoreAllMocks();
    await rm(homeDir, { recursive: true, force: true });
  });

  const start = () =>
    manageProxy(name, {
      outputMode: 'json',
      name: 'new',
      listen: '8181',
      bearerTokenFile: tokenFile,
    });

  it.each(['old', 'stale'])(
    'rejects a %s bridge before writing credentials or desired state',
    async (kind) => {
      handle = async (request, socket) => {
        if (kind === 'old') reject(socket, request);
        else
          reply(socket, request, { version: 1, ...owner, bridgeOwner: 'other-owner', ready: true });
      };
      const before = await readFile(join(homeDir, 'sessions.json'), 'utf8');
      await expect(start()).rejects.toThrow('does not support');
      expect(requests.map((request) => request.method)).toEqual(['proxy/capabilities']);
      expect(storeKeychainProxyListenerToken).not.toHaveBeenCalled();
      expect(await readFile(join(homeDir, 'sessions.json'), 'utf8')).toBe(before);
    }
  );

  it('rejects an unsafe socket namespace before sending any request', async () => {
    await chmod(dirname(socketPath), 0o755);
    await expect(start()).rejects.toThrow('0700');
    expect(requests).toEqual([]);
    expect(storeKeychainProxyListenerToken).not.toHaveBeenCalled();
  });

  it('retires the pre-recorded UUID after a credential write partially fails', async () => {
    vi.mocked(storeKeychainProxyListenerToken).mockRejectedValueOnce(
      new Error('partial credential write')
    );
    await expect(start()).rejects.toThrow('partial credential write');
    const id = vi.mocked(storeKeychainProxyListenerToken).mock.calls[0]?.[0];
    expect(id).toBeTypeOf('string');
    expect(removeKeychainProxyListenerToken).toHaveBeenCalledWith(id);
    expect((await getSession(name))?.proxyListeners).toEqual([]);
    expect(requests.map((request) => request.method)).toEqual(['proxy/capabilities', 'proxy/stop']);
  });

  it('retains a recoverable stopped receipt when credential cleanup fails', async () => {
    vi.mocked(storeKeychainProxyListenerToken).mockRejectedValueOnce(
      new Error('partial credential write')
    );
    vi.mocked(removeKeychainProxyListenerToken).mockRejectedValueOnce(
      new Error('keychain unavailable')
    );
    await expect(start()).rejects.toThrow('partial credential write');
    const entry = (await getSession(name))?.proxyListeners?.[0];
    expect(entry).toMatchObject({ state: 'stopped', authentication: 'bearer' });
    expect(entry).not.toHaveProperty('credentialWriterPid');
    await manageProxy(name, { outputMode: 'json', stop: 'new' });
    expect((await getSession(name))?.proxyListeners).toEqual([]);
  });

  it('keeps a committed listener and credential when the start response is lost', async () => {
    const fallback = handle;
    handle = async (request, socket) => {
      if (request.method === 'proxy/start') {
        const id = (request.params as { id: string }).id;
        await activateProxyListener(name, owner, id);
        socket.destroy();
      } else await fallback(request, socket);
    };
    await expect(start()).rejects.toThrow('Connection closed');
    expect((await getSession(name))?.proxyListeners?.[0]?.state).toBe('active');
    expect(removeKeychainProxyListenerToken).not.toHaveBeenCalled();
  });

  it('persists removal before close and retains an unconfirmed stop for a later retry', async () => {
    const entry = await reserveProxyListener(name, owner, {
      name: 'existing',
      host: '127.0.0.1',
      port: 8181,
      authentication: 'bearer',
    });
    await finishProxyCredentialWrite(name, owner.createdAt, entry.id);
    await activateProxyListener(name, owner, entry.id);
    const fallback = handle;
    handle = async (request, socket) => {
      if (request.method === 'proxy/stop') {
        expect((await getSession(name))?.proxyListeners?.[0]?.state).toBe('stopped');
        reject(socket, request, 3);
      } else await fallback(request, socket);
    };
    await manageProxy(name, { outputMode: 'json', stop: 'existing' });
    expect(JSON.parse(output[0] as string).stopped).toMatchObject({
      closed: false,
      credentialCleanupPending: false,
    });
    expect((await getSession(name))?.proxyListeners?.[0]?.state).toBe('stopped');
    handle = fallback;
    await manageProxy(name, { outputMode: 'json', stop: 'existing' });
    expect((await getSession(name))?.proxyListeners).toEqual([]);
  });
});
