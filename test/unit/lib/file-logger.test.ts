/**
 * Unit tests for the rotating file logger used for bridge logs
 */

import { mkdtempSync, rmSync, statSync, readFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileLogger } from '../../../src/lib/file-logger.js';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcpc-file-logger-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

posixOnly('FileLogger file permissions', () => {
  it('creates the log file owner-only (0600) regardless of the umask', async () => {
    const previousUmask = process.umask(0o000);
    try {
      const logger = new FileLogger({ filePath: join(dir, 'bridge-@s.log') });
      await logger.init();
      logger.write('hello');
      await logger.close();
    } finally {
      process.umask(previousUmask);
    }

    expect(statSync(join(dir, 'bridge-@s.log')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'bridge-@s.log'), 'utf8')).toBe('hello\n');
  });

  it('creates the file opened after a rotation owner-only too', async () => {
    const previousUmask = process.umask(0o000);
    try {
      // 1-byte max size: the first write rotates, so the next open goes through rotate()
      const logger = new FileLogger({ filePath: join(dir, 'bridge-@s.log'), maxSize: 1 });
      await logger.init();
      logger.write('first line');
      // rotation is asynchronous: wait until the rotated file shows up
      const rotated = join(dir, 'bridge-@s.log.1');
      for (let i = 0; i < 200 && !existsSync(rotated); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      logger.write('second line');
      await logger.close();
    } finally {
      process.umask(previousUmask);
    }

    expect(statSync(join(dir, 'bridge-@s.log')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'bridge-@s.log.1')).mode & 0o777).toBe(0o600);
  });
});

describe('FileLogger rotation', () => {
  it('keeps every line written while a rotation is in progress', async () => {
    // 1-byte max size: every write rotates, so the second and third writes land while
    // the first rotation is closing and renaming files
    const logger = new FileLogger({ filePath: join(dir, 'bridge-@s.log'), maxSize: 1 });
    await logger.init();
    logger.write('first');
    logger.write('second');
    logger.write('third');
    await logger.close();

    const lines = readdirSync(dir)
      .filter((name) => name.startsWith('bridge-@s.log'))
      .flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n'))
      .filter((line) => line.length > 0)
      .sort();
    expect(lines).toEqual(['first', 'second', 'third']);
    // Each line rotated once written (the limit is one byte), in order, into its own file
    expect(readFileSync(join(dir, 'bridge-@s.log.1'), 'utf8')).toBe('third\n');
    expect(readFileSync(join(dir, 'bridge-@s.log.2'), 'utf8')).toBe('second\n');
    expect(readFileSync(join(dir, 'bridge-@s.log.3'), 'utf8')).toBe('first\n');
    expect(readFileSync(join(dir, 'bridge-@s.log'), 'utf8')).toBe('');
  });

  it('waits for the rotated stream to close before renaming', async () => {
    const logger = new FileLogger({ filePath: join(dir, 'bridge-@s.log'), maxSize: 1 });
    await logger.init();
    logger.write('only');
    await logger.close();
    // The rotation moved the whole first file aside, so nothing of it was lost or split
    expect(readFileSync(join(dir, 'bridge-@s.log.1'), 'utf8')).toBe('only\n');
    expect(readFileSync(join(dir, 'bridge-@s.log'), 'utf8')).toBe('');
  });
});
