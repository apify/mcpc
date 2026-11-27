/**
 * Unit tests for stopBridge()
 *
 * The PID in sessions.json is signalled only when the bridge's own IPC socket answers.
 * PIDs are recycled: after a reboot the recorded number may belong to an unrelated process
 * of the user, which a restart or `close` must not kill. A bridge that is told to exit then
 * gets its whole teardown budget (HTTP DELETE, stdio child shutdown) before SIGKILL.
 *
 * On Windows the graceful IPC shutdown must not depend on the liveness check, which can be
 * wrong (a timed-out `tasklist` reported every PID dead, #427).
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
import { stopBridge } from '../../../src/lib/bridge-manager.js';

const REAL_PLATFORM = process.platform;
const SESSION_NAME = '@stop-test';
const BRIDGE_PID = 4242;
const NOT_LISTENING = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });

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
  vi.mocked(isProcessAlive).mockReset();
  // The bridge answers on its socket unless a test says otherwise
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

describe('stopBridge when no bridge answers on the socket', () => {
  for (const platform of ['linux', 'win32']) {
    it(`${platform}: never signals the recorded PID, even though it is alive`, async () => {
      setPlatform(platform);
      ipc.connect.mockRejectedValue(NOT_LISTENING);
      // A recycled PID *is* alive: it belongs to some other process now.
      vi.mocked(isProcessAlive).mockReturnValue(true);

      await stopBridge(SESSION_NAME, { graceful: true });

      expect(ipc.connect).toHaveBeenCalledWith({ retryTimeoutMillis: 0 });
      expect(ipc.send).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
    });
  }

  it('does nothing when the session has no bridge PID', async () => {
    vi.mocked(getSession).mockResolvedValue({
      name: SESSION_NAME,
      server: { url: 'https://mcp.example.com' },
    } as never);
    vi.mocked(isProcessAlive).mockReturnValue(true);

    await stopBridge(SESSION_NAME, { graceful: true });

    expect(ipc.connect).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });
});

describe('stopBridge on Unix', () => {
  beforeEach(() => {
    setPlatform('linux');
    vi.useFakeTimers();
  });

  it('sends SIGTERM and returns once the bridge has exited, without SIGKILL', async () => {
    // Alive for the first few polls, then gone: a bridge finishing its teardown.
    let polls = 0;
    vi.mocked(isProcessAlive).mockImplementation(() => ++polls <= 3);

    const stopping = stopBridge(SESSION_NAME);
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;

    expect(killSpy).toHaveBeenCalledWith(BRIDGE_PID, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(BRIDGE_PID, 'SIGKILL');
  });

  it('gives the bridge its whole teardown budget before SIGKILL', async () => {
    vi.mocked(isProcessAlive).mockReturnValue(true);

    const stopping = stopBridge(SESSION_NAME);

    // A stdio server that ignores stdin EOF needs the SDK's close-stdin → SIGTERM → SIGKILL
    // escalation (~6 s) on top of the 2 s HTTP DELETE budget; one second used to be the limit.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(killSpy).toHaveBeenCalledWith(BRIDGE_PID, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(BRIDGE_PID, 'SIGKILL');

    await vi.advanceTimersByTimeAsync(1_500);
    await stopping;
    expect(killSpy).toHaveBeenCalledWith(BRIDGE_PID, 'SIGKILL');
  });
});

describe('stopBridge on Windows', () => {
  beforeEach(() => {
    setPlatform('win32');
  });

  it('sends the IPC shutdown even when the liveness check calls the bridge dead (#427)', async () => {
    vi.mocked(isProcessAlive).mockReturnValue(false);

    await stopBridge(SESSION_NAME, { graceful: true });

    expect(ipc.send).toHaveBeenCalledWith({ type: 'shutdown' });
    // Nothing to force-kill when the check says the bridge is gone
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('force-kills a listening bridge that did not take the IPC shutdown', async () => {
    vi.mocked(isProcessAlive).mockReturnValue(true);
    // Answers the identity check, then fails the shutdown message
    ipc.connect.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('EPIPE'));

    await stopBridge(SESSION_NAME, { graceful: true });

    expect(ipc.send).not.toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(BRIDGE_PID, 'SIGKILL');
  });
});
