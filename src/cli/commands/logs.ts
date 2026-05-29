/**
 * `mcpc @<session> logs` — show or follow bridge log files.
 */

import { stat } from 'fs/promises';
import chalk from 'chalk';
import { ClientError } from '../../lib/errors.js';
import { getSession } from '../../lib/sessions.js';
import {
  followLog,
  getBridgeLogPath,
  listLogFiles,
  parseLogLine,
  readRecentLogLines,
  resolveSince,
} from '../../lib/log-reader.js';
import { formatJson } from '../output.js';
import type { CommandOptions } from '../../lib/types.js';

const DEFAULT_TAIL = 50;

export interface LogsCommandOptions extends CommandOptions {
  tail?: number;
  follow?: boolean;
  since?: string;
}

/**
 * Implementation of `mcpc @<session> logs`.
 *
 * `target` is the session name including the leading "@" (e.g. "@apify").
 */
export async function showLogs(target: string, options: LogsCommandOptions): Promise<void> {
  if (!target.startsWith('@')) {
    throw new ClientError(
      `logs requires a session target (e.g. mcpc @<session> logs). Got: ${target}`
    );
  }

  const session = await getSession(target);
  if (!session) {
    throw new ClientError(
      `Session not found: ${target}\n\n` +
        `List sessions with: mcpc\nCreate one with: mcpc connect <server> ${target}`
    );
  }

  let since: Date | undefined;
  if (options.since) {
    since = resolveSince(options.since) ?? undefined;
    if (!since) {
      throw new ClientError(
        `Invalid --since value: "${options.since}". ` +
          `Use a duration (e.g. 30s, 5m, 2h, 1d, 1w) or an ISO 8601 timestamp.`
      );
    }
  }

  // Default tail also acts as the backlog size when --follow is set.
  const tail = options.tail ?? DEFAULT_TAIL;
  const backlog = await readRecentLogLines(target, { tail, ...(since && { since }) });

  if (options.outputMode === 'json') {
    if (!options.follow) {
      console.log(formatJson(backlog.map(parseLogLine)));
      return;
    }
    // Streaming: emit NDJSON (one record per line) — a JSON array can't be streamed.
    backlog.forEach(emitJsonLine);
    await follow(target, emitJsonLine);
    return;
  }

  // Human mode: header on stderr, raw log lines on stdout.
  for (const line of await buildHeader(target, since, tail, options.follow)) {
    console.error(line);
  }
  for (const line of backlog) {
    console.log(line);
  }
  if (options.follow) {
    await follow(target, (line) => console.log(line));
  }
}

function emitJsonLine(line: string): void {
  process.stdout.write(JSON.stringify(parseLogLine(line)) + '\n');
}

/**
 * Follow the log until interrupted, forwarding each new line.
 *
 * Cancellation sources:
 *   - SIGINT / SIGTERM (always — works for both interactive and piped invocations)
 *   - When stdin is a TTY: also accept ESC, Ctrl+C, or `q` keypresses. Putting
 *     stdin in raw mode short-circuits the kernel's Ctrl+C → SIGINT translation,
 *     so we have to read the 0x03 byte ourselves.
 */
function follow(sessionName: string, onLine: (line: string) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const sub = followLog(sessionName, onLine);
    const stdin = process.stdin;
    let onKey: ((data: Buffer) => void) | undefined;
    let stopping = false;

    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      if (onKey && stdin.isTTY) {
        stdin.removeListener('data', onKey);
        try {
          stdin.setRawMode?.(false);
        } catch {
          // restoring raw mode is best-effort
        }
        stdin.pause();
      }
      void sub.stop().finally(resolve);
    };

    const onSignal = (): void => stop();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
      stdin.resume();
      onKey = (data: Buffer): void => {
        const byte = data[0];
        // ESC (0x1b), Ctrl+C (0x03), or 'q'
        if (byte === 0x1b || byte === 0x03 || data.toString() === 'q') {
          stop();
        }
      };
      stdin.on('data', onKey);
    }
  });
}

async function buildHeader(
  sessionName: string,
  since: Date | undefined,
  tail: number,
  follow: boolean | undefined
): Promise<string[]> {
  const logPath = getBridgeLogPath(sessionName);
  const fileCount = (await listLogFiles(sessionName)).length;
  const size = await stat(logPath)
    .then((st) => st.size)
    .catch(() => null);

  const tailLabel = follow
    ? `following (backlog ${tail} lines, ESC/Ctrl+C/q to stop)`
    : since
      ? `since ${since.toISOString()}, last ${tail} lines`
      : `last ${tail} lines`;

  const sizeLabel =
    size === null
      ? `no logs yet`
      : fileCount > 1
        ? `${formatBytes(size)}, ${fileCount} files (current + ${fileCount - 1} rotated)`
        : formatBytes(size);

  return [chalk.dim(`Session ${sessionName}  ·  ${logPath}  ·  ${tailLabel}  ·  ${sizeLabel}`), ''];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
