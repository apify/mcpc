/**
 * MCP Client wrapper
 * Wraps the @modelcontextprotocol/sdk Client class with additional functionality
 */

import { Client as SDKClient, type ClientOptions } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  Implementation,
  ListToolsResult,
  CallToolResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ReadResourceResult,
  ListPromptsResult,
  GetPromptResult,
  ServerCapabilities,
  LoggingLevel,
} from '@modelcontextprotocol/sdk/types.js';
import { createNoOpLogger, type Logger } from '../lib/logger.js';
import { ServerError, NetworkError } from '../lib/errors.js';

/**
 * Transport with protocol version information (e.g., StreamableHTTPClientTransport)
 */
interface TransportWithProtocolVersion extends Transport {
  protocolVersion?: string;
}

/**
 * Options for creating an MCP client
 */
export interface McpClientOptions extends ClientOptions {
  /**
   * Logger to use for client operations
   */
  logger?: Logger;
}

/**
 * MCP Client wrapper class
 * Provides a convenient interface to the MCP SDK Client with error handling and logging
 */
export class McpClient {
  private client: SDKClient;
  private logger: Logger;
  private negotiatedProtocolVersion?: string;

  constructor(clientInfo: Implementation, options: McpClientOptions = {}) {
    this.logger = options.logger || createNoOpLogger();

    this.client = new SDKClient(clientInfo, {
      capabilities: options.capabilities || {},
      ...options,
    });

    // Set up error handling
    this.client.onerror = (error) => {
      this.logger.error('Client error:', error);
    };
  }

  /**
   * Connect to an MCP server using the provided transport
   */
  async connect(transport: Transport): Promise<void> {
    try {
      this.logger.debug('Connecting to MCP server...');

      // Set up transport error handlers
      transport.onerror = (error) => {
        this.logger.error('Transport error:', error);
      };

      transport.onclose = () => {
        this.logger.debug('Transport closed');
      };

      await this.client.connect(transport);

      const serverVersion = this.client.getServerVersion();
      const serverCapabilities = this.client.getServerCapabilities();

      // Capture negotiated protocol version from transport if available
      // StreamableHTTPClientTransport exposes protocolVersion after initialization
      const transportWithVersion = transport as TransportWithProtocolVersion;
      if (transportWithVersion.protocolVersion) {
        this.negotiatedProtocolVersion = transportWithVersion.protocolVersion;
        this.logger.debug(`Negotiated protocol version: ${this.negotiatedProtocolVersion}`);
      }

      this.logger.info(
        `Connected to ${serverVersion?.name || 'unknown'} v${serverVersion?.version || 'unknown'}`
      );
      this.logger.debug('Server capabilities:', serverCapabilities);
    } catch (error) {
      this.logger.error('Failed to connect:', error);
      throw new NetworkError(
        `Failed to connect to MCP server: ${(error as Error).message}`,
        { originalError: error }
      );
    }
  }

  /**
   * Close the connection to the server
   */
  async close(): Promise<void> {
    try {
      this.logger.debug('Closing connection...');
      await this.client.close();
      this.logger.info('Connection closed');
    } catch (error) {
      this.logger.error('Error closing connection:', error);
      throw new NetworkError(
        `Failed to close connection: ${(error as Error).message}`,
        { originalError: error }
      );
    }
  }

  /**
   * Get server capabilities
   */
  getServerCapabilities(): ServerCapabilities | undefined {
    return this.client.getServerCapabilities();
  }

  /**
   * Get server version information
   */
  getServerVersion(): Implementation | undefined {
    return this.client.getServerVersion();
  }

  /**
   * Get server instructions
   */
  getInstructions(): string | undefined {
    return this.client.getInstructions();
  }

  /**
   * Get the negotiated protocol version
   * Returns the protocol version agreed upon during initialization
   */
  getProtocolVersion(): string | undefined {
    return this.negotiatedProtocolVersion;
  }

  /**
   * Ping the server
   */
  async ping(): Promise<void> {
    try {
      this.logger.debug('Sending ping...');
      await this.client.ping();
      this.logger.debug('Ping successful');
    } catch (error) {
      this.logger.error('Ping failed:', error);
      throw new NetworkError(
        `Ping failed: ${(error as Error).message}`,
        { originalError: error }
      );
    }
  }

  /**
   * List available tools
   */
  async listTools(cursor?: string): Promise<ListToolsResult> {
    try {
      this.logger.debug('Listing tools...', cursor ? { cursor } : {});
      const result = await this.client.listTools({ cursor });
      this.logger.debug(`Found ${result.tools.length} tools`);
      return result;
    } catch (error) {
      this.logger.error('Failed to list tools:', error);
      throw new ServerError(
        `Failed to list tools: ${(error as Error).message}`,
        { originalError: error }
      );
    }
  }

  /**
   * Call a tool
   */
  async callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    try {
      this.logger.debug(`Calling tool: ${name}`, args);
      const result = (await this.client.callTool({
        name,
        arguments: args || {},
      })) as CallToolResult;
      this.logger.debug(`Tool ${name} completed`);
      return result;
    } catch (error) {
      this.logger.error(`Failed to call tool ${name}:`, error);
      throw new ServerError(
        `Failed to call tool ${name}: ${(error as Error).message}`,
        { originalError: error }
      );
    }
  }

  /**
   * List available resources
   */
  async listResources(cursor?: string): Promise<ListResourcesResult> {
    try {
      this.logger.debug('Listing resources...', cursor ? { cursor } : {});
      const result = await this.client.listResources({ cursor });
      this.logger.debug(`Found ${result.resources.length} resources`);
      return result;
    } catch (error) {
      this.logger.error('Failed to list resources:', error);
      throw new ServerError(
        `Failed to list resources: ${(error as Error).message}`,
        { originalError: error }
      );
    }
  }

  /**
   * List available resource templates
   */
  async listResourceTemplates(cursor?: string): Promise<ListResourceTemplatesResult> {
    try {
      this.logger.debug('Listing resource templates...', cursor ? { cursor } : {});
      const result = await this.client.listResourceTemplates({ cursor });
      this.logger.debug(`Found ${result.resourceTemplates.length} resource templates`);
      return result;
    } catch (error) {
      this.logger.error('Failed to list resource templates:', error);
      throw new ServerError(
        `Failed to list resource templates: ${(error as Error).message}`,
        { originalError: error }
      );
    }
  }

  /**
   * Read a resource
   */
  async readResource(uri: string): Promise<ReadResourceResult> {
    try {
      this.logger.debug(`Reading resource: ${uri}`);
      const result = await this.client.readResource({ uri });
      this.logger.debug(`Resource ${uri} read successfully`);
      return result;
    } catch (error) {
      this.logger.error(`Failed to read resource ${uri}:`, error);
      throw new ServerError(
        `Failed to read resource ${uri}: ${(error as Error).message}`,
        { originalError: error }
      );
    }
  }

  /**
   * Subscribe to resource updates
   */
  async subscribeResource(uri: string): Promise<void> {
    try {
      this.logger.debug(`Subscribing to resource: ${uri}`);
      await this.client.subscribeResource({ uri });
      this.logger.debug(`Subscribed to resource ${uri}`);
    } catch (error) {
      this.logger.error(`Failed to subscribe to resource ${uri}:`, error);
      throw new ServerError(
        `Failed to subscribe to resource ${uri}: ${(error as Error).message}`,
        { originalError: error }
      );
    }
  }

  /**
   * Unsubscribe from resource updates
   */
  async unsubscribeResource(uri: string): Promise<void> {
    try {
      this.logger.debug(`Unsubscribing from resource: ${uri}`);
      await this.client.unsubscribeResource({ uri });
      this.logger.debug(`Unsubscribed from resource ${uri}`);
    } catch (error) {
      this.logger.error(`Failed to unsubscribe from resource ${uri}:`, error);
      throw new ServerError(
        `Failed to unsubscribe from resource ${uri}: ${(error as Error).message}`,
        { originalError: error }
      );
    }
  }

  /**
   * List available prompts
   */
  async listPrompts(cursor?: string): Promise<ListPromptsResult> {
    try {
      this.logger.debug('Listing prompts...', cursor ? { cursor } : {});
      const result = await this.client.listPrompts({ cursor });
      this.logger.debug(`Found ${result.prompts.length} prompts`);
      return result;
    } catch (error) {
      this.logger.error('Failed to list prompts:', error);
      throw new ServerError(
        `Failed to list prompts: ${(error as Error).message}`,
        { originalError: error }
      );
    }
  }

  /**
   * Get a prompt
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    try {
      this.logger.debug(`Getting prompt: ${name}`, args);
      const result = (await this.client.getPrompt({
        name,
        arguments: args,
      })) as GetPromptResult;
      this.logger.debug(`Prompt ${name} retrieved`);
      return result;
    } catch (error) {
      this.logger.error(`Failed to get prompt ${name}:`, error);
      throw new ServerError(
        `Failed to get prompt ${name}: ${(error as Error).message}`,
        { originalError: error }
      );
    }
  }

  /**
   * Set the logging level on the server
   */
  async setLoggingLevel(level: LoggingLevel): Promise<void> {
    try {
      this.logger.debug(`Setting log level to: ${level}`);
      await this.client.setLoggingLevel(level);
      this.logger.debug('Log level set successfully');
    } catch (error) {
      this.logger.error(`Failed to set log level:`, error);
      throw new ServerError(
        `Failed to set log level: ${(error as Error).message}`,
        { originalError: error }
      );
    }
  }

  /**
   * Get the underlying SDK client instance
   * Use this for advanced operations not covered by the wrapper
   */
  getSDKClient(): SDKClient {
    return this.client;
  }
}
