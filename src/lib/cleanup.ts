/**
 * Shared cleanup utilities
 */

import { readdir, unlink, stat } from 'fs/promises';
import { join } from 'path';
import { getLogsDir, getBridgesDir, fileExists, isProcessAlive } from './utils.js';
import { createLogger } from './logger.js';
import type { SessionData, SessionsStorage } from './types.js';
import { getSessionsFilePath } from './utils.js';
import { withFileLock } from './file-lock.js';

const logger = createLogger('cleanup');

/**
 * Result of session consolidation
 */
export interface ConsolidateSessionsResult {
  /** Number of sessions with dead bridges that were updated */
  deadBridges: number;
  /** Number of expired sessions that were removed */
  expiredSessions: number;
  /** Number of stale socket files that were deleted */
  staleSockets: number;
  /** Updated sessions map (for use by caller) */
  sessions: Record<string, SessionData>;
}

/**
 * Consolidate sessions: review all sessions, update their status, and clean up stale resources.
 *
 * This function performs a single atomic operation that:
 * 1. Acquires the session file lock
 * 2. Reviews each session's bridge status (live/dead/expired)
 * 3. Clears pid/socketPath from sessions with dead bridges
 * 4. Removes expired sessions from the list
 * 5. Saves the updated sessions file
 * 6. Deletes stale socket files (in background, ignoring errors)
 *
 * Use this function in both `listSessionsAndAuthProfiles()` and `--clean` operation.
 *
 * @returns Counts of what was cleaned up, plus the updated sessions
 */
export async function consolidateSessions(): Promise<ConsolidateSessionsResult> {
  const result: ConsolidateSessionsResult = {
    deadBridges: 0,
    expiredSessions: 0,
    staleSockets: 0,
    sessions: {},
  };

  const filePath = getSessionsFilePath();
  const defaultContent = JSON.stringify({ sessions: {} }, null, 2);

  await withFileLock(filePath, async () => {
    // Load sessions
    let storage: SessionsStorage;
    if (await fileExists(filePath)) {
      try {
        const { readFile } = await import('fs/promises');
        const content = await readFile(filePath, 'utf-8');
        storage = JSON.parse(content) as SessionsStorage;
        if (!storage.sessions || typeof storage.sessions !== 'object') {
          storage = { sessions: {} };
        }
      } catch {
        storage = { sessions: {} };
      }
    } else {
      storage = { sessions: {} };
    }

    // Track which sessions have sockets (for orphan detection)
    const sessionsWithValidSockets = new Set<string>();

    // Review each session
    const sessionNames = Object.keys(storage.sessions);
    for (const name of sessionNames) {
      const session = storage.sessions[name];
      if (!session) continue;

      // Check for expired sessions → remove them
      if (session.status === 'expired') {
        logger.debug(`Removing expired session: ${name}`);
        delete storage.sessions[name];
        result.expiredSessions++;
        continue;
      }

      // Check bridge status
      if (session.pid) {
        if (isProcessAlive(session.pid)) {
          // Bridge is alive
          if (session.socketPath) {
            sessionsWithValidSockets.add(session.socketPath);
          }
        } else {
          // Bridge is dead → clear pid/socketPath
          logger.debug(`Clearing dead bridge info for session: ${name} (PID: ${session.pid})`);
          delete session.pid;
          delete session.socketPath;
          result.deadBridges++;
        }
      }
    }

    // Save updated sessions
    if (result.deadBridges > 0 || result.expiredSessions > 0) {
      const { writeFile, rename, unlink: unlinkFile } = await import('fs/promises');
      const { tmpdir } = await import('os');

      const tempFile = join(tmpdir(), `mcpc-sessions-${Date.now()}-${process.pid}.json`);
      try {
        const content = JSON.stringify(storage, null, 2);
        await writeFile(tempFile, content, 'utf-8');
        await rename(tempFile, filePath);
        logger.debug('Sessions consolidated and saved');
      } catch (error) {
        try {
          await unlinkFile(tempFile);
        } catch {
          // Ignore cleanup errors
        }
        throw error;
      }
    }

    result.sessions = storage.sessions;

    // Clean up stale socket files (sockets without valid session or with dead bridge)
    // This runs within the lock to ensure consistency (TODO only delete known sockets!)
    const bridgesDir = getBridgesDir();
    if (await fileExists(bridgesDir)) {
      const files = await readdir(bridgesDir);
      for (const file of files) {
        if (file.endsWith('.sock')) {
          const socketPath = join(bridgesDir, file);
          if (!sessionsWithValidSockets.has(socketPath)) {
            try {
              await unlink(socketPath);
              result.staleSockets++;
              logger.debug(`Removed stale socket: ${file}`);
            } catch {
              // Ignore errors - file may already be deleted
            }
          }
        }
      }
    }
  }, defaultContent);

  return result;
}

/**
 * Clean up orphaned log files (logs for sessions that no longer exist)
 * Only deletes files older than the specified age to avoid removing recent debug logs
 *
 * @param activeSessions - Map of active session names (used to check if session exists)
 * @param options - Cleanup options
 * @param options.maxAgeDays - Only delete files older than this many days (default: 7)
 * @param options.skipSession - Session name to skip (e.g., current session in bridge)
 * @returns Number of files deleted
 */
export async function cleanupOrphanedLogFiles(
  activeSessions: Record<string, unknown>,
  options: { maxAgeDays?: number; skipSession?: string } = {}
): Promise<number> {
  const { maxAgeDays = 7, skipSession } = options;

  let deletedCount = 0;
  const logsDir = getLogsDir();

  if (!(await fileExists(logsDir))) {
    return 0;
  }

  const files = await readdir(logsDir);

  // Match bridge log files: bridge-@session.log, bridge-@session.log.1, etc.
  const bridgeLogPattern = /^bridge-(@.+?)\.log(?:\.\d+)?$/;

  // Calculate cutoff date
  const cutoffTime = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  logger.debug(`Cleaning orphaned logs older than ${maxAgeDays} days`);

  for (const file of files) {
    const match = file.match(bridgeLogPattern);
    if (!match || !match[1]) continue;

    const sessionName = match[1];

    // Skip the specified session (e.g., current session in bridge)
    if (skipSession && sessionName === skipSession) {
      logger.debug(`Skipping current session's log file: ${file}`);
      continue;
    }

    // Only clean logs for sessions that no longer exist
    if (!activeSessions[sessionName]) {
      const filePath = join(logsDir, file);

      try {
        const fileStats = await stat(filePath);
        const fileAge = fileStats.mtime.getTime();
        const ageInDays = Math.floor((Date.now() - fileAge) / (24 * 60 * 60 * 1000));

        // Only delete if older than cutoff
        if (fileAge < cutoffTime) {
          await unlink(filePath);
          deletedCount++;
          logger.debug(`Removed orphaned log file: ${file} (age: ${ageInDays} days)`);
        } else {
          logger.debug(`Keeping recent orphaned log file: ${file} (age: ${ageInDays} days)`);
        }
      } catch {
        // Ignore stat/unlink errors
        logger.debug(`Failed to process log file: ${file}`);
      }
    }
  }

  return deletedCount;
}
