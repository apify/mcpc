/**
 * Helper functions for CLI command handlers
 * Provides target resolution and MCP client management
 */

import { createMcpClient } from '../core/factory.js';
import type { IMcpClient, OutputMode, TransportConfig } from '../lib/types.js';
import { ClientError, NetworkError, AuthError } from '../lib/errors.js';
import { normalizeServerUrl, isValidSessionName } from '../lib/utils.js';
import { setVerbose, createLogger } from '../lib/logger.js';
import { loadConfig, getServerConfig, validateServerConfig } from '../lib/config.js';
import { getValidAccessTokenFromKeychain } from '../lib/auth/token-refresh.js';
import { logTarget } from './output.js';
import packageJson from '../../package.json' with { type: 'json' };
import { DEFAULT_AUTH_PROFILE } from '../lib/auth/oauth-utils.js';

const logger = createLogger('cli');

/**
 * Parse --header CLI flags into a headers object
 * Format: "Key: Value" (colon-separated)
 */
function parseHeaderFlags(headerFlags: string[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (headerFlags) {
    for (const header of headerFlags) {
      const colonIndex = header.indexOf(':');
      if (colonIndex < 1) {
        throw new ClientError(`Invalid header format: ${header}. Use "Key: Value"`);
      }
      const key = header.substring(0, colonIndex).trim();
      const value = header.substring(colonIndex + 1).trim();
      headers[key] = value;
    }
  }
  return headers;
}

/**
 * Load auth profile and add Authorization header if available
 * Automatically refreshes expired tokens if a refresh token is available
 * Tokens are read from and saved to OS keychain for security
 */
async function addAuthHeader(
  url: string,
  headers: Record<string, string>,
  profileName: string = DEFAULT_AUTH_PROFILE
): Promise<Record<string, string>> {
  try {
    const accessToken = await getValidAccessTokenFromKeychain(url, profileName);
    if (!accessToken) {
      return headers;
    }
    return {
      ...headers,
      Authorization: `Bearer ${accessToken}`,
    };
  } catch (error) {
    // Re-throw AuthError (expired token, refresh failed, etc.)
    if (error instanceof AuthError) {
      throw error;
    }
    // Log other errors but don't fail the connection
    logger.warn(`Failed to load auth profile: ${(error as Error).message}`);
    return headers;
  }
}

/**
 * Resolve a target string to transport configuration
 *
 * Target types:
 * - @<name> - Named session (looks up in sessions.json)
 * - <url> - Remote HTTP server (defaults to https:// if no scheme provided)
 * - <config-entry> - Entry from config file (when --config is used)
 */
export async function resolveTarget(
  target: string,
  options: {
    config?: string;
    headers?: string[];
    timeout?: number;
    verbose?: boolean;
    profile?: string;
  } = {}
): Promise<TransportConfig> {
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

    // Load and parse config file
    const config = loadConfig(options.config);

    // Get server configuration by name
    const serverConfig = getServerConfig(config, target);

    // Validate server configuration
    validateServerConfig(serverConfig);

    // Convert to TransportConfig
    if (serverConfig.url) {
      // HTTP/HTTPS server - merge config headers with CLI --header flags (CLI takes precedence)
      const headers: Record<string, string> = {
        ...serverConfig.headers,
        ...parseHeaderFlags(options.headers),
      };

      // Add auth header if profile exists
      const headersWithAuth = await addAuthHeader(
        serverConfig.url,
        headers,
        options.profile
      );

      const transportConfig: TransportConfig = {
        type: 'http',
        url: serverConfig.url,
        headers: headersWithAuth,
      };

      // Timeout: CLI flag > config file > default
      if (options.timeout) {
        transportConfig.timeoutMs = options.timeout * 1000;
      } else if (serverConfig.timeout) {
        transportConfig.timeoutMs = serverConfig.timeout * 1000;
      }

      return transportConfig;
    } else if (serverConfig.command) {
      // Stdio server
      const transportConfig: TransportConfig = {
        type: 'stdio',
        command: serverConfig.command,
      };

      if (serverConfig.args !== undefined) {
        transportConfig.args = serverConfig.args;
      }

      if (serverConfig.env !== undefined) {
        transportConfig.env = serverConfig.env;
      }

      return transportConfig;
    }

    // Should never reach here due to validateServerConfig
    throw new ClientError(`Invalid server configuration for: ${target}`);
  }

  // Try to parse as URL (will default to https:// if no scheme provided)
  let url;
  try {
    url = normalizeServerUrl(target);
  } catch (error) {
    // Not a valid URL, throw error with helpful message
    throw new ClientError(
      `Failed to resolve target: ${target}\n` +
        `Target must be one of:\n` +
        `  - Named session (@name)\n` +
        `  - Server URL (e.g., mcp.apify.com or https://mcp.apify.com)\n` +
        `  - Entry in JSON config file specified by --config flag\n\n` +
        `Error: ${(error as Error).message}`
    );
  }

  // Parse --header flags and add auth header if profile exists
  const headers = parseHeaderFlags(options.headers);
  const headersWithAuth = await addAuthHeader(url, headers, options.profile);

  const config: TransportConfig = {
    type: 'http',
    url,
    headers: headersWithAuth,
  };

  // Only include timeout if it's provided
  if (options.timeout) {
    config.timeoutMs = options.timeout * 1000;
  }

  return config;
}

/**
 * Execute an operation with an MCP client
 * Handles connection, execution, and cleanup
 * Automatically detects and uses sessions (targets starting with @)
 * Logs the target prefix before executing the operation
 *
 * @param target - Target string (URL, @session, package, etc.)
 * @param options - CLI options (verbose, config, headers, etc.)
 * @param callback - Async function that receives the connected client
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
  callback: (client: IMcpClient) => Promise<T>
): Promise<T> {
  // Check if this is a session target (@name, not @scope/package)
  if (isValidSessionName(target)) {
    const { withSessionClient } = await import('../lib/session-client.js');

    logger.debug('Using session:', target);

    // Log target prefix (unless hidden)
    if (options.outputMode) {
      logTarget(target, options.outputMode, options.hideTarget);
    }

    // Use session client (SessionClient implements IMcpClient interface)
    return await withSessionClient(target, callback);
  }

  // Regular direct connection
  const transportConfig = await resolveTarget(target, options);

  logger.debug('Resolved target:', { target, transportConfig });

  // Create and connect client
  const clientConfig: Parameters<typeof createMcpClient>[0] = {
    clientInfo: { name: 'mcpc', version: packageJson.version },
    transport: transportConfig,
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

  const client = await createMcpClient(clientConfig);

  try {
    logger.debug('Connected successfully');

    // Log target prefix (unless hidden)
    if (options.outputMode) {
      logTarget(target, options.outputMode, options.hideTarget);
    }

    // Execute callback with connected client
    const result = await callback(client);

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
