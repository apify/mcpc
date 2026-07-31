/**
 * Factory functions for creating MCP clients with transports
 */

import type {
  ClientCapabilities,
  ListChangedHandlers,
  OAuthClientProvider,
  FetchLike,
} from '@modelcontextprotocol/client';
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
   * MCP-Session-Id for resuming a previous session (HTTP transport only)
   */
  mcpSessionId?: string;

  /**
   * Protocol version negotiated by the session being resumed (HTTP transport only,
   * pass together with mcpSessionId). The SDK skips the handshake when resuming, so
   * the transport needs the original version to keep sending the required
   * MCP-Protocol-Version header.
   */
  protocolVersion?: string;

  /**
   * Custom fetch function for the transport (HTTP transport only)
   * Used by x402 payment middleware
   */
  customFetch?: FetchLike;

  /**
   * Callback for lines written to stderr by the child (stdio transport only).
   * Ignored for HTTP transports.
   */
  onStderrLine?: (line: string) => void;

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
    ...(options.serverConfig.timeout && {
      requestTimeoutMillis: options.serverConfig.timeout * 1000,
    }),
    // Cap the version-negotiation probe timeout on stdio (local servers answer fast;
    // some legacy ones never answer pre-initialize requests at all)
    ...(options.serverConfig.command && { stdioTransport: true }),
    // Pin the MCP protocol version when requested (strict, no fallback)
    ...(options.serverConfig.protocolVersion && {
      protocolVersion: options.serverConfig.protocolVersion,
    }),
  };

  // Tolerate tool schemas stamped with pre-2020-12 dialects (draft-07 etc.), which the
  // SDK's default validator rejects outright — most 2025-era servers emit them.
  // Loaded dynamically so the bundled AJV engine is only paid for when a client is created.
  if (!clientOptions.jsonSchemaValidator) {
    const { DialectAwareJsonSchemaValidator } = await import('./json-schema-validator.js');
    clientOptions.jsonSchemaValidator = new DialectAwareJsonSchemaValidator();
  }

  const client = new McpClient(options.clientInfo, clientOptions);

  // Create and connect transport if autoConnect is true
  if (autoConnect) {
    factoryLogger.debug('Creating transport with authProvider:', !!options.authProvider);
    factoryLogger.debug('Creating transport with mcpSessionId:', options.mcpSessionId || '(none)');
    factoryLogger.debug('Creating transport with customFetch:', !!options.customFetch);
    const transportOptions: {
      authProvider?: OAuthClientProvider;
      mcpSessionId?: string;
      protocolVersion?: string;
      customFetch?: FetchLike;
      onStderrLine?: (line: string) => void;
    } = {};
    if (options.authProvider) {
      transportOptions.authProvider = options.authProvider;
    }
    if (options.mcpSessionId) {
      transportOptions.mcpSessionId = options.mcpSessionId;
      if (options.protocolVersion) {
        transportOptions.protocolVersion = options.protocolVersion;
      }
    }
    if (options.customFetch) {
      transportOptions.customFetch = options.customFetch;
    }
    if (options.onStderrLine) {
      transportOptions.onStderrLine = options.onStderrLine;
    }
    const transport = createTransportFromConfig(options.serverConfig, transportOptions);
    await client.connect(transport);
  }

  return client;
}
