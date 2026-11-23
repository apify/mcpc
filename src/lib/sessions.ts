/**
 * Session management
 * Provides functions to read and manage sessions stored in ~/.mcpc/sessions.json
 * Uses file locking to prevent concurrent access issues
 */

import { readFile, writeFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
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
import {
  removeKeychainSessionHeaders,
  removeKeychainSessionEnv,
  removeKeychainProxyBearerToken,
  removeKeychainProxyListenerToken,
} from './auth/keychain.js';

const logger = createLogger('sessions');

/** Keep UUID credential receipts until every writer and serving owner has stopped. */
function assertCanDeleteSession(session: SessionData, willStopBridge = false): void {
  if (
    !willStopBridge &&
    (session.bridgeOwner || session.proxy || session.proxyListeners?.length) &&
    session.pid &&
    isProcessAlive(session.pid)
  ) {
    throw new ClientError(
      `Session ${session.name} still has a live proxy owner. Stop the bridge before deleting it.`
    );
  }
  if (!session.proxyListeners?.length) return;
  for (const entry of session.proxyListeners) {
    if (entry.credentialWriterPid && isProcessAlive(entry.credentialWriterPid)) {
      throw new ClientError(
        `Proxy ${entry.name} still has a credential writer. Retry closing the session after it exits.`
      );
    }
  }
}

export function assertSessionNotDeleting(session: SessionData): void {
  if (session.deletion) {
    throw new ClientError(
      `Session ${session.name} has pending deletion. Retry: mcpc ${session.name} close`
    );
  }
}

async function cleanupSessionCredentials(session: SessionData): Promise<void> {
  for (const entry of session.proxyListeners ?? []) {
    if (!entry.legacy && entry.authentication === 'bearer') {
      await removeKeychainProxyListenerToken(entry.id);
    }
  }
  await removeKeychainSessionHeaders(session.name);
  await removeKeychainSessionEnv(session.name);
  await removeKeychainProxyBearerToken(session.name);
}

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
      await quarantineCorruptSessionsFile(filePath, 'invalid format (missing "sessions" object)');
      return { sessions: {} };
    }

    return storage;
  } catch (error) {
    await quarantineCorruptSessionsFile(filePath, (error as Error).message);
    return { sessions: {} };
  }
}

/**
 * Move an unreadable sessions.json aside instead of silently discarding it.
 *
 * Without this, a corrupted file would be treated as "no sessions" and the very
 * next save would overwrite it with an empty map — permanently losing every
 * session record while their bridges keep running as orphans. The backup keeps
 * the data recoverable and the stderr warning makes the corruption visible.
 */
async function quarantineCorruptSessionsFile(filePath: string, reason: string): Promise<void> {
  const backupPath = `${filePath}.corrupt-${Date.now()}`;
  try {
    await atomicRename(filePath, backupPath);
    logger.warn(`Sessions file is corrupted (${reason}); backed up to ${backupPath}`);
    console.error(
      `Warning: ~/.mcpc sessions file was corrupted (${reason}). ` +
        `It has been backed up to ${backupPath} and reset. ` +
        `Run 'mcpc' to see current sessions and 'mcpc clean sessions' to clean up stale bridges.`
    );
  } catch (renameError) {
    // Rename failed (e.g. permissions) — warn, but do not throw: commands like
    // `mcpc connect` must still be usable.
    logger.warn(
      `Sessions file is corrupted (${reason}) and could not be backed up: ${(renameError as Error).message}`
    );
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
  sessionData: Omit<SessionData, 'name'>,
  options?: { createOnly?: boolean }
): Promise<SessionData> {
  const filePath = getSessionsFilePath();
  return withFileLock(
    filePath,
    async () => {
      const storage = await loadSessionsInternal();

      // Add name field and timestamps
      const now = new Date().toISOString();
      const existingSession = storage.sessions[sessionName];
      if (existingSession) assertSessionNotDeleting(existingSession);
      if (options?.createOnly && existingSession) {
        throw new ClientError(
          `Session ${sessionName} was created concurrently. Run the command again.`
        );
      }

      const saved: SessionData = {
        name: sessionName,
        ...sessionData,
        createdAt: existingSession?.createdAt || now,
      };
      storage.sessions[sessionName] = saved;

      await saveSessionsInternal(storage);

      logger.debug(`Session ${sessionName} saved`);
      return saved;
    },
    SESSIONS_DEFAULT_CONTENT
  );
}

/** The fields of a session that `updateSession` and `modifySession` may change. */
export type SessionUpdates = Partial<Omit<SessionData, 'name' | 'createdAt'>>;

/**
 * Update specific fields of an existing session
 * @param sessionName - Name of the session (without @ prefix)
 * @param updates - Partial session data to update
 */
export async function updateSession(sessionName: string, updates: SessionUpdates): Promise<void> {
  return modifySession(sessionName, () => updates);
}

/**
 * Update an existing session from its current state, atomically. `mutate` runs under the
 * sessions file lock with the session as stored at that moment and returns the fields to
 * change — or `undefined` to leave the session as it is — so two concurrent edits of the
 * same field compose: a task record one request prunes while another extends it keeps
 * both edits, where reading the session, editing the copy and calling `updateSession`
 * would let the last writer replace the other's snapshot.
 * @param sessionName - Name of the session (without @ prefix)
 * @param mutate - Computes the update from the stored session
 */
export async function modifySession(
  sessionName: string,
  mutate: (current: SessionData) => SessionUpdates | undefined
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
      assertSessionNotDeleting(existingSession);

      const updates = mutate(existingSession);
      if (updates === undefined) {
        logger.debug(`Session ${sessionName} left unchanged`);
        return;
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
export async function deleteSession(
  sessionName: string,
  expected?: Pick<SessionData, 'createdAt' | 'bridgeOwner' | 'pid'>,
  options?: { shutdownBridge?: boolean }
): Promise<void> {
  const filePath = getSessionsFilePath();
  const reservation = await withFileLock(
    filePath,
    async () => {
      const storage = await loadSessionsInternal();
      const current = storage.sessions[sessionName];
      if (!current) throw new ClientError(`Session not found: ${sessionName}`);
      if (
        expected &&
        (current.createdAt !== expected.createdAt ||
          current.bridgeOwner !== expected.bridgeOwner ||
          current.pid !== expected.pid)
      ) {
        throw new ClientError('Session changed before deletion. Run the command again.');
      }
      assertCanDeleteSession(current, options?.shutdownBridge);
      if (current.deletion?.workerPid && isProcessAlive(current.deletion.workerPid)) {
        throw new ClientError(
          `Session ${sessionName} already has a cleanup worker. Retry close after it exits.`
        );
      }
      // Only one worker may touch the old shared legacy/header accounts. Otherwise
      // a late second worker could delete credentials after the name is recreated.
      const reserved = { ...current, deletion: { id: randomUUID(), workerPid: process.pid } };
      storage.sessions[sessionName] = reserved;
      await saveSessionsInternal(storage);
      return reserved;
    },
    SESSIONS_DEFAULT_CONTENT
  );

  try {
    // Reserve before stopping: otherwise another command can observe the dead
    // PID and auto-restart the session between shutdown and credential cleanup.
    if (options?.shutdownBridge) {
      const { stopBridge } = await import('./bridge-manager.js');
      await stopBridge(sessionName, { graceful: true, expected: reservation });
      assertCanDeleteSession(reservation);
    }
    // Native keychain calls can block the event loop, including lock heartbeats.
    // Keep the durable reservation, but never hold a shared file lock here.
    await cleanupSessionCredentials(reservation);
    await withFileLock(
      filePath,
      async () => {
        const latest = await loadSessionsInternal();
        const current = latest.sessions[sessionName];
        if (
          !current ||
          current.createdAt !== reservation.createdAt ||
          current.bridgeOwner !== reservation.bridgeOwner ||
          current.pid !== reservation.pid ||
          current.deletion?.id !== reservation.deletion.id
        ) {
          throw new ClientError('Session deletion reservation changed. Retry close.');
        }
        delete latest.sessions[sessionName];
        await saveSessionsInternal(latest);
      },
      SESSIONS_DEFAULT_CONTENT
    );
  } catch (error) {
    // A failed/partial cleanup remains visible and can be retried. A crashed worker
    // leaves its PID; a subsequent close may reclaim it only after that PID exits.
    await withFileLock(
      filePath,
      async () => {
        const latest = await loadSessionsInternal();
        const current = latest.sessions[sessionName];
        if (current?.deletion?.id === reservation.deletion.id) {
          current.deletion = { id: reservation.deletion.id };
          await saveSessionsInternal(latest);
        }
      },
      SESSIONS_DEFAULT_CONTENT
    ).catch(() => {});
    throw error;
  }
  logger.debug(`Session ${sessionName} deleted`);
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
  const toDelete: SessionData[] = [];

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

        if (session.deletion) {
          if (cleanExpired) toDelete.push(session);
          continue;
        }

        // If session expired or unauthorized → remove it
        if (cleanExpired && (session.status === 'expired' || session.status === 'unauthorized')) {
          toDelete.push(session);
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
      const AUTO_RESTART_COOLDOWN_MILLIS = 10_000;
      const now = Date.now();

      // Expire stale 'connecting'/'reconnecting' states — if the connection attempt
      // started more than the cooldown period ago and no PID exists, assume it failed
      for (const [name, session] of Object.entries(storage.sessions)) {
        if (session?.deletion) continue;
        if (
          (session?.status === 'connecting' || session?.status === 'reconnecting') &&
          !session.pid
        ) {
          const attemptAt = session.lastConnectionAttemptAt
            ? new Date(session.lastConnectionAttemptAt).getTime()
            : 0;
          if (attemptAt > 0 && now - attemptAt > AUTO_RESTART_COOLDOWN_MILLIS) {
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
        if (session?.deletion || toDelete.some((entry) => entry.name === name)) continue;
        const isRetryableUnauthorized = session?.status === 'unauthorized' && !!session.profileName;
        if ((session?.status === 'crashed' || isRetryableUnauthorized) && !session.pid) {
          // Skip if a connection was already attempted within the cooldown window
          const lastAttempt = session.lastConnectionAttemptAt
            ? new Date(session.lastConnectionAttemptAt).getTime()
            : 0;
          if (now - lastAttempt <= AUTO_RESTART_COOLDOWN_MILLIS) {
            continue;
          }
          // Skip if bridge was recently alive — it may have just crashed and needs
          // time for cleanup before we restart (also avoids conflicts with parallel
          // sessions sharing the same home directory)
          const lastSeen = session.lastSeenAt ? new Date(session.lastSeenAt).getTime() : 0;
          if (lastSeen > 0 && now - lastSeen <= AUTO_RESTART_COOLDOWN_MILLIS) {
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

  for (const session of toDelete) {
    try {
      await deleteSession(session.name, session, { shutdownBridge: true });
      delete result.sessions[session.name];
      result.expiredSessions++;
      if (process.platform !== 'win32' && session.pid) {
        await unlink(getSocketPath(session.name, session.pid)).catch(() => {});
      }
    } catch {
      logger.warn(`Keeping session ${session.name}: shutdown or credential cleanup is incomplete.`);
    }
  }
  if (toDelete.length) result.sessions = (await loadSessions()).sessions;

  return result;
}
