/**
 * Unit tests for stopBridge()
 *
 * Two things must hold before a PID is signalled. It must still be this session's bridge
 * (identifyBridgeProcess): PIDs are recycled, and after a reboot the number in
 * sessions.json may belong to any process of the user, which a restart must not SIGTERM.
 * And a bridge that is told to exit must be given time to run its own teardown — the HTTP
 * DELETE that ends the server-side MCP session and the SDK's stdio child shutdown — before
 * a SIGKILL orphans the child.
 *
 * On Windows the graceful IPC shutdown is attempted whenever the bridge's pipe answers, not
 * only when the liveness check says the bridge is running: that check can be wrong (a
 * timed-out `tasklist` reported every PID dead, #427), and a bridge that is never told to
 * exit lives on next to its replacement.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  connect: vi.fn(),
  send: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../../../src/lib/sessions.js', () => ({
  getSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../../../src/lib/utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/utils.js')>();
  return { ...actual, isProcessAlive: vi.fn() };
});

vi.mock('../../../src/lib/bridge-process.js', () => ({
  identifyBridgeProcess: vi.fn(),
  isBridgeProcess: vi.fn(),
}));

vi.mock('../../../src/lib/bridge-client.js', () => ({
  BridgeClient: class {
    connect = ipc.connect;
    send = ipc.send;
    close = ipc.close;
  },
}));

vi.mock('../../../src/lib/auth/keychain.js', () => ({}));
vi.mock('../../../src/lib/auth/profiles.js', () => ({}));

import { getSession } from '../../../src/lib/sessions.js';
import { isProcessAlive } from '../../../src/lib/utils.js';
import { identifyBridgeProcess } from '../../../src/lib/bridge-process.js';
import { stopBridge } from '../../../src/lib/bridge-manager.js';

const REAL_PLATFORM = process.platform;
const SESSION_NAME = '@stop-test';
const BRIDGE_PID = 4242;

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(getSession).mockResolvedValue({
    name: SESSION_NAME,
    pid: BRIDGE_PID,
    server: { url: 'https://mcp.example.com' },
  } as never);
  vi.mocked(identifyBridgeProcess).mockReset().mockResolvedValue('bridge');
  vi.mocked(isProcessAlive).mockReset();
  ipc.connect.mockReset().mockResolvedValue(undefined);
  ipc.send.mockReset();
  ipc.close.mockReset().mockResolvedValue(undefined);
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
  killSpy.mockRestore();
  setPlatform(REAL_PLATFORM);
  vi.useRealTimers();
});

describe('stopBridge never signals a PID that is not the bridge', () => {
  for (const platform of ['linux', 'win32']) {
    for (const identity of ['other', 'dead', 'unknown'] as const) {
      it(`${platform}: leaves a PID identified as "${identity}" alone`, async () => {
        setPlatform(platform);
        vi.mocked(identifyBridgeProcess).mockResolvedValue(identity);
        // Whatever the bare liveness check says: a recycled PID *is* alive.
        vi.mocked(isProcessAlive).mockReturnValue(true);

        await stopBridge(SESSION_NAME, { graceful: true });

        expect(identifyBridgeProcess).toHaveBeenCalledWith(SESSION_NAME, BRIDGE_PID);
        expect(killSpy).not.toHaveBeenCalled();
        expect(ipc.connect).not.toHaveBeenCalled();
      });
    }
  }

  it('does nothing when the session has no bridge PID', async () => {
    vi.mocked(getSession).mockResolvedValue({
      name: SESSION_NAME,
      server: { url: 'https://mcp.example.com' },
    } as never);
    vi.mocked(isProcessAlive).mockReturnValue(true);

    await stopBridge(SESSION_NAME, { graceful: true });

    expect(identifyBridgeProcess).not.toHaveBeenCalled();
    expect(ipc.connect).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe('stopBridge on Unix', () => {
  beforeEach(() => {
    setPlatform('linux');
  });

  it('sends SIGTERM and returns as soon as the bridge has exited, without SIGKILL', async () => {
    vi.useFakeTimers();
    // Alive for the first few polls, gone after ~300 ms: a bridge finishing its teardown.
    let polls = 0;
    vi.mocked(isProcessAlive).mockImplementation(() => ++polls <= 3);

    const stopping = stopBridge(SESSION_NAME);
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;

    expect(killSpy).toHaveBeenCalledWith(BRIDGE_PID, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(BRIDGE_PID, 'SIGKILL');
  });

  it('gives the bridge its whole teardown budget before SIGKILL', async () => {
    vi.useFakeTimers();
    vi.mocked(isProcessAlive).mockReturnValue(true);

    const stopping = stopBridge(SESSION_NAME);

    // A stdio server that ignores stdin EOF needs the SDK's close-stdin → SIGTERM → SIGKILL
    // escalation (~6 s), after the 2 s HTTP DELETE budget — one second used to be the limit.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(killSpy).toHaveBeenCalledWith(BRIDGE_PID, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(BRIDGE_PID, 'SIGKILL');

    await vi.advanceTimersByTimeAsync(1_500);
    await stopping;
    expect(killSpy).toHaveBeenCalledWith(BRIDGE_PID, 'SIGKILL');
  });

  it('tolerates a bridge that exits between the identity check and SIGTERM', async () => {
    killSpy.mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM') throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    });
    vi.mocked(isProcessAlive).mockReturnValue(false);

    await expect(stopBridge(SESSION_NAME)).resolves.toBeUndefined();

    expect(killSpy).not.toHaveBeenCalledWith(BRIDGE_PID, 'SIGKILL');
  });
});

describe('stopBridge on Windows', () => {
  beforeEach(() => {
    setPlatform('win32');
  });

  it('sends the IPC shutdown even when the liveness check calls the bridge dead (#427)', async () => {
    vi.mocked(isProcessAlive).mockReturnValue(false);

    await stopBridge(SESSION_NAME, { graceful: true });

    expect(ipc.connect).toHaveBeenCalledWith({ retryTimeoutMillis: 0 });
    expect(ipc.send).toHaveBeenCalledWith({ type: 'shutdown' });
    // Nothing to force-kill when the check says the bridge is gone
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('waits for the bridge to exit after the IPC shutdown before force-killing it', async () => {
    vi.useFakeTimers();
    let polls = 0;
    vi.mocked(isProcessAlive).mockImplementation(() => ++polls <= 20);

    const stopping = stopBridge(SESSION_NAME, { graceful: true });
    await vi.advanceTimersByTimeAsync(3_000);
    await stopping;

    expect(ipc.send).toHaveBeenCalledWith({ type: 'shutdown' });
    // Exited on its own after ~2 s, inside the budget: no SIGKILL
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('force-kills a live bridge that did not take the IPC shutdown', async () => {
    vi.mocked(isProcessAlive).mockReturnValue(true);
    ipc.connect.mockRejectedValue(Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));

    await stopBridge(SESSION_NAME, { graceful: true });

    expect(ipc.send).not.toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(BRIDGE_PID, 'SIGKILL');
  });
});
