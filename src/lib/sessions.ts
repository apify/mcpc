/**
 * Session management
 * Provides functions to read and manage sessions stored in ~/.mcpc/sessions.json
 * Uses file locking to prevent concurrent access issues
 */

import { readFile, writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import type { SessionData, SessionsStorage } from './types.js';
import {
  getSessionsFilePath,
  getSocketPath,
  fileExists,
  ensureDir,
  getMcpcHome,
  isProcessAlive,
  atomicRename,
} from './utils.js';
import { withFileLock } from './file-lock.js';
import { createLogger } from './logger.js';
import { ClientError } from './errors.js';
import { removeKeychainSessionHeaders, removeKeychainProxyBearerToken } from './auth/keychain.js';

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

  // Write temp file in the same directory as the target to avoid EXDEV on Linux
  // (rename() fails across filesystem boundaries, e.g. /tmp vs ~/.mcpc)
  const tempFile = join(getMcpcHome(), `.sessions-${Date.now()}-${process.pid}.tmp`);

  try {
    const content = JSON.stringify(storage, null, 2);
    await writeFile(tempFile, content, { encoding: 'utf-8', mode: 0o600 });

    // Atomic rename (retries on Windows EPERM/EBUSY from transient file locks)
    await atomicRename(tempFile, filePath);

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
  return withFileLock(
    filePath,
    async () => {
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
    },
    SESSIONS_DEFAULT_CONTENT
  );
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
  return withFileLock(
    filePath,
    async () => {
      const storage = await loadSessionsInternal();

      const existingSession = storage.sessions[sessionName];
      if (!existingSession) {
        throw new ClientError(`Session not found: ${sessionName}`);
      }

      // Merge updates (shallow merge for most fields)
      const merged = {
        ...existingSession,
        ...updates,
        name: sessionName, // Ensure name doesn't change
      };

      // Deep merge notifications field to preserve existing timestamps
      if (updates.notifications) {
        merged.notifications = {
          ...existingSession.notifications,
          tools: { ...existingSession.notifications?.tools, ...updates.notifications.tools },
          prompts: { ...existingSession.notifications?.prompts, ...updates.notifications.prompts },
          resources: {
            ...existingSession.notifications?.resources,
            ...updates.notifications.resources,
          },
        };
      }

      storage.sessions[sessionName] = merged;

      await saveSessionsInternal(storage);

      logger.debug(`Session ${sessionName} updated`);
    },
    SESSIONS_DEFAULT_CONTENT
  );
}

/**
 * Delete a session
 * @param sessionName - Name of the session to delete (without @ prefix)
 */
export async function deleteSession(sessionName: string): Promise<void> {
  const filePath = getSessionsFilePath();
  return withFileLock(
    filePath,
    async () => {
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

      // Delete proxy bearer token from keychain (if any)
      try {
        await removeKeychainProxyBearerToken(sessionName);
        logger.debug(`Deleted proxy bearer token from keychain for session: ${sessionName}`);
      } catch {
        // Ignore errors - token may not exist
      }

      logger.debug(`Session ${sessionName} deleted`);
    },
    SESSIONS_DEFAULT_CONTENT
  );
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
  /** Number of sessions with crashed bridges that were updated */
  crashedBridges: number;
  /** Number of expired sessions that were removed */
  expiredSessions: number;
  /** Updated sessions map (for use by caller) */
  sessions: Record<string, SessionData>;
  /** Session names eligible for automatic background restart */
  sessionsToRestart: string[];
}

/**
 * Consolidate sessions: flag them as 'crashed' if not alive, remove expired or invalid ones.
 * This function runs on every "mcpc" command, so it must be efficient, so it uses one lock for all sessions.
 *
 * @returns Counts of what was cleaned up, plus the updated sessions
 */
export async function consolidateSessions(
  cleanExpired: boolean
): Promise<ConsolidateSessionsResult> {
  const result: ConsolidateSessionsResult = {
    crashedBridges: 0,
    expiredSessions: 0,
    sessions: {},
    sessionsToRestart: [],
  };

  const filePath = getSessionsFilePath();
  const defaultContent = JSON.stringify({ sessions: {} }, null, 2);

  await withFileLock(
    filePath,
    async () => {
      const storage = await loadSessionsInternal();
      let hasChanges = false;

      // Review each session
      for (const [name, session] of Object.entries(storage.sessions)) {
        if (!session) {
          logger.debug(`Missing record for session: ${name}`);
          hasChanges = true;
          delete storage.sessions[name];
          continue;
        }

        // If session expired or unauthorized → remove it
        if (cleanExpired && (session.status === 'expired' || session.status === 'unauthorized')) {
          logger.debug(`Removing ${session.status} session: ${name}`);
          delete storage.sessions[name];
          result.expiredSessions++;
          hasChanges = true;

          // Delete headers from keychain (if any)
          try {
            await removeKeychainSessionHeaders(name);
            logger.debug(`Deleted headers from keychain for session: ${name}`);
          } catch {
            // Ignore errors - headers may not exist
          }

          // Delete proxy bearer token from keychain (if any)
          try {
            await removeKeychainProxyBearerToken(name);
            logger.debug(`Deleted proxy bearer token from keychain for session: ${name}`);
          } catch {
            // Ignore errors - token may not exist
          }

          // Delete socket file (Unix only - Windows named pipes don't leave files)
          if (process.platform !== 'win32' && session.pid) {
            const socketPath = getSocketPath(name, session.pid);
            try {
              await unlink(socketPath);
              logger.debug(`Removed stale socket: ${socketPath}`);
            } catch {
              // Ignore errors - file may already be deleted
            }
          }

          continue;
        }

        // Check bridge status - always remove pid if process is not alive
        if (session.pid && !isProcessAlive(session.pid)) {
          logger.debug(`Clearing crashed bridge PID for session: ${name} (PID: ${session.pid})`);
          // Clean up the PID-based socket file for this dead bridge
          if (process.platform !== 'win32') {
            try {
              await unlink(getSocketPath(name, session.pid));
            } catch {
              // Ignore - file may already be deleted by bridge cleanup
            }
          }
          delete session.pid;
          hasChanges = true;
          // Don't overwrite terminal/transient statuses
          if (
            session.status !== 'crashed' &&
            session.status !== 'expired' &&
            session.status !== 'unauthorized' &&
            session.status !== 'reconnecting' &&
            session.status !== 'connecting'
          ) {
            session.status = 'crashed';
            result.crashedBridges++;
          }
        } else if (
          !session.pid &&
          session.status !== 'crashed' &&
          session.status !== 'expired' &&
          session.status !== 'unauthorized' &&
          session.status !== 'connecting' &&
          session.status !== 'reconnecting'
        ) {
          // No pid but not marked crashed yet (and not in a transient/terminal state)
          session.status = 'crashed';
          result.crashedBridges++;
          hasChanges = true;
        }
      }

      // Cooldown: socket connect timeout (5s) + 5s buffer = 10s
      const AUTO_RESTART_COOLDOWN_MS = 10_000;
      const now = Date.now();

      // Expire stale 'connecting'/'reconnecting' states — if the connection attempt
      // started more than the cooldown period ago and no PID exists, assume it failed
      for (const [name, session] of Object.entries(storage.sessions)) {
        if (
          (session?.status === 'connecting' || session?.status === 'reconnecting') &&
          !session.pid
        ) {
          const attemptAt = session.lastConnectionAttemptAt
            ? new Date(session.lastConnectionAttemptAt).getTime()
            : 0;
          if (attemptAt > 0 && now - attemptAt > AUTO_RESTART_COOLDOWN_MS) {
            logger.debug(`Stale ${session.status} state for ${name}, marking as crashed`);
            session.status = 'crashed';
            result.crashedBridges++;
            hasChanges = true;
          }
        }
      }

      // Identify crashed or unauthorized sessions eligible for automatic reconnection.
      // Unauthorized sessions are only included when the session has an OAuth profile —
      // another session sharing the same profile may have refreshed the tokens, so a
      // retry can succeed as the bridge re-reads from keychain on startup. Sessions
      // without a profile (e.g. static bearer token via --header) cannot self-heal, so
      // retrying would just flip the status back to 'connecting' on every `mcpc` call
      // and hide the real state from the user.
      for (const [name, session] of Object.entries(storage.sessions)) {
        const isRetryableUnauthorized = session?.status === 'unauthorized' && !!session.profileName;
        if ((session?.status === 'crashed' || isRetryableUnauthorized) && !session.pid) {
          // Skip if a connection was already attempted within the cooldown window
          const lastAttempt = session.lastConnectionAttemptAt
            ? new Date(session.lastConnectionAttemptAt).getTime()
            : 0;
          if (now - lastAttempt <= AUTO_RESTART_COOLDOWN_MS) {
            continue;
          }
          // Skip if bridge was recently alive — it may have just crashed and needs
          // time for cleanup before we restart (also avoids conflicts with parallel
          // sessions sharing the same home directory)
          const lastSeen = session.lastSeenAt ? new Date(session.lastSeenAt).getTime() : 0;
          if (lastSeen > 0 && now - lastSeen <= AUTO_RESTART_COOLDOWN_MS) {
            logger.debug(`Skipping auto-restart for ${name}: bridge was recently alive`);
            continue;
          }
          session.lastConnectionAttemptAt = new Date(now).toISOString();
          // Use 'connecting' if session has never successfully connected, 'reconnecting' otherwise
          session.status = session.lastSeenAt ? 'reconnecting' : 'connecting';
          hasChanges = true;
          result.sessionsToRestart.push(name);
          logger.debug(`Marking session ${name} for auto-restart (${session.status})`);
        }
      }

      // Save updated sessions
      if (hasChanges) {
        await saveSessionsInternal(storage);
      }

      result.sessions = storage.sessions;
    },
    defaultContent
  );

  return result;
}
