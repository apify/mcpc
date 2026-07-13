/**
 * File locking utility
 * Provides atomic file operations with proper locking
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import * as lockfile from 'proper-lockfile';
import { ensureDir, fileExists } from './utils.js';
import { createLogger } from './logger.js';
import { ClientError } from './errors.js';

const logger = createLogger('file-lock');

// Lock timeout in milliseconds (5 seconds as per CLAUDE.md)
const LOCK_TIMEOUT_MILLIS = 5000;

/**
 * Execute an operation with file locking
 * Prevents concurrent access to a JSON file
 * @param filePath - Path to the file to lock
 * @param operation - Async operation to execute while holding the lock
 * @param defaultContent - Default content to write if file doesn't exist (default: empty object)
 */
export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  defaultContent: string = '{}'
): Promise<T> {
  const dir = join(filePath, '..');

  // Ensure the directory and file exist before locking
  await ensureDir(dir);
  if (!(await fileExists(filePath))) {
    await writeFile(filePath, defaultContent, { encoding: 'utf-8', mode: 0o600 });
  }

  let release: (() => Promise<void>) | undefined;

  try {
    // Acquire lock with timeout
    logger.debug(`Acquiring file lock for ${filePath}`);
    release = await lockfile.lock(filePath, {
      stale: 10000, // Consider lock stale after 10s (handles crashed processes)
      retries: {
        retries: 10,
        minTimeout: 200,
        maxTimeout: LOCK_TIMEOUT_MILLIS,
        randomize: true,
      },
    });

    logger.debug('Lock acquired');

    // Execute operation
    return await operation();
  } catch (error) {
    if ((error as Error).message.includes('ELOCKED')) {
      throw new ClientError(`File is locked by another process: ${filePath}. Please try again.`);
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
