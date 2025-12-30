/**
 * Session-aware MCP client wrapper
 * Adapts BridgeClient to look like McpClient for seamless session support
 *
 * Responsibilities:
 * - Implements IMcpClient interface by forwarding to bridge
 * - Simple one-shot retry on socket failure (restart bridge once)
 * - Forwards notifications from bridge
 *
 * NOT responsible for:
 * - Bridge lifecycle management (that's bridge-manager's job)
 * - Health checking (that's bridge-manager's job via ensureBridgeReady)
 * - Complex retry logic (keep it simple: fail or restart once)
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
  ServerDetails,
} from './types.js';
import type { ListResourceTemplatesResult } from '@modelcontextprotocol/sdk/types.js';
import { BridgeClient } from './bridge-client.js';
import { ensureBridgeReady, restartBridge } from './bridge-manager.js';
import { NetworkError } from './errors.js';
import { getSocketPath, getLogsDir } from './utils.js';
import { createLogger } from './logger.js';

const logger = createLogger('session-client');

/**
 * Wrapper that makes BridgeClient compatible with McpClient interface
 * Implements IMcpClient by sending requests to bridge process via IPC
 */
export class SessionClient extends EventEmitter implements IMcpClient {
  private bridgeClient: BridgeClient;
  private sessionName: string;

  constructor(sessionName: string, bridgeClient: BridgeClient) {
    super();
    this.sessionName = sessionName;
    this.bridgeClient = bridgeClient;
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
   * Execute a bridge request with one-shot restart on socket failure
   *
   * If the bridge socket connection fails (bridge crashed/killed), we:
   * 1. Restart the bridge once
   * 2. Reconnect
   * 3. Retry the operation once
   *
   * This handles the common case of a crashed bridge without complex retry logic.
   * MCP-level errors (server errors, auth errors) are NOT retried - they're returned to caller.
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      // Only retry on network errors (socket failures, connection lost)
      if (!(error instanceof NetworkError)) {
        // Add log hint for MCP/server errors
        const err = error as Error;
        const logPath = `${getLogsDir()}/bridge-${this.sessionName}.log`;
        err.message = `${err.message}. Check logs at ${logPath} for details.`;
        throw error;
      }

      logger.warn(`Socket error during ${operationName}, will restart bridge...`);

      // Close the failed client
      await this.bridgeClient.close();

      // Restart bridge
      await restartBridge(this.sessionName);

      // Reconnect using computed socket path
      const socketPath = getSocketPath(this.sessionName);
      this.bridgeClient = new BridgeClient(socketPath);
      this.setupNotificationForwarding();
      await this.bridgeClient.connect();

      logger.info(`Reconnected to bridge for ${this.sessionName}, retrying ${operationName}`);

      // Retry once
      return await operation();
    }
  }

  async close(): Promise<void> {
    await this.bridgeClient.close();
  }

  // Server info (single IPC call for all server information)
  async getServerDetails(): Promise<ServerDetails> {
    return this.withRetry(
      () => this.bridgeClient.request('getServerDetails') as Promise<ServerDetails>,
      'getServerDetails'
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
 *
 * Uses ensureBridgeReady() to guarantee the bridge is healthy before connecting.
 * This handles all the restart logic in one place (bridge-manager).
 */
export async function createSessionClient(sessionName: string): Promise<SessionClient> {
  // Ensure bridge is healthy (may restart it)
  const socketPath = await ensureBridgeReady(sessionName);

  // Connect to the healthy bridge
  const bridgeClient = new BridgeClient(socketPath);
  await bridgeClient.connect();

  logger.debug(`Created SessionClient for ${sessionName}`);
  return new SessionClient(sessionName, bridgeClient);
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
    return await callback(client);
  } finally {
    await client.close();
  }
}
