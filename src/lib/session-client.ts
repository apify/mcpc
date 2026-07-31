/**
 * Session-aware MCP client wrapper
 * Adapts BridgeClient to look like McpClient for seamless session support
 *
 * Responsibilities:
 * - Implements IMcpClient interface by forwarding to bridge
 * - Simple one-shot retry on socket failure (restart bridge once)
 *
 * NOT responsible for:
 * - Bridge lifecycle management (that's bridge-manager's job)
 * - Health checking (that's bridge-manager's job via ensureBridgeReady)
 * - Complex retry logic (keep it simple: fail or restart once)
 */

import type {
  DiscoverResult,
  ListToolsResult,
  CallToolResult,
  ListResourcesResult,
  ReadResourceResult,
  ListPromptsResult,
  GetPromptResult,
  LoggingLevel,
  IMcpClient,
  ServerDetails,
  TaskUpdate,
  GetTaskResult,
  ListTasksResult,
  CancelTaskResult,
  ResourceSyncResult,
  ResourceUnsubscribeResult,
} from './types.js';
import type { ListResourceTemplatesResult } from '@modelcontextprotocol/client';
import { BridgeClient } from './bridge-client.js';
import { ensureBridgeReady, restartBridge } from './bridge-manager.js';
import { updateSession } from './sessions.js';
import { NetworkError, IpcTimeoutError } from './errors.js';
import { getSocketPath, generateRequestId } from './utils.js';
import { createLogger } from './logger.js';

const logger = createLogger('session-client');

/**
 * Wrapper that makes BridgeClient compatible with McpClient interface
 * Implements IMcpClient by sending requests to bridge process via IPC
 */
export class SessionClient implements IMcpClient {
  private bridgeClient: BridgeClient;
  private sessionName: string;
  private requestTimeoutSecs?: number; // Per-request timeout in seconds

  constructor(sessionName: string, bridgeClient: BridgeClient) {
    this.sessionName = sessionName;
    this.bridgeClient = bridgeClient;
  }

  /**
   * Set request timeout for all subsequent requests (in seconds)
   */
  setRequestTimeout(timeoutSecs: number): void {
    this.requestTimeoutSecs = timeoutSecs;
  }

  /**
   * Execute a bridge request with one-shot restart on socket failure
   *
   * If the bridge socket connection fails (bridge crashed/killed), we:
   * 1. Restart the bridge once
   * 2. Reconnect
   * 3. Retry the operation once — but only for idempotent operations
   *
   * Two cases are deliberately NOT retried:
   * - IPC timeouts: the bridge is likely healthy and still processing the request;
   *   restarting would kill the in-flight request and retrying could execute it twice.
   * - Non-idempotent operations (tool calls) after a socket failure: the bridge died
   *   with the request in flight, so the server may already have executed it. We
   *   restart the bridge to recover the session, but surface the uncertainty to the
   *   caller instead of silently re-executing.
   *
   * MCP-level errors (server errors, auth errors) are NOT retried - they're returned to caller.
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    options?: { idempotent?: boolean }
  ): Promise<T> {
    const idempotent = options?.idempotent ?? true;
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

      // IPC timeout: the bridge did not answer in time, but it did not crash —
      // the request may still be running. Never restart or retry here.
      if (error instanceof IpcTimeoutError) {
        error.message =
          `${error.message}. The bridge did not respond in time; the request may still be ` +
          `running on the server. For details, run: mcpc ${this.sessionName} logs`;
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
      await this.bridgeClient.connect();
      await updateSession(this.sessionName, { status: 'active' });

      if (!idempotent) {
        // The request was in flight when the bridge died — the server may or may
        // not have executed it. The session is reconnected; let the user decide.
        error.message =
          `${error.message}. The bridge connection was lost while the request was in flight — ` +
          `it may or may not have executed on the server. The session has been reconnected; ` +
          `verify the outcome before retrying. For details, run: mcpc ${this.sessionName} logs`;
        throw error;
      }

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
          this.requestTimeoutSecs
        ) as Promise<ServerDetails>,
      'getServerDetails'
    );
  }

  // MCP operations
  async ping(): Promise<void> {
    return this.withRetry(
      () =>
        this.bridgeClient.request('ping', undefined, this.requestTimeoutSecs).then(() => undefined),
      'ping'
    );
  }

  async discover(): Promise<DiscoverResult> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'discover',
          undefined,
          this.requestTimeoutSecs
        ) as Promise<DiscoverResult>,
      'discover'
    );
  }

  async listTools(cursor?: string): Promise<ListToolsResult> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'listTools',
          cursor,
          this.requestTimeoutSecs
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
          this.requestTimeoutSecs
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
          this.requestTimeoutSecs
        ) as Promise<CallToolResult>,
      'callTool',
      { idempotent: false }
    );
  }

  async listResources(cursor?: string): Promise<ListResourcesResult> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'listResources',
          cursor,
          this.requestTimeoutSecs
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
          this.requestTimeoutSecs
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
          this.requestTimeoutSecs
        ) as Promise<ReadResourceResult>,
      'readResource'
    );
  }

  /**
   * Subscribe to a resource and keep a local file in sync with it.
   * The bridge performs an initial download to filePath and rewrites the file
   * whenever the server sends notifications/resources/updated for the URI.
   *
   * @param filePath - Absolute target path (resolve user input in the CLI —
   *   the bridge process has a different cwd)
   */
  async subscribeResource(uri: string, filePath: string): Promise<ResourceSyncResult> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'subscribeResource',
          { uri, filePath },
          this.requestTimeoutSecs
        ) as Promise<ResourceSyncResult>,
      'subscribeResource'
    );
  }

  /**
   * Stop syncing a subscribed resource. The synced file is kept as-is.
   */
  async unsubscribeResource(uri: string): Promise<ResourceUnsubscribeResult> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'unsubscribeResource',
          { uri },
          this.requestTimeoutSecs
        ) as Promise<ResourceUnsubscribeResult>,
      'unsubscribeResource'
    );
  }

  async listPrompts(cursor?: string): Promise<ListPromptsResult> {
    return this.withRetry(
      () =>
        this.bridgeClient.request(
          'listPrompts',
          cursor,
          this.requestTimeoutSecs
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
          this.requestTimeoutSecs
        ) as Promise<GetPromptResult>,
      'getPrompt'
    );
  }

  async setLoggingLevel(level: LoggingLevel): Promise<void> {
    return this.withRetry(
      () =>
        this.bridgeClient
          .request('setLoggingLevel', level, this.requestTimeoutSecs)
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
            this.requestTimeoutSecs,
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

      // IPC timeout: the bridge is likely still processing the call — never
      // restart or re-invoke (the tool could execute twice). If we know the task
      // ID, keep following it; otherwise surface the timeout.
      if (error instanceof IpcTimeoutError) {
        if (capturedTaskId) {
          logger.debug(`IPC timeout, polling existing task ${capturedTaskId} instead`);
          return await this.pollTask(capturedTaskId, onUpdate);
        }
        error.message =
          `${error.message}. The bridge did not respond in time; the tool call may still be ` +
          `running on the server. For details, run: mcpc ${this.sessionName} logs`;
        throw error;
      }

      logger.debug(`Socket error during callToolWithTask, will restart bridge...`);
      await this.bridgeClient.close();
      const { pid: newPid } = await restartBridge(this.sessionName);

      const socketPath = getSocketPath(this.sessionName, newPid);
      this.bridgeClient = new BridgeClient(socketPath);
      await this.bridgeClient.connect();

      if (capturedTaskId) {
        // Task was already created — poll it instead of re-invoking
        logger.debug(`Reconnected, polling existing task ${capturedTaskId} instead of re-invoking`);
        return await this.pollTask(capturedTaskId, onUpdate);
      }

      // No task was observed, but the tools/call request was already in flight
      // when the bridge died — the server may have received it. Re-invoking could
      // execute the tool twice, so surface the uncertainty instead.
      error.message =
        `${error.message}. The bridge connection was lost while the tool call was in flight — ` +
        `it may or may not have executed on the server. The session has been reconnected; ` +
        `check mcpc ${this.sessionName} tasks-list and verify the outcome before retrying.`;
      throw error;
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
          this.requestTimeoutSecs
        ) as Promise<TaskUpdate>,
      'callToolDetached',
      { idempotent: false }
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
          .request('pollTask', { taskId }, this.requestTimeoutSecs, id)
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
          this.requestTimeoutSecs
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
          this.requestTimeoutSecs
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
          this.requestTimeoutSecs
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
          this.requestTimeoutSecs
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
 *
 * @param timeoutSecs - Optional request timeout in seconds (the `--timeout` value). It bounds the
 *   health check inside ensureBridgeReady(), which is what blocks while the server completes its
 *   handshake — so `--timeout` must reach it here, before setRequestTimeout() is applied below.
 */
export async function createSessionClient(
  sessionName: string,
  timeoutSecs?: number
): Promise<SessionClient> {
  // Ensure bridge is healthy (may restart it)
  const socketPath = await ensureBridgeReady(sessionName, timeoutSecs);

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
  callback: (client: SessionClient) => Promise<T>,
  options?: { timeoutSecs?: number }
): Promise<T> {
  const client = await createSessionClient(sessionName, options?.timeoutSecs);

  if (options?.timeoutSecs !== undefined) {
    client.setRequestTimeout(options.timeoutSecs);
  }

  try {
    return await callback(client);
  } finally {
    await client.close();
  }
}
