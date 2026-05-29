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
  TaskUpdate,
  GetTaskResult,
  ListTasksResult,
  CancelTaskResult,
} from './types.js';
import type { ListResourceTemplatesResult } from '@modelcontextprotocol/sdk/types.js';
import { BridgeClient } from './bridge-client.js';
import { ensureBridgeReady, restartBridge } from './bridge-manager.js';
import { updateSession } from './sessions.js';
import { NetworkError } from './errors.js';
import { getSocketPath, generateRequestId } from './utils.js';
import { createLogger } from './logger.js';

const logger = createLogger('session-client');

/**
 * Wrapper that makes BridgeClient compatible with McpClient interface
 * Implements IMcpClient by sending requests to bridge process via IPC
 */
export class SessionClient extends EventEmitter implements IMcpClient {
  private bridgeClient: BridgeClient;
  private sessionName: string;
  private requestTimeout?: number; // Per-request timeout in seconds

  constructor(sessionName: string, bridgeClient: BridgeClient) {
    super();
    this.sessionName = sessionName;
    this.bridgeClient = bridgeClient;
    this.setupNotificationForwarding();
  }

  /**
   * Set request timeout for all subsequent requests (in seconds)
   */
  setRequestTimeout(timeout: number): void {
    this.requestTimeout = timeout;
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
  private async withRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      // Only retry on network errors (socket failures, connection lost)
      if (!(error instanceof NetworkError)) {
        // Add log hint for MCP/server errors
        const err = error as Error;
        err.message = `${err.message}. For details, run: mcpc ${this.sessionName} logs`;
        throw error;
      }

      logger.debug(`Socket error during ${operationName}, will restart bridge...`);

      // Close the failed client
      await this.bridgeClient.close();

      // Restart bridge
      await updateSession(this.sessionName, { status: 'reconnecting' });
      const { pid: newPid } = await restartBridge(this.sessionName);

      // Reconnect using the new bridge's PID-based socket path
      const socketPath = getSocketPath(this.sessionName, newPid);
      this.bridgeClient = new BridgeClient(socketPath);
      this.setupNotificationForwarding();
      await this.bridgeClient.connect();
      await updateSession(this.sessionName, { status: 'active' });

      logger.debug(`Reconnected to bridge for ${this.sessionName}, retrying ${operationName}`);

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
      () =>
        this.bridgeClient.request(
          'getServerDetails',
          undefined,
          this.requestTimeout
        ) as Promise<ServerDetails>,
      'getServerDetails'
    );
  }

  // MCP operations
  async ping(): Promise<void> {
    return this.withRetry(
      () => this.bridgeClient.request('ping', undefined, this.requestTimeout).then(() => undefined),
      'ping'
    );
  }

  async listTools(cursor?: string): Promise<ListToolsResult> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'listTools',
          cursor,
          this.requestTimeout
        ) as Promise<ListToolsResult>,
      'listTools'
    );
  }

  async listAllTools(options?: { refreshCache?: boolean }): Promise<ListToolsResult> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'listAllTools',
          options?.refreshCache ? { refreshCache: true } : undefined,
          this.requestTimeout
        ) as Promise<ListToolsResult>,
      'listAllTools'
    );
  }

  async callTool(
    name: string,
    args?: Record<string, unknown>,
    meta?: Record<string, unknown>
  ): Promise<CallToolResult> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (meta) {
      params._meta = meta;
    }
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'callTool',
          params,
          this.requestTimeout
        ) as Promise<CallToolResult>,
      'callTool'
    );
  }

  async listResources(cursor?: string): Promise<ListResourcesResult> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'listResources',
          cursor,
          this.requestTimeout
        ) as Promise<ListResourcesResult>,
      'listResources'
    );
  }

  async listResourceTemplates(cursor?: string): Promise<ListResourceTemplatesResult> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'listResourceTemplates',
          cursor,
          this.requestTimeout
        ) as Promise<ListResourceTemplatesResult>,
      'listResourceTemplates'
    );
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'readResource',
          { uri },
          this.requestTimeout
        ) as Promise<ReadResourceResult>,
      'readResource'
    );
  }

  async subscribeResource(uri: string): Promise<void> {
    return this.withRetry(
      () =>
        this.bridgeClient
          .request('subscribeResource', { uri }, this.requestTimeout)
          .then(() => undefined),
      'subscribeResource'
    );
  }

  async unsubscribeResource(uri: string): Promise<void> {
    return this.withRetry(
      () =>
        this.bridgeClient
          .request('unsubscribeResource', { uri }, this.requestTimeout)
          .then(() => undefined),
      'unsubscribeResource'
    );
  }

  async listPrompts(cursor?: string): Promise<ListPromptsResult> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'listPrompts',
          cursor,
          this.requestTimeout
        ) as Promise<ListPromptsResult>,
      'listPrompts'
    );
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'getPrompt',
          {
            name,
            arguments: args,
          },
          this.requestTimeout
        ) as Promise<GetPromptResult>,
      'getPrompt'
    );
  }

  async setLoggingLevel(level: LoggingLevel): Promise<void> {
    return this.withRetry(
      () =>
        this.bridgeClient
          .request('setLoggingLevel', level, this.requestTimeout)
          .then(() => undefined),
      'setLoggingLevel'
    );
  }

  /**
   * Call a tool with task-augmented execution
   * Listens for task-update IPC messages keyed by request ID.
   * On bridge crash, if a task was already created, reconnects via pollTask
   * instead of re-invoking the tool (crash resilience).
   */
  async callToolWithTask(
    name: string,
    args?: Record<string, unknown>,
    onUpdate?: (update: TaskUpdate) => void,
    meta?: Record<string, unknown>
  ): Promise<CallToolResult> {
    let capturedTaskId: string | undefined;

    const executeToolCall = (): Promise<CallToolResult> => {
      return new Promise<CallToolResult>((resolve, reject) => {
        const id = generateRequestId();

        const updateHandler = (update: TaskUpdate): void => {
          capturedTaskId = update.taskId;
          onUpdate?.(update);
        };
        this.bridgeClient.on(`task-update:${id}`, updateHandler);

        const cleanup = (): void => {
          this.bridgeClient.removeListener(`task-update:${id}`, updateHandler);
        };

        this.bridgeClient
          .request(
            'callTool',
            { name, arguments: args, useTask: true, ...(meta && { _meta: meta }) },
            this.requestTimeout,
            id
          )
          .then((result) => {
            cleanup();
            resolve(result as CallToolResult);
          })
          .catch((error: Error) => {
            cleanup();
            reject(error);
          });
      });
    };

    try {
      return await executeToolCall();
    } catch (error) {
      if (!(error instanceof NetworkError)) {
        const err = error as Error;
        err.message = `${err.message}. For details, run: mcpc ${this.sessionName} logs`;
        throw error;
      }

      logger.debug(`Socket error during callToolWithTask, will restart bridge...`);
      await this.bridgeClient.close();
      const { pid: newPid } = await restartBridge(this.sessionName);

      const socketPath = getSocketPath(this.sessionName, newPid);
      this.bridgeClient = new BridgeClient(socketPath);
      this.setupNotificationForwarding();
      await this.bridgeClient.connect();

      if (capturedTaskId) {
        // Task was already created — poll it instead of re-invoking
        logger.debug(`Reconnected, polling existing task ${capturedTaskId} instead of re-invoking`);
        return await this.pollTask(capturedTaskId, onUpdate);
      }

      // Task wasn't created yet — retry the full tool call
      logger.debug(`Reconnected, retrying callToolWithTask`);
      return await executeToolCall();
    }
  }

  /**
   * Call a tool in detached mode — returns task ID immediately without waiting
   */
  async callToolDetached(
    name: string,
    args?: Record<string, unknown>,
    meta?: Record<string, unknown>
  ): Promise<TaskUpdate> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'callTool',
          { name, arguments: args, useTask: true, detach: true, ...(meta && { _meta: meta }) },
          this.requestTimeout
        ) as Promise<TaskUpdate>,
      'callToolDetached'
    );
  }

  /**
   * Poll a task by ID until terminal state (for crash recovery)
   */
  async pollTask(taskId: string, onUpdate?: (update: TaskUpdate) => void): Promise<CallToolResult> {
    return this.withRetry(() => {
      return new Promise<CallToolResult>((resolve, reject) => {
        const id = generateRequestId();

        const updateHandler = (update: TaskUpdate): void => {
          onUpdate?.(update);
        };
        this.bridgeClient.on(`task-update:${id}`, updateHandler);

        const cleanup = (): void => {
          this.bridgeClient.removeListener(`task-update:${id}`, updateHandler);
        };

        this.bridgeClient
          .request('pollTask', { taskId }, this.requestTimeout, id)
          .then((result) => {
            cleanup();
            resolve(result as CallToolResult);
          })
          .catch((error: Error) => {
            cleanup();
            reject(error);
          });
      });
    }, 'pollTask');
  }

  async listTasks(cursor?: string): Promise<ListTasksResult> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'listTasks',
          cursor,
          this.requestTimeout
        ) as Promise<ListTasksResult>,
      'listTasks'
    );
  }

  async getTask(taskId: string): Promise<GetTaskResult> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'getTask',
          { taskId },
          this.requestTimeout
        ) as Promise<GetTaskResult>,
      'getTask'
    );
  }

  async getTaskResult(taskId: string): Promise<CallToolResult> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'getTaskResult',
          { taskId },
          this.requestTimeout
        ) as Promise<CallToolResult>,
      'getTaskResult'
    );
  }

  async cancelTask(taskId: string): Promise<CancelTaskResult> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'cancelTask',
          { taskId },
          this.requestTimeout
        ) as Promise<CancelTaskResult>,
      'cancelTask'
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
  callback: (client: IMcpClient) => Promise<T>,
  options?: { timeout?: number }
): Promise<T> {
  const client = await createSessionClient(sessionName);

  if (options?.timeout !== undefined) {
    client.setRequestTimeout(options.timeout);
  }

  try {
    return await callback(client);
  } finally {
    await client.close();
  }
}
