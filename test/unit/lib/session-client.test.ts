/**
 * Unit tests for SessionClient retry semantics (withRetry).
 *
 * The critical invariants under test:
 * - An IPC timeout is NEVER retried and never restarts the bridge — the bridge
 *   is likely healthy and still processing the request; restarting would kill
 *   it and retrying could execute a non-idempotent tool call twice.
 * - A socket failure restarts the bridge, but non-idempotent operations
 *   (tool calls) are NOT re-executed — the server may already have run them.
 * - Idempotent operations (listTools etc.) are retried once after restart.
 */

import { vi } from 'vitest';
import { NetworkError, IpcTimeoutError, ServerError } from '../../../src/lib/errors.js';

const restartBridge = vi.fn(async () => ({ pid: 4242 }));
const updateSession = vi.fn(async () => {});
const connect = vi.fn(async () => {});
const replacementRequest = vi.fn(async () => ({ tools: [] }));

vi.mock('../../../src/lib/bridge-manager.js', () => ({
  restartBridge: (...args: unknown[]) => restartBridge(...(args as [])),
  ensureBridgeReady: vi.fn(),
}));

vi.mock('../../../src/lib/sessions.js', () => ({
  updateSession: (...args: unknown[]) => updateSession(...(args as [])),
}));

// The BridgeClient created after a restart must not touch a real socket.
vi.mock('../../../src/lib/bridge-client.js', () => ({
  BridgeClient: class {
    connect = connect;
    close = vi.fn(async () => {});
    request = replacementRequest;
    on = vi.fn();
    removeListener = vi.fn();
  },
}));

import { SessionClient } from '../../../src/lib/session-client.js';
import type { BridgeClient } from '../../../src/lib/bridge-client.js';

/** Build a fake initial BridgeClient whose request() behaves as instructed. */
function fakeBridgeClient(request: (...args: unknown[]) => Promise<unknown>): BridgeClient {
  return {
    request: vi.fn(request),
    close: vi.fn(async () => {}),
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as BridgeClient;
}

beforeEach(() => {
  restartBridge.mockClear();
  updateSession.mockClear();
  connect.mockClear();
  replacementRequest.mockClear();
});

describe('SessionClient.withRetry', () => {
  it('does not restart or retry on an IPC timeout (tool call)', async () => {
    const bridge = fakeBridgeClient(async () => {
      throw new IpcTimeoutError('Request timeout: callTool');
    });
    const client = new SessionClient('@test', bridge);

    await expect(client.callTool('deploy', {})).rejects.toThrow(/may still be running/);
    expect(bridge.request).toHaveBeenCalledTimes(1);
    expect(restartBridge).not.toHaveBeenCalled();
  });

  it('does not restart or retry on an IPC timeout (idempotent op)', async () => {
    const bridge = fakeBridgeClient(async () => {
      throw new IpcTimeoutError('Request timeout: listTools');
    });
    const client = new SessionClient('@test', bridge);

    await expect(client.listTools()).rejects.toThrow(IpcTimeoutError);
    expect(restartBridge).not.toHaveBeenCalled();
  });

  it('restarts the bridge but does NOT re-execute a tool call on socket failure', async () => {
    const bridge = fakeBridgeClient(async () => {
      throw new NetworkError('Socket closed');
    });
    const client = new SessionClient('@test', bridge);

    await expect(client.callTool('deploy', {})).rejects.toThrow(/may or may not have executed/);
    // Original request attempted once; the replacement client never re-sends it
    expect(bridge.request).toHaveBeenCalledTimes(1);
    expect(replacementRequest).not.toHaveBeenCalled();
    // ...but the bridge WAS restarted so the session recovers
    expect(restartBridge).toHaveBeenCalledTimes(1);
  });

  it('restarts the bridge and retries an idempotent operation once on socket failure', async () => {
    const bridge = fakeBridgeClient(async () => {
      throw new NetworkError('Socket closed');
    });
    const client = new SessionClient('@test', bridge);

    const result = await client.listTools();
    expect(result).toEqual({ tools: [] });
    expect(restartBridge).toHaveBeenCalledTimes(1);
    expect(replacementRequest).toHaveBeenCalledTimes(1);
  });

  it('does not retry MCP-level errors', async () => {
    const bridge = fakeBridgeClient(async () => {
      throw new ServerError('Tool execution failed');
    });
    const client = new SessionClient('@test', bridge);

    await expect(client.listTools()).rejects.toThrow(/Tool execution failed/);
    expect(restartBridge).not.toHaveBeenCalled();
  });
});
