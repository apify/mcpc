/**
 * Unit tests for identifyBridgeProcess() — the check that runs before mcpc signals a PID.
 *
 * PIDs are recycled, so the number sessions.json remembers for a bridge can belong to an
 * unrelated process after a reboot. The check must tell a bridge (its socket answers, or
 * its command line names the bridge script and the session) from a stranger that merely
 * has the same PID, and from a PID nobody has any more. The sockets and processes here
 * are real; only the mcpc home is pointed at a temp dir.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { once } from 'events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'net';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  commandLineNamesBridge,
  identifyBridgeProcess,
  isBridgeProcess,
} from '../../../src/lib/bridge-process.js';
import { getSocketPath } from '../../../src/lib/utils.js';

const IS_WINDOWS = process.platform === 'win32';

describe('commandLineNamesBridge', () => {
  const BRIDGE_ARGV = ['/usr/bin/node', '/opt/mcpc/dist/bridge/index.js', '@foo', '{"url":"x"}'];

  it('recognises a bridge command line for its own session', () => {
    expect(commandLineNamesBridge(BRIDGE_ARGV, '@foo')).toBe(true);
  });

  it('does not match a bridge of another session', () => {
    expect(commandLineNamesBridge(BRIDGE_ARGV, '@bar')).toBe(false);
  });

  it('needs the session name right after the bridge script, not anywhere on the line', () => {
    const argv = ['node', '/x/dist/bridge/index.js', '@bar', '{"url":"https://h/@foo"}', '@foo'];
    expect(commandLineNamesBridge(argv, '@foo')).toBe(false);
  });

  it('accepts Windows paths', () => {
    const argv = [
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@apify\\mcpc\\dist\\bridge\\index.js',
      '@foo',
      '{}',
    ];
    expect(commandLineNamesBridge(argv, '@foo')).toBe(true);
  });

  it('survives ps splitting an install path that contains spaces', () => {
    const tokens = '/usr/local/bin/node /Users/Jo Doe/mcpc/dist/bridge/index.js @foo {}'.split(
      /\s+/
    );
    expect(commandLineNamesBridge(tokens, '@foo')).toBe(true);
  });

  it('rejects command lines without the bridge script', () => {
    expect(commandLineNamesBridge(['sleep', '300'], '@foo')).toBe(false);
    expect(commandLineNamesBridge(['node', 'bridge/index.js', '@foo'], '@foo')).toBe(false);
    expect(commandLineNamesBridge([], '@foo')).toBe(false);
  });
});

describe('identifyBridgeProcess', () => {
  let home: string;
  const servers: Server[] = [];
  const children: ChildProcess[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mcpc-bp-'));
    process.env.MCPC_HOME_DIR = home;
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
    delete process.env.MCPC_HOME_DIR;
    rmSync(home, { recursive: true, force: true });
  });

  /** Listen on the socket path mcpc derives for (session, pid) from this process. */
  async function listenAs(sessionName: string, pid: number): Promise<string> {
    const socketPath = getSocketPath(sessionName, pid);
    if (!IS_WINDOWS) mkdirSync(dirname(socketPath), { recursive: true });
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    return socketPath;
  }

  /** Spawn a child process that stays alive until killed, and return it once it has started. */
  function spawnIdle(args: string[]): ChildProcess {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    children.push(child);
    return child;
  }

  /** A PID that no process has: that of a child which has already exited. */
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(child, 'exit');
    return child.pid as number;
  }

  /**
   * Leave a stale socket file at the path for (session, pid) — what a crash or a reboot
   * leaves behind on Unix: a child listens there and is SIGKILLed, so the file stays
   * while nothing accepts connections on it.
   */
  async function leaveStaleSocket(sessionName: string, pid: number): Promise<void> {
    const socketPath = getSocketPath(sessionName, pid);
    mkdirSync(dirname(socketPath), { recursive: true });
    const child = spawnIdle([
      '-e',
      "process.stdin.once('data', (d) => require('net').createServer().listen(d.toString().trim(), () => process.stdout.write('ready')))",
    ]);
    const ready = once(child.stdout as NodeJS.ReadableStream, 'data');
    child.stdin?.write(`${socketPath}\n`);
    await ready;
    child.kill('SIGKILL');
    await once(child, 'exit');
  }

  it('is "bridge" when the socket for the session and PID accepts connections', async () => {
    await listenAs('@bp-live', process.pid);

    expect(await identifyBridgeProcess('@bp-live', process.pid)).toBe('bridge');
    expect(await isBridgeProcess('@bp-live', process.pid)).toBe(true);
  });

  it('is "dead" for a PID no process has', async () => {
    const pid = await deadPid();

    expect(await identifyBridgeProcess('@bp-dead', pid)).toBe('dead');
    expect(await isBridgeProcess('@bp-dead', pid)).toBe(false);
  });

  it('is "other" for a live process that is not the bridge (a recycled PID)', async () => {
    // This test runner is alive and has no bridge socket; its command line is not a bridge's.
    expect(await identifyBridgeProcess('@bp-stranger', process.pid)).toBe('other');
    expect(await isBridgeProcess('@bp-stranger', process.pid)).toBe(false);
  });

  it('is "other" for a bridge of a different session whose PID was recycled', async () => {
    const script = join(home, 'dist', 'bridge', 'index.js');
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    const child = spawnIdle([script, '@bp-theirs', '{}']);
    await once(child, 'spawn');

    expect(await identifyBridgeProcess('@bp-mine', child.pid as number)).toBe('other');
  });

  it.skipIf(IS_WINDOWS)(
    'is still "bridge" when the socket is gone but the command line names the bridge',
    async () => {
      const script = join(home, 'dist', 'bridge', 'index.js');
      mkdirSync(dirname(script), { recursive: true });
      writeFileSync(script, 'setInterval(() => {}, 1000);\n');
      const child = spawnIdle([script, '@bp-cmdline', '{"url":"https://mcp.example.com"}']);
      await once(child, 'spawn');

      expect(await identifyBridgeProcess('@bp-cmdline', child.pid as number)).toBe('bridge');
    }
  );

  it.skipIf(IS_WINDOWS)(
    'is "dead" when only a stale socket file is left behind (crash, reboot)',
    async () => {
      const pid = await deadPid();
      await leaveStaleSocket('@bp-stale', pid);

      expect(await identifyBridgeProcess('@bp-stale', pid)).toBe('dead');
    }
  );

  it.skipIf(IS_WINDOWS)(
    'is "other" when a stale socket file sits next to a recycled PID (the post-reboot case)',
    async () => {
      // After a reboot the socket file of the old bridge is still there, and its PID now
      // belongs to this test runner. Neither must make mcpc signal the PID.
      await leaveStaleSocket('@bp-reboot', process.pid);

      expect(await identifyBridgeProcess('@bp-reboot', process.pid)).toBe('other');
    }
  );
});
