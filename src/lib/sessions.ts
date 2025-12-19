/**
 * Session management
 * Provides functions to read and manage sessions stored in ~/.mcpc/sessions.json
 * Uses file locking to prevent concurrent access issues
 */

import { readFile, writeFile, rename, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as lockfile from 'proper-lockfile';
import type { SessionData, SessionsStorage } from './types.js';
import { getSessionsFilePath, exists, ensureDir, getMcpcHome } from './utils.js';
import { createLogger } from './logger.js';
import { ClientError } from './errors.js';

const logger = createLogger('sessions');

// Lock timeout in milliseconds (5 seconds as per CLAUDE.md)
const LOCK_TIMEOUT = 5000;

/**
 * Load sessions from storage file
 * Returns an empty sessions structure if file doesn't exist
 */
async function loadSessionsInternal(): Promise<SessionsStorage> {
  const filePath = getSessionsFilePath();

  if (!(await exists(filePath))) {
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

/**
 * Execute an operation with file locking
 * Prevents concurrent access to sessions.json
 */
async function withLock<T>(
  operation: () => Promise<T>
): Promise<T> {
  const filePath = getSessionsFilePath();

  // Ensure the directory and file exist before locking
  await ensureDir(getMcpcHome());
  if (!(await exists(filePath))) {
    await writeFile(filePath, JSON.stringify({ sessions: {} }, null, 2), 'utf-8');
  }

  let release: (() => Promise<void>) | undefined;

  try {
    // Acquire lock with timeout
    logger.debug('Acquiring file lock...');
    release = await lockfile.lock(filePath, {
      retries: {
        retries: 5,
        minTimeout: 100,
        maxTimeout: LOCK_TIMEOUT,
      },
    });

    logger.debug('Lock acquired');

    // Execute operation
    const result = await operation();

    return result;
  } catch (error) {
    if ((error as Error).message.includes('ELOCKED')) {
      throw new ClientError(
        'Sessions file is locked by another process. Please try again.'
      );
    }
    throw error;
  } finally {
    // Always release lock
    if (release) {
      try {
        await release();
        logger.debug('Lock released');
      } catch (error) {
        logger.warn('Failed to release lock:', error);
      }
    }
  }
}

/**
 * Load sessions from storage (with locking)
 */
export async function loadSessions(): Promise<SessionsStorage> {
  return withLock(async () => {
    return await loadSessionsInternal();
  });
}

/**
 * Get all sessions as a flat list
 */
export async function listSessions(): Promise<SessionData[]> {
  const storage = await loadSessions();
  const sessions: SessionData[] = [];

  for (const sessionName in storage.sessions) {
    const session = storage.sessions[sessionName];
    if (session) {
      sessions.push(session);
    }
  }

  return sessions;
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
 * @param sessionName - Name of the session (without @ prefix)
 * @param sessionData - Session data to store
 */
export async function saveSession(
  sessionName: string,
  sessionData: Omit<SessionData, 'name'>
): Promise<void> {
  return withLock(async () => {
    const storage = await loadSessionsInternal();

    // Add name field and timestamps
    const now = new Date().toISOString();
    const existingSession = storage.sessions[sessionName];

    storage.sessions[sessionName] = {
      name: sessionName,
      ...sessionData,
      createdAt: existingSession?.createdAt || now,
      updatedAt: now,
    };

    await saveSessionsInternal(storage);

    logger.info(`Session '${sessionName}' saved`);
  });
}

/**
 * Update specific fields of an existing session
 * @param sessionName - Name of the session (without @ prefix)
 * @param updates - Partial session data to update
 */
export async function updateSession(
  sessionName: string,
  updates: Partial<Omit<SessionData, 'name' | 'createdAt' | 'updatedAt'>>
): Promise<void> {
  return withLock(async () => {
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
      updatedAt: new Date().toISOString(),
    };

    await saveSessionsInternal(storage);

    logger.info(`Session '${sessionName}' updated`);
  });
}

/**
 * Delete a session
 * @param sessionName - Name of the session to delete (without @ prefix)
 */
export async function deleteSession(sessionName: string): Promise<void> {
  return withLock(async () => {
    const storage = await loadSessionsInternal();

    if (!storage.sessions[sessionName]) {
      throw new ClientError(`Session not found: ${sessionName}`);
    }

    delete storage.sessions[sessionName];

    await saveSessionsInternal(storage);

    logger.info(`Session '${sessionName}' deleted`);
  });
}

/**
 * Check if a session exists
 */
export async function sessionExists(sessionName: string): Promise<boolean> {
  const storage = await loadSessions();
  return sessionName in storage.sessions;
}
