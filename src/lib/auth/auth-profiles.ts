/**
 * Authentication profiles management
 * Provides functions to read and manage auth profiles stored in ~/.mcpc/auth-profiles.json
 * Uses file locking to prevent concurrent access issues
 */

import { readFile, writeFile, rename, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AuthProfile, AuthProfilesStorage } from '../types.js';
import { getAuthProfilesFilePath, fileExists, ensureDir, getMcpcHome } from '../utils.js';
import { withFileLock } from '../file-lock.js';
import { createLogger } from '../logger.js';
import { ClientError } from '../errors.js';
import {
  removeKeychainOAuthClientInfo,
  removeKeychainOAuthTokenInfo,
} from './keychain.js';

const logger = createLogger('auth-profiles');

const AUTH_PROFILES_DEFAULT_CONTENT = JSON.stringify({ profiles: {} }, null, 2);

/**
 * Load auth profiles from storage file (internal, no locking)
 * Returns an empty profiles structure if file doesn't exist
 */
async function loadAuthProfilesInternal(): Promise<AuthProfilesStorage> {
  const filePath = getAuthProfilesFilePath();

  if (!(await fileExists(filePath))) {
    logger.debug('Auth profiles file does not exist, returning empty profiles');
    return { profiles: {} };
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    const storage = JSON.parse(content) as AuthProfilesStorage;

    if (!storage.profiles || typeof storage.profiles !== 'object') {
      logger.warn('Invalid auth profiles file format, returning empty profiles');
      return { profiles: {} };
    }

    return storage;
  } catch (error) {
    logger.warn(`Failed to load auth profiles: ${(error as Error).message}`);
    return { profiles: {} };
  }
}

/**
 * Save auth profiles to storage file atomically (internal, no locking)
 * Uses temp file + rename for atomicity
 */
async function saveAuthProfilesInternal(storage: AuthProfilesStorage): Promise<void> {
  const filePath = getAuthProfilesFilePath();

  // Ensure the directory exists
  await ensureDir(getMcpcHome());

  // Write to a temp file first (atomic operation)
  const tempFile = join(tmpdir(), `mcpc-auth-profiles-${Date.now()}-${process.pid}.json`);

  try {
    const content = JSON.stringify(storage, null, 2);
    await writeFile(tempFile, content, { encoding: 'utf-8', mode: 0o600 });

    // Atomic rename
    await rename(tempFile, filePath);

    logger.debug('Auth profiles saved successfully');
  } catch (error) {
    // Clean up temp file on error
    try {
      await unlink(tempFile);
    } catch {
      // Ignore cleanup errors
    }
    throw new ClientError(`Failed to save auth profiles: ${(error as Error).message}`);
  }
}

/**
 * Load auth profiles from storage (with locking)
 */
export async function loadAuthProfiles(): Promise<AuthProfilesStorage> {
  const filePath = getAuthProfilesFilePath();
  return withFileLock(filePath, loadAuthProfilesInternal, AUTH_PROFILES_DEFAULT_CONTENT);
}

/**
 * Get all auth profiles as a flat list
 */
export async function listAuthProfiles(): Promise<AuthProfile[]> {
  const storage = await loadAuthProfiles();
  const profiles: AuthProfile[] = [];

  for (const serverUrl in storage.profiles) {
    const serverProfiles = storage.profiles[serverUrl];
    if (serverProfiles) {
      for (const profileName in serverProfiles) {
        const profile = serverProfiles[profileName];
        if (profile) {
          profiles.push(profile);
        }
      }
    }
  }

  return profiles;
}

/**
 * Get a specific auth profile by server URL and profile name
 */
export async function getAuthProfile(
  serverUrl: string,
  profileName: string
): Promise<AuthProfile | undefined> {
  const storage = await loadAuthProfiles();
  return storage.profiles[serverUrl]?.[profileName];
}

/**
 * Save or update a single auth profile
 */
export async function saveAuthProfile(profile: AuthProfile): Promise<void> {
  const filePath = getAuthProfilesFilePath();
  return withFileLock(filePath, async () => {
    const storage = await loadAuthProfilesInternal();

    // Ensure server entry exists
    if (!storage.profiles[profile.serverUrl]) {
      storage.profiles[profile.serverUrl] = {};
    }

    // Update profile
    storage.profiles[profile.serverUrl]![profile.name] = profile;

    await saveAuthProfilesInternal(storage);
    logger.debug(`Saved auth profile: ${profile.name} for ${profile.serverUrl}`);
  }, AUTH_PROFILES_DEFAULT_CONTENT);
}

/**
 * Delete a specific auth profile (metadata + keychain credentials)
 */
export async function deleteAuthProfile(serverUrl: string, profileName: string): Promise<boolean> {
  const filePath = getAuthProfilesFilePath();
  return withFileLock(filePath, async () => {
    const storage = await loadAuthProfilesInternal();

    const serverProfiles = storage.profiles[serverUrl];
    if (!serverProfiles || !serverProfiles[profileName]) {
      return false;
    }

    // Delete credentials from OS keychain (tokens + client info)
    await removeKeychainOAuthClientInfo(serverUrl, profileName);
    await removeKeychainOAuthTokenInfo(serverUrl, profileName);

    // Delete profile metadata from storage
    delete serverProfiles[profileName];

    // Clean up empty server entries
    if (Object.keys(serverProfiles).length === 0) {
      delete storage.profiles[serverUrl];
    }

    await saveAuthProfilesInternal(storage);
    logger.debug(`Deleted auth profile: ${profileName} for ${serverUrl}`);
    return true;
  }, AUTH_PROFILES_DEFAULT_CONTENT);
}
