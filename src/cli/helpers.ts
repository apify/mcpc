/**
 * Helper functions for CLI command handlers
 * Provides target resolution and MCP client management
 */

import { createMcpClient } from '../core/factory.js';
import type { IMcpClient, OutputMode, ServerConfig } from '../lib/types.js';
import { ClientError, NetworkError, AuthError } from '../lib/errors.js';
import { normalizeServerUrl, isValidSessionName, getServerHost } from '../lib/utils.js';
import { setVerbose, createLogger } from '../lib/logger.js';
import { loadConfig, getServerConfig, validateServerConfig } from '../lib/config.js';
import { OAuthProvider } from '../lib/auth/oauth-provider.js';
import { OAuthTokenManager } from '../lib/auth/oauth-token-manager.js';
import { getAuthProfile, listAuthProfiles } from '../lib/auth/profiles.js';
import { readKeychainOAuthTokenInfo, readKeychainOAuthClientInfo } from '../lib/auth/keychain.js';
import { logTarget } from './output.js';
import packageJson from '../../package.json' with { type: 'json' };
import { DEFAULT_AUTH_PROFILE } from '../lib/auth/oauth-utils.js';
import { parseHeaderFlags } from './parser.js';

const logger = createLogger('cli');

/**
 * Create an OAuthProvider for a server URL if auth profile exists
 * Returns undefined if no auth profile or tokens are available
 */
async function createAuthProviderForServer(
  url: string,
  profileName: string = DEFAULT_AUTH_PROFILE
): Promise<OAuthProvider | undefined> {
  try {
    // Check if auth profile exists
    const profile = await getAuthProfile(url, profileName);
    if (!profile) {
      logger.debug(`No auth profile found for ${url} (profile: ${profileName})`);
      return undefined;
    }

    // Load tokens from keychain
    const tokens = await readKeychainOAuthTokenInfo(url, profileName);
    if (!tokens?.refreshToken) {
      logger.debug(`No refresh token in keychain for profile: ${profileName}`);
      return undefined;
    }

    // Load client info from keychain
    const clientInfo = await readKeychainOAuthClientInfo(url, profileName);
    if (!clientInfo?.clientId) {
      logger.warn(`OAuth client ID not found in keychain for profile: ${profileName}`);
      return undefined;
    }

    // Create token manager with tokens from keychain
    const tokenManagerOptions: ConstructorParameters<typeof OAuthTokenManager>[0] = {
      serverUrl: url,
      profileName,
      clientId: clientInfo.clientId,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
    };
    if (tokens.expiresAt !== undefined) {
      tokenManagerOptions.accessTokenExpiresAt = tokens.expiresAt;
    }
    const tokenManager = new OAuthTokenManager(tokenManagerOptions);

    // Create and return OAuthProvider in runtime mode
    logger.debug(`Created OAuthProvider for profile: ${profileName}`);
    return new OAuthProvider({
      serverUrl: url,
      profileName,
      tokenManager,
      clientId: clientInfo.clientId,
    });
  } catch (error) {
    // Re-throw AuthError (expired token, refresh failed, etc.)
    if (error instanceof AuthError) {
      throw error;
    }
    // Log other errors but don't fail the connection
    logger.warn(`Failed to create auth provider: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Resolve which auth profile to use for an HTTP server
 * Returns the profile name to use, or throws with helpful error if none available
 *
 * @param serverUrl - The server URL
 * @param target - Original target string (for error messages)
 * @param specifiedProfile - Profile name from --profile flag (optional)
 * @param context - Additional context for error messages (e.g., session name)
 * @returns The profile name to use
 * @throws ClientError with helpful guidance if no profile available
 */
export async function resolveAuthProfile(
  serverUrl: string,
  target: string,
  specifiedProfile?: string,
  context?: { sessionName?: string }
): Promise<string> {
  const host = getServerHost(serverUrl);

  if (specifiedProfile) {
    // Profile specified - verify it exists
    const profile = await getAuthProfile(serverUrl, specifiedProfile);
    if (!profile) {
      throw new ClientError(
        `Authentication profile "${specifiedProfile}" not found for ${host}.\n\n` +
        `To create this profile, run:\n` +
        `  mcpc ${target} login --profile ${specifiedProfile}`
      );
    }
    return specifiedProfile;
  }

  // No profile specified - try to use "default" profile if it exists
  const defaultProfile = await getAuthProfile(serverUrl, DEFAULT_AUTH_PROFILE);
  if (defaultProfile) {
    logger.debug(`Using default auth profile for ${host}`);
    return DEFAULT_AUTH_PROFILE;
  }

  // No default profile - check if ANY profile exists for this server
  const allProfiles = await listAuthProfiles();
  const serverProfiles = allProfiles.filter(p => getServerHost(p.serverUrl) === host);

  if (serverProfiles.length === 0) {
    // No profiles at all - error with guidance
    const sessionHint = context?.sessionName
      ? `Then create the session:\n  mcpc ${target} session ${context.sessionName}`
      : `Then run your command again.`;
    throw new ClientError(
      `No authentication profile found for ${host}.\n\n` +
      `To authenticate, run:\n` +
      `  mcpc ${target} login\n\n` +
      sessionHint
    );
  } else {
    // Profiles exist but no default - suggest using --profile
    const profileNames = serverProfiles.map(p => p.name).join(', ');
    const commandHint = context?.sessionName
      ? `mcpc ${target} session ${context.sessionName} --profile <name>`
      : `mcpc ${target} <command> --profile <name>`;
    throw new ClientError(
      `No default authentication profile for ${host}.\n\n` +
      `Available profiles: ${profileNames}\n\n` +
      `To use a profile, run:\n` +
      `  ${commandHint}`
    );
  }
}

/**
 * Resolve a target string to server configuration
 *
 * Target types:
 * - @<name> - Named session (looks up in sessions.json)
 * - <url> - Remote HTTP server (defaults to https:// if no scheme provided)
 * - <config-entry> - Entry from config file (when --config is used)
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function resolveTarget(
  target: string,
  options: {
    config?: string;
    headers?: string[];
    timeout?: number;
    verbose?: boolean;
    profile?: string;
  } = {}
): Promise<ServerConfig> {
  if (options.verbose) {
    setVerbose(true);
  }

  // Named session (@name) is handled in withMcpClient, should not reach here
  if (isValidSessionName(target)) {
    throw new ClientError(`Session target should be handled by withMcpClient: ${target}`);
  }

  // Config file entry - check this first to avoid treating config names as URLs
  if (options.config) {
    logger.debug(`Loading config file: ${options.config}`);
    const mcpConfig = loadConfig(options.config);
    const serverConfig = getServerConfig(mcpConfig, target);
    validateServerConfig(serverConfig);

    // Merge CLI options with config file (CLI takes precedence)
    const cliHeaders = parseHeaderFlags(options.headers);
    const mergedHeaders = { ...serverConfig.headers, ...cliHeaders };

    return {
      ...serverConfig,
      ...(Object.keys(mergedHeaders).length > 0 && { headers: mergedHeaders }),
      ...(options.timeout && { timeout: options.timeout }),
    };
  }

  // Try to parse as URL (will default to https:// if no scheme provided)
  let url;
  try {
    url = normalizeServerUrl(target);
  } catch (error) {
    throw new ClientError(
      `Failed to resolve target: ${target}\n` +
        `Target must be one of:\n` +
        `  - Named session (@name)\n` +
        `  - Server URL (e.g., mcp.apify.com or https://mcp.apify.com)\n` +
        `  - Entry in JSON config file specified by --config flag\n\n` +
        `Error: ${(error as Error).message}`
    );
  }

  // Build server config from URL and CLI options
  const headers = parseHeaderFlags(options.headers);

  return {
    url,
    ...(Object.keys(headers).length > 0 && { headers }),
    ...(options.timeout && { timeout: options.timeout }),
  };
}

/**
 * Context passed to the withMcpClient callback
 */
export interface McpClientContext {
  sessionName?: string | undefined;
  profileName?: string | undefined;
  serverConfig?: ServerConfig | undefined;
}

/**
 * Execute an operation with an MCP client
 * Handles connection, execution, and cleanup
 * Automatically detects and uses sessions (targets starting with @)
 * Logs the target prefix before executing the operation
 *
 * @param target - Target string (URL, @session, package, etc.)
 * @param options - CLI options (verbose, config, headers, etc.)
 * @param callback - Async function that receives the connected client and context
 */
export async function withMcpClient<T>(
  target: string,
  options: {
    outputMode?: OutputMode;
    config?: string;
    headers?: string[];
    timeout?: number;
    verbose?: boolean;
    hideTarget?: boolean;
    profile?: string;
  },
  callback: (client: IMcpClient, context: McpClientContext) => Promise<T>
): Promise<T> {
  // Check if this is a session target (@name, not @scope/package)
  if (isValidSessionName(target)) {
    const { withSessionClient } = await import('../lib/session-client.js');
    const { getSession } = await import('../lib/sessions.js');

    logger.debug('Using session:', target);

    // Get session data to include in context
    // TODO: getSession() is called also in withSessionClient() => createSessionClient() => ensureBridgeReady()
    //  if we could reuse it, we'd save extra file lock and read operation
    const session = await getSession(target);
    const context: McpClientContext = {
      sessionName: session?.name,
      profileName: session?.profileName,
      serverConfig: session?.server,
    };

    // Log target prefix (unless hidden)
    if (options.outputMode) {
      await logTarget(target, {
        outputMode: options.outputMode,
        hide: options.hideTarget,
      });
    }

    // Use session client (SessionClient implements IMcpClient interface)
    return await withSessionClient(target, (client) => callback(client, context));
  }

  // Regular direct connection
  const serverConfig = await resolveTarget(target, options);

  logger.debug('Resolved target:', { target, serverConfig });

  // Create and connect client
  const clientConfig: Parameters<typeof createMcpClient>[0] = {
    clientInfo: { name: 'mcpc', version: packageJson.version },
    serverConfig,
    capabilities: {
      // Declare client capabilities
      roots: { listChanged: true },
      sampling: {},
    },
    autoConnect: true,
  };

  // Only include verbose if it's true
  if (options.verbose) {
    clientConfig.verbose = true;
  }

  // For HTTP transports, resolve auth profile and create authProvider
  let profileName: string | undefined;
  if (serverConfig.url) {
    profileName = await resolveAuthProfile(serverConfig.url, target, options.profile);
    const authProvider = await createAuthProviderForServer(serverConfig.url, profileName);
    if (authProvider) {
      clientConfig.authProvider = authProvider;
      logger.debug(`Using auth profile: ${profileName}`);
    }
  }

  const client = await createMcpClient(clientConfig);

  try {
    logger.debug('Connected successfully');

    // Log target prefix (unless hidden)
    if (options.outputMode) {
      // Get protocol version for display
      const serverDetails = await client.getServerDetails();
      await logTarget(target, {
        outputMode: options.outputMode,
        hide: options.hideTarget,
        profileName,
        serverConfig,
        protocolVersion: serverDetails.protocolVersion,
      });
    }

    // Execute callback with connected client and context
    const context: McpClientContext = { serverConfig, profileName };
    const result = await callback(client, context);

    return result;
  } catch (error) {
    logger.error('MCP operation failed:', error);

    if (error instanceof NetworkError || error instanceof ClientError) {
      throw error;
    }

    throw new NetworkError(
      `Failed to communicate with MCP server: ${(error as Error).message}`,
      { originalError: error }
    );
  } finally {
    // Always clean up
    try {
      logger.debug('Closing connection...');
      await client.close();
      logger.debug('Connection closed');
    } catch (error) {
      logger.warn('Error closing connection:', error);
    }
  }
}
