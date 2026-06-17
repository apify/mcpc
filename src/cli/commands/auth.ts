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
import type { CommandOptions, OutputMode } from '../../lib/types.js';
import { deleteAuthProfiles } from '../../lib/auth/profiles.js';
import { performOAuthFlow } from '../../lib/auth/oauth-flow.js';
import { getServerHost, normalizeServerUrl, validateProfileName } from '../../lib/utils.js';
import { DEFAULT_AUTH_PROFILE, DEFAULT_CLIENT_METADATA_URL } from '../../lib/auth/oauth-utils.js';
import type { OAuthClientCredentialsInfo } from '../../lib/auth/keychain.js';
import {
  loginClientCredentials,
  validateKeyAlgorithm,
  resolvePrivateKeyPem,
  DEFAULT_KEY_ALGORITHM,
} from '../../lib/auth/client-credentials.js';

/**
 * Authenticate with a server and create/update auth profile
 */
export async function login(
  serverUrl: string,
  options: CommandOptions & {
    profile?: string;
    scope?: string;
    grant?: string;
    clientId?: string;
    clientSecret?: string;
    clientKey?: string;
    clientKeyAlg?: string;
    clientMetadataUrl?: string | false;
    callbackPort?: number;
    callbackHost?: string;
  }
): Promise<void> {
  try {
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const profileName = options.profile || DEFAULT_AUTH_PROFILE;

    validateProfileName(profileName);

    // Resolve the grant type (default: the interactive authorization-code flow).
    const grant = options.grant ?? 'authorization-code';
    if (grant !== 'authorization-code' && grant !== 'client-credentials') {
      throw new Error(
        `Invalid --grant "${grant}". Supported values: authorization-code (default), client-credentials.`
      );
    }

    if (grant === 'client-credentials') {
      await loginWithClientCredentials(normalizedUrl, profileName, options);
      return;
    }

    // --- Interactive authorization-code flow (default) ---

    // --client-key / --client-key-alg only apply to the client-credentials grant.
    if (options.clientKey || options.clientKeyAlg) {
      throw new Error('--client-key/--client-key-alg require --grant client-credentials');
    }

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

    // The hosted CIMD registers only 127.0.0.1 redirect URIs, so a CIMD-capable
    // server would reject the localhost form with a redirect_uri mismatch.
    if (
      options.callbackHost === 'localhost' &&
      resolvedClientMetadataUrl === DEFAULT_CLIENT_METADATA_URL
    ) {
      throw new Error(
        '--callback-host localhost cannot be used with the default hosted CIMD, which only ' +
          'registers 127.0.0.1 redirect URIs. Use --client-id (pre-registered client), ' +
          '--client-metadata-url (custom CIMD listing localhost redirect URIs), or ' +
          '--no-client-metadata-url (Dynamic Client Registration)'
      );
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
      options.callbackPort,
      options.callbackHost
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
 * Non-interactive login using the OAuth client-credentials grant.
 * Validates the supplied credentials against the server, stores them, and writes
 * the profile. No browser and no user interaction. Throws on invalid flag
 * combinations; the caller's try/catch maps errors to exit code 4.
 */
async function loginWithClientCredentials(
  normalizedUrl: string,
  profileName: string,
  options: {
    outputMode: OutputMode;
    scope?: string;
    clientId?: string;
    clientSecret?: string;
    clientKey?: string;
    clientKeyAlg?: string;
    clientMetadataUrl?: string | false;
    callbackPort?: number;
    callbackHost?: string;
  }
): Promise<void> {
  if (!options.clientId) {
    throw new Error('--grant client-credentials requires --client-id');
  }

  const clientSecret = options.clientSecret;
  const clientKey = options.clientKey;
  if (!!clientSecret === !!clientKey) {
    throw new Error(
      'With --grant client-credentials, provide exactly one of --client-secret ' +
        '(client_secret_basic) or --client-key (private_key_jwt)'
    );
  }

  // Browser-flow-only options have no meaning for the client-credentials grant.
  if (typeof options.clientMetadataUrl === 'string') {
    throw new Error('--client-metadata-url cannot be used with --grant client-credentials');
  }
  if (options.callbackPort !== undefined || options.callbackHost !== undefined) {
    throw new Error(
      '--callback-port/--callback-host cannot be used with --grant client-credentials'
    );
  }

  const info: OAuthClientCredentialsInfo = { clientId: options.clientId };
  if (options.scope) {
    info.scope = options.scope;
  }
  if (clientSecret) {
    info.clientSecret = clientSecret;
  } else if (clientKey) {
    const alg = options.clientKeyAlg || DEFAULT_KEY_ALGORITHM;
    validateKeyAlgorithm(alg);
    info.privateKeyPem = await resolvePrivateKeyPem(clientKey);
    info.keyAlg = alg;
  }

  if (options.outputMode === 'human') {
    console.log(formatInfo(`Authenticating with client-credentials grant for ${normalizedUrl}`));
    console.log(formatInfo(`Profile: ${theme.magenta(profileName)}`));
  }

  const result = await loginClientCredentials(normalizedUrl, profileName, info);

  if (options.outputMode === 'human') {
    console.log(formatSuccess('Authentication successful!'));
    console.log(formatInfo(`Profile ${theme.magenta(profileName)} saved`));
    if (result.scopes && result.scopes.length > 0) {
      console.log(formatInfo(`Scopes: ${result.scopes.join(', ')}`));
    }
  } else {
    console.log(
      formatOutput(
        {
          profile: profileName,
          serverUrl: normalizedUrl,
          grant: 'client_credentials',
          scopes: result.scopes,
        },
        'json'
      )
    );
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
