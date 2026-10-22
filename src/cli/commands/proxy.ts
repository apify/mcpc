import { constants } from 'fs';
import { open } from 'fs/promises';
import chalk from 'chalk';
import { ClientError, NetworkError } from '../../lib/errors.js';
import { getSession } from '../../lib/sessions.js';
import { isProcessAlive, isValidSessionName } from '../../lib/utils.js';
import { verifyProxyHome } from '../../lib/bridge-trust.js';
import { connectProxyControl, type ProxyControl } from '../../lib/proxy-control.js';
import {
  configuredProxyListeners,
  finishProxyCredentialWrite,
  parseProxyListen,
  reserveProxyListener,
  retireProxyCredential,
  stopProxyListener,
  validateProxyName,
} from '../../lib/proxy-listeners.js';
import { storeKeychainProxyListenerToken } from '../../lib/auth/keychain.js';
import type { OutputMode, ProxyListener, ProxyObservation, SessionData } from '../../lib/types.js';
import { formatJson } from '../output.js';

export interface ProxyCommandOptions {
  outputMode: OutputMode;
  name?: string;
  listen?: string;
  stop?: string;
  bearerTokenFile?: string;
  noAuth?: boolean;
}

function offline(error: unknown): boolean {
  return (
    error instanceof NetworkError ||
    ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException)?.code ?? '')
  );
}

async function readToken(path: string): Promise<string> {
  // A FIFO must fail the regular-file check instead of blocking before stat().
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8192)
      throw new ClientError('Bearer token file must be a regular file of at most 8 KiB.');
    // Bound the read even if another process grows the file after stat().
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const token = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (bytesRead > 8192 || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token) || token.length > 4096) {
      throw new ClientError(
        'Bearer token file must contain one nonempty bearer token (at most 4096 characters).'
      );
    }
    return token;
  } finally {
    await file.close();
  }
}

async function snapshot(
  session: SessionData,
  control?: ProxyControl
): Promise<{
  sessionName: string;
  bridge: 'connected' | 'offline' | 'unavailable';
  deletionPending?: true;
  listeners: Array<Record<string, unknown>>;
}> {
  let observations: ProxyObservation[] =
    session.proxyObservations && session.proxyObservations.bridgeOwner === session.bridgeOwner
      ? session.proxyObservations.listeners
      : [];
  let bridge: 'connected' | 'offline' | 'unavailable' =
    session.pid && isProcessAlive(session.pid) ? 'unavailable' : 'offline';
  if (control) {
    try {
      const result = (await control.request('proxy/list')) as { listeners: ProxyObservation[] };
      observations = result.listeners;
      bridge = 'connected';
    } catch {
      // Desired state remains useful even while the owner is unreachable or shutting down.
    }
  }
  return {
    sessionName: session.name,
    bridge,
    ...(session.deletion && { deletionPending: true as const }),
    listeners: configuredProxyListeners(session).map((entry) => {
      const observed = observations.find((item) => item.id === entry.id);
      const observedState =
        entry.state === 'stopped'
          ? bridge === 'offline' || (observed?.status === 'stopped' && bridge === 'connected')
            ? 'stopped'
            : 'stop-pending'
          : bridge === 'connected'
            ? (observed?.status ?? 'not-running')
            : bridge;
      return {
        name: entry.name,
        host: entry.host,
        port: entry.port,
        authentication:
          entry.legacy && !session.proxy?.requireBearerToken ? 'legacy' : entry.authentication,
        desiredState: entry.state,
        observedState,
        ...(entry.legacy && { legacy: true }),
        ...(observed?.error && { error: observed.error }),
      };
    }),
  };
}

function printResult(
  result: Awaited<ReturnType<typeof snapshot>> & {
    stopped?: { name: string; closed: boolean; credentialCleanupPending: boolean };
  },
  mode: OutputMode
): void {
  if (mode === 'json') {
    console.log(formatJson(result));
    return;
  }
  console.log(`Proxy listeners for ${result.sessionName} (bridge ${result.bridge})`);
  if (result.deletionPending)
    console.log(`Session deletion is pending; retry: mcpc ${result.sessionName} close`);
  if (result.listeners.length === 0) console.log('No proxy listeners configured.');
  for (const entry of result.listeners) {
    console.log(
      `  ${entry.name}: ${entry.host}:${entry.port} — ${entry.observedState} (desired ${entry.desiredState}, auth ${entry.authentication})`
    );
    if (entry.error) console.log(`    ${entry.error}`);
  }
  if (result.stopped) {
    console.log(
      result.stopped.closed
        ? `Stopped ${result.stopped.name}.`
        : `Stop saved for ${result.stopped.name}; closure is unconfirmed. The owning bridge may still be listening.`
    );
    if (result.stopped.credentialCleanupPending)
      console.log('Credential cleanup is pending; repeat --stop after the writer exits.');
  }
  console.log(chalk.dim(`Manage listeners with: mcpc proxy ${result.sessionName} --help`));
}

export async function manageProxy(
  sessionName: string,
  options: ProxyCommandOptions
): Promise<void> {
  if (!isValidSessionName(sessionName))
    throw new ClientError('Proxy management requires a saved @session name.');
  if (options.listen && options.stop)
    throw new ClientError('--listen and --stop cannot be combined.');
  if (!options.listen && (options.name || options.bearerTokenFile || options.noAuth)) {
    throw new ClientError('--name, --bearer-token-file and --no-auth require --listen.');
  }
  if (
    options.listen &&
    (!options.name || Boolean(options.bearerTokenFile) === Boolean(options.noAuth))
  ) {
    throw new ClientError(
      'Starting a proxy requires --name and either --bearer-token-file or --no-auth.'
    );
  }
  if (options.name) validateProxyName(options.name);
  if (options.stop) validateProxyName(options.stop);
  const address = options.listen ? parseProxyListen(options.listen) : undefined;
  await verifyProxyHome();
  const session = await getSession(sessionName);
  if (!session) throw new ClientError(`Session not found: ${sessionName}`);

  let control: ProxyControl | undefined;
  try {
    if (session.pid && isProcessAlive(session.pid)) {
      try {
        control = await connectProxyControl(session);
      } catch (error) {
        if (options.listen || (options.stop && (!offline(error) || !session.bridgeOwner)))
          throw error;
      }
    }
    if (address && options.name) {
      if (!control?.ready)
        throw new ClientError(
          `Session bridge is not ready. Restore it with: mcpc ${sessionName} restart`
        );
      const token = options.bearerTokenFile ? await readToken(options.bearerTokenFile) : undefined;
      const entry = await reserveProxyListener(sessionName, control.owner, {
        ...address,
        name: options.name,
        authentication: token === undefined ? 'none' : 'bearer',
      });
      try {
        if (token !== undefined) {
          try {
            await storeKeychainProxyListenerToken(entry.id, token);
          } finally {
            await finishProxyCredentialWrite(sessionName, session.createdAt, entry.id);
          }
        }
        await control.request('proxy/start', {
          id: entry.id,
          ...(token !== undefined && { token }),
        });
      } catch (error) {
        await abandonPending(session, entry, control);
        throw error;
      }
    }

    let stopped: { name: string; closed: boolean; credentialCleanupPending: boolean } | undefined;
    if (options.stop) {
      const entry = configuredProxyListeners(session).find(
        (listener) => listener.name === options.stop
      );
      if (!entry)
        throw new ClientError(`Proxy ${options.stop} not found. Run: mcpc proxy ${sessionName}`);
      await stopProxyListener(sessionName, session, entry.id);
      let closed = !session.pid || !isProcessAlive(session.pid);
      if (control) {
        try {
          await control.request('proxy/stop', { id: entry.id });
          closed = true;
        } catch {
          // The persisted stop is authoritative; never misreport an unconfirmed port closure.
        }
      }
      let credentialCleanupPending = true;
      try {
        credentialCleanupPending = !(await retireProxyCredential(
          sessionName,
          session.createdAt,
          entry.id,
          closed
        ));
      } catch {
        // The stopped entry is a durable cleanup receipt; a later stop/close can retry.
      }
      stopped = { name: entry.name, closed, credentialCleanupPending };
    }
    const latest = await getSession(sessionName);
    if (!latest || latest.createdAt !== session.createdAt)
      throw new ClientError('Session changed during proxy management.');
    printResult(
      { ...(await snapshot(latest, control)), ...(stopped && { stopped }) },
      options.outputMode
    );
  } finally {
    await control?.close();
  }
}

/** A lost reply after activation must not erase a successfully committed listener or token. */
async function abandonPending(
  session: SessionData,
  entry: ProxyListener,
  control: ProxyControl
): Promise<void> {
  try {
    const latest = await getSession(session.name);
    if (!latest || latest.createdAt !== session.createdAt) return;
    const current = latest.proxyListeners?.find((listener) => listener.id === entry.id);
    if (!current || current.state === 'active') return;
    await stopProxyListener(session.name, latest, entry.id);
    let closed = !latest.pid || !isProcessAlive(latest.pid);
    try {
      await control.request('proxy/stop', { id: entry.id });
      closed = true;
    } catch {
      /* retain the tombstone until closure is confirmed */
    }
    await retireProxyCredential(session.name, session.createdAt, entry.id, closed);
  } catch {
    /* durable reservation/stop records keep cleanup retryable */
  }
}
