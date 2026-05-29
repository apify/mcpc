/**
 * Unit tests for the `showLogs` command handler.
 *
 * Drives the real handler against a tmp MCPC_HOME_DIR. Captures stdout/stderr.
 */

// Mock chalk to plain strings. `vi.mock` is hoisted above local consts,
// so identity helpers must come from `vi.hoisted`.
const { chalkApi } = vi.hoisted(() => {
  const id = (s: string): string => s;
  const hex = (): ((s: string) => string) => id;
  return {
    chalkApi: {
      cyan: id,
      yellow: id,
      red: id,
      dim: id,
      gray: id,
      bold: id,
      green: id,
      greenBright: id,
      blue: id,
      magenta: id,
      white: id,
      hex,
    },
  };
});
vi.mock('chalk', () => ({
  default: chalkApi,
  ...chalkApi,
}));

import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { saveSession } from '../../../src/lib/sessions';
import { showLogs } from '../../../src/cli/commands/logs';
import type { OutputMode } from '../../../src/lib/types';

interface Captured {
  stdout: string;
  stderr: string;
}

async function capture(fn: () => Promise<void>): Promise<Captured> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const origLog = console.log;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const origErr = console.error;
  console.log = (...args: unknown[]): void => {
    stdout.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.error = (...args: unknown[]): void => {
    stderr.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

async function seedSession(name: string): Promise<void> {
  await saveSession(name, {
    server: { url: 'https://example.com' },
    transport: 'http',
    status: 'live',
  } as never);
}

describe('showLogs (CLI command)', () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpc-cmdlogs-test-'));
    originalHome = process.env.MCPC_HOME_DIR;
    process.env.MCPC_HOME_DIR = homeDir;
    await mkdir(join(homeDir, 'logs'), { recursive: true });
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.MCPC_HOME_DIR;
    else process.env.MCPC_HOME_DIR = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('rejects targets without a leading @', async () => {
    await expect(
      showLogs('https://example.com', { outputMode: 'human' as OutputMode })
    ).rejects.toThrow(/requires a session target/);
  });

  it('errors when session does not exist', async () => {
    await expect(
      showLogs('@does-not-exist', { outputMode: 'human' as OutputMode })
    ).rejects.toThrow(/Session not found: @does-not-exist/);
  });

  it('errors with a friendly message on invalid --since', async () => {
    await seedSession('@x');
    await expect(
      showLogs('@x', { outputMode: 'human' as OutputMode, since: 'not-a-date' })
    ).rejects.toThrow(/Invalid --since value/);
  });

  it('writes header to stderr and lines to stdout in human mode', async () => {
    await seedSession('@x');
    const logFile = join(homeDir, 'logs', 'bridge-@x.log');
    await writeFile(
      logFile,
      '[2026-04-28T10:00:00.000Z] [INFO] [test] hello\n' +
        '[2026-04-28T10:00:01.000Z] [INFO] [test] world\n'
    );
    const out = await capture(() =>
      showLogs('@x', { outputMode: 'human' as OutputMode, tail: 100 })
    );
    expect(out.stderr).toContain('@x');
    expect(out.stderr).toContain(logFile);
    expect(out.stderr).toContain('last 100 lines');
    expect(out.stdout).toContain('hello');
    expect(out.stdout).toContain('world');
  });

  it('shows "no logs yet" header when log file is missing', async () => {
    await seedSession('@x');
    const out = await capture(() => showLogs('@x', { outputMode: 'human' as OutputMode }));
    expect(out.stderr).toContain('no logs yet');
    expect(out.stdout).toBe('');
  });

  it('JSON mode emits structured records', async () => {
    await seedSession('@x');
    const logFile = join(homeDir, 'logs', 'bridge-@x.log');
    // A startup banner is timestamped but has no [LEVEL], so it surfaces as a
    // standalone { raw } record rather than folding into a neighbour.
    const banner = '[2026-04-28T10:00:00.500Z] ========================================';
    await writeFile(
      logFile,
      '[2026-04-28T10:00:00.000Z] [INFO] [test] one\n' +
        banner +
        '\n' +
        '[2026-04-28T10:00:01.000Z] [WARN] [test] two\n'
    );
    const out = await capture(() => showLogs('@x', { outputMode: 'json' as OutputMode }));
    expect(out.stderr).toBe('');
    const parsed = JSON.parse(out.stdout) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({
      time: '2026-04-28T10:00:00.000Z',
      level: 'info',
      context: 'test',
      msg: 'one',
    });
    expect(parsed[1]).toEqual({ raw: banner });
    expect(parsed[2]).toMatchObject({
      time: '2026-04-28T10:00:01.000Z',
      level: 'warn',
      msg: 'two',
    });
  });

  it('JSON mode folds stack-trace lines into the preceding record', async () => {
    await seedSession('@x');
    const logFile = join(homeDir, 'logs', 'bridge-@x.log');
    await writeFile(
      logFile,
      '[2026-04-28T10:00:00.000Z] [ERROR] [McpClient] Transport error: terminated\n' +
        '    at processStream (file:///x/streamableHttp.js:233:32)\n' +
        '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)\n' +
        '[2026-04-28T10:00:01.000Z] [INFO] [bridge] recovered\n'
    );
    const out = await capture(() => showLogs('@x', { outputMode: 'json' as OutputMode }));
    const parsed = JSON.parse(out.stdout) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      level: 'error',
      context: 'McpClient',
      msg:
        'Transport error: terminated\n' +
        '    at processStream (file:///x/streamableHttp.js:233:32)\n' +
        '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    });
    expect(parsed[1]).toMatchObject({ msg: 'recovered' });
  });

  it('JSON mode honours --tail', async () => {
    await seedSession('@x');
    const logFile = join(homeDir, 'logs', 'bridge-@x.log');
    await writeFile(
      logFile,
      ['a', 'b', 'c', 'd', 'e']
        .map((m, i) => `[2026-04-28T10:00:0${i}.000Z] [INFO] [test] ${m}`)
        .join('\n') + '\n'
    );
    const out = await capture(() => showLogs('@x', { outputMode: 'json' as OutputMode, tail: 2 }));
    const parsed = JSON.parse(out.stdout) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ msg: 'd' });
    expect(parsed[1]).toMatchObject({ msg: 'e' });
  });

  it('JSON mode honours --since', async () => {
    await seedSession('@x');
    const logFile = join(homeDir, 'logs', 'bridge-@x.log');
    await writeFile(
      logFile,
      '[2026-04-28T08:00:00.000Z] [INFO] old\n' + '[2026-04-28T13:00:00.000Z] [INFO] new\n'
    );
    const out = await capture(() =>
      showLogs('@x', {
        outputMode: 'json' as OutputMode,
        since: '2026-04-28T12:00:00Z',
      })
    );
    const parsed = JSON.parse(out.stdout) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ msg: 'new' });
  });

  it('header shows file count when rotated files are present', async () => {
    await seedSession('@x');
    const dir = join(homeDir, 'logs');
    await writeFile(join(dir, 'bridge-@x.log'), 'curr\n');
    await writeFile(join(dir, 'bridge-@x.log.1'), 'one\n');
    await writeFile(join(dir, 'bridge-@x.log.2'), 'two\n');
    const out = await capture(() => showLogs('@x', { outputMode: 'human' as OutputMode }));
    expect(out.stderr).toContain('3 files');
    expect(out.stderr).toContain('rotated');
  });

  it('default tail is 50 (advertised in header)', async () => {
    await seedSession('@x');
    await writeFile(join(homeDir, 'logs', 'bridge-@x.log'), 'one\n');
    const out = await capture(() => showLogs('@x', { outputMode: 'human' as OutputMode }));
    expect(out.stderr).toContain('last 50 lines');
  });
});
