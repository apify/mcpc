/** Foreground control plane: no SessionClient, health request, spawn, or reconnect. */
import { BridgeClient } from './bridge-client.js';
import { verifyBridgeEndpoint, verifyProxyHome } from './bridge-trust.js';
import { ClientError, NetworkError, IpcTimeoutError } from './errors.js';
import { assertBridgeOwner, PROXY_CONTROL_VERSION } from './proxy-listeners.js';
import { getSession } from './sessions.js';
import { getSocketPath } from './utils.js';
import type { BridgeOwner, SessionData } from './types.js';

export interface ProxyControl {
  client: BridgeClient;
  owner: BridgeOwner;
  ready: boolean;
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
}

export async function connectProxyControl(session: SessionData): Promise<ProxyControl> {
  await verifyProxyHome();
  if (!session.pid) throw new NetworkError('Session bridge is offline.');
  const socketPath = getSocketPath(session.name, session.pid);
  await verifyBridgeEndpoint(socketPath);
  const client = new BridgeClient(socketPath);
  try {
    await client.connect({ retryTimeoutMillis: 0 });
    // No secrets or mutations until both endpoint trust and capability/owner checks pass.
    let capabilities;
    try {
      capabilities = await client.controlRequest('proxy/capabilities');
    } catch (error) {
      if (error instanceof ClientError || error instanceof IpcTimeoutError) {
        throw new ClientError(
          `Bridge does not support proxy management. Run: mcpc ${session.name} restart`
        );
      }
      throw error;
    }
    const result = capabilities as Partial<BridgeOwner> & { version?: number; ready?: boolean };
    if (
      result?.version !== PROXY_CONTROL_VERSION ||
      typeof result.bridgeOwner !== 'string' ||
      !result.bridgeOwner ||
      result.createdAt !== session.createdAt ||
      result.pid !== session.pid ||
      result.bridgeOwner !== session.bridgeOwner
    ) {
      throw new ClientError(
        `Bridge does not support this proxy owner. Run: mcpc ${session.name} restart`
      );
    }
    const owner: BridgeOwner = {
      createdAt: result.createdAt,
      pid: result.pid,
      bridgeOwner: result.bridgeOwner,
    };
    return {
      client,
      owner,
      ready: result.ready === true,
      request: async (method, params = {}) => {
        await verifyBridgeEndpoint(socketPath);
        const latest = await getSession(session.name);
        if (!latest) throw new ClientError('Proxy session no longer exists.');
        assertBridgeOwner(latest, owner);
        return client.controlRequest(method, { ...params, owner });
      },
      close: () => client.close(),
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}
