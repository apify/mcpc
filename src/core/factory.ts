/**
 * Factory functions for creating MCP clients with transports
 */

import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { McpClient, type McpClientOptions } from './client.js';
import { createTransportFromConfig } from './transports.js';
import type { TransportConfig } from '../lib/types.js';
import { createLogger } from '../lib/logger.js';

/**
 * Client information for identification
 */
export interface ClientInfo {
  name: string;
  version: string;
}

/**
 * Options for creating and connecting a client
 */
export interface CreateClientOptions {
  /**
   * Client identification info
   */
  clientInfo: ClientInfo;

  /**
   * Transport configuration
   */
  transport: TransportConfig;

  /**
   * Client capabilities to advertise
   */
  capabilities?: ClientCapabilities;

  /**
   * Whether to automatically connect after creation
   * @default true
   */
  autoConnect?: boolean;
}

/**
 * Create an MCP client with the specified transport
 *
 * @param options - Client creation options
 * @returns Connected MCP client
 *
 * @example
 * // Create client with HTTP transport
 * const client = await createClient({
 *   clientInfo: { name: 'mcpc', version: '0.1.0' },
 *   transport: {
 *     type: 'http',
 *     url: 'https://mcp.example.com',
 *   },
 * });
 *
 * @example
 * // Create client with stdio transport
 * const client = await createClient({
 *   clientInfo: { name: 'mcpc', version: '0.1.0' },
 *   transport: {
 *     type: 'stdio',
 *     command: 'node',
 *     args: ['server.js'],
 *   },
 * });
 */
export async function createClient(options: CreateClientOptions): Promise<McpClient> {
  const logger = createLogger('ClientFactory');
  const { autoConnect = true } = options;

  logger.debug('Creating MCP client', {
    clientName: options.clientInfo.name,
    transportType: options.transport.type,
  });

  // Create the client
  const clientOptions: McpClientOptions = {
    capabilities: options.capabilities || {},
    logger: createLogger(`McpClient:${options.clientInfo.name}`),
  };

  const client = new McpClient(options.clientInfo, clientOptions);

  // Create and connect transport if autoConnect is true
  if (autoConnect) {
    const transport = createTransportFromConfig(options.transport);
    await client.connect(transport);
  }

  return client;
}

/**
 * Create a client for a stdio-based MCP server
 *
 * @param clientInfo - Client identification
 * @param command - Command to execute
 * @param args - Command arguments
 * @param env - Environment variables
 * @returns Connected MCP client
 */
export async function createStdioClient(
  clientInfo: ClientInfo,
  command: string,
  args?: string[],
  env?: Record<string, string>
): Promise<McpClient> {
  const transport: TransportConfig = {
    type: 'stdio',
    command,
  };

  if (args !== undefined) {
    transport.args = args;
  }
  if (env !== undefined) {
    transport.env = env;
  }

  return createClient({
    clientInfo,
    transport,
  });
}

/**
 * Create a client for an HTTP-based MCP server
 *
 * @param clientInfo - Client identification
 * @param url - Server URL
 * @param headers - Optional HTTP headers
 * @param timeout - Optional request timeout in milliseconds
 * @returns Connected MCP client
 */
export async function createHttpClient(
  clientInfo: ClientInfo,
  url: string,
  headers?: Record<string, string>,
  timeout?: number
): Promise<McpClient> {
  const transport: TransportConfig = {
    type: 'http',
    url,
  };

  if (headers) {
    transport.headers = headers;
  }
  if (timeout) {
    transport.timeout = timeout;
  }

  return createClient({
    clientInfo,
    transport,
  });
}
