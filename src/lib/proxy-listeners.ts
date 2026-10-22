/** Durable desired listener state. Every edit composes under the sessions file lock. */
import { randomUUID } from 'crypto';
import { isIP } from 'net';
import { ClientError } from './errors.js';
import { getSession, modifySession, type SessionUpdates } from './sessions.js';
import { isProcessAlive } from './utils.js';
import { removeKeychainProxyListenerToken } from './auth/keychain.js';
import type { BridgeOwner, ProxyListener, SessionData } from './types.js';

export const PROXY_CONTROL_VERSION = 1;
export const LEGACY_PROXY_ID = 'legacy';
export type SessionIdentity = Pick<SessionData, 'createdAt' | 'bridgeOwner' | 'pid'>;

export function assertSessionIdentity(current: SessionData, expected: SessionIdentity): void {
  if (
    current.createdAt !== expected.createdAt ||
    current.bridgeOwner !== expected.bridgeOwner ||
    current.pid !== expected.pid
  ) {
    throw new ClientError('Session bridge changed during proxy management. Run the command again.');
  }
}

export function assertBridgeOwner(current: SessionData, owner: BridgeOwner): void {
  assertSessionIdentity(current, owner);
}

export function validateProxyName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new ClientError('Proxy name must contain 1–64 letters, digits, hyphens or underscores.');
  }
}

export function parseProxyListen(value: string): { host: string; port: number } {
  const match = /^(?:(\[[^\]]+\]|[^:]+):)?([0-9]+)$/.exec(value);
  const host = (match?.[1] ?? '127.0.0.1').replace(/^\[|\]$/g, '').toLowerCase();
  const port = Number(match?.[2]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ClientError('--listen requires [HOST:]PORT, with a port between 1 and 65535.');
  }
  if (host !== 'localhost' && !isIP(host)) {
    throw new ClientError('--listen host must be localhost or an IP address.');
  }
  return { host, port };
}

/** Listing never migrates the old config or changes its matching legacy token. */
export function configuredProxyListeners(session: SessionData): ProxyListener[] {
  const listeners = session.proxyListeners ?? [];
  if (!session.proxy) return listeners;
  return [
    {
      id: LEGACY_PROXY_ID,
      name: 'legacy',
      host: session.proxy.host,
      port: session.proxy.port,
      authentication: session.proxy.requireBearerToken ? 'bearer' : 'none',
      state: 'active',
      legacy: true,
    },
    ...listeners.filter((listener) => !listener.legacy),
  ];
}

function nextState(session: SessionData, listeners: ProxyListener[]): SessionUpdates {
  return { proxyListeners: listeners, proxyRevision: (session.proxyRevision ?? 0) + 1 };
}

export async function updateOwnedSession(
  name: string,
  owner: BridgeOwner,
  updates: SessionUpdates
): Promise<void> {
  await updateSessionForIdentity(name, owner, updates);
}

/** Also fences metadata written by a foreground check of a legacy or stopped bridge. */
export async function updateSessionForIdentity(
  name: string,
  identity: SessionIdentity,
  updates: SessionUpdates
): Promise<void> {
  await modifySession(name, (current) => {
    assertSessionIdentity(current, identity);
    return updates;
  });
}

/** Reserve ownership before the keychain call, including a writer that can finish after stop. */
export async function reserveProxyListener(
  sessionName: string,
  owner: BridgeOwner,
  config: Pick<ProxyListener, 'name' | 'host' | 'port' | 'authentication'>
): Promise<ProxyListener> {
  validateProxyName(config.name);
  if (config.name === 'legacy') throw new ClientError('The proxy name "legacy" is reserved.');
  const entry: ProxyListener = {
    ...config,
    id: randomUUID(),
    state: 'pending',
    ...(config.authentication === 'bearer' && { credentialWriterPid: process.pid }),
  };
  await modifySession(sessionName, (current) => {
    assertBridgeOwner(current, owner);
    const listeners = configuredProxyListeners(current);
    if (listeners.some((listener) => listener.name === entry.name)) {
      throw new ClientError(`Proxy ${entry.name} already exists. Stop it before reusing its name.`);
    }
    if (
      listeners.some(
        (listener) =>
          listener.state !== 'stopped' &&
          listener.host === entry.host &&
          listener.port === entry.port
      )
    ) {
      throw new ClientError('Another proxy already uses this listen address.');
    }
    return nextState(current, [...(current.proxyListeners ?? []), entry]);
  });
  return entry;
}

/** Called even after a partial keychain failure. Stop cannot forget a still-running writer. */
export async function finishProxyCredentialWrite(
  name: string,
  createdAt: string,
  id: string
): Promise<void> {
  await modifySession(name, (current) => {
    if (current.createdAt !== createdAt) throw new ClientError('Proxy session was replaced.');
    const listeners = (current.proxyListeners ?? []).map((entry) => {
      if (entry.id !== id || entry.credentialWriterPid !== process.pid) return entry;
      const { credentialWriterPid: _writer, ...finished } = entry;
      return finished;
    });
    return nextState(current, listeners);
  });
}

/** Bind happens first. Only this commit makes the listener eligible for restoration. */
export async function activateProxyListener(
  name: string,
  owner: BridgeOwner,
  id: string
): Promise<void> {
  await modifySession(name, (current) => {
    assertBridgeOwner(current, owner);
    const entry = current.proxyListeners?.find((listener) => listener.id === id);
    if (!entry || entry.state !== 'pending' || entry.credentialWriterPid !== undefined) {
      throw new ClientError(
        'Proxy start was cancelled or its credentials are still being written.'
      );
    }
    return nextState(
      current,
      (current.proxyListeners ?? []).map((listener) =>
        listener.id === id ? { ...listener, state: 'active' } : listener
      )
    );
  });
}

/** Durably stop the exact entry. An unrelated listener edit never gets overwritten. */
export async function stopProxyListener(
  name: string,
  identity: SessionIdentity,
  id: string
): Promise<ProxyListener> {
  let stopped: ProxyListener | undefined;
  await modifySession(name, (current) => {
    assertSessionIdentity(current, identity);
    const entry = configuredProxyListeners(current).find((listener) => listener.id === id);
    if (!entry) throw new ClientError('Proxy listener changed. List proxies and try again.');
    stopped = { ...entry, state: 'stopped' };
    const listeners = (current.proxyListeners ?? []).filter((listener) => listener.id !== id);
    listeners.push(stopped);
    return {
      ...nextState(current, listeners),
      ...(entry.legacy && { proxy: undefined }),
    };
  });
  if (!stopped) throw new ClientError('Proxy listener not found.');
  return stopped;
}

/**
 * Retire only a stopped UUID whose foreground writer has finished. A lost closure
 * acknowledgement keeps the tombstone so list reports stop-pending. Legacy keys
 * are deliberately retained until close: older binaries still share that account.
 */
export async function retireProxyCredential(
  name: string,
  createdAt: string,
  id: string,
  closureConfirmed: boolean
): Promise<boolean> {
  const current = await getSession(name);
  if (!current || current.createdAt !== createdAt) return false;
  const entry = current.proxyListeners?.find((listener) => listener.id === id);
  if (!entry || entry.state !== 'stopped') return false;
  if (entry.legacy) return true;
  if (entry.credentialWriterPid && isProcessAlive(entry.credentialWriterPid)) return false;
  if (entry.authentication === 'bearer') await removeKeychainProxyListenerToken(entry.id);
  if (!closureConfirmed) return true;
  await modifySession(name, (latest) => {
    if (latest.createdAt !== createdAt) return undefined;
    const candidate = latest.proxyListeners?.find((listener) => listener.id === id);
    if (!candidate || candidate.state !== 'stopped') return undefined;
    return nextState(
      latest,
      (latest.proxyListeners ?? []).filter((listener) => listener.id !== id)
    );
  });
  return true;
}
