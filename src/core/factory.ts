/**
 * Factory functions for creating MCP clients with transports
 */

import type { ClientCapabilities, ListChangedHandlers } from '@modelcontextprotocol/sdk/types.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { McpClient, type McpClientOptions } from './mcp-client.js';
import { createTransportFromConfig } from './transports.js';
import { type ServerConfig } from '../lib/types.js';
import { createLogger } from '../lib/logger.js';

/**
 * Client information for identification
 */
export interface ClientInfo {
  name: string;
  version: string;
}

/**
 * Options for creating and connecting McpClient
 */
export interface CreateMcpClientOptions {
  /**
   * Client identification info
   */
  clientInfo: ClientInfo;

  /**
   * Transport configuration
   */
  serverConfig: ServerConfig;

  /**
   * Client capabilities to advertise
   */
  capabilities?: ClientCapabilities;

  /**
   * Handlers for list changed notifications
   */
  listChanged?: ListChangedHandlers;

  /**
   * OAuth provider for automatic token refresh (HTTP transport only)
   */
  authProvider?: OAuthClientProvider;

  /**
   * Whether to automatically connect after creation
   * @default true
   */
  autoConnect?: boolean;

  /**
   * Enable verbose logging
   * @default false
   */
  verbose?: boolean;
}

/**
 * Create an MCP client with the specified transport
 *
 * @param options - Client creation options
 * @returns Connected MCP client
 *
 * @example
 * // Create client with HTTP transport
 * const client = await createMcpClient({
 *   clientInfo: { name: 'mcpc', version: '0.1.0' },
 *   transport: {
 *     type: 'http',
 *     url: 'https://mcp.example.com',
 *   },
 * });
 *
 * @example
 * // Create client with stdio transport
 * const client = await createMcpClient({
 *   clientInfo: { name: 'mcpc', version: '0.1.0' },
 *   transport: {
 *     type: 'stdio',
 *     command: 'node',
 *     args: ['server.js'],
 *   },
 * });
 */
export async function createMcpClient(options: CreateMcpClientOptions): Promise<McpClient> {
  const { autoConnect = true } = options;

  // Create logger - always create it so file logging works
  // Console output is controlled by verbose mode within the logger itself
  const factoryLogger = createLogger('ClientFactory');

  factoryLogger.debug('Creating MCP client', {
    clientName: options.clientInfo.name,
    transportType: options.serverConfig.command ? 'stdio' : 'http',
    hasAuthProvider: !!options.authProvider,
  });

  // Create the client with a logger
  // The logger will only output to console in verbose mode, but will always log to file
  const clientOptions: McpClientOptions = {
    capabilities: options.capabilities || {},
    ...(options.listChanged && { listChanged: options.listChanged }),
    logger: createLogger(`McpClient:${options.clientInfo.name}`),
    // Pass timeout from serverConfig (in seconds) to client (in milliseconds)
    ...(options.serverConfig.timeout && { requestTimeout: options.serverConfig.timeout * 1000 }),
  };

  const client = new McpClient(options.clientInfo, clientOptions);

  // Create and connect transport if autoConnect is true
  if (autoConnect) {
    factoryLogger.debug('Creating transport with authProvider:', !!options.authProvider);
    const transport = createTransportFromConfig(
      options.serverConfig,
      options.authProvider ? { authProvider: options.authProvider } : {}
    );
    await client.connect(transport);
  }

  return client;
}

