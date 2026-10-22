import { ClientError } from './errors.js';
import { modifySession } from './sessions.js';
import { isProcessAlive } from './utils.js';
import { assertSessionIdentity } from './proxy-listeners.js';
import type { BridgeOwner, SessionData } from './types.js';

/** Claim one spawned lifetime without replacing another live or concurrently started owner. */
export async function claimBridgeOwner(
  name: string,
  previous: SessionData,
  bridgeOwner: string,
  pid: number
): Promise<BridgeOwner> {
  await modifySession(name, (current) => {
    assertSessionIdentity(current, previous);
    if (current.pid && isProcessAlive(current.pid)) {
      throw new ClientError(`Session ${name} already has a live bridge. Use restart explicitly.`);
    }
    if ((current.proxyRevision ?? 0) !== (previous.proxyRevision ?? 0)) {
      throw new ClientError(
        'Proxy configuration changed during bridge startup. Run the command again.'
      );
    }
    return { pid, bridgeOwner };
  });
  return { createdAt: previous.createdAt, bridgeOwner, pid };
}
