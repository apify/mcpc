/**
 * Helper functions for CLI command handlers
 * Provides target resolution and MCP client management
 */

import { createClient } from '../core/factory.js';
import type { McpClient } from '../core/client.js';
import type { OutputMode, TransportConfig } from '../lib/types.js';
import { ClientError, NetworkError } from '../lib/errors.js';
import { normalizeServerUrl, isValidSessionName } from '../lib/utils.js';
import { setVerbose, createLogger } from '../lib/logger.js';
import { loadConfig, getServerConfig, validateServerConfig } from '../lib/config.js';

const logger = createLogger('cli');

/**
 * Resolve a target string to transport configuration
 *
 * Target types:
 * - @<name> - Named session (looks up in sessions.json)
 * - <url> - Remote HTTP server (defaults to https:// if no scheme provided)
 * - <config-entry> - Entry from config file (when --config is used)
 */
export function resolveTarget(
  target: string,
  options: {
    config?: string;
    headers?: string[];
    timeout?: number;
    verbose?: boolean;
  } = {}
): TransportConfig {
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
      // HTTP/HTTPS server
      const headers: Record<string, string> = {};

      // Merge headers from config file
      if (serverConfig.headers) {
        Object.assign(headers, serverConfig.headers);
      }

      // Override with CLI --header flags (CLI flags take precedence)
      if (options.headers) {
        for (const header of options.headers) {
          const colonIndex = header.indexOf(':');
          if (colonIndex < 1) {
            throw new ClientError(`Invalid header format: ${header}. Use "Key: Value"`);
          }
          const key = header.substring(0, colonIndex).trim();
          const value = header.substring(colonIndex + 1).trim();
          headers[key] = value;
        }
      }

      const transportConfig: TransportConfig = {
        type: 'http',
        url: serverConfig.url,
        headers,
      };

      // Timeout: CLI flag > config file > default
      if (options.timeout) {
        transportConfig.timeout = options.timeout * 1000;
      } else if (serverConfig.timeout) {
        transportConfig.timeout = serverConfig.timeout * 1000;
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
  try {
    const url = normalizeServerUrl(target);
    const headers: Record<string, string> = {};

    // Parse --header flags
    if (options.headers) {
      for (const header of options.headers) {
        const colonIndex = header.indexOf(':');
        if (colonIndex < 1) {
          throw new ClientError(`Invalid header format: ${header}. Use "Key: Value"`);
        }
        const key = header.substring(0, colonIndex).trim();
        const value = header.substring(colonIndex + 1).trim();
        headers[key] = value;
      }
    }

    const config: TransportConfig = {
      type: 'http',
      url,
      headers,
    };

    // Only include timeout if it's provided
    if (options.timeout) {
      config.timeout = options.timeout * 1000;
    }

    return config;
  } catch (urlError) {
    // Not a valid URL, throw error with helpful message
    throw new ClientError(
      `Failed to resolve target: ${target}\n` +
        `Target must be one of:\n` +
        `  - Named session (@name)\n` +
        `  - Server URL (e.g., mcp.example.com or https://mcp.example.com)\n` +
        `  - Config file entry (with --config flag)\n\n` +
        `For local MCP servers, use a config file with the --config flag.\n\n` +
        `Error: ${(urlError as Error).message}`
    );
  }
}

/**
 * Execute an operation with an MCP client
 * Handles connection, execution, and cleanup
 * Automatically detects and uses sessions (targets starting with @)
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
  },
  callback: (client: McpClient) => Promise<T>
): Promise<T> {
  // Check if this is a session target (@name, not @scope/package)
  if (isValidSessionName(target)) {
    const { withSessionClient } = await import('../lib/session-client.js');

    logger.debug('Using session:', target);

    // Use session client (it implements the same interface as McpClient)
    return await withSessionClient(target, callback as any);
  }

  // Regular direct connection
  const transportConfig = resolveTarget(target, options);

  logger.debug('Resolved target:', { target, transportConfig });

  // Create and connect client
  const clientConfig: Parameters<typeof createClient>[0] = {
    clientInfo: { name: 'mcpc', version: '0.1.0' },
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

  const client = await createClient(clientConfig);

  try {
    logger.debug('Connected successfully');

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
