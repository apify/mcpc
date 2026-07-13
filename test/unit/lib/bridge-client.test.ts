/**
 * Unit tests for BridgeClient connection behaviour.
 *
 * Focused on the connect() retry path: a freshly spawned bridge may not be
 * accepting connections yet (e.g. a stale socket left by a prior bridge that
 * reused the same PID), and the first connect must wait that out instead of
 * failing the command. See bridge-manager.startBridge / restartSession.
 */

import net from 'net';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BridgeClient } from '../../../src/lib/bridge-client.js';

// Unix domain sockets only; Windows uses named pipes with different semantics.
const onWindows = process.platform === 'win32';

describe.skipIf(onWindows)('BridgeClient.connect retry', () => {
  const sockets: string[] = [];
  const servers: net.Server[] = [];
  const clients: BridgeClient[] = [];

  function sockPath(): string {
    const p = join(tmpdir(), `mcpc-bc-test-${Math.random().toString(36).slice(2)}.sock`);
    sockets.push(p);
    return p;
  }

  function listen(p: string): Promise<net.Server> {
    return new Promise((resolve) => {
      const server = net.createServer((conn) => conn.on('error', () => {}));
      servers.push(server);
      server.listen(p, () => resolve(server));
    });
  }

  afterEach(async () => {
    for (const client of clients) await client.close().catch(() => {});
    clients.length = 0;
    for (const server of servers) server.close();
    servers.length = 0;
    for (const p of sockets) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        // ignore
      }
    }
    sockets.length = 0;
  });

  // Generous timeout (default retry budget equals vitest's default 5s timeout) so
  // there is headroom for CPU contention when the whole suite runs in parallel.
  it(
    'retries transient errors by default until the bridge socket starts listening',
    { timeout: 20_000 },
    async () => {
      const p = sockPath();
      const client = new BridgeClient(p);
      clients.push(client);

      // The "bridge" only starts accepting connections after a short delay.
      setTimeout(() => void listen(p), 150);

      // No options: the default retry budget must ride out the not-yet-listening window.
      await expect(client.connect()).resolves.toBeUndefined();
    }
  );

  it('gives up with a NetworkError after the retry budget elapses', async () => {
    const p = sockPath(); // nothing ever listens here
    const client = new BridgeClient(p);
    clients.push(client);

    const start = Date.now();
    await expect(client.connect({ retryTimeoutMillis: 400 })).rejects.toThrow(
      /Failed to connect to bridge/
    );
    // It should have spent roughly the budget retrying, not failed immediately.
    expect(Date.now() - start).toBeGreaterThanOrEqual(300);
  });

  it('fails fast when retryTimeoutMillis is 0', async () => {
    const p = sockPath(); // nothing listens here
    const client = new BridgeClient(p);
    clients.push(client);

    const start = Date.now();
    await expect(client.connect({ retryTimeoutMillis: 0 })).rejects.toThrow(
      /Failed to connect to bridge/
    );
    // Well under the 5s default retry budget — proves it did not retry. The wide
    // margin keeps this robust under parallel-suite CPU contention.
    expect(Date.now() - start).toBeLessThan(2500);
  });
});
