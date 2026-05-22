/**
 * Authentication management commands
 */

import {
  formatSuccess,
  formatError,
  formatOutput,
  formatInfo,
  formatWarning,
  theme,
} from '../output.js';
import type { CommandOptions } from '../../lib/types.js';
import { deleteAuthProfiles } from '../../lib/auth/profiles.js';
import { performOAuthFlow } from '../../lib/auth/oauth-flow.js';
import { getServerHost, normalizeServerUrl, validateProfileName } from '../../lib/utils.js';
import { DEFAULT_AUTH_PROFILE, DEFAULT_CLIENT_METADATA_URL } from '../../lib/auth/oauth-utils.js';

/**
 * Authenticate with a server and create/update auth profile
 */
export async function login(
  serverUrl: string,
  options: CommandOptions & {
    profile?: string;
    scope?: string;
    clientId?: string;
    clientSecret?: string;
    clientMetadataUrl?: string | false;
    callbackPort?: number;
  }
): Promise<void> {
  try {
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const profileName = options.profile || DEFAULT_AUTH_PROFILE;

    validateProfileName(profileName);

    if (options.clientSecret && !options.clientId) {
      throw new Error('--client-secret requires --client-id');
    }

    if (options.clientMetadataUrl && options.clientId) {
      throw new Error(
        '--client-metadata-url cannot be combined with --client-id (they are mutually exclusive ' +
          'client registration approaches)'
      );
    }

    // Resolve the effective CIMD URL:
    // - --client-id → no CIMD (pre-registered client)
    // - --no-client-metadata-url → explicitly disabled (force DCR)
    // - --client-metadata-url <url> → user override
    // - default → mcpc's hosted CIMD
    let resolvedClientMetadataUrl: string | undefined;
    if (options.clientId) {
      resolvedClientMetadataUrl = undefined;
    } else if (options.clientMetadataUrl === false) {
      resolvedClientMetadataUrl = undefined;
    } else if (typeof options.clientMetadataUrl === 'string') {
      resolvedClientMetadataUrl = options.clientMetadataUrl;
    } else {
      resolvedClientMetadataUrl = DEFAULT_CLIENT_METADATA_URL;
    }

    if (options.outputMode === 'human') {
      console.log(formatInfo(`Starting OAuth authentication for ${normalizedUrl}`));
      console.log(formatInfo(`Profile: ${theme.magenta(profileName)}`));
    }

    // Perform OAuth flow
    const clientCredentials: {
      clientId?: string;
      clientSecret?: string;
      clientMetadataUrl?: string;
    } = {};
    if (options.clientId) {
      clientCredentials.clientId = options.clientId;
    }
    if (options.clientSecret) {
      clientCredentials.clientSecret = options.clientSecret;
    }
    if (resolvedClientMetadataUrl) {
      clientCredentials.clientMetadataUrl = resolvedClientMetadataUrl;
    }
    const result = await performOAuthFlow(
      normalizedUrl,
      profileName,
      options.scope,
      clientCredentials,
      options.callbackPort
    );

    if (options.outputMode === 'human') {
      console.log(formatSuccess('Authentication successful!'));
      console.log(formatInfo(`Profile ${theme.magenta(profileName)} saved`));

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

    const result = await deleteAuthProfiles(normalizedUrl, profileName);

    if (result.count === 0) {
      if (options.outputMode === 'human') {
        console.error(
          formatError(`Profile ${theme.magenta(profileName)} for ${normalizedUrl} not found`)
        );
      } else {
        console.error(formatOutput({ error: 'Profile not found' }, 'json'));
      }
      process.exit(1); // Client error
      return;
    }

    if (options.outputMode === 'human') {
      console.log(
        formatSuccess(`Profile ${theme.magenta(profileName)} for ${normalizedUrl} deleted`)
      );

      // Warn about affected sessions
      if (result.affectedSessions.length > 0) {
        const loginCmd =
          profileName === DEFAULT_AUTH_PROFILE
            ? `mcpc login ${getServerHost(normalizedUrl)}`
            : `mcpc login ${getServerHost(normalizedUrl)} --profile ${profileName}`;
        console.log(
          formatWarning(
            `Warning: ${result.affectedSessions.length} session(s) were using this profile: ${result.affectedSessions.join(', ')}`
          )
        );
        console.log(
          formatWarning(
            `These sessions may fail to authenticate. Recreate them or login again by running: ${loginCmd}`
          )
        );
      }
    } else {
      console.log(
        formatOutput(
          {
            profile: profileName,
            serverUrl: normalizedUrl,
            deleted: true,
            affectedSessions: result.affectedSessions,
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
