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
import { ClientError, isMcpError } from '../../lib/errors.js';
import { deleteAuthProfiles } from '../../lib/auth/profiles.js';
import { getServerHost, normalizeServerUrl, validateProfileName } from '../../lib/utils.js';
import { closeProxy } from '../../lib/proxy.js';
import { DEFAULT_AUTH_PROFILE, DEFAULT_CLIENT_METADATA_URL } from '../../lib/auth/oauth-utils.js';
import type { OAuthClientCredentialsInfo } from '../../lib/auth/keychain.js';
// The OAuth flow modules (oauth-flow.js, client-credentials.js) statically pull
// in the MCP SDK's auth stack, which is expensive to import — they are loaded
// lazily inside the login paths so other commands don't pay the cost at startup.

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
    tokenEndpoint?: string;
    clientMetadataUrl?: string | false;
    idp?: string;
    idpClientId?: string;
    idpClientSecret?: string;
    idpScope?: string;
    callbackPort?: number;
    callbackHost?: string;
  }
): Promise<void> {
  try {
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const profileName = options.profile || DEFAULT_AUTH_PROFILE;

    validateProfileName(profileName);

    // Resolve the grant type (default: the interactive authorization-code flow).
    // Accept both hyphen and underscore spellings (e.g. "client_credentials").
    const grant = (options.grant ?? 'authorization-code').toLowerCase().replace(/_/g, '-');
    if (grant !== 'authorization-code' && grant !== 'client-credentials' && grant !== 'id-jag') {
      throw new ClientError(
        `Invalid --grant "${grant}". Supported values: authorization-code (default), ` +
          `client-credentials, id-jag.`
      );
    }

    // The --idp-* flags only apply to the enterprise-managed authorization grant.
    if (grant !== 'id-jag') {
      if (options.idp || options.idpClientId || options.idpClientSecret || options.idpScope) {
        throw new ClientError(
          '--idp/--idp-client-id/--idp-client-secret/--idp-scope require --grant id-jag'
        );
      }
    }

    if (grant === 'client-credentials') {
      await loginWithClientCredentials(normalizedUrl, profileName, options);
      return;
    }

    if (grant === 'id-jag') {
      await loginWithIdJag(normalizedUrl, profileName, options);
      return;
    }

    // --- Interactive authorization-code flow (default) ---

    // --client-key / --client-key-alg / --token-endpoint only apply to client-credentials.
    if (options.clientKey || options.clientKeyAlg) {
      throw new ClientError('--client-key/--client-key-alg require --grant client-credentials');
    }
    if (options.tokenEndpoint) {
      throw new ClientError('--token-endpoint is only supported with --grant client-credentials');
    }

    if (options.clientSecret && !options.clientId) {
      throw new ClientError('--client-secret requires --client-id');
    }

    if (options.clientMetadataUrl && options.clientId) {
      throw new ClientError(
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
      throw new ClientError(
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
    const { performOAuthFlow } = await import('../../lib/auth/oauth-flow.js');
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
    // Flag-validation mistakes are client errors (exit 1); actual auth failures
    // keep exit 4. Typed errors carry their own code.
    const exitCode = isMcpError(error) ? error.code : 4;
    if (options.outputMode === 'human') {
      console.error(formatError(errorMessage));
    } else {
      console.error(formatOutput({ error: errorMessage, code: exitCode }, 'json'));
    }
    // `login` runs OAuth/token requests in this process. A forced process.exit()
    // here races libuv's handle teardown on Windows and aborts with an async-handle
    // assertion that corrupts the --json error output. Instead, drain undici's pool
    // (closes idle keep-alive sockets for a prompt exit) and let the event loop exit
    // on its own via process.exitCode — the same clean teardown the success path uses.
    await closeProxy();
    process.exitCode = exitCode;
    return;
  }
}

/**
 * Non-interactive login using the OAuth client-credentials grant.
 * Validates the supplied credentials against the server, stores them, and writes
 * the profile. No browser and no user interaction. Throws on invalid flag
 * combinations (ClientError, exit 1); the caller maps errors to their exit codes.
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
    tokenEndpoint?: string;
    clientMetadataUrl?: string | false;
    callbackPort?: number;
    callbackHost?: string;
  }
): Promise<void> {
  if (!options.clientId) {
    throw new ClientError('--grant client-credentials requires --client-id');
  }

  const clientSecret = options.clientSecret;
  const clientKey = options.clientKey;
  if (!!clientSecret === !!clientKey) {
    throw new ClientError(
      'With --grant client-credentials, provide exactly one of --client-secret ' +
        '(client_secret_basic) or --client-key (private_key_jwt)'
    );
  }

  // Browser-flow-only options have no meaning for the client-credentials grant.
  if (typeof options.clientMetadataUrl === 'string') {
    throw new ClientError('--client-metadata-url cannot be used with --grant client-credentials');
  }
  if (options.callbackPort !== undefined || options.callbackHost !== undefined) {
    throw new ClientError(
      '--callback-port/--callback-host cannot be used with --grant client-credentials'
    );
  }

  const {
    loginClientCredentials,
    validateKeyAlgorithm,
    resolvePrivateKeyPem,
    DEFAULT_KEY_ALGORITHM,
  } = await import('../../lib/auth/client-credentials.js');

  const info: OAuthClientCredentialsInfo = { clientId: options.clientId };
  if (options.scope) {
    info.scope = options.scope;
  }
  if (options.tokenEndpoint) {
    try {
      void new URL(options.tokenEndpoint);
    } catch {
      throw new ClientError(
        `Invalid --token-endpoint: "${options.tokenEndpoint}" is not a valid URL`
      );
    }
    info.tokenEndpoint = options.tokenEndpoint;
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
 * Login with enterprise-managed authorization (SEP-990, ID-JAG): interactive SSO
 * at the enterprise IdP, then identity-assertion grants for the MCP server.
 * Throws on invalid flag combinations (ClientError, exit 1); the caller maps
 * errors to their exit codes.
 */
async function loginWithIdJag(
  normalizedUrl: string,
  profileName: string,
  options: {
    outputMode: OutputMode;
    scope?: string;
    clientId?: string;
    clientSecret?: string;
    clientKey?: string;
    clientKeyAlg?: string;
    tokenEndpoint?: string;
    clientMetadataUrl?: string | false;
    idp?: string;
    idpClientId?: string;
    idpClientSecret?: string;
    idpScope?: string;
    callbackPort?: number;
    callbackHost?: string;
  }
): Promise<void> {
  if (!options.idp || !options.idpClientId) {
    throw new ClientError(
      '--grant id-jag requires --idp <issuer-url> and --idp-client-id ' +
        '(the client your organization pre-registered at the enterprise IdP)'
    );
  }
  if (!options.clientId || !options.clientSecret) {
    throw new ClientError(
      '--grant id-jag requires --client-id and --client-secret ' +
        "(a confidential client registered at the MCP server's authorization server)"
    );
  }

  // Flags of the other grants have no meaning here.
  if (options.clientKey || options.clientKeyAlg) {
    throw new ClientError('--client-key/--client-key-alg require --grant client-credentials');
  }
  if (options.tokenEndpoint) {
    throw new ClientError('--token-endpoint is only supported with --grant client-credentials');
  }
  if (typeof options.clientMetadataUrl === 'string') {
    throw new ClientError('--client-metadata-url cannot be used with --grant id-jag');
  }

  if (options.outputMode === 'human') {
    console.log(formatInfo(`Starting enterprise-managed authorization (SSO via ${options.idp})`));
    console.log(formatInfo(`Server: ${normalizedUrl}`));
    console.log(formatInfo(`Profile: ${theme.magenta(profileName)}`));
  }

  const { loginIdJag } = await import('../../lib/auth/id-jag-login.js');
  const result = await loginIdJag(normalizedUrl, profileName, {
    idpIssuer: options.idp,
    idpClientId: options.idpClientId,
    mcpClientId: options.clientId,
    mcpClientSecret: options.clientSecret,
    ...(options.idpClientSecret ? { idpClientSecret: options.idpClientSecret } : {}),
    ...(options.idpScope ? { idpScope: options.idpScope } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.callbackPort !== undefined ? { callbackPort: options.callbackPort } : {}),
    ...(options.callbackHost ? { callbackHost: options.callbackHost } : {}),
  });

  if (options.outputMode === 'human') {
    console.log(formatSuccess('Authentication successful!'));
    console.log(formatInfo(`Profile ${theme.magenta(profileName)} saved`));
    if (result.profile.userEmail || result.profile.userName) {
      console.log(
        formatInfo(
          `User: ${result.profile.userName || ''}${result.profile.userEmail ? ` <${result.profile.userEmail}>` : ''}`.trim()
        )
      );
    }
    if (result.scopes && result.scopes.length > 0) {
      console.log(formatInfo(`Scopes: ${result.scopes.join(', ')}`));
    }
  } else {
    console.log(
      formatOutput(
        {
          profile: profileName,
          serverUrl: normalizedUrl,
          grant: 'id_jag',
          idpIssuer: result.profile.idpIssuer,
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
        console.error(formatOutput({ error: 'Profile not found', code: 1 }, 'json'));
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
      console.error(formatOutput({ error: errorMessage, code: 1 }, 'json'));
    }
    process.exit(1); // Client error
  }
}
