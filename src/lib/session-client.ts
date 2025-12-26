/**
 * Session-aware MCP client wrapper
 * Adapts BridgeClient to look like McpClient for seamless session support
 */

import { EventEmitter } from 'events';
import type {
  ListToolsResult,
  CallToolResult,
  ListResourcesResult,
  ReadResourceResult,
  ListPromptsResult,
  GetPromptResult,
  LoggingLevel,
  IMcpClient,
  NotificationData,
  ServerInfo,
} from './types.js';
import type { ListResourceTemplatesResult } from '@modelcontextprotocol/sdk/types.js';
import { BridgeClient } from './bridge-client.js';
import { getSession } from './sessions.js';
import { ensureBridgeHealthy } from './bridge-manager.js';
import { ClientError, NetworkError } from './errors.js';
import { createLogger } from './logger.js';

const logger = createLogger('session-client');

/**
 * Wrapper that makes BridgeClient compatible with McpClient interface
 * Implements IMcpClient by sending requests to bridge process via IPC
 * Extends EventEmitter to forward notifications from the bridge
 */
export class SessionClient extends EventEmitter implements IMcpClient {
  private bridgeClient: BridgeClient;
  private sessionName: string;

  constructor(sessionName: string, socketPath: string) {
    super();
    this.sessionName = sessionName;
    this.bridgeClient = new BridgeClient(socketPath);
    this.setupNotificationForwarding();
  }

  /**
   * Set up notification forwarding from bridge client
   */
  private setupNotificationForwarding(): void {
    this.bridgeClient.on('notification', (notification: NotificationData) => {
      logger.debug(`Forwarding notification: ${notification.method}`);
      this.emit('notification', notification);
    });
  }

  /**
   * Execute a bridge request with automatic retry on failure
   * If the request fails (bridge crashed), restart the bridge and retry
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      // Only retry on network errors (bridge crashed/disconnected)
      if (error instanceof NetworkError) {
        logger.warn(`Request failed (${operationName}), attempting bridge restart...`);

        try {
          // Ensure bridge is healthy (will restart if needed)
          await ensureBridgeHealthy(this.sessionName);

          // Reconnect to the new bridge
          await this.bridgeClient.close();
          const session = await getSession(this.sessionName);
          if (!session || !session.socketPath) {
            throw new ClientError(`Session ${this.sessionName} not found or invalid after restart`);
          }

          this.bridgeClient = new BridgeClient(session.socketPath);
          this.setupNotificationForwarding(); // Re-setup notification forwarding for new client
          await this.bridgeClient.connect();

          logger.info(`Bridge restarted successfully, retrying ${operationName}`);

          // Retry the operation
          return await operation();
        } catch (retryError) {
          logger.error('Failed to restart bridge:', retryError);
          throw new ClientError(
            `Bridge restart failed: ${retryError instanceof Error ? retryError.message : 'Unknown error'}`
          );
        }
      }

      // Re-throw non-network errors
      throw error;
    }
  }

  async connect(): Promise<void> {
    await this.bridgeClient.connect();
  }

  async close(): Promise<void> {
    await this.bridgeClient.close();
  }

  // Server info (single IPC call for all server information)
  async getServerInfo(): Promise<ServerInfo> {
    return this.withRetry(
      () => this.bridgeClient.request('getServerInfo') as Promise<ServerInfo>,
      'getServerInfo'
    );
  }

  // MCP operations
  async ping(): Promise<void> {
    return this.withRetry(
      () => this.bridgeClient.request('ping').then(() => undefined),
      'ping'
    );
  }

  async listTools(cursor?: string): Promise<ListToolsResult> {
    return this.withRetry(
      () => this.bridgeClient.request('listTools', cursor) as Promise<ListToolsResult>,
      'listTools'
    );
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    return this.withRetry(
      () => this.bridgeClient.request('callTool', { name, arguments: args }) as Promise<CallToolResult>,
      'callTool'
    );
  }

  async listResources(cursor?: string): Promise<ListResourcesResult> {
    return this.withRetry(
      () => this.bridgeClient.request('listResources', cursor) as Promise<ListResourcesResult>,
      'listResources'
    );
  }

  async listResourceTemplates(cursor?: string): Promise<ListResourceTemplatesResult> {
    return this.withRetry(
      () => this.bridgeClient.request('listResourceTemplates', cursor) as Promise<ListResourceTemplatesResult>,
      'listResourceTemplates'
    );
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    return this.withRetry(
      () => this.bridgeClient.request('readResource', { uri }) as Promise<ReadResourceResult>,
      'readResource'
    );
  }

  async subscribeResource(uri: string): Promise<void> {
    return this.withRetry(
      () => this.bridgeClient.request('subscribeResource', { uri }).then(() => undefined),
      'subscribeResource'
    );
  }

  async unsubscribeResource(uri: string): Promise<void> {
    return this.withRetry(
      () => this.bridgeClient.request('unsubscribeResource', { uri }).then(() => undefined),
      'unsubscribeResource'
    );
  }

  async listPrompts(cursor?: string): Promise<ListPromptsResult> {
    return this.withRetry(
      () => this.bridgeClient.request('listPrompts', cursor) as Promise<ListPromptsResult>,
      'listPrompts'
    );
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    return this.withRetry(
      () => this.bridgeClient.request('getPrompt', { name, arguments: args }) as Promise<GetPromptResult>,
      'getPrompt'
    );
  }

  async setLoggingLevel(level: LoggingLevel): Promise<void> {
    return this.withRetry(
      () => this.bridgeClient.request('setLoggingLevel', level).then(() => undefined),
      'setLoggingLevel'
    );
  }

  // Compatibility method for SDK client
  getSDKClient(): never {
    throw new Error('SessionClient does not expose underlying SDK client');
  }
}

/**
 * Create a client for a session
 * Automatically handles bridge health checks and reconnection
 */
export async function createSessionClient(sessionName: string): Promise<SessionClient> {
  // Get session info
  const session = await getSession(sessionName);

  if (!session) {
    throw new ClientError(`Session not found: ${sessionName}`);
  }

  // Check if session is expired
  if (session.status === 'expired') {
    throw new ClientError(
      `Session ${sessionName} has expired. ` +
      `The MCP server indicated the session is no longer valid.\n` +
      `To reconnect, run: mcpc ${sessionName} connect\n` +
      `To remove the expired session, run: mcpc ${sessionName} close`
    );
  }

  if (!session.socketPath) {
    throw new ClientError(`Session ${sessionName} has no socket path`);
  }

  // Ensure bridge is healthy (auto-restart if needed)
  await ensureBridgeHealthy(sessionName);

  // Create and connect client
  const client = new SessionClient(sessionName, session.socketPath);
  await client.connect();

  return client;
}

/**
 * Execute a callback with a session client
 * Handles connection and cleanup automatically
 */
export async function withSessionClient<T>(
  sessionName: string,
  callback: (client: IMcpClient) => Promise<T>
): Promise<T> {
  const client = await createSessionClient(sessionName);

  try {
    const result = await callback(client);
    return result;
  } finally {
    await client.close();
  }
}
