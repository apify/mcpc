/**
 * Reader for bridge log files (~/.mcpc/logs/bridge-<session>.log[.N]).
 *
 * Produces raw text lines for human output and structured records for JSON output.
 * Transparently spans rotated files (.log.5 → .log.1 → .log).
 */

import { readdir, readFile, stat } from 'fs/promises';
import { createReadStream, watch as fsWatch, type FSWatcher, type Stats } from 'fs';
import { join } from 'path';
import { getLogsDir } from './utils.js';

/**
 * A parsed log record. All fields are optional to keep the JSON output compact:
 *   - Entries that match `[ISO] [LEVEL] [context?] msg` carry `time`, `level`,
 *     optionally `context`, and `msg`.
 *   - Lines that don't (banners, stack-trace frames that landed at the top of a
 *     window, etc.) carry only `raw`.
 *
 * Continuation lines (anything that doesn't begin with an `[ISO-timestamp]`)
 * fold into the preceding record's `msg` or `raw`, so a multi-line error stays
 * a single record.
 */
export interface LogRecord {
  /** ISO 8601 timestamp, e.g. "2026-04-28T12:01:14.231Z". */
  time?: string;
  /** Lowercased level: debug, info, warn, error, ... */
  level?: string;
  /** Optional context tag, e.g. "bridge-manager". */
  context?: string;
  /** Message body without the prefix. May span multiple lines. */
  msg?: string;
  /** Raw text for lines that didn't match the expected prefix shape. */
  raw?: string;
}

export interface ReadLogsOptions {
  /** Maximum number of lines to return (most recent kept). */
  tail?: number;
  /** Drop lines with a parseable timestamp older than this Date. Unparseable lines are kept. */
  since?: Date;
}

const LINE_RE =
  /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\] \[([A-Z]+)\](?: \[([^\]]+)\])?\s?(.*)$/;

/**
 * A line starts a new log entry when it begins with an `[ISO-timestamp]`.
 * Lines that don't (e.g. stack-trace frames) are continuations of the entry above.
 */
export const ENTRY_START_RE = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\]/;

/**
 * Path of the active (current) bridge log file for a session.
 * `sessionName` should include the leading "@".
 */
export function getBridgeLogPath(sessionName: string): string {
  return join(getLogsDir(), `bridge-${sessionName}.log`);
}

/**
 * Parse a single raw log line into a structured record.
 * Lines that don't match the expected `[ISO] [LEVEL] [context?] msg` shape return `{ raw }`.
 * Absent fields are omitted (rather than serialized as `null`) to keep JSON output compact.
 */
export function parseLogLine(line: string): LogRecord {
  const m = LINE_RE.exec(line);
  if (!m) {
    return { raw: line };
  }
  // Field order chosen to read naturally in JSON output: time, level, context, msg.
  const rec: LogRecord = {};
  if (m[1]) rec.time = m[1];
  if (m[2]) rec.level = m[2].toLowerCase();
  if (m[3]) rec.context = m[3];
  rec.msg = m[4] ?? '';
  return rec;
}

/**
 * Append a continuation line (e.g. a stack-trace frame) onto the record it belongs to,
 * preserving the newline so the original multi-line text round-trips.
 */
export function appendContinuation(record: LogRecord, line: string): void {
  if (record.msg !== undefined) {
    record.msg += '\n' + line;
  } else {
    record.raw = (record.raw ?? '') + '\n' + line;
  }
}

/**
 * Parse raw log lines into structured records, folding continuation lines
 * (stack-trace frames and other un-prefixed lines) into the entry above them.
 * A line begins a new entry only when it starts with an `[ISO-timestamp]`.
 */
export function parseLogLines(lines: string[]): LogRecord[] {
  const records: LogRecord[] = [];
  for (const line of lines) {
    const prev = records[records.length - 1];
    if (prev && !ENTRY_START_RE.test(line)) {
      appendContinuation(prev, line);
    } else {
      records.push(parseLogLine(line));
    }
  }
  return records;
}

/**
 * List all log files for a session in age order (oldest first, current last).
 * Returns absolute paths. Returns [] if the logs directory or files don't exist.
 */
export async function listLogFiles(sessionName: string): Promise<string[]> {
  const dir = getLogsDir();
  const baseName = `bridge-${sessionName}.log`;
  const basePath = join(dir, baseName);

  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const rotated: { path: string; num: number }[] = [];
  for (const file of files) {
    if (file.startsWith(baseName + '.')) {
      const numStr = file.substring(baseName.length + 1);
      const num = parseInt(numStr, 10);
      if (!isNaN(num)) {
        rotated.push({ path: join(dir, file), num });
      }
    }
  }
  // Higher rotation numbers are older (.5 oldest, .1 newest among rotated).
  rotated.sort((a, b) => b.num - a.num);
  const result = rotated.map((r) => r.path);

  try {
    await stat(basePath);
    result.push(basePath);
  } catch {
    // current file doesn't exist yet
  }
  return result;
}

function parseLineTimestamp(line: string): number | null {
  const m = LINE_RE.exec(line);
  if (!m || !m[1]) return null;
  const t = Date.parse(m[1]);
  return isNaN(t) ? null : t;
}

/**
 * Read recent log lines for a session, transparently spanning rotated files.
 * Returns lines in chronological order (oldest first).
 */
export async function readRecentLogLines(
  sessionName: string,
  options: ReadLogsOptions = {}
): Promise<string[]> {
  const files = await listLogFiles(sessionName);
  if (files.length === 0) return [];

  const cutoff = options.since ? options.since.getTime() : null;
  const collected: string[] = [];

  // Read newest file first; stop early once we have enough lines or hit a fully out-of-range file.
  for (let i = files.length - 1; i >= 0; i--) {
    const path = files[i];
    if (!path) continue;
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      continue;
    }

    const rawLines = content.split('\n');
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
      rawLines.pop();
    }

    let kept = rawLines;
    if (cutoff !== null) {
      kept = rawLines.filter((line) => {
        const ts = parseLineTimestamp(line);
        // Lines without parseable timestamps (banners, stack frames) are kept.
        return ts === null || ts >= cutoff;
      });
    }

    collected.unshift(...kept);

    // Stop reading older files when we either have enough lines (no --since)
    // or every line in the just-read file pre-dates the cutoff (--since path).
    if (cutoff === null && options.tail !== undefined && collected.length >= options.tail) {
      break;
    }
    if (cutoff !== null && rawLines.length > 0) {
      const allBeforeCutoff = rawLines.every((line) => {
        const ts = parseLineTimestamp(line);
        return ts !== null && ts < cutoff;
      });
      if (allBeforeCutoff) break;
    }
  }

  if (options.tail !== undefined && collected.length > options.tail) {
    return collected.slice(collected.length - options.tail);
  }
  return collected;
}

/**
 * Parse a duration shorthand like "30s", "5m", "2h", "1d", "1w" into milliseconds.
 * Returns null for unparseable input.
 */
export function parseDurationMillis(input: string): number | null {
  const m = /^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|wk|wks)$/i.exec(input.trim());
  if (!m || !m[1] || !m[2]) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const SEC_MILLIS = 1000;
  const MIN_MILLIS = 60 * SEC_MILLIS;
  const HOUR_MILLIS = 60 * MIN_MILLIS;
  const DAY_MILLIS = 24 * HOUR_MILLIS;
  const WEEK_MILLIS = 7 * DAY_MILLIS;
  if (unit.startsWith('s')) return n * SEC_MILLIS;
  if (unit.startsWith('mi') || unit === 'm') return n * MIN_MILLIS;
  if (unit.startsWith('h')) return n * HOUR_MILLIS;
  if (unit.startsWith('d')) return n * DAY_MILLIS;
  if (unit.startsWith('w')) return n * WEEK_MILLIS;
  return null;
}

/**
 * Resolve `--since <value>` to an absolute Date.
 * Accepts duration shorthand (treated as relative to now) or an ISO 8601 timestamp.
 * Returns null if the input cannot be parsed.
 */
export function resolveSince(input: string): Date | null {
  const millis = parseDurationMillis(input);
  if (millis !== null) {
    return new Date(Date.now() - millis);
  }
  const t = Date.parse(input);
  if (!isNaN(t)) {
    return new Date(t);
  }
  return null;
}

export interface FollowOptions {
  /**
   * Poll interval in ms. Backstop for filesystems where fs.watch is unreliable
   * (NFS, some network mounts). Defaults to 1000ms; tests can lower it.
   */
  pollIntervalMillis?: number;
  /**
   * Start streaming from the beginning of the file instead of the end.
   * Default false — backlog is normally the caller's responsibility.
   */
  startAtBeginning?: boolean;
}

/**
 * Live-follow the current log file for a session (tail -f style).
 *
 * - Streams appended bytes to `onLine`, line by line.
 * - On rotation (size shrinks or inode changes), re-opens the file from the start.
 * - Returns a `stop()` function that cleans up watchers and pending reads.
 */
export function followLog(
  sessionName: string,
  onLine: (line: string) => void,
  options: FollowOptions = {}
): { stop: () => Promise<void> } {
  const path = getBridgeLogPath(sessionName);
  const pollIntervalMillis = options.pollIntervalMillis ?? 1000;
  let position = 0;
  let inode: number | null = null;
  let watcher: FSWatcher | null = null;
  let reading = false;
  let queued = false;
  let stopped = false;
  let buffer = '';

  const flush = (chunk: string): void => {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      onLine(line);
      idx = buffer.indexOf('\n');
    }
  };

  const drainPending = async (): Promise<void> => {
    if (stopped) return;
    if (reading) {
      queued = true;
      return;
    }
    reading = true;
    try {
      let st: Stats;
      try {
        st = await stat(path);
      } catch {
        // File doesn't exist yet — wait for it via the directory watcher (set up below).
        return;
      }
      // Detect rotation: inode changed or size shrunk → reset to start of new file.
      if (inode !== null && (st.ino !== inode || st.size < position)) {
        position = 0;
        if (buffer) {
          // Emit any partial line we had buffered before rotation.
          onLine(buffer);
          buffer = '';
        }
      }
      inode = st.ino;
      if (st.size <= position) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(path, {
          start: position,
          end: st.size - 1,
          encoding: 'utf8',
        });
        stream.on('data', (chunk) => flush(chunk as string));
        stream.on('error', reject);
        stream.on('end', () => {
          position = st.size;
          resolve();
        });
      });
    } finally {
      reading = false;
      if (queued && !stopped) {
        queued = false;
        void drainPending();
      }
    }
  };

  // Start at end of file so backlog is the caller's responsibility, unless the
  // caller explicitly opts into replaying from the beginning (used by tests).
  void (async () => {
    try {
      const st = await stat(path);
      position = options.startAtBeginning ? 0 : st.size;
      inode = st.ino;
      if (options.startAtBeginning) {
        await drainPending();
      }
    } catch {
      position = 0;
    }
    if (stopped) return;
    try {
      watcher = fsWatch(path, () => void drainPending());
      watcher.on('error', () => {
        // Swallow: the periodic poll below keeps us going if fs.watch hiccups.
      });
    } catch {
      // fs.watch may fail on some filesystems; the poller below covers us.
    }
  })();

  // Belt-and-suspenders polling so rotations and edge cases on certain filesystems
  // (NFS, network mounts) still get picked up.
  const poll = setInterval(() => {
    void drainPending();
  }, pollIntervalMillis);

  return {
    stop: async (): Promise<void> => {
      stopped = true;
      clearInterval(poll);
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
        watcher = null;
      }
      // Final drain to flush any pending tail before exit.
      await drainPending();
      if (buffer) {
        onLine(buffer);
        buffer = '';
      }
    },
  };
}
