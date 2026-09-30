/**
 * Unit tests for the Windows branch of isProcessAlive() (#427)
 *
 * The Windows check shells out to `tasklist`. When that fails — it timed out on a busy
 * machine, or is not on PATH — the answer must not be "dead": a live bridge reported dead
 * makes the CLI spawn a replacement and never stop the original. The check falls back to
 * `process.kill(pid, 0)` instead, which works the same on every platform, so this file
 * exercises the win32 branch on whatever OS runs the tests by stubbing `process.platform`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn() };
});

import { execFileSync } from 'child_process';
import { invalidateProcessAliveCache, isProcessAlive } from '../../../src/lib/utils.js';

const REAL_PLATFORM = process.platform;
const DEAD_PID = 999999;

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function tasklistListing(...pids: number[]): string {
  return pids.map((pid) => `"node.exe","${pid}","Console","1","10,000 K"`).join('\r\n') + '\r\n';
}

describe('isProcessAlive on Windows', () => {
  beforeEach(() => {
    setPlatform('win32');
    invalidateProcessAliveCache();
    vi.mocked(execFileSync).mockReset();
  });

  afterEach(() => {
    setPlatform(REAL_PLATFORM);
    invalidateProcessAliveCache();
  });

  it('answers from the tasklist output when tasklist works', () => {
    vi.mocked(execFileSync).mockReturnValue(tasklistListing(4, 4242));

    expect(isProcessAlive(4242)).toBe(true);
    expect(isProcessAlive(4243)).toBe(false);
    // One tasklist run serves every lookup within the cache window
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('still reports a live PID alive when tasklist fails (#427)', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error('spawnSync tasklist ETIMEDOUT'), { code: 'ETIMEDOUT' });
    });

    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('still reports a dead PID dead when tasklist fails', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error('spawnSync tasklist ENOENT'), { code: 'ENOENT' });
    });

    expect(isProcessAlive(DEAD_PID)).toBe(false);
  });

  it('does not re-run a failed tasklist for every check in the same invocation', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('spawnSync tasklist ETIMEDOUT');
    });

    // ensureBridgeReady, stopBridge and waitForProcessExit each check the same PID; a
    // timed-out tasklist must not cost its full timeout again for each of them.
    isProcessAlive(process.pid);
    isProcessAlive(process.pid);
    isProcessAlive(DEAD_PID);

    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('runs tasklist again after the cache is invalidated', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('spawnSync tasklist ETIMEDOUT');
    });
    expect(isProcessAlive(4242)).toBe(false);

    invalidateProcessAliveCache();
    vi.mocked(execFileSync).mockReturnValue(tasklistListing(4242));

    expect(isProcessAlive(4242)).toBe(true);
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });
});
