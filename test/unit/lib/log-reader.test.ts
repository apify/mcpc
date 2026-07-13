/**
 * Unit tests for the log-reader module.
 */

import { mkdtemp, mkdir, writeFile, appendFile, rename, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  followLog,
  getBridgeLogPath,
  listLogFiles,
  parseDurationMillis,
  parseLogLine,
  parseLogLines,
  readRecentLogLines,
  resolveSince,
} from '../../../src/lib/log-reader';

describe('parseLogLine', () => {
  it('parses a well-formed line with context', () => {
    const rec = parseLogLine(
      '[2026-04-28T12:01:14.231Z] [INFO] [bridge-manager] Started bridge for @apify'
    );
    expect(rec.time).toBe('2026-04-28T12:01:14.231Z');
    expect(rec.level).toBe('info');
    expect(rec.context).toBe('bridge-manager');
    expect(rec.msg).toBe('Started bridge for @apify');
    expect(rec.raw).toBeUndefined();
  });

  it('parses a line without context', () => {
    const rec = parseLogLine('[2026-04-28T12:01:14.231Z] [WARN] something happened');
    expect(rec.level).toBe('warn');
    expect(rec.context).toBeUndefined();
    expect(rec.msg).toBe('something happened');
  });

  it('parses every standard log level', () => {
    for (const level of ['DEBUG', 'INFO', 'WARN', 'ERROR']) {
      const rec = parseLogLine(`[2026-04-28T12:00:00.000Z] [${level}] msg`);
      expect(rec.level).toBe(level.toLowerCase());
    }
  });

  it('handles a missing message body', () => {
    const rec = parseLogLine('[2026-04-28T12:00:00.000Z] [INFO]');
    expect(rec.time).toBe('2026-04-28T12:00:00.000Z');
    expect(rec.level).toBe('info');
    expect(rec.msg).toBe('');
  });

  it('falls back to raw for non-matching lines (no time/level/context emitted)', () => {
    const rec = parseLogLine('========================================');
    expect(rec).toEqual({ raw: '========================================' });
  });

  it('falls back to raw for stack-trace continuation lines', () => {
    const rec = parseLogLine('    at Foo.bar (/path/to/file.ts:42:13)');
    expect(rec).toEqual({ raw: '    at Foo.bar (/path/to/file.ts:42:13)' });
  });

  it('falls back to raw for empty input', () => {
    expect(parseLogLine('')).toEqual({ raw: '' });
  });
});

describe('parseLogLines (folding)', () => {
  it('folds stack-trace continuation lines into the preceding entry msg', () => {
    const records = parseLogLines([
      '[2026-04-28T12:00:00.000Z] [ERROR] [McpClient] Transport error: terminated',
      '    at processStream (file:///x/streamableHttp.js:233:32)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
      '[2026-04-28T12:00:01.000Z] [INFO] [bridge] recovered',
    ]);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      time: '2026-04-28T12:00:00.000Z',
      level: 'error',
      context: 'McpClient',
      msg:
        'Transport error: terminated\n' +
        '    at processStream (file:///x/streamableHttp.js:233:32)\n' +
        '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    });
    expect(records[1]).toMatchObject({ level: 'info', msg: 'recovered' });
  });

  it('keeps timestamped banner lines as their own records (not folded)', () => {
    const banner = '[2026-04-28T12:00:00.001Z] ========================================';
    const records = parseLogLines([
      '[2026-04-28T12:00:00.000Z] [INFO] hello',
      banner,
      '[2026-04-28T12:00:00.002Z] mcpc v0.3.0',
    ]);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ msg: 'hello' });
    // Banner has a timestamp but no [LEVEL], so it stays a standalone raw record.
    expect(records[1]).toEqual({ raw: banner });
    expect(records[2]).toEqual({ raw: '[2026-04-28T12:00:00.002Z] mcpc v0.3.0' });
  });

  it('folds leading continuation lines into a raw record', () => {
    const records = parseLogLines([
      '    at orphaned stack frame',
      '    at another frame',
      '[2026-04-28T12:00:00.000Z] [INFO] entry',
    ]);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      raw: '    at orphaned stack frame\n    at another frame',
    });
    expect(records[1]).toMatchObject({ msg: 'entry' });
  });

  it('returns [] for no lines', () => {
    expect(parseLogLines([])).toEqual([]);
  });
});

describe('parseDurationMillis', () => {
  it('parses common shortforms', () => {
    expect(parseDurationMillis('30s')).toBe(30 * 1000);
    expect(parseDurationMillis('5m')).toBe(5 * 60 * 1000);
    expect(parseDurationMillis('2h')).toBe(2 * 60 * 60 * 1000);
    expect(parseDurationMillis('1d')).toBe(24 * 60 * 60 * 1000);
    expect(parseDurationMillis('1w')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('parses long unit names', () => {
    expect(parseDurationMillis('30sec')).toBe(30 * 1000);
    expect(parseDurationMillis('5mins')).toBe(5 * 60 * 1000);
    expect(parseDurationMillis('2hrs')).toBe(2 * 60 * 60 * 1000);
    expect(parseDurationMillis('3days')).toBe(3 * 24 * 60 * 60 * 1000);
    expect(parseDurationMillis('2wks')).toBe(2 * 7 * 24 * 60 * 60 * 1000);
  });

  it('is case-insensitive and tolerant of whitespace', () => {
    expect(parseDurationMillis('30S')).toBe(30 * 1000);
    expect(parseDurationMillis('  5m  ')).toBe(5 * 60 * 1000);
  });

  it('returns null for garbage', () => {
    expect(parseDurationMillis('1y')).toBeNull(); // years not supported
    expect(parseDurationMillis('abc')).toBeNull();
    expect(parseDurationMillis('')).toBeNull();
    expect(parseDurationMillis('m5')).toBeNull(); // wrong order
    expect(parseDurationMillis('5')).toBeNull(); // missing unit
    expect(parseDurationMillis('-5m')).toBeNull(); // negative not supported
  });
});

describe('resolveSince', () => {
  it('treats durations as relative to now', () => {
    const now = Date.now();
    const d = resolveSince('1h');
    expect(d).not.toBeNull();
    const diff = now - d!.getTime();
    expect(diff).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1000);
    expect(diff).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
  });

  it('parses ISO 8601 timestamps', () => {
    const d = resolveSince('2026-04-28T12:00:00Z');
    expect(d?.toISOString()).toBe('2026-04-28T12:00:00.000Z');
  });

  it('parses ISO 8601 with milliseconds', () => {
    const d = resolveSince('2026-04-28T12:00:00.500Z');
    expect(d?.toISOString()).toBe('2026-04-28T12:00:00.500Z');
  });

  it('returns null for invalid input', () => {
    expect(resolveSince('not a date')).toBeNull();
    expect(resolveSince('')).toBeNull();
  });
});

describe('getBridgeLogPath', () => {
  it('returns expected path under MCPC_HOME_DIR/logs', () => {
    const original = process.env.MCPC_HOME_DIR;
    process.env.MCPC_HOME_DIR = '/tmp/mcpc-fake';
    try {
      const p = getBridgeLogPath('@x');
      expect(p).toBe('/tmp/mcpc-fake/logs/bridge-@x.log');
    } finally {
      if (original === undefined) delete process.env.MCPC_HOME_DIR;
      else process.env.MCPC_HOME_DIR = original;
    }
  });
});

describe('listLogFiles + readRecentLogLines', () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpc-logs-test-'));
    originalHome = process.env.MCPC_HOME_DIR;
    process.env.MCPC_HOME_DIR = homeDir;
    await mkdir(join(homeDir, 'logs'), { recursive: true });
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.MCPC_HOME_DIR;
    else process.env.MCPC_HOME_DIR = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns [] when no log files exist', async () => {
    const files = await listLogFiles('@nope');
    expect(files).toEqual([]);
    const lines = await readRecentLogLines('@nope');
    expect(lines).toEqual([]);
  });

  it('returns [] when only logs directory is missing', async () => {
    await rm(join(homeDir, 'logs'), { recursive: true, force: true });
    expect(await listLogFiles('@nope')).toEqual([]);
    expect(await readRecentLogLines('@nope')).toEqual([]);
  });

  it('orders rotated files oldest-first, then current last', async () => {
    const dir = join(homeDir, 'logs');
    await writeFile(join(dir, 'bridge-@x.log'), 'current\n');
    await writeFile(join(dir, 'bridge-@x.log.1'), 'one\n');
    await writeFile(join(dir, 'bridge-@x.log.2'), 'two\n');
    await writeFile(join(dir, 'bridge-@x.log.5'), 'five\n');
    const files = await listLogFiles('@x');
    expect(files.map((f) => f.split('/').pop())).toEqual([
      'bridge-@x.log.5',
      'bridge-@x.log.2',
      'bridge-@x.log.1',
      'bridge-@x.log',
    ]);
  });

  it('ignores files with non-numeric rotation suffixes', async () => {
    const dir = join(homeDir, 'logs');
    await writeFile(join(dir, 'bridge-@x.log'), 'current\n');
    await writeFile(join(dir, 'bridge-@x.log.bak'), 'oops\n');
    await writeFile(join(dir, 'bridge-@x.log.tmp'), 'oops\n');
    const files = await listLogFiles('@x');
    expect(files.map((f) => f.split('/').pop())).toEqual(['bridge-@x.log']);
  });

  it('does not match other sessions whose names share a prefix', async () => {
    const dir = join(homeDir, 'logs');
    await writeFile(join(dir, 'bridge-@x.log'), 'mine\n');
    await writeFile(join(dir, 'bridge-@xyz.log'), 'other\n');
    await writeFile(join(dir, 'bridge-@xyz.log.1'), 'other-rotated\n');
    const files = await listLogFiles('@x');
    expect(files.map((f) => f.split('/').pop())).toEqual(['bridge-@x.log']);
  });

  it('handles a missing trailing newline on the last line', async () => {
    const dir = join(homeDir, 'logs');
    await writeFile(join(dir, 'bridge-@x.log'), 'a\nb\nno-newline');
    const lines = await readRecentLogLines('@x');
    expect(lines).toEqual(['a', 'b', 'no-newline']);
  });

  it('preserves blank/empty lines between log entries', async () => {
    const dir = join(homeDir, 'logs');
    await writeFile(join(dir, 'bridge-@x.log'), 'a\n\nb\n');
    const lines = await readRecentLogLines('@x');
    expect(lines).toEqual(['a', '', 'b']);
  });

  it('tail returns the last N lines, spanning rotations when needed', async () => {
    const dir = join(homeDir, 'logs');
    await writeFile(join(dir, 'bridge-@x.log.1'), 'line1\nline2\nline3\nline4\nline5\n');
    await writeFile(join(dir, 'bridge-@x.log'), 'line6\nline7\nline8\n');
    const lines = await readRecentLogLines('@x', { tail: 6 });
    expect(lines).toEqual(['line3', 'line4', 'line5', 'line6', 'line7', 'line8']);
  });

  it('tail spans multiple rotation files when needed', async () => {
    const dir = join(homeDir, 'logs');
    await writeFile(join(dir, 'bridge-@x.log.3'), 'r3a\nr3b\n');
    await writeFile(join(dir, 'bridge-@x.log.2'), 'r2a\nr2b\n');
    await writeFile(join(dir, 'bridge-@x.log.1'), 'r1a\nr1b\n');
    await writeFile(join(dir, 'bridge-@x.log'), 'cur\n');
    const lines = await readRecentLogLines('@x', { tail: 6 });
    // 7 lines total; tail 6 drops the oldest "r3a"
    expect(lines).toEqual(['r3b', 'r2a', 'r2b', 'r1a', 'r1b', 'cur']);
  });

  it('tail does not read older files when current alone has enough lines', async () => {
    const dir = join(homeDir, 'logs');
    // If readRecentLogLines opened the rotated file unnecessarily, the test
    // would still pass — so we validate the bounded slice instead.
    await writeFile(join(dir, 'bridge-@x.log.1'), 'old1\nold2\n');
    await writeFile(join(dir, 'bridge-@x.log'), 'a\nb\nc\nd\ne\n');
    const lines = await readRecentLogLines('@x', { tail: 3 });
    expect(lines).toEqual(['c', 'd', 'e']);
  });

  it('tail larger than total returns everything in chronological order', async () => {
    const dir = join(homeDir, 'logs');
    await writeFile(join(dir, 'bridge-@x.log.1'), 'old1\nold2\n');
    await writeFile(join(dir, 'bridge-@x.log'), 'new1\n');
    const lines = await readRecentLogLines('@x', { tail: 1000 });
    expect(lines).toEqual(['old1', 'old2', 'new1']);
  });

  it('tail = 0 returns no lines', async () => {
    const dir = join(homeDir, 'logs');
    await writeFile(join(dir, 'bridge-@x.log'), 'a\nb\nc\n');
    const lines = await readRecentLogLines('@x', { tail: 0 });
    expect(lines).toEqual([]);
  });

  it('--since filters by timestamp and keeps unparseable lines', async () => {
    const dir = join(homeDir, 'logs');
    const old = '[2026-04-28T10:00:00.000Z] [INFO] old line';
    const banner = '========================================';
    const newer = '[2026-04-28T13:00:00.000Z] [INFO] new line';
    await writeFile(join(dir, 'bridge-@x.log'), `${old}\n${banner}\n${newer}\n`);
    const lines = await readRecentLogLines('@x', {
      since: new Date('2026-04-28T12:00:00.000Z'),
    });
    expect(lines).toEqual([banner, newer]);
  });

  it('--since drops everything when all lines pre-date cutoff', async () => {
    const dir = join(homeDir, 'logs');
    await writeFile(
      join(dir, 'bridge-@x.log'),
      '[2026-04-28T08:00:00.000Z] [INFO] a\n[2026-04-28T08:30:00.000Z] [INFO] b\n'
    );
    const lines = await readRecentLogLines('@x', {
      since: new Date('2026-04-28T12:00:00.000Z'),
    });
    expect(lines).toEqual([]);
  });

  it('--since spans rotated files', async () => {
    const dir = join(homeDir, 'logs');
    await writeFile(
      join(dir, 'bridge-@x.log.1'),
      '[2026-04-28T08:00:00.000Z] [INFO] old\n' +
        '[2026-04-28T11:00:00.000Z] [INFO] within window\n'
    );
    await writeFile(join(dir, 'bridge-@x.log'), '[2026-04-28T13:00:00.000Z] [INFO] newer\n');
    const lines = await readRecentLogLines('@x', {
      since: new Date('2026-04-28T10:00:00.000Z'),
    });
    expect(lines).toEqual([
      '[2026-04-28T11:00:00.000Z] [INFO] within window',
      '[2026-04-28T13:00:00.000Z] [INFO] newer',
    ]);
  });

  it('combines tail and --since (since is a floor, tail caps the result)', async () => {
    const dir = join(homeDir, 'logs');
    await writeFile(
      join(dir, 'bridge-@x.log'),
      '[2026-04-28T08:00:00.000Z] [INFO] way old\n' +
        '[2026-04-28T11:00:00.000Z] [INFO] in-window-1\n' +
        '[2026-04-28T11:30:00.000Z] [INFO] in-window-2\n' +
        '[2026-04-28T12:00:00.000Z] [INFO] in-window-3\n'
    );
    const lines = await readRecentLogLines('@x', {
      since: new Date('2026-04-28T10:00:00.000Z'),
      tail: 2,
    });
    expect(lines).toEqual([
      '[2026-04-28T11:30:00.000Z] [INFO] in-window-2',
      '[2026-04-28T12:00:00.000Z] [INFO] in-window-3',
    ]);
  });
});

describe('followLog', () => {
  // Polling-based file follow is timing-sensitive. We use a 50ms poll interval
  // and a small wait helper to keep these tests reasonably fast and reliable.

  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpc-follow-test-'));
    originalHome = process.env.MCPC_HOME_DIR;
    process.env.MCPC_HOME_DIR = homeDir;
    await mkdir(join(homeDir, 'logs'), { recursive: true });
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.MCPC_HOME_DIR;
    else process.env.MCPC_HOME_DIR = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  async function waitFor(
    predicate: () => boolean,
    timeoutMillis = 2000,
    stepMillis = 25
  ): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMillis) {
        throw new Error(`waitFor timed out after ${timeoutMillis}ms`);
      }
      await sleep(stepMillis);
    }
  }

  it('emits lines appended after follow starts', async () => {
    const path = join(homeDir, 'logs', 'bridge-@x.log');
    await writeFile(path, 'pre-existing\n');
    const seen: string[] = [];
    const sub = followLog('@x', (l) => seen.push(l), { pollIntervalMillis: 50 });
    try {
      // Give the watcher a tick to start at end-of-file.
      await sleep(100);
      await appendFile(path, 'one\n');
      await appendFile(path, 'two\n');
      await waitFor(() => seen.length >= 2);
      expect(seen).toEqual(['one', 'two']);
    } finally {
      await sub.stop();
    }
  });

  it('does not replay backlog by default', async () => {
    const path = join(homeDir, 'logs', 'bridge-@x.log');
    await writeFile(path, 'old1\nold2\nold3\n');
    const seen: string[] = [];
    const sub = followLog('@x', (l) => seen.push(l), { pollIntervalMillis: 50 });
    try {
      await sleep(150);
      expect(seen).toEqual([]);
    } finally {
      await sub.stop();
    }
  });

  it('handles partial writes that complete a line later', async () => {
    const path = join(homeDir, 'logs', 'bridge-@x.log');
    await writeFile(path, '');
    const seen: string[] = [];
    const sub = followLog('@x', (l) => seen.push(l), { pollIntervalMillis: 50 });
    try {
      await sleep(100);
      await appendFile(path, 'hello ');
      await sleep(100);
      // Line shouldn't be emitted yet: still buffered without a newline.
      expect(seen).toEqual([]);
      await appendFile(path, 'world\n');
      await waitFor(() => seen.length >= 1);
      expect(seen).toEqual(['hello world']);
    } finally {
      await sub.stop();
    }
  });

  it('detects rotation (file replaced with smaller content)', async () => {
    const path = join(homeDir, 'logs', 'bridge-@x.log');
    await writeFile(path, 'pre\n');
    const seen: string[] = [];
    const sub = followLog('@x', (l) => seen.push(l), { pollIntervalMillis: 50 });
    try {
      await sleep(100);
      // Append, then "rotate" by renaming current to .1 and writing a fresh,
      // smaller file at the same path — this is what FileLogger does.
      await appendFile(path, 'before-rotation\n');
      await waitFor(() => seen.includes('before-rotation'));
      await rename(path, path + '.1');
      await writeFile(path, 'fresh-line\n');
      await waitFor(() => seen.includes('fresh-line'), 3000);
      expect(seen).toContain('before-rotation');
      expect(seen).toContain('fresh-line');
    } finally {
      await sub.stop();
    }
  });

  it('startAtBeginning replays existing content', async () => {
    const path = join(homeDir, 'logs', 'bridge-@x.log');
    await writeFile(path, 'a\nb\nc\n');
    const seen: string[] = [];
    const sub = followLog('@x', (l) => seen.push(l), {
      pollIntervalMillis: 50,
      startAtBeginning: true,
    });
    try {
      await waitFor(() => seen.length >= 3);
      expect(seen).toEqual(['a', 'b', 'c']);
    } finally {
      await sub.stop();
    }
  });

  it('survives following a file that does not exist yet', async () => {
    const path = join(homeDir, 'logs', 'bridge-@x.log');
    const seen: string[] = [];
    const sub = followLog('@x', (l) => seen.push(l), { pollIntervalMillis: 50 });
    try {
      await sleep(100);
      // Now the file appears
      await writeFile(path, 'first-line\n');
      await waitFor(() => seen.includes('first-line'), 3000);
      expect(seen).toContain('first-line');
    } finally {
      await sub.stop();
    }
  });

  it('stop() flushes a partial trailing line', async () => {
    const path = join(homeDir, 'logs', 'bridge-@x.log');
    await writeFile(path, '');
    const seen: string[] = [];
    const sub = followLog('@x', (l) => seen.push(l), { pollIntervalMillis: 50 });
    await sleep(100);
    await appendFile(path, 'no-trailing-newline');
    // Wait for the read to drain the bytes into the internal buffer.
    await sleep(150);
    await sub.stop();
    expect(seen).toContain('no-trailing-newline');
  });

  it('stop() is idempotent', async () => {
    const path = join(homeDir, 'logs', 'bridge-@x.log');
    await writeFile(path, '');
    const sub = followLog('@x', () => {}, { pollIntervalMillis: 50 });
    await sub.stop();
    await expect(sub.stop()).resolves.toBeUndefined();
  });
});
