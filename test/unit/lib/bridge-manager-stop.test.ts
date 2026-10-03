/**
 * Unit tests for stopBridge() on Windows (#427)
 *
 * The graceful IPC shutdown must be attempted whenever a PID is recorded for the session,
 * not only when the liveness check says the bridge is running: that check can be wrong
 * (a timed-out `tasklist` reported every PID dead), and a bridge that is never told to
 * exit lives on next to its replacement. Connecting to a dead pipe fails fast and is harmless.
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

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('stopBridge on Windows', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setPlatform('win32');
    vi.mocked(getSession).mockResolvedValue({
      name: SESSION_NAME,
      pid: BRIDGE_PID,
      server: { url: 'https://mcp.example.com' },
    } as never);
    ipc.connect.mockReset().mockResolvedValue(undefined);
    ipc.send.mockReset();
    ipc.close.mockReset().mockResolvedValue(undefined);
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
    setPlatform(REAL_PLATFORM);
  });

  it('sends the IPC shutdown even when the liveness check calls the bridge dead (#427)', async () => {
    vi.mocked(isProcessAlive).mockReturnValue(false);

    await stopBridge(SESSION_NAME, { graceful: true });

    expect(ipc.connect).toHaveBeenCalledWith({ retryTimeoutMillis: 0 });
    expect(ipc.send).toHaveBeenCalledWith({ type: 'shutdown' });
    // Nothing to force-kill when the check says the bridge is gone
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('force-kills a live bridge that did not take the IPC shutdown', async () => {
    vi.mocked(isProcessAlive).mockReturnValue(true);
    ipc.connect.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await stopBridge(SESSION_NAME, { graceful: true });

    expect(ipc.send).not.toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(BRIDGE_PID, 'SIGKILL');
  });

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
