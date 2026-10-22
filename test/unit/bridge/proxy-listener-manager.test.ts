import { vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
vi.mock('../../../src/lib/bridge-trust.js', () => ({
  assertProxyControlPlatform: vi.fn(),
  verifyBridgeEndpoint: vi.fn(async () => {}),
}));
import { ProxyListenerManager } from '../../../src/bridge/proxy-listener-manager.js';
import type { ProxyServer } from '../../../src/bridge/proxy-server.js';
import { getSession, saveSession, updateSession } from '../../../src/lib/sessions.js';
import {
  activateProxyListener,
  finishProxyCredentialWrite,
  reserveProxyListener,
  stopProxyListener,
} from '../../../src/lib/proxy-listeners.js';
import * as utils from '../../../src/lib/utils.js';
import type { BridgeOwner, ProxyListener, SessionData } from '../../../src/lib/types.js';

let homeDir: string;
let originalHome: string | undefined;
let owner: BridgeOwner;
let manager: ProxyListenerManager;
let ready: boolean;
const name = '@listener-manager';
const servers = new Map<string, { stop: ReturnType<typeof vi.fn> }>();
const create = vi.fn<(entry: ProxyListener, token?: string) => Promise<ProxyServer>>();

async function pending(
  listenerName = 'one',
  authentication: 'bearer' | 'none' = 'bearer'
): Promise<ProxyListener> {
  const count = (await getSession(name))?.proxyListeners?.length ?? 0;
  const entry = await reserveProxyListener(name, owner, {
    name: listenerName,
    host: '127.0.0.1',
    port: 8500 + count,
    authentication,
  });
  if (authentication === 'bearer')
    await finishProxyCredentialWrite(name, owner.createdAt, entry.id);
  return entry;
}

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'mcpc-listener-manager-'));
  originalHome = process.env.MCPC_HOME_DIR;
  process.env.MCPC_HOME_DIR = homeDir;
  await saveSession(name, {
    server: { url: 'https://example.test' },
    createdAt: '',
    pid: process.pid,
    bridgeOwner: 'owner-a',
    status: 'active',
    lastSeenAt: new Date().toISOString(),
  });
  const session = (await getSession(name)) as SessionData;
  owner = { createdAt: session.createdAt, pid: process.pid, bridgeOwner: 'owner-a' };
  servers.clear();
  create.mockReset().mockImplementation(async (entry) => {
    const server = { stop: vi.fn(async () => {}) };
    servers.set(entry.id, server);
    return server as unknown as ProxyServer;
  });
  ready = true;
  manager = new ProxyListenerManager({
    sessionName: name,
    owner,
    socketPath: '/test-only.sock',
    ready: () => ready,
    create,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await manager.close();
  if (originalHome === undefined) delete process.env.MCPC_HOME_DIR;
  else process.env.MCPC_HOME_DIR = originalHome;
  await rm(homeDir, { recursive: true, force: true });
});

it('restores two independently authenticated listeners and stops only the persisted removal', async () => {
  const a = await pending('a');
  const b = await pending('b');
  await activateProxyListener(name, owner, a.id);
  await activateProxyListener(name, owner, b.id);
  await manager.restore({ [a.id]: 'token-a', [b.id]: 'token-b' });
  expect(create.mock.calls.map(([entry, token]) => [entry.name, token])).toEqual([
    ['a', 'token-a'],
    ['b', 'token-b'],
  ]);
  await expect(manager.control('proxy/stop', { owner, id: a.id })).rejects.toThrow(
    'persisted before closing'
  );
  await stopProxyListener(name, owner, a.id);
  await manager.control('proxy/stop', { owner, id: a.id });
  expect(servers.get(a.id)?.stop).toHaveBeenCalledTimes(1);
  expect(servers.get(b.id)?.stop).not.toHaveBeenCalled();
  expect(await manager.control('proxy/list', { owner })).toEqual({
    listeners: [
      { id: a.id, status: 'stopped' },
      { id: b.id, status: 'running' },
    ],
  });
});

it('never restores a pending, stopped, or authenticated listener with a missing token', async () => {
  const pendingEntry = await pending('pending');
  const missing = await pending('missing');
  const stopped = await pending('stopped');
  await activateProxyListener(name, owner, missing.id);
  await stopProxyListener(name, owner, stopped.id);
  await manager.restore({ [pendingEntry.id]: 'not-active', [stopped.id]: 'removed' });
  expect(create).not.toHaveBeenCalled();
  expect((await getSession(name))?.proxyObservations?.listeners).toEqual([
    {
      id: missing.id,
      status: 'failed',
      error: 'Required bearer token is missing or unavailable in the keychain.',
    },
  ]);
});

it('records one failed restore without discarding a healthy sibling or upstream readiness', async () => {
  const a = await pending('a');
  const b = await pending('b');
  await activateProxyListener(name, owner, a.id);
  await activateProxyListener(name, owner, b.id);
  create.mockRejectedValueOnce(
    Object.assign(new Error('raw secret must not escape'), { code: 'EADDRINUSE' })
  );
  await manager.restore({ [a.id]: 'token-a', [b.id]: 'token-b' });
  expect(await manager.control('proxy/capabilities', undefined)).toMatchObject({
    version: 1,
    ready: true,
  });
  expect((await getSession(name))?.proxyObservations?.listeners).toEqual([
    { id: a.id, status: 'failed', error: 'Listen address is already in use.' },
    { id: b.id, status: 'running' },
  ]);
});

it('fails closed for a marked legacy bearer listener when its saved token is missing', async () => {
  await updateSession(name, {
    proxy: { host: '127.0.0.1', port: 8500, requireBearerToken: true },
  });
  await manager.restore({});
  expect(create).not.toHaveBeenCalled();
  expect((await getSession(name))?.proxyObservations?.listeners).toEqual([
    {
      id: 'legacy',
      status: 'failed',
      error: 'Required bearer token is missing or unavailable in the keychain.',
    },
  ]);
  expect(await manager.control('proxy/capabilities', undefined)).toMatchObject({ ready: true });
});

it('rolls back a successful bind when the desired-state commit fails', async () => {
  const entry = await pending();
  create.mockImplementationOnce(async (listener) => {
    const server = { stop: vi.fn(async () => {}) };
    servers.set(listener.id, server);
    vi.spyOn(utils, 'atomicRename').mockRejectedValueOnce(new Error('simulated full disk'));
    return server as unknown as ProxyServer;
  });
  await expect(
    manager.control('proxy/start', { owner, id: entry.id, token: 'private-token' })
  ).rejects.toThrow('Failed to save sessions');
  expect(servers.get(entry.id)?.stop).toHaveBeenCalledTimes(1);
  expect((await getSession(name))?.proxyListeners?.[0]?.state).toBe('pending');
});

it('closes a bound listener when stop commits during bind and never resurrects it', async () => {
  const entry = await pending();
  create.mockImplementationOnce(async (listener) => {
    const server = { stop: vi.fn(async () => {}) };
    servers.set(listener.id, server);
    await stopProxyListener(name, owner, entry.id);
    return server as unknown as ProxyServer;
  });
  await expect(
    manager.control('proxy/start', { owner, id: entry.id, token: 'private-token' })
  ).rejects.toThrow('cancelled');
  expect(servers.get(entry.id)?.stop).toHaveBeenCalledTimes(1);
  create.mockClear();
  await manager.restore({ [entry.id]: 'private-token' });
  expect(create).not.toHaveBeenCalled();
});

it('fences an old bridge when a new owner takes over during bind', async () => {
  const entry = await pending();
  create.mockImplementationOnce(async (listener) => {
    const server = { stop: vi.fn(async () => {}) };
    servers.set(listener.id, server);
    await updateSession(name, { bridgeOwner: 'new-owner' });
    return server as unknown as ProxyServer;
  });
  await expect(
    manager.control('proxy/start', { owner, id: entry.id, token: 'private-token' })
  ).rejects.toThrow('changed');
  expect(servers.get(entry.id)?.stop).toHaveBeenCalledTimes(1);
  expect((await getSession(name))?.bridgeOwner).toBe('new-owner');
  expect((await getSession(name))?.proxyListeners?.[0]?.state).toBe('pending');
});

it('keeps list and stop available without upstream readiness, but rejects attach', async () => {
  const entry = await pending();
  ready = false;
  await updateSession(name, { status: 'expired' });
  expect(await manager.control('proxy/capabilities', undefined)).toMatchObject({ ready: false });
  await expect(
    manager.control('proxy/start', { owner, id: entry.id, token: 'private-token' })
  ).rejects.toThrow('not ready');
  await stopProxyListener(name, owner, entry.id);
  expect(await manager.control('proxy/stop', { owner, id: entry.id })).toEqual({ stopped: true });
  expect(await manager.control('proxy/list', { owner })).toEqual({
    listeners: [{ id: entry.id, status: 'stopped' }],
  });
  expect(create).not.toHaveBeenCalled();
});

it('refuses missing bearer credentials and does not accidentally authenticate a no-auth listener', async () => {
  const bearer = await pending();
  await expect(manager.control('proxy/start', { owner, id: bearer.id })).rejects.toThrow(
    'bearer token is required'
  );
  const anonymous = await pending('anonymous', 'none');
  await expect(
    manager.control('proxy/start', { owner, id: anonymous.id, token: 'mismatch' })
  ).rejects.toThrow('configured without');
  expect(create).not.toHaveBeenCalled();
});
