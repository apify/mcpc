/**
 * Authentication profiles management
 * Provides functions to read and manage auth profiles stored in ~/.mcpc/profiles.json
 * Uses file locking to prevent concurrent access issues
 */

import { readFile, writeFile, rename, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AuthProfile, AuthProfilesStorage } from '../types.js';
import { getAuthProfilesFilePath, fileExists, ensureDir, getMcpcHome, getServerHost } from '../utils.js';
import { loadSessions } from '../sessions.js';
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
 * Uses getServerHost() to normalize the URL to a canonical host key
 */
export async function getAuthProfile(
  serverUrl: string,
  profileName: string
): Promise<AuthProfile | undefined> {
  const storage = await loadAuthProfiles();
  const host = getServerHost(serverUrl);
  return storage.profiles[host]?.[profileName];
}

/**
 * Save or update a single auth profile
 * Uses getServerHost() to normalize the URL to a canonical host key
 */
export async function saveAuthProfile(profile: AuthProfile): Promise<void> {
  const filePath = getAuthProfilesFilePath();
  return withFileLock(filePath, async () => {
    const storage = await loadAuthProfilesInternal();
    const host = getServerHost(profile.serverUrl);

    // Ensure server entry exists
    if (!storage.profiles[host]) {
      storage.profiles[host] = {};
    }

    // Update profile
    storage.profiles[host]![profile.name] = profile;

    await saveAuthProfilesInternal(storage);
    logger.debug(`Saved auth profile: ${profile.name} for ${host}`);
  }, AUTH_PROFILES_DEFAULT_CONTENT);
}

/**
 * Update the refreshedAt timestamp for a profile (atomic operation)
 * Uses getServerHost() to normalize the URL to a canonical host key
 */
export async function updateAuthProfileRefreshedAt(serverUrl: string, profileName: string): Promise<void> {
  const filePath = getAuthProfilesFilePath();
  return withFileLock(filePath, async () => {
    const storage = await loadAuthProfilesInternal();
    const host = getServerHost(serverUrl);

    const profile = storage.profiles[host]?.[profileName];
    if (profile) {
      profile.refreshedAt = new Date().toISOString();
      await saveAuthProfilesInternal(storage);
      logger.debug(`Updated refreshedAt for profile: ${profileName} on ${host}`);
    }
  }, AUTH_PROFILES_DEFAULT_CONTENT);
}

/**
 * Result of deleting auth profiles
 */
export interface DeleteAuthProfilesResult {
  /** Number of profiles deleted */
  count: number;
  /** Session names that were using deleted profiles */
  affectedSessions: string[];
}

/**
 * Delete authentication profiles (metadata + keychain credentials)
 * Also identifies sessions that were using the deleted profiles
 *
 * @param serverUrl - If provided with profileName, delete only that specific profile
 * @param profileName - If provided with serverUrl, delete only that specific profile
 * @returns Result with count of deleted profiles and affected sessions
 *
 * Usage:
 * - deleteAuthProfiles() - Delete all profiles
 * - deleteAuthProfiles(serverUrl, profileName) - Delete specific profile
 */
export async function deleteAuthProfiles(
  serverUrl?: string,
  profileName?: string
): Promise<DeleteAuthProfilesResult> {
  const filePath = getAuthProfilesFilePath();

  // Check if profiles file exists
  if (!(await fileExists(filePath))) {
    return { count: 0, affectedSessions: [] };
  }

  const deleteSpecific = serverUrl !== undefined && profileName !== undefined;

  return withFileLock(filePath, async () => {
    const storage = await loadAuthProfilesInternal();

    // Collect profiles to delete
    const profilesToDelete: AuthProfile[] = [];

    if (deleteSpecific) {
      // Delete specific profile
      const host = getServerHost(serverUrl);
      const profile = storage.profiles[host]?.[profileName];
      if (profile) {
        profilesToDelete.push(profile);
      }
    } else {
      // Delete all profiles
      for (const host in storage.profiles) {
        const serverProfiles = storage.profiles[host];
        if (serverProfiles) {
          for (const name in serverProfiles) {
            const profile = serverProfiles[name];
            if (profile) {
              profilesToDelete.push(profile);
            }
          }
        }
      }
    }

    if (profilesToDelete.length === 0) {
      // No profiles to delete
      if (!deleteSpecific) {
        // Delete empty profiles file
        try {
          await unlink(filePath);
        } catch {
          // Ignore errors
        }
      }
      return { count: 0, affectedSessions: [] };
    }

    // Find sessions that reference the profiles being deleted
    const sessionsStorage = await loadSessions();
    const affectedSessions: string[] = [];

    for (const session of Object.values(sessionsStorage.sessions)) {
      if (session.profileName && session.transportConfig.url) {
        const sessionHost = getServerHost(session.transportConfig.url);
        for (const profile of profilesToDelete) {
          const profileHost = getServerHost(profile.serverUrl);
          if (sessionHost === profileHost && session.profileName === profile.name) {
            affectedSessions.push(session.name);
            break;
          }
        }
      }
    }

    // Delete keychain entries for each profile
    for (const profile of profilesToDelete) {
      try {
        await removeKeychainOAuthClientInfo(profile.serverUrl, profile.name);
        await removeKeychainOAuthTokenInfo(profile.serverUrl, profile.name);
        logger.debug(`Removed keychain entries for profile: ${profile.name} on ${getServerHost(profile.serverUrl)}`);
      } catch (error) {
        logger.warn(`Failed to remove keychain entries for ${profile.name}:`, error);
      }
    }

    // Update or delete the profiles file
    if (deleteSpecific) {
      // Remove specific profile from storage
      const host = getServerHost(serverUrl);
      const serverProfiles = storage.profiles[host];
      if (serverProfiles) {
        delete serverProfiles[profileName];
        // Clean up empty server entries
        if (Object.keys(serverProfiles).length === 0) {
          delete storage.profiles[host];
        }
      }
      await saveAuthProfilesInternal(storage);
      logger.debug(`Deleted auth profile: ${profileName} for ${host}`);
    } else {
      // Delete the entire profiles file
      try {
        await unlink(filePath);
        logger.debug('Removed profiles.json');
      } catch {
        // Ignore errors
      }
    }

    return { count: profilesToDelete.length, affectedSessions };
  }, AUTH_PROFILES_DEFAULT_CONTENT);
}
