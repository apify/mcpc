import { vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../../../src/lib/auth/keychain.js', () => ({
  removeKeychainProxyListenerToken: vi.fn(async () => true),
  removeKeychainProxyBearerToken: vi.fn(async () => true),
  removeKeychainSessionHeaders: vi.fn(async () => true),
  removeKeychainSessionEnv: vi.fn(async () => true),
}));
vi.mock('../../../src/lib/bridge-manager.js', () => ({ stopBridge: vi.fn(async () => {}) }));

import {
  activateProxyListener,
  configuredProxyListeners,
  finishProxyCredentialWrite,
  parseProxyListen,
  reserveProxyListener,
  retireProxyCredential,
  stopProxyListener,
  updateOwnedSession,
} from '../../../src/lib/proxy-listeners.js';
import { claimBridgeOwner } from '../../../src/lib/bridge-ownership.js';
import { stopBridge } from '../../../src/lib/bridge-manager.js';
import * as utils from '../../../src/lib/utils.js';
import {
  consolidateSessions,
  deleteSession,
  getSession,
  saveSession,
  updateSession,
} from '../../../src/lib/sessions.js';
import {
  removeKeychainProxyBearerToken,
  removeKeychainProxyListenerToken,
  removeKeychainSessionHeaders,
} from '../../../src/lib/auth/keychain.js';
import type { BridgeOwner, SessionData } from '../../../src/lib/types.js';

let homeDir: string;
let originalHome: string | undefined;
let owner: BridgeOwner;
const name = '@proxy-state';
const config = (listenerName: string, port = 8001) => ({
  name: listenerName,
  host: '127.0.0.1',
  port,
  authentication: 'bearer' as const,
});

beforeEach(async () => {
  vi.clearAllMocks();
  homeDir = await mkdtemp(join(tmpdir(), 'mcpc-proxy-state-'));
  originalHome = process.env.MCPC_HOME_DIR;
  process.env.MCPC_HOME_DIR = homeDir;
  await saveSession(name, {
    server: { url: 'https://example.test' },
    createdAt: '',
    pid: process.pid,
    bridgeOwner: 'owner-a',
  });
  const session = (await getSession(name)) as SessionData;
  owner = { createdAt: session.createdAt, pid: process.pid, bridgeOwner: 'owner-a' };
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.MCPC_HOME_DIR;
  else process.env.MCPC_HOME_DIR = originalHome;
  await rm(homeDir, { recursive: true, force: true });
});

it('composes independent reservations and promotions without losing a sibling or metadata', async () => {
  const [a, b] = await Promise.all([
    reserveProxyListener(name, owner, config('a')),
    reserveProxyListener(name, owner, config('b', 8002)),
  ]);
  await Promise.all([
    finishProxyCredentialWrite(name, owner.createdAt, a.id),
    finishProxyCredentialWrite(name, owner.createdAt, b.id),
  ]);
  await Promise.all([
    activateProxyListener(name, owner, a.id),
    activateProxyListener(name, owner, b.id),
    updateOwnedSession(name, owner, { lastSeenAt: 'fresh' }),
  ]);
  const session = await getSession(name);
  expect(session?.proxyListeners?.map((entry) => entry.state)).toEqual(['active', 'active']);
  expect(session?.proxyRevision).toBe(6);
  expect(session?.lastSeenAt).toBe('fresh');
});

it('rejects a duplicate name/address and activation before credential write completion', async () => {
  const a = await reserveProxyListener(name, owner, config('a'));
  await expect(reserveProxyListener(name, owner, config('a', 8002))).rejects.toThrow(
    'already exists'
  );
  await expect(reserveProxyListener(name, owner, config('b'))).rejects.toThrow('listen address');
  await expect(activateProxyListener(name, owner, a.id)).rejects.toThrow(
    'credentials are still being written'
  );
  expect((await getSession(name))?.proxyListeners).toEqual([a]);
});

it('does not forget or clean a pending credential writer that may still finish after stop', async () => {
  const a = await reserveProxyListener(name, owner, config('a'));
  await stopProxyListener(name, owner, a.id);
  expect(await retireProxyCredential(name, owner.createdAt, a.id, true)).toBe(false);
  expect(removeKeychainProxyListenerToken).not.toHaveBeenCalled();
  await finishProxyCredentialWrite(name, owner.createdAt, a.id);
  await expect(activateProxyListener(name, owner, a.id)).rejects.toThrow('cancelled');
  expect(await retireProxyCredential(name, owner.createdAt, a.id, true)).toBe(true);
  expect(removeKeychainProxyListenerToken).toHaveBeenCalledWith(a.id);
  expect((await getSession(name))?.proxyListeners).toEqual([]);
});

it('retains unconfirmed stop and keychain-failure receipts, and never deletes a reused name token', async () => {
  const a = await reserveProxyListener(name, owner, config('a'));
  await finishProxyCredentialWrite(name, owner.createdAt, a.id);
  await activateProxyListener(name, owner, a.id);
  await stopProxyListener(name, owner, a.id);
  vi.mocked(removeKeychainProxyListenerToken).mockRejectedValueOnce(
    new Error('keychain unavailable')
  );
  await expect(retireProxyCredential(name, owner.createdAt, a.id, true)).rejects.toThrow(
    'unavailable'
  );
  expect((await getSession(name))?.proxyListeners?.[0]?.state).toBe('stopped');
  await retireProxyCredential(name, owner.createdAt, a.id, false);
  expect((await getSession(name))?.proxyListeners).toHaveLength(1);
  await retireProxyCredential(name, owner.createdAt, a.id, true);
  const b = await reserveProxyListener(name, owner, config('a'));
  vi.mocked(removeKeychainProxyListenerToken).mockClear();
  await retireProxyCredential(name, owner.createdAt, a.id, true);
  expect(b.id).not.toBe(a.id);
  expect(removeKeychainProxyListenerToken).not.toHaveBeenCalled();
});

it('fences stale owner, PID and session generations without replacing newer desired state', async () => {
  const a = await reserveProxyListener(name, owner, config('a'));
  await finishProxyCredentialWrite(name, owner.createdAt, a.id);
  await updateSession(name, { bridgeOwner: 'owner-b' });
  const before = await readFile(join(homeDir, 'sessions.json'), 'utf8');
  await expect(activateProxyListener(name, owner, a.id)).rejects.toThrow('changed');
  await expect(stopProxyListener(name, owner, a.id)).rejects.toThrow('changed');
  await expect(updateOwnedSession(name, owner, { pid: 1, lastSeenAt: 'stale' })).rejects.toThrow(
    'changed'
  );
  expect(await readFile(join(homeDir, 'sessions.json'), 'utf8')).toBe(before);
});

it('lists legacy without migration and retains its token until the config has gone and session closes', async () => {
  await updateSession(name, { proxy: { host: '127.0.0.1', port: 8000, requireBearerToken: true } });
  const before = await readFile(join(homeDir, 'sessions.json'), 'utf8');
  const session = (await getSession(name)) as SessionData;
  expect(configuredProxyListeners(session)).toMatchObject([
    { name: 'legacy', authentication: 'bearer' },
  ]);
  expect(await readFile(join(homeDir, 'sessions.json'), 'utf8')).toBe(before);
  await stopProxyListener(name, owner, 'legacy');
  await retireProxyCredential(name, owner.createdAt, 'legacy', true);
  expect((await getSession(name))?.proxy).toBeUndefined();
  expect(removeKeychainProxyBearerToken).not.toHaveBeenCalled();
});

it('refuses session deletion with a live listener owner and keeps receipts after cleanup failure', async () => {
  const a = await reserveProxyListener(name, owner, config('a'));
  await finishProxyCredentialWrite(name, owner.createdAt, a.id);
  await expect(deleteSession(name)).rejects.toThrow('live proxy owner');
  await updateSession(name, { pid: 2147483647 });
  vi.mocked(removeKeychainProxyListenerToken).mockRejectedValueOnce(new Error('cleanup failed'));
  await expect(deleteSession(name)).rejects.toThrow('cleanup failed');
  expect((await getSession(name))?.proxyListeners?.[0]?.id).toBe(a.id);
  await deleteSession(name);
  expect(await getSession(name)).toBeUndefined();
});

it('refuses duplicate bridge launch and does not overwrite a simultaneous proxy change', async () => {
  const before = (await getSession(name)) as SessionData;
  await expect(claimBridgeOwner(name, before, 'owner-b', 12345)).rejects.toThrow('live bridge');
  await updateSession(name, { pid: 2147483647 });
  const stopped = (await getSession(name)) as SessionData;
  await updateSession(name, { proxyRevision: 1 });
  await expect(claimBridgeOwner(name, stopped, 'owner-b', 12345)).rejects.toThrow(
    'Proxy configuration changed'
  );
});

it('does not replace a concurrently created session or delete a newly claimed owner', async () => {
  const before = await readFile(join(homeDir, 'sessions.json'), 'utf8');
  await expect(
    saveSession(name, { server: { command: 'different' }, createdAt: '' }, { createOnly: true })
  ).rejects.toThrow('created concurrently');
  expect(await readFile(join(homeDir, 'sessions.json'), 'utf8')).toBe(before);
  await updateSession(name, { bridgeOwner: 'new-owner', pid: 2147483647 });
  await expect(deleteSession(name, owner)).rejects.toThrow('changed before deletion');
  expect((await getSession(name))?.bridgeOwner).toBe('new-owner');
  expect(removeKeychainProxyListenerToken).not.toHaveBeenCalled();
});

it('reserves one cleanup worker outside the shared lock and preserves sibling writes', async () => {
  const entry = await reserveProxyListener(name, owner, config('a'));
  await finishProxyCredentialWrite(name, owner.createdAt, entry.id);
  await updateSession(name, { pid: 2147483647 });
  await saveSession('@sibling', { server: { url: 'https://other.test' }, createdAt: '' });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(removeKeychainProxyListenerToken).mockImplementationOnce(async () => {
    entered();
    await blocked;
    return true;
  });
  const deleting = deleteSession(name);
  try {
    await started;
    expect((await getSession(name))?.deletion?.workerPid).toBe(process.pid);
    await updateSession('@sibling', { lastSeenAt: 'written during native cleanup' });
    await expect(deleteSession(name)).rejects.toThrow('already has a cleanup worker');
    await expect(updateSession(name, { status: 'active' })).rejects.toThrow('pending deletion');
    await expect(reserveProxyListener(name, owner, config('b'))).rejects.toThrow(
      'pending deletion'
    );
    await expect(
      saveSession(name, { server: { command: 'replacement' }, createdAt: '' })
    ).rejects.toThrow('pending deletion');
    expect((await consolidateSessions(false)).sessionsToRestart).not.toContain(name);
  } finally {
    release();
    await deleting;
  }
  expect(await getSession(name)).toBeUndefined();
  expect((await getSession('@sibling'))?.lastSeenAt).toBe('written during native cleanup');
  expect(removeKeychainProxyListenerToken).toHaveBeenCalledTimes(1);
});

it('keeps a retryable reservation after partial cleanup and does not admit a new owner', async () => {
  const entry = await reserveProxyListener(name, owner, config('a'));
  await finishProxyCredentialWrite(name, owner.createdAt, entry.id);
  await updateSession(name, { pid: 2147483647 });
  vi.mocked(removeKeychainSessionHeaders).mockRejectedValueOnce(
    new Error('native keychain denied')
  );
  await expect(deleteSession(name)).rejects.toThrow('native keychain denied');
  const pending = (await getSession(name)) as SessionData;
  expect(pending.deletion?.id).toBeTypeOf('string');
  expect(pending.deletion).not.toHaveProperty('workerPid');
  await expect(claimBridgeOwner(name, pending, 'replacement-owner', 12345)).rejects.toThrow(
    'pending deletion'
  );
  await deleteSession(name, pending);
  expect(await getSession(name)).toBeUndefined();
});

it('reserves close before shutdown so shared-home consolidation cannot restart its owner', async () => {
  const actualAlive = utils.isProcessAlive;
  let alive = true;
  const liveness = vi
    .spyOn(utils, 'isProcessAlive')
    .mockImplementation((pid) => (pid === process.pid ? alive : actualAlive(pid)));
  vi.mocked(stopBridge).mockImplementationOnce(async (_name, options) => {
    expect(options).toMatchObject({ graceful: true, expected: owner });
    expect((await getSession(name))?.deletion?.workerPid).toBe(process.pid);
    alive = false;
    const result = await consolidateSessions(false);
    expect(result.sessionsToRestart).not.toContain(name);
    expect(result.sessions[name]?.pid).toBe(owner.pid);
    await expect(
      claimBridgeOwner(name, result.sessions[name]!, 'interloper', 12345)
    ).rejects.toThrow('pending deletion');
  });
  try {
    await deleteSession(name, owner, { shutdownBridge: true });
    expect(await getSession(name)).toBeUndefined();
  } finally {
    liveness.mockRestore();
  }
});

it('keeps close reserved without touching credentials when bridge shutdown fails', async () => {
  vi.mocked(stopBridge).mockRejectedValueOnce(new Error('bridge did not exit'));
  await expect(deleteSession(name, owner, { shutdownBridge: true })).rejects.toThrow(
    'did not exit'
  );
  expect((await getSession(name))?.deletion).toEqual({ id: expect.any(String) });
  expect(removeKeychainSessionHeaders).not.toHaveBeenCalled();
  await expect(
    claimBridgeOwner(name, (await getSession(name))!, 'interloper', 12345)
  ).rejects.toThrow('pending deletion');
});

it('does not auto-restart an explicit restart intent when its old PID exits', async () => {
  await updateSession(name, {
    pid: 2147483647,
    status: 'reconnecting',
    lastConnectionAttemptAt: new Date().toISOString(),
  });
  const result = await consolidateSessions(false);
  expect(result.sessionsToRestart).not.toContain(name);
  expect(result.sessions[name]?.status).toBe('reconnecting');

  await updateSession(name, {
    lastConnectionAttemptAt: new Date(Date.now() - 11_000).toISOString(),
  });
  const retry = await consolidateSessions(false);
  expect(retry.sessionsToRestart).toContain(name);
  expect(retry.sessions[name]?.bridgeOwner).toBe(owner.bridgeOwner);
  expect(retry.sessions[name]?.pid).toBeUndefined();
});

it('reclaims a dead cleanup worker and clean uses the same unlocked credential path', async () => {
  await saveSession('@abandoned', {
    server: { url: 'https://abandoned.test' },
    createdAt: '',
    status: 'expired',
    deletion: { id: 'abandoned-reservation', workerPid: 2147483647 },
  });
  vi.mocked(removeKeychainSessionHeaders).mockImplementationOnce(async () => {
    await updateSession(name, { lastSeenAt: 'concurrent cleanup sibling' });
    return true;
  });
  const result = await consolidateSessions(true);
  expect(result.expiredSessions).toBe(1);
  expect(result.sessions['@abandoned']).toBeUndefined();
  expect(result.sessions[name]?.lastSeenAt).toBe('concurrent cleanup sibling');
});

it.each(['8000junk', '-1', '0', '65536', 'host.test:8080', ':8080', '127.0.0.1:8e3'])(
  'rejects ambiguous listen value %s',
  (value) => {
    expect(() => parseProxyListen(value)).toThrow();
  }
);

it('accepts loopback and explicit IPv4/IPv6 addresses', () => {
  expect(parseProxyListen('8080')).toEqual({ host: '127.0.0.1', port: 8080 });
  expect(parseProxyListen('[::1]:8081')).toEqual({ host: '::1', port: 8081 });
  expect(parseProxyListen('localhost:8082')).toEqual({ host: 'localhost', port: 8082 });
});
