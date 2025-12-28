/**
 * Session management
 * Provides functions to read and manage sessions stored in ~/.mcpc/sessions.json
 * Uses file locking to prevent concurrent access issues
 */

import { readFile, writeFile, rename, unlink, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SessionData, SessionsStorage } from './types.js';
import {
  getSessionsFilePath,
  fileExists,
  ensureDir,
  getMcpcHome,
  isProcessAlive,
  getBridgesDir,
} from './utils.js';
import { withFileLock } from './file-lock.js';
import { createLogger } from './logger.js';
import { ClientError } from './errors.js';
import { removeKeychainSessionHeaders } from './auth/keychain.js';

const logger = createLogger('sessions');

/**
 * Load sessions from storage file
 * Returns an empty sessions structure if file doesn't exist
 */
async function loadSessionsInternal(): Promise<SessionsStorage> {
  const filePath = getSessionsFilePath();

  if (!(await fileExists(filePath))) {
    logger.debug('Sessions file does not exist, returning empty sessions');
    return { sessions: {} };
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    const storage = JSON.parse(content) as SessionsStorage;

    if (!storage.sessions || typeof storage.sessions !== 'object') {
      logger.warn('Invalid sessions file format, returning empty sessions');
      return { sessions: {} };
    }

    return storage;
  } catch (error) {
    logger.warn(`Failed to load sessions: ${(error as Error).message}`);
    return { sessions: {} };
  }
}

/**
 * Save sessions to storage file atomically
 * Uses temp file + rename for atomicity
 */
async function saveSessionsInternal(storage: SessionsStorage): Promise<void> {
  const filePath = getSessionsFilePath();

  // Ensure the directory exists
  await ensureDir(getMcpcHome());

  // Write to a temp file first (atomic operation)
  const tempFile = join(tmpdir(), `mcpc-sessions-${Date.now()}-${process.pid}.json`);

  try {
    const content = JSON.stringify(storage, null, 2);
    await writeFile(tempFile, content, 'utf-8');

    // Atomic rename
    await rename(tempFile, filePath);

    logger.debug('Sessions saved successfully');
  } catch (error) {
    // Clean up temp file on error
    try {
      await unlink(tempFile);
    } catch {
      // Ignore cleanup errors
    }
    throw new ClientError(`Failed to save sessions: ${(error as Error).message}`);
  }
}

const SESSIONS_DEFAULT_CONTENT = JSON.stringify({ sessions: {} }, null, 2);

/**
 * Load sessions from storage (with locking)
 */
export async function loadSessions(): Promise<SessionsStorage> {
  const filePath = getSessionsFilePath();
  return withFileLock(filePath, loadSessionsInternal, SESSIONS_DEFAULT_CONTENT);
}

/**
 * Get a specific session by name
 */
export async function getSession(sessionName: string): Promise<SessionData | undefined> {
  const storage = await loadSessions();
  return storage.sessions[sessionName];
}

/**
 * Create or update a session
 * @param sessionName - Name of the session (with @ prefix)
 * @param sessionData - Session data to store
 */
export async function saveSession(
  sessionName: string,
  sessionData: Omit<SessionData, 'name'>
): Promise<void> {
  const filePath = getSessionsFilePath();
  return withFileLock(filePath, async () => {
    const storage = await loadSessionsInternal();

    // Add name field and timestamps
    const now = new Date().toISOString();
    const existingSession = storage.sessions[sessionName];

    storage.sessions[sessionName] = {
      name: sessionName,
      ...sessionData,
      createdAt: existingSession?.createdAt || now,
    };

    await saveSessionsInternal(storage);

    logger.debug(`Session ${sessionName} saved`);
  }, SESSIONS_DEFAULT_CONTENT);
}

/**
 * Update specific fields of an existing session
 * @param sessionName - Name of the session (without @ prefix)
 * @param updates - Partial session data to update
 */
export async function updateSession(
  sessionName: string,
  updates: Partial<Omit<SessionData, 'name' | 'createdAt'>>
): Promise<void> {
  const filePath = getSessionsFilePath();
  return withFileLock(filePath, async () => {
    const storage = await loadSessionsInternal();

    const existingSession = storage.sessions[sessionName];
    if (!existingSession) {
      throw new ClientError(`Session not found: ${sessionName}`);
    }

    // Merge updates
    storage.sessions[sessionName] = {
      ...existingSession,
      ...updates,
      name: sessionName, // Ensure name doesn't change
    };

    await saveSessionsInternal(storage);

    logger.debug(`Session ${sessionName} updated`);
  }, SESSIONS_DEFAULT_CONTENT);
}

/**
 * Delete a session
 * @param sessionName - Name of the session to delete (without @ prefix)
 */
export async function deleteSession(sessionName: string): Promise<void> {
  const filePath = getSessionsFilePath();
  return withFileLock(filePath, async () => {
    const storage = await loadSessionsInternal();

    if (!storage.sessions[sessionName]) {
      throw new ClientError(`Session not found: ${sessionName}`);
    }

    delete storage.sessions[sessionName];

    await saveSessionsInternal(storage);

    // Delete headers from keychain (if any)
    try {
      await removeKeychainSessionHeaders(sessionName);
      logger.debug(`Deleted headers from keychain for session: ${sessionName}`);
    } catch {
      // Ignore errors - headers may not exist
    }

    logger.debug(`Session ${sessionName} deleted`);
  }, SESSIONS_DEFAULT_CONTENT);
}

/**
 * Check if a session exists
 */
export async function sessionExists(sessionName: string): Promise<boolean> {
  const storage = await loadSessions();
  return sessionName in storage.sessions;
}


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
        // TODO: call removeKeychainSessionHeaders()
        continue;
      }

      // Check bridge status
      if (!session.pid) {
        continue;
      }
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
        session.status = 'dead';
        result.deadBridges++;
      }
    }

    // Save updated sessions
    if (result.deadBridges > 0 || result.expiredSessions > 0) {
      const tempFile = join(tmpdir(), `mcpc-sessions-${Date.now()}-${process.pid}.json`);
      try {
        const content = JSON.stringify(storage, null, 2);
        await writeFile(tempFile, content, 'utf-8');
        await rename(tempFile, filePath);
        logger.debug('Sessions consolidated and saved');
      } catch (error) {
        try {
          await unlink(tempFile);
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

