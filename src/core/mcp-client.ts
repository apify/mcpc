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
  LoggingLevel,
  GetTaskResult,
  ListTasksResult,
  CancelTaskResult,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createNoOpLogger, type Logger } from '../lib/logger.js';
import { ServerError, NetworkError, isShutdownError } from '../lib/errors.js';

/**
 * Traverse the .cause chain to find the deepest (most specific) error message
 */
function getRootCauseMessage(error: Error): string {
  let current: Error = error;
  while (current.cause instanceof Error) {
    current = current.cause;
  }
  return current.message;
}
import type { IMcpClient, ServerDetails, SessionStatefulness, TaskUpdate } from '../lib/types.js';
import type { Task } from '@modelcontextprotocol/sdk/types.js';

/**
 * Convert an SDK Task to a TaskUpdate, handling exactOptionalPropertyTypes
 */
function taskToUpdate(task: Task): TaskUpdate {
  const update: TaskUpdate = {
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
  };
  if (task.statusMessage) {
    update.statusMessage = task.statusMessage;
  }
  return update;
}

/**
 * Transport with protocol version information (e.g., StreamableHTTPClientTransport)
 */
interface TransportWithProtocolVersion extends Transport {
  protocolVersion?: string;
}

/**
 * Fallback freshness window for the in-memory tools cache on stateless connections.
 * Stateless servers (2026-07-28) may not push tools/list_changed (no standing stream), so the
 * cache would otherwise go stale silently. Stateful connections rely on notification-driven
 * invalidation and use no expiry. Phase 1 will replace this fixed value with the server's
 * ttlMs/cacheScope hint.
 */
const STATELESS_TOOLS_CACHE_TTL_MS = 60_000;

/**
 * Options for creating an MCP client
 */
export interface McpClientOptions extends ClientOptions {
  /**
   * Logger to use for client operations
   */
  logger?: Logger;

  /**
   * Request timeout in milliseconds for MCP operations
   * If not specified, uses SDK default (60 seconds)
   */
  requestTimeout?: number;
}

/**
 * Transport with session termination capability (e.g., StreamableHTTPClientTransport)
 */
interface TransportWithTermination extends Transport {
  terminateSession?: () => Promise<void>;
}

/**
 * MCP Client wrapper class
 * Provides a convenient interface to the MCP SDK Client with error handling and logging
 * Implements IMcpClient interface for compatibility with SessionClient
 */
export class McpClient implements IMcpClient {
  private client: SDKClient;
  private logger: Logger;
  private negotiatedProtocolVersion?: string;
  private mcpSessionId?: string;
  private transport?: TransportWithTermination;
  private hasConnected = false;
  private requestTimeout?: number;
  private cachedTools: Tool[] | null = null;
  private cachedToolsExpiresAt: number | null = null;

  constructor(clientInfo: Implementation, options: McpClientOptions = {}) {
    this.logger = options.logger || createNoOpLogger();
    if (options.requestTimeout !== undefined) {
      this.requestTimeout = options.requestTimeout;
    }

    this.client = new SDKClient(clientInfo, {
      capabilities: options.capabilities || {},
      ...options,
    });

    // Set up error handling
    this.client.onerror = (error) => {
      // Ignore abort errors - these occur when connection is closed intentionally
      if (isShutdownError(error)) {
        this.logger.debug('Client aborted (expected during close)');
        return;
      }
      // Don't duplicate logging of errors on initial connection
      this.logger.log(this.hasConnected ? 'error' : 'debug', 'Client error:', error);
    };
  }

  /**
   * Override request timeout for subsequent requests (in milliseconds)
   * Used by bridge to apply per-request timeout from CLI --timeout flag
   */
  setRequestTimeout(timeoutMs: number): void {
    this.requestTimeout = timeoutMs;
  }

  /**
   * Get request options with timeout if configured
   */
  private getRequestOptions(): { timeout?: number } | undefined {
    return this.requestTimeout ? { timeout: this.requestTimeout } : undefined;
  }

  /**
   * Connect to an MCP server using the provided transport
   */
  async connect(transport: Transport): Promise<void> {
    try {
      this.logger.debug('Connecting to MCP server...');

      // Store transport for later use (e.g., terminateSession on close)
      this.transport = transport;

      // Set up transport error handlers
      transport.onerror = (error) => {
        // Ignore abort errors - these occur when connection is closed intentionally
        if (isShutdownError(error)) {
          this.logger.debug('Transport aborted (expected during close)');
          return;
        }
        // Don't duplicate logging of errors on initial connection
        this.logger.log(this.hasConnected ? 'error' : 'debug', 'Transport error:', error);
      };

      transport.onclose = () => {
        this.logger.debug('Transport closed');
      };

      await this.client.connect(transport);

      this.hasConnected = true;

      // Capture negotiated protocol version from transport if available
      // StreamableHTTPClientTransport exposes protocolVersion after initialization
      const transportWithVersion = transport as TransportWithProtocolVersion;
      if (transportWithVersion.protocolVersion) {
        this.negotiatedProtocolVersion = transportWithVersion.protocolVersion;
        this.logger.debug(`Negotiated protocol version: ${this.negotiatedProtocolVersion}`);
      }

      // Capture MCP session ID from transport if available (for session resumption)
      // StreamableHTTPClientTransport exposes sessionId after initialization
      if (transport.sessionId) {
        this.mcpSessionId = transport.sessionId;
        this.logger.debug(`MCP session ID: ${this.mcpSessionId}`);
      }

      const serverVersion = this.client.getServerVersion();
      const serverCapabilities = this.client.getServerCapabilities();

      this.logger.debug(
        `Connected to ${serverVersion?.name || 'unknown'} v${serverVersion?.version || 'unknown'}`
      );
      this.logger.debug('Server capabilities:', serverCapabilities);
    } catch (error) {
      this.logger.debug('Failed to connect:', error);
      throw new NetworkError(
        `Failed to connect to MCP server: ${getRootCauseMessage(error as Error)}`,
        {
          originalError: error,
        }
      );
    }
  }

  /**
   * Close the connection to the server
   * For HTTP transport, sends DELETE request to terminate session before closing
   */
  async close(): Promise<void> {
    this.logger.debug('Closing connection...');

    try {
      // For HTTP transport, terminate the session first (sends HTTP DELETE)
      // This is separate from close() in the SDK - terminateSession() sends the DELETE,
      // while close() just cleans up the client without notifying the server
      if (this.transport?.terminateSession) {
        this.logger.debug('Terminating session (sending DELETE)...');
        try {
          await Promise.race([
            this.transport.terminateSession(),
            new Promise<void>((resolve) => setTimeout(resolve, 2000)),
          ]);
          this.logger.debug('Session terminated');
        } catch (error) {
          this.logger.debug('Error terminating session:', error);
        }
      }

      // Now close the client
      await Promise.race([
        this.client.close(),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
      this.logger.debug('Connection closed');
    } catch (error) {
      this.logger.debug('Error during close (ignored):', error);
    }
  }

  /**
   * Get all server information in a single call
   * Returns a Promise for interface compatibility with SessionClient
   * Structure matches MCP InitializeResult for consistency
   */
  getServerDetails(): Promise<ServerDetails> {
    const details: ServerDetails = {};
    const serverInfo = this.client.getServerVersion();
    const capabilities = this.client.getServerCapabilities();
    const instructions = this.client.getInstructions();

    if (this.negotiatedProtocolVersion) details.protocolVersion = this.negotiatedProtocolVersion;
    if (capabilities) details.capabilities = capabilities;
    if (serverInfo) details.serverInfo = serverInfo;
    if (instructions) details.instructions = instructions;
    details.statefulness = this.deriveStatefulness();

    return Promise.resolve(details);
  }

  /**
   * Get the MCP session ID assigned by the server (if any)
   * This can be used for session resumption after bridge restart
   */
  getMcpSessionId(): string | undefined {
    return this.mcpSessionId;
  }

  /**
   * Derive whether this connection carries server-side session state.
   * stdio transports are persistent local processes (always stateful). Streamable HTTP is
   * stateful/resumable when the server assigned a session id, otherwise stateless (the
   * 2026-07-28 model where any request may hit any server instance).
   */
  private deriveStatefulness(): SessionStatefulness {
    if (!this.hasConnected) return 'unknown';
    // Only the Streamable HTTP transport exposes terminateSession() (it sends an HTTP DELETE);
    // its absence indicates a stdio transport. The method exists on the HTTP transport
    // regardless of whether a session id was issued, so it reliably distinguishes the two.
    const isHttpTransport = typeof this.transport?.terminateSession === 'function';
    if (!isHttpTransport) return 'stateful';
    return this.mcpSessionId ? 'stateful' : 'stateless';
  }

  /**
   * Ping the server
   */
  async ping(): Promise<void> {
    try {
      this.logger.debug('Sending ping...');
      await this.client.ping(this.getRequestOptions());
      this.logger.debug('Ping successful');
    } catch (error) {
      this.logger.error('Ping failed:', error);
      throw new NetworkError(`Ping failed: ${(error as Error).message}`, { originalError: error });
    }
  }

  /**
   * List available tools (single page)
   */
  async listTools(cursor?: string): Promise<ListToolsResult> {
    try {
      this.logger.debug('Listing tools...', cursor ? { cursor } : {});
      const result = await this.client.listTools({ cursor }, this.getRequestOptions());
      this.logger.debug(`Found ${result.tools.length} tools`);
      return result;
    } catch (error) {
      this.logger.error('Failed to list tools:', error);
      throw new ServerError(`Failed to list tools: ${(error as Error).message}`, {
        originalError: error,
      });
    }
  }

  /**
   * List all available tools across all pages.
   * Returns cached tools if available; use refreshCache to bypass cache.
   */
  async listAllTools(options?: { refreshCache?: boolean }): Promise<ListToolsResult> {
    if (!options?.refreshCache && this.cachedTools && !this.isToolsCacheExpired()) {
      return { tools: this.cachedTools };
    }

    const allTools: Tool[] = [];
    let cursor: string | undefined = undefined;

    do {
      const result = await this.listTools(cursor);
      allTools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);

    this.cachedTools = allTools;
    // Stateless connections get a time-based expiry as a fallback for absent list_changed
    // pushes; stateful connections keep no expiry (notifications/explicit invalidation drive it).
    this.cachedToolsExpiresAt =
      this.deriveStatefulness() === 'stateless' ? Date.now() + STATELESS_TOOLS_CACHE_TTL_MS : null;
    return { tools: allTools };
  }

  private isToolsCacheExpired(): boolean {
    return this.cachedToolsExpiresAt !== null && Date.now() >= this.cachedToolsExpiresAt;
  }

  /**
   * Get the cached tools list synchronously (returns null if not yet populated).
   */
  getCachedTools(): Tool[] | null {
    return this.cachedTools;
  }

  /**
   * Invalidate the cached tools list, forcing the next listAllTools call to re-fetch.
   */
  invalidateToolsCache(): void {
    this.cachedTools = null;
    this.cachedToolsExpiresAt = null;
  }

  /**
   * Call a tool
   */
  async callTool(
    name: string,
    args?: Record<string, unknown>,
    meta?: Record<string, unknown>
  ): Promise<CallToolResult> {
    try {
      this.logger.debug(`Calling tool: ${name}`, args);
      const callParams: {
        name: string;
        arguments: Record<string, unknown>;
        _meta?: Record<string, unknown>;
      } = {
        name,
        arguments: args || {},
      };
      if (meta) {
        callParams._meta = meta;
      }
      const result = (await this.client.callTool(
        callParams,
        undefined, // resultSchema - use default
        this.getRequestOptions()
      )) as CallToolResult;
      this.logger.debug(`Tool ${name} completed`);
      return result;
    } catch (error) {
      this.logger.error(`Failed to call tool ${name}:`, error);
      throw new ServerError(`Failed to call tool ${name}: ${(error as Error).message}`, {
        originalError: error,
      });
    }
  }

  /**
   * List available resources
   */
  async listResources(cursor?: string): Promise<ListResourcesResult> {
    try {
      this.logger.debug('Listing resources...', cursor ? { cursor } : {});
      const result = await this.client.listResources({ cursor }, this.getRequestOptions());
      this.logger.debug(`Found ${result.resources.length} resources`);
      return result;
    } catch (error) {
      this.logger.error('Failed to list resources:', error);
      throw new ServerError(`Failed to list resources: ${(error as Error).message}`, {
        originalError: error,
      });
    }
  }

  /**
   * List available resource templates
   */
  async listResourceTemplates(cursor?: string): Promise<ListResourceTemplatesResult> {
    try {
      this.logger.debug('Listing resource templates...', cursor ? { cursor } : {});
      const result = await this.client.listResourceTemplates({ cursor }, this.getRequestOptions());
      this.logger.debug(`Found ${result.resourceTemplates.length} resource templates`);
      return result;
    } catch (error) {
      this.logger.error('Failed to list resource templates:', error);
      throw new ServerError(`Failed to list resource templates: ${(error as Error).message}`, {
        originalError: error,
      });
    }
  }

  /**
   * Read a resource
   */
  async readResource(uri: string): Promise<ReadResourceResult> {
    try {
      this.logger.debug(`Reading resource: ${uri}`);
      const result = await this.client.readResource({ uri }, this.getRequestOptions());
      this.logger.debug(`Resource ${uri} read successfully`);
      return result;
    } catch (error) {
      this.logger.error(`Failed to read resource ${uri}:`, error);
      throw new ServerError(`Failed to read resource ${uri}: ${(error as Error).message}`, {
        originalError: error,
      });
    }
  }

  /**
   * Subscribe to resource updates
   */
  async subscribeResource(uri: string): Promise<void> {
    try {
      this.logger.debug(`Subscribing to resource: ${uri}`);
      await this.client.subscribeResource({ uri }, this.getRequestOptions());
      this.logger.debug(`Subscribed to resource ${uri}`);
    } catch (error) {
      this.logger.error(`Failed to subscribe to resource ${uri}:`, error);
      throw new ServerError(`Failed to subscribe to resource ${uri}: ${(error as Error).message}`, {
        originalError: error,
      });
    }
  }

  /**
   * Unsubscribe from resource updates
   */
  async unsubscribeResource(uri: string): Promise<void> {
    try {
      this.logger.debug(`Unsubscribing from resource: ${uri}`);
      await this.client.unsubscribeResource({ uri }, this.getRequestOptions());
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
      const result = await this.client.listPrompts({ cursor }, this.getRequestOptions());
      this.logger.debug(`Found ${result.prompts.length} prompts`);
      return result;
    } catch (error) {
      this.logger.error('Failed to list prompts:', error);
      throw new ServerError(`Failed to list prompts: ${(error as Error).message}`, {
        originalError: error,
      });
    }
  }

  /**
   * Get a prompt
   */
  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    try {
      this.logger.debug(`Getting prompt: ${name}`, args);
      const result = await this.client.getPrompt(
        {
          name,
          arguments: args,
        },
        this.getRequestOptions()
      );
      this.logger.debug(`Prompt ${name} retrieved`);
      return result;
    } catch (error) {
      this.logger.error(`Failed to get prompt ${name}:`, error);
      throw new ServerError(`Failed to get prompt ${name}: ${(error as Error).message}`, {
        originalError: error,
      });
    }
  }

  /**
   * Set the logging level on the server
   */
  async setLoggingLevel(level: LoggingLevel): Promise<void> {
    try {
      this.logger.debug(`Setting log level to: ${level}`);
      await this.client.setLoggingLevel(level, this.getRequestOptions());
      this.logger.debug('Log level set successfully');
    } catch (error) {
      this.logger.error(`Failed to set log level:`, error);
      throw new ServerError(`Failed to set log level: ${(error as Error).message}`, {
        originalError: error,
      });
    }
  }

  /**
   * Check if the server supports task-augmented tool calls
   */
  supportsTasksForToolCall(): boolean {
    const capabilities = this.client.getServerCapabilities();
    return !!capabilities?.tasks?.requests?.tools?.call;
  }

  /**
   * Single access point for the SDK's task API. The `2025-11-25` experimental Tasks API
   * (`experimental.tasks`) is superseded by the `2026-07-28` Tasks extension (SEP-2663:
   * `tasks/get` polling, `tasks/update`, returnless `tasks/cancel`, and removal of
   * `tasks/list`). Keeping every task call funnelled through here means that migration is a
   * change to this one accessor rather than scattered across the file.
   */
  private get tasksApi(): SDKClient['experimental']['tasks'] {
    return this.client.experimental.tasks;
  }

  /**
   * Call a tool with task-augmented execution
   * Uses the SDK's experimental callToolStream which handles task creation,
   * polling, and result retrieval automatically via an AsyncGenerator.
   */
  async callToolWithTask(
    name: string,
    args?: Record<string, unknown>,
    onUpdate?: (update: TaskUpdate) => void,
    meta?: Record<string, unknown>
  ): Promise<CallToolResult> {
    try {
      this.logger.debug(`Calling tool with task: ${name}`, args);

      // Track latest task info so progress notifications can reference it
      let currentTaskId: string | undefined;
      let currentStatus: TaskUpdate['status'] = 'working';

      const onprogress = onUpdate
        ? (progress: {
            progress: number;
            total?: number | undefined;
            message?: string | undefined;
          }): void => {
            if (!currentTaskId) return;
            this.logger.debug(
              `Task ${currentTaskId} progress: ${progress.progress}/${progress.total ?? '?'}${progress.message ? ` - ${progress.message}` : ''}`
            );
            const update: TaskUpdate = {
              taskId: currentTaskId,
              status: currentStatus,
            };
            if (progress.message) {
              update.progressMessage = progress.message;
            }
            update.progress = progress.progress;
            if (progress.total !== undefined) {
              update.progressTotal = progress.total;
            }
            onUpdate(update);
          }
        : undefined;

      const requestOptions = { ...this.getRequestOptions(), task: {} };
      if (onprogress) {
        (requestOptions as Record<string, unknown>).onprogress = onprogress;
      }

      const callParams: {
        name: string;
        arguments: Record<string, unknown>;
        _meta?: Record<string, unknown>;
      } = {
        name,
        arguments: args || {},
      };
      if (meta) {
        callParams._meta = meta;
      }

      const stream = this.tasksApi.callToolStream(callParams, CallToolResultSchema, requestOptions);

      let result: CallToolResult | undefined;

      for await (const message of stream) {
        switch (message.type) {
          case 'taskCreated':
            this.logger.debug(`Task created: ${message.task.taskId}`);
            currentTaskId = message.task.taskId;
            currentStatus = message.task.status;
            onUpdate?.(taskToUpdate(message.task));
            break;

          case 'taskStatus':
            this.logger.debug(`Task ${message.task.taskId} status: ${message.task.status}`);
            currentTaskId = message.task.taskId;
            currentStatus = message.task.status;
            onUpdate?.(taskToUpdate(message.task));
            break;

          case 'result':
            this.logger.debug(`Task completed with result for tool ${name}`);
            result = message.result;
            break;

          case 'error':
            this.logger.error(`Task error for tool ${name}:`, message.error);
            throw new ServerError(`Tool ${name} task failed: ${message.error.message}`, {
              originalError: message.error,
            });
        }
      }

      if (!result) {
        throw new ServerError(`Tool ${name} task completed without a result`);
      }

      return result;
    } catch (error) {
      if (error instanceof ServerError) throw error;
      this.logger.error(`Failed to call tool ${name} with task:`, error);
      throw new ServerError(`Failed to call tool ${name} with task: ${(error as Error).message}`, {
        originalError: error,
      });
    }
  }

  /**
   * Call a tool with task-augmented execution in detached mode.
   * Returns immediately after task creation with the task ID.
   */
  async callToolDetached(
    name: string,
    args?: Record<string, unknown>,
    meta?: Record<string, unknown>
  ): Promise<TaskUpdate> {
    try {
      this.logger.debug(`Calling tool detached: ${name}`, args);
      const callParams: {
        name: string;
        arguments: Record<string, unknown>;
        _meta?: Record<string, unknown>;
      } = {
        name,
        arguments: args || {},
      };
      if (meta) {
        callParams._meta = meta;
      }
      const stream = this.tasksApi.callToolStream(callParams, CallToolResultSchema, {
        ...this.getRequestOptions(),
        task: {},
      });

      for await (const message of stream) {
        if (message.type === 'taskCreated') {
          this.logger.debug(`Task created (detached): ${message.task.taskId}`);
          const update = taskToUpdate(message.task);
          // Break out of the generator — this closes the stream
          // The task continues running on the server
          return update;
        }
        if (message.type === 'error') {
          throw new ServerError(`Tool ${name} task failed: ${message.error.message}`, {
            originalError: message.error,
          });
        }
      }

      throw new ServerError(`Tool ${name} task stream ended without creating a task`);
    } catch (error) {
      if (error instanceof ServerError) throw error;
      this.logger.error(`Failed to call tool ${name} detached:`, error);
      throw new ServerError(`Failed to call tool ${name} detached: ${(error as Error).message}`, {
        originalError: error,
      });
    }
  }

  /**
   * Poll a task by ID until it reaches a terminal state.
   * Used for crash recovery — reconnect to an existing task.
   */
  async pollTask(taskId: string, onUpdate?: (update: TaskUpdate) => void): Promise<CallToolResult> {
    const POLL_INTERVAL_MS = 2000;

    try {
      this.logger.debug(`Polling task: ${taskId}`);

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const task = await this.getTask(taskId);
        const update: TaskUpdate = {
          taskId: task.taskId,
          status: task.status,
          ...(task.statusMessage != null ? { statusMessage: task.statusMessage } : {}),
          createdAt: task.createdAt,
          lastUpdatedAt: task.lastUpdatedAt,
        };
        onUpdate?.(update);

        if (
          task.status === 'completed' ||
          task.status === 'failed' ||
          task.status === 'cancelled'
        ) {
          // For completed tasks, the result is in the task itself
          if (task.status === 'completed') {
            // Re-fetch task to get final result if needed
            // The GetTaskResult includes the task with its artifacts
            return {
              content: [{ type: 'text', text: task.statusMessage || 'Task completed' }],
            };
          }
          throw new ServerError(
            `Task ${taskId} ${task.status}: ${task.statusMessage || 'no details'}`
          );
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (error) {
      if (error instanceof ServerError) throw error;
      this.logger.error(`Failed to poll task ${taskId}:`, error);
      throw new ServerError(`Failed to poll task ${taskId}: ${(error as Error).message}`, {
        originalError: error,
      });
    }
  }

  /**
   * List tasks on the server
   */
  async listTasks(cursor?: string): Promise<ListTasksResult> {
    try {
      this.logger.debug('Listing tasks...', cursor ? { cursor } : {});
      const result = await this.tasksApi.listTasks(cursor, this.getRequestOptions());
      this.logger.debug(`Found ${result.tasks.length} tasks`);
      return result;
    } catch (error) {
      this.logger.error('Failed to list tasks:', error);
      throw new ServerError(`Failed to list tasks: ${(error as Error).message}`, {
        originalError: error,
      });
    }
  }

  /**
   * Get a task's current status
   */
  async getTask(taskId: string): Promise<GetTaskResult> {
    try {
      this.logger.debug(`Getting task: ${taskId}`);
      const result = await this.tasksApi.getTask(taskId, this.getRequestOptions());
      this.logger.debug(`Task ${taskId} status: ${result.status}`);
      return result;
    } catch (error) {
      this.logger.error(`Failed to get task ${taskId}:`, error);
      throw new ServerError(`Failed to get task ${taskId}: ${(error as Error).message}`, {
        originalError: error,
      });
    }
  }

  /**
   * Get the final result of a task.
   * Blocks on the server until the task reaches a terminal state, per
   * the MCP `tasks/result` protocol method.
   */
  async getTaskResult(taskId: string): Promise<CallToolResult> {
    try {
      this.logger.debug(`Getting task result: ${taskId}`);
      const result = await this.tasksApi.getTaskResult(
        taskId,
        CallToolResultSchema,
        this.getRequestOptions()
      );
      this.logger.debug(`Task ${taskId} result received`);
      return result;
    } catch (error) {
      this.logger.error(`Failed to get task result ${taskId}:`, error);
      throw new ServerError(`Failed to get task result ${taskId}: ${(error as Error).message}`, {
        originalError: error,
      });
    }
  }

  /**
   * Cancel a running task
   */
  async cancelTask(taskId: string): Promise<CancelTaskResult> {
    try {
      this.logger.debug(`Cancelling task: ${taskId}`);
      const result = await this.tasksApi.cancelTask(taskId, this.getRequestOptions());
      this.logger.debug(`Task ${taskId} cancelled`);
      return result;
    } catch (error) {
      this.logger.error(`Failed to cancel task ${taskId}:`, error);
      throw new ServerError(`Failed to cancel task ${taskId}: ${(error as Error).message}`, {
        originalError: error,
      });
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
