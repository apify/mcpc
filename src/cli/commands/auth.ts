/**
 * Authentication management commands
 */

import { formatSuccess, formatError, formatOutput, formatInfo } from '../output.js';
import type { CommandOptions } from '../../lib/types.js';
import {
  listAuthProfiles,
  getAuthProfilesForServer,
  getAuthProfile,
  deleteAuthProfile,
} from '../../lib/auth-profiles.js';
import { performOAuthFlow } from '../../lib/auth/oauth-flow.js';
import { normalizeServerUrl } from '../../lib/utils.js';
import chalk from 'chalk';

/**
 * Authenticate with a server and create/update auth profile
 */
export async function auth(
  serverUrl: string,
  options: CommandOptions & { profile?: string; scope?: string }
): Promise<void> {
  try {
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const profileName = options.profile || 'default';

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

      if (result.profile.expiresAt) {
        const expiresDate = new Date(result.profile.expiresAt);
        console.log(formatInfo(`Expires: ${expiresDate.toISOString()}`));
      }
    } else {
      console.log(
        formatOutput(
          {
            profile: profileName,
            serverUrl: normalizedUrl,
            scopes: result.profile.scopes,
            expiresAt: result.profile.expiresAt,
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
 * List all authentication profiles or profiles for a specific server
 */
export async function authList(
  serverUrl: string | undefined,
  options: CommandOptions
): Promise<void> {
  try {
    const profiles = serverUrl
      ? await getAuthProfilesForServer(normalizeServerUrl(serverUrl))
      : await listAuthProfiles();

    if (options.outputMode === 'human') {
      if (profiles.length === 0) {
        console.log(formatInfo('No authentication profiles found'));
        return;
      }

      console.log(chalk.bold(`\nAuthentication profiles (${profiles.length}):\n`));

      for (const profile of profiles) {
        console.log(chalk.cyan(`  ${profile.name}`) + chalk.dim(` (${profile.serverUrl})`));
        console.log(`    Type: ${profile.authType}`);

        if (profile.scopes && profile.scopes.length > 0) {
          console.log(`    Scopes: ${profile.scopes.join(', ')}`);
        }

        if (profile.authenticatedAt) {
          const authDate = new Date(profile.authenticatedAt);
          console.log(`    Authenticated: ${authDate.toISOString()}`);
        }

        if (profile.expiresAt) {
          const expiresDate = new Date(profile.expiresAt);
          const isExpired = expiresDate < new Date();
          const expiryStr = isExpired
            ? chalk.red(`${expiresDate.toISOString()} (expired)`)
            : chalk.green(expiresDate.toISOString());
          console.log(`    Expires: ${expiryStr}`);
        }

        console.log('');
      }
    } else {
      console.log(
        formatOutput(
          profiles.map((p) => ({
            name: p.name,
            serverUrl: p.serverUrl,
            authType: p.authType,
            scopes: p.scopes,
            authenticatedAt: p.authenticatedAt,
            expiresAt: p.expiresAt,
          })),
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

/**
 * Show details of a specific authentication profile
 */
export async function authShow(
  serverUrl: string,
  options: CommandOptions & { profile?: string }
): Promise<void> {
  try {
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const profileName = options.profile || 'default';

    const profile = await getAuthProfile(normalizedUrl, profileName);

    if (!profile) {
      if (options.outputMode === 'human') {
        console.error(
          formatError(`Profile ${chalk.cyan(profileName)} not found for ${normalizedUrl}`)
        );
      } else {
        console.error(formatOutput({ error: 'Profile not found' }, 'json'));
      }
      process.exit(1); // Client error
      return;
    }

    if (options.outputMode === 'human') {
      console.log(chalk.bold(`\nAuthentication profile: ${chalk.cyan(profile.name)}\n`));
      console.log(`Server URL: ${profile.serverUrl}`);
      console.log(`Auth Type: ${profile.authType}`);

      if (profile.oauthIssuer) {
        console.log(`OAuth Issuer: ${profile.oauthIssuer}`);
      }

      if (profile.scopes && profile.scopes.length > 0) {
        console.log(`Scopes: ${profile.scopes.join(', ')}`);
      }

      if (profile.authenticatedAt) {
        const authDate = new Date(profile.authenticatedAt);
        console.log(`Authenticated: ${authDate.toISOString()}`);
      }

      if (profile.expiresAt) {
        const expiresDate = new Date(profile.expiresAt);
        const isExpired = expiresDate < new Date();
        const expiryStr = isExpired
          ? chalk.red(`${expiresDate.toISOString()} (expired)`)
          : chalk.green(expiresDate.toISOString());
        console.log(`Expires: ${expiryStr}`);
      }

      console.log(`Created: ${new Date(profile.createdAt).toISOString()}`);
      console.log(`Updated: ${new Date(profile.updatedAt).toISOString()}`);
      console.log('');
    } else {
      console.log(
        formatOutput(
          {
            name: profile.name,
            serverUrl: profile.serverUrl,
            authType: profile.authType,
            oauthIssuer: profile.oauthIssuer,
            scopes: profile.scopes,
            authenticatedAt: profile.authenticatedAt,
            expiresAt: profile.expiresAt,
            createdAt: profile.createdAt,
            updatedAt: profile.updatedAt,
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

/**
 * Delete an authentication profile
 */
export async function authDelete(
  serverUrl: string,
  options: CommandOptions & { profile?: string }
): Promise<void> {
  try {
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const profileName = options.profile || 'default';

    const deleted = await deleteAuthProfile(normalizedUrl, profileName);

    if (!deleted) {
      if (options.outputMode === 'human') {
        console.error(
          formatError(`Profile ${chalk.cyan(profileName)} not found for ${normalizedUrl}`)
        );
      } else {
        console.error(formatOutput({ error: 'Profile not found' }, 'json'));
      }
      process.exit(1); // Client error
      return;
    }

    if (options.outputMode === 'human') {
      console.log(formatSuccess(`Profile ${chalk.cyan(profileName)} deleted`));
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
