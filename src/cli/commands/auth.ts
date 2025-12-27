/**
 * Authentication management commands
 */

import { formatSuccess, formatError, formatOutput, formatInfo } from '../output.js';
import type { CommandOptions } from '../../lib/types.js';
import { deleteAuthProfile } from '../../lib/auth/profiles.js';
import { performOAuthFlow } from '../../lib/auth/oauth-flow.js';
import { normalizeServerUrl, validateProfileName } from '../../lib/utils.js';
import chalk from 'chalk';
import { DEFAULT_AUTH_PROFILE } from '../../lib/auth/oauth-utils.js';

/**
 * Authenticate with a server and create/update auth profile
 */
export async function login(
  serverUrl: string,
  options: CommandOptions & { profile?: string; scope?: string }
): Promise<void> {
  try {
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const profileName = options.profile || DEFAULT_AUTH_PROFILE;

    validateProfileName(profileName);

    if (options.outputMode === 'human') {
      console.log(formatInfo(`Starting OAuth authentication for ${chalk.cyan(normalizedUrl)}`));
      console.log(formatInfo(`Profile: ${chalk.cyan(profileName)}`));
    }

    // Perform OAuth flow
    const result = await performOAuthFlow(normalizedUrl, profileName, options.scope);

    if (options.outputMode === 'human') {
      console.log(formatSuccess('Authentication successful!'));
      console.log(formatInfo(`Profile ${chalk.cyan(profileName)} saved`));

      if (result.profile.scopes && result.profile.scopes.length > 0) {
        console.log(formatInfo(`Scopes: ${result.profile.scopes.join(', ')}`));
      }
    } else {
      console.log(
        formatOutput(
          {
            profile: profileName,
            serverUrl: normalizedUrl,
            scopes: result.profile.scopes,
          },
          'json'
        )
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (options.outputMode === 'human') {
      console.error(formatError(errorMessage));
    } else {
      console.error(formatOutput({ error: errorMessage }, 'json'));
    }
    process.exit(4); // Authentication error
  }
}

/**
 * Delete an authentication profile (logout)
 */
export async function logout(
  serverUrl: string,
  options: CommandOptions & { profile?: string }
): Promise<void> {
  try {
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const profileName = options.profile || DEFAULT_AUTH_PROFILE;

    validateProfileName(profileName);

    const deleted = await deleteAuthProfile(normalizedUrl, profileName);

    if (!deleted) {
      if (options.outputMode === 'human') {
        console.error(
          formatError(`Profile ${chalk.cyan(profileName)} for ${normalizedUrl} not found`)
        );
      } else {
        console.error(formatOutput({ error: 'Profile not found' }, 'json'));
      }
      process.exit(1); // Client error
      return;
    }

    if (options.outputMode === 'human') {
      console.log(formatSuccess(`Profile ${chalk.cyan(profileName)} for ${normalizedUrl} deleted`));
    } else {
      console.log(
        formatOutput(
          {
            profile: profileName,
            serverUrl: normalizedUrl,
            deleted: true,
          },
          'json'
        )
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (options.outputMode === 'human') {
      console.error(formatError(errorMessage));
    } else {
      console.error(formatOutput({ error: errorMessage }, 'json'));
    }
    process.exit(1); // Client error
  }
}
