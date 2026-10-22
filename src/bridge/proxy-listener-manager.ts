/** Bridge-owned listeners. Control never waits for an upstream MCP operation. */
import type { ProxyServer } from './proxy-server.js';
import type { BridgeOwner, ProxyListener, ProxyObservation, SessionData } from '../lib/types.js';
import { DISCONNECTED_THRESHOLD_MILLIS } from '../lib/types.js';
import { assertSessionNotDeleting, getSession, modifySession } from '../lib/sessions.js';
import {
  activateProxyListener,
  assertBridgeOwner,
  configuredProxyListeners,
  PROXY_CONTROL_VERSION,
} from '../lib/proxy-listeners.js';
import { assertProxyControlPlatform, verifyBridgeEndpoint } from '../lib/bridge-trust.js';
import { ClientError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('proxy-listeners');
const RECONCILE_INTERVAL_MILLIS = 5_000;

export interface ProxyListenerManagerOptions {
  sessionName: string;
  owner: BridgeOwner;
  socketPath: string;
  ready: () => boolean;
  create: (listener: ProxyListener, token?: string) => Promise<ProxyServer>;
}

function safeListenError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'EADDRINUSE') return 'Listen address is already in use.';
  if (code === 'EACCES') return 'Permission denied for listen address.';
  return 'Could not start listener. Check its address, credentials, and session logs.';
}

export class ProxyListenerManager {
  private running = new Map<string, { listener: ProxyListener; server: ProxyServer }>();
  private observations = new Map<string, ProxyObservation>();
  private tail: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private closing = false;

  constructor(private readonly options: ProxyListenerManagerOptions) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }

  private async current(): Promise<SessionData> {
    const current = await getSession(this.options.sessionName);
    if (!current) throw new ClientError('Proxy session no longer exists.');
    assertSessionNotDeleting(current);
    assertBridgeOwner(current, this.options.owner);
    if (this.closing) throw new ClientError('Session bridge is shutting down.');
    return current;
  }

  private async publish(): Promise<void> {
    const listeners = [...this.observations.values()];
    try {
      await modifySession(this.options.sessionName, (current) => {
        assertBridgeOwner(current, this.options.owner);
        const proxyObservations = { bridgeOwner: this.options.owner.bridgeOwner, listeners };
        return JSON.stringify(current.proxyObservations) === JSON.stringify(proxyObservations)
          ? undefined
          : { proxyObservations };
      });
    } catch {
      // The desired-state commit is authoritative. Observation persistence is optional.
      logger.warn('Could not persist proxy observations.');
    }
  }

  private observe(id: string, status: ProxyObservation['status'], error?: string): void {
    this.observations.set(id, { id, status, ...(error && { error }) });
  }

  private async closeOne(id: string): Promise<void> {
    const running = this.running.get(id);
    if (running) {
      await running.server.stop();
      this.running.delete(id);
    }
    this.observe(id, 'stopped');
  }

  /** Optional restore failures leave the upstream session usable and remain visible. */
  async restore(tokens: Record<string, string>, legacyToken?: string): Promise<void> {
    await this.serial(async () => {
      const current = await this.current();
      for (const listener of configuredProxyListeners(current)) {
        if (listener.state !== 'active') continue;
        if (!listener.legacy && process.platform === 'win32') {
          this.observe(
            listener.id,
            'failed',
            'Named proxy restoration is not supported on Windows.'
          );
          continue;
        }
        const token = listener.legacy
          ? legacyToken
          : listener.authentication === 'bearer'
            ? tokens[listener.id]
            : undefined;
        if (listener.authentication === 'bearer' && !token) {
          this.observe(
            listener.id,
            'failed',
            'Required bearer token is missing or unavailable in the keychain.'
          );
          continue;
        }
        let server: ProxyServer | undefined;
        try {
          server = await this.options.create(listener, token);
          const latest = await this.current();
          const desired = configuredProxyListeners(latest).find(
            (entry) => entry.id === listener.id
          );
          if (
            !desired ||
            desired.state !== 'active' ||
            desired.host !== listener.host ||
            desired.port !== listener.port
          ) {
            await server.stop();
            this.observe(listener.id, 'stopped');
            continue;
          }
          this.running.set(listener.id, { listener, server });
          this.observe(listener.id, 'running');
        } catch (error) {
          await server?.stop();
          this.observe(listener.id, 'failed', safeListenError(error));
        }
      }
      await this.publish();
      this.scheduleReconcile();
    });
  }

  private scheduleReconcile(): void {
    if (this.closing || this.timer || this.running.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.serial(() => this.reconcile())
        .catch(() => {
          logger.warn('Could not reconcile proxy desired state.');
        })
        .finally(() => this.scheduleReconcile());
    }, RECONCILE_INTERVAL_MILLIS);
    this.timer.unref();
  }

  /** Never restore here: removals converge; a failed start needs an explicit retry/restart. */
  private async reconcile(): Promise<void> {
    const current = await getSession(this.options.sessionName);
    const owned =
      current &&
      current.createdAt === this.options.owner.createdAt &&
      current.bridgeOwner === this.options.owner.bridgeOwner &&
      current.pid === this.options.owner.pid;
    const desired = owned ? configuredProxyListeners(current) : [];
    for (const [id, running] of this.running) {
      const entry = desired.find((listener) => listener.id === id);
      if (
        !entry ||
        entry.state !== 'active' ||
        entry.host !== running.listener.host ||
        entry.port !== running.listener.port
      ) {
        await this.closeOne(id);
      }
    }
    for (const id of this.observations.keys()) {
      if (!this.running.has(id) && !desired.some((entry) => entry.id === id))
        this.observations.delete(id);
    }
    if (owned) await this.publish();
  }

  async control(method: string, params: unknown): Promise<unknown> {
    assertProxyControlPlatform();
    await verifyBridgeEndpoint(this.options.socketPath);
    const current = await this.current();
    if (method === 'proxy/capabilities') {
      return { version: PROXY_CONTROL_VERSION, ...this.options.owner, ready: this.options.ready() };
    }
    if (typeof params !== 'object' || params === null)
      throw new ClientError('Missing proxy control parameters.');
    const request = params as { owner?: BridgeOwner; id?: string; token?: string };
    if (!request.owner) throw new ClientError('Missing proxy bridge owner.');
    assertBridgeOwner(current, request.owner);
    return this.serial(async () => {
      const latest = await this.current();
      assertBridgeOwner(latest, request.owner as BridgeOwner);
      if (method === 'proxy/list') {
        await this.reconcile();
        return { listeners: [...this.observations.values()] };
      }
      if (typeof request.id !== 'string') throw new ClientError('Missing proxy listener identity.');
      if (method === 'proxy/stop') {
        const entry = configuredProxyListeners(latest).find(
          (listener) => listener.id === request.id
        );
        if (entry?.state === 'active' || entry?.state === 'pending') {
          throw new ClientError('Proxy stop must be persisted before closing its listener.');
        }
        await this.closeOne(request.id);
        await this.publish();
        return { stopped: true };
      }
      if (method !== 'proxy/start') throw new ClientError('Unknown proxy control method.');
      const entry = latest.proxyListeners?.find((listener) => listener.id === request.id);
      if (!entry || entry.legacy || entry.state !== 'pending')
        throw new ClientError('Proxy start is no longer pending.');
      if (
        !this.options.ready() ||
        latest.status !== 'active' ||
        !latest.lastSeenAt ||
        Date.now() - Date.parse(latest.lastSeenAt) > DISCONNECTED_THRESHOLD_MILLIS
      ) {
        throw new ClientError(
          'Upstream session is not ready. Restore it explicitly before attaching a proxy.'
        );
      }
      if (
        entry.authentication === 'bearer' &&
        (typeof request.token !== 'string' || !request.token)
      ) {
        throw new ClientError('A bearer token is required for this listener.');
      }
      if (entry.authentication === 'none' && request.token !== undefined) {
        throw new ClientError('This listener was configured without bearer authentication.');
      }
      if (entry.credentialWriterPid !== undefined)
        throw new ClientError('Proxy credentials are still being written.');
      let server: ProxyServer | undefined;
      try {
        server = await this.options.create(entry, request.token);
        await activateProxyListener(this.options.sessionName, this.options.owner, entry.id);
      } catch (error) {
        await server?.stop();
        this.observe(entry.id, 'failed', safeListenError(error));
        await this.publish();
        if (error instanceof ClientError) throw error;
        throw new ClientError(safeListenError(error));
      }
      this.running.set(entry.id, { listener: entry, server });
      this.observe(entry.id, 'running');
      await this.publish();
      this.scheduleReconcile();
      return { started: true };
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.serial(async () => {
      // A failure closing one listener must not leave its siblings running.
      const results = await Promise.allSettled(
        [...this.running.keys()].map((id) => this.closeOne(id))
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    });
  }
}
