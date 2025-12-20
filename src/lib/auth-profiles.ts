/**
 * Authentication profiles management
 * Provides functions to read and manage auth profiles stored in ~/.mcpc/auth-profiles.json
 */

import { readFileSync } from 'fs';
import type { AuthProfile, AuthProfilesStorage } from './types.js';
import { getAuthProfilesFilePath, fileExists } from './utils.js';
import { createLogger } from './logger.js';

const logger = createLogger('auth-profiles');

/**
 * Load auth profiles from storage file
 * Returns an empty profiles structure if file doesn't exist
 */
export async function loadAuthProfiles(): Promise<AuthProfilesStorage> {
  const filePath = getAuthProfilesFilePath();

  if (!(await fileExists(filePath))) {
    logger.debug('Auth profiles file does not exist, returning empty profiles');
    return { profiles: {} };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
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
 * Get auth profiles for a specific server URL
 */
export async function getAuthProfilesForServer(serverUrl: string): Promise<AuthProfile[]> {
  const storage = await loadAuthProfiles();
  const serverProfiles = storage.profiles[serverUrl];

  if (!serverProfiles) {
    return [];
  }

  return Object.values(serverProfiles).filter((p): p is AuthProfile => p !== undefined);
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
