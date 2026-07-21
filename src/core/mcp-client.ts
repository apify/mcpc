/**
 * MCP Client wrapper
 * Wraps the @modelcontextprotocol/client (SDK v2) Client class with additional functionality
 */

import { Client as SDKClient, type ClientOptions } from '@modelcontextprotocol/client';
import type { Transport, McpSubscription, ProtocolEra } from '@modelcontextprotocol/client';
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
} from '@modelcontextprotocol/client';
import {
  CallToolResultSchema,
  CreateTaskResultSchema,
  ListTasksResultSchema,
  GetTaskResultSchema,
  CancelTaskResultSchema,
} from '@modelcontextprotocol/core';
import { createNoOpLogger, type Logger } from '../lib/logger.js';
import { ServerError, NetworkError, isShutdownError } from '../lib/errors.js';
import { fetchAllPages } from '../lib/utils.js';

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
import type { IMcpClient, ServerDetails, ConnectionMode, TaskUpdate } from '../lib/types.js';
import type { Task } from '@modelcontextprotocol/client';

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
const STATELESS_TOOLS_CACHE_TTL_MILLIS = 60_000;

/**
 * Options for creating an MCP client
 */
export interface McpClientOptions extends ClientOptions {
  /**
   * Logger to use for client operations
   */
  logger?: Logger;

  /**
   * Request timeout in milliseconds for MCP operations.
   * Defaults to DEFAULT_REQUEST_TIMEOUT_MILLIS (60 seconds) when not specified.
   */
  requestTimeoutMillis?: number;

  /**
   * Set when the client will connect over a stdio transport. Caps the
   * version-negotiation probe timeout (see STDIO_PROBE_TIMEOUT_MILLIS).
   */
  stdioTransport?: boolean;
}

/**
 * Transport with session termination capability (e.g., StreamableHTTPClientTransport)
 */
interface TransportWithTermination extends Transport {
  terminateSession?: () => Promise<void>;
}

/**
 * Default request timeout in milliseconds (60 seconds).
 *
 * Pinned explicitly instead of relying on the MCP SDK's built-in default, so the
 * documented `--timeout` default (shown as "default: 60" in the CLI help) stays
 * accurate even if the SDK changes its own default. A config-file `timeout` or
 * the `--timeout` flag overrides it (via the constructor / setRequestTimeout()).
 */
const DEFAULT_REQUEST_TIMEOUT_MILLIS = 60_000;

/**
 * Backoff bounds for re-opening the `subscriptions/listen` stream (2026-07-28 connections)
 * after an unexpected remote drop. Mirrors the Streamable HTTP reconnection policy (1s → 30s).
 */
const RELISTEN_INITIAL_DELAY_MILLIS = 1_000;
const RELISTEN_MAX_DELAY_MILLIS = 30_000;

/**
 * Timeout for the connect-time `server/discover` version-negotiation probe on stdio
 * transports. Some stdio servers never answer unknown pre-`initialize` requests; the SDK
 * treats a probe timeout on a local pipe as "legacy server" and falls back to `initialize`
 * on the same stream, so a short timeout keeps connecting to such servers fast instead of
 * waiting out the full request timeout. Not applied to HTTP, where probe silence means an
 * outage and the SDK rejects instead of falling back.
 */
const STDIO_PROBE_TIMEOUT_MILLIS = 5_000;

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
  private requestTimeoutMillis: number = DEFAULT_REQUEST_TIMEOUT_MILLIS;
  /** Baseline timeout from the constructor — what resetRequestTimeout() restores. */
  private readonly configuredRequestTimeoutMillis: number;
  private cachedTools: Tool[] | null = null;
  private cachedToolsExpiresAt: number | null = null;
  private isClosing = false;
  /** Resource URIs subscribed on a 2026-07-28 connection (served by one listen stream). */
  private modernSubscribedUris = new Set<string>();
  /** The open `subscriptions/listen` stream backing modernSubscribedUris, if any. */
  private modernListen: McpSubscription | undefined;

  constructor(clientInfo: Implementation, options: McpClientOptions = {}) {
    this.logger = options.logger || createNoOpLogger();
    if (options.requestTimeoutMillis !== undefined) {
      this.requestTimeoutMillis = options.requestTimeoutMillis;
    }
    this.configuredRequestTimeoutMillis = this.requestTimeoutMillis;

    this.client = new SDKClient(clientInfo, {
      capabilities: options.capabilities || {},
      // Probe servers with `server/discover` and talk 2026-07-28 when they support it,
      // falling back to the 2025-11-25 `initialize` handshake on the same connection.
      versionNegotiation: {
        mode: 'auto',
        ...(options.stdioTransport ? { probe: { timeoutMs: STDIO_PROBE_TIMEOUT_MILLIS } } : {}),
      },
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
  setRequestTimeout(timeoutMillis: number): void {
    this.requestTimeoutMillis = timeoutMillis;
  }

  /**
   * Restore the request timeout to the constructor-configured baseline.
   * The bridge calls this after each request that carried an explicit
   * `--timeout`, so a one-off override never leaks into later requests.
   */
  resetRequestTimeout(): void {
    this.requestTimeoutMillis = this.configuredRequestTimeoutMillis;
  }

  /**
   * Request options applied to every SDK call. Always carries an explicit
   * timeout (DEFAULT_REQUEST_TIMEOUT_MILLIS unless overridden) so requests never
   * fall back to the SDK's own default.
   */
  private getRequestOptions(): { timeout: number } {
    return { timeout: this.requestTimeoutMillis };
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

      // Capture the negotiated protocol version (the client knows it for both eras;
      // fall back to the transport for safety).
      const transportWithVersion = transport as TransportWithProtocolVersion;
      const negotiatedVersion =
        this.client.getNegotiatedProtocolVersion() ?? transportWithVersion.protocolVersion;
      if (negotiatedVersion) {
        this.negotiatedProtocolVersion = negotiatedVersion;
        this.logger.debug(
          `Negotiated protocol version: ${this.negotiatedProtocolVersion} (${this.getProtocolEra() ?? 'unknown'} era)`
        );
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
    this.isClosing = true;

    try {
      // Tear down the listen stream first on 2026-07-28 connections so its
      // closed promise resolves 'local' and no re-listen is attempted.
      if (this.modernListen) {
        const listen = this.modernListen;
        this.modernListen = undefined;
        await listen.close().catch((error) => {
          this.logger.debug('Error closing listen stream (ignored):', error);
        });
      }
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

      // Now close the client. Stdio transports need a longer budget: the SDK's
      // close() escalates close-stdin → wait → SIGTERM → wait → SIGKILL (~4.5s
      // worst case), and abandoning it early would orphan the child server
      // process. HTTP transports have nothing to kill, so they get a short one.
      const isHttp = typeof this.transport?.terminateSession === 'function';
      const closeBudgetMillis = isHttp ? 1000 : 6000;
      await Promise.race([
        this.client.close(),
        new Promise<void>((resolve) => setTimeout(resolve, closeBudgetMillis)),
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
    details.connectionMode = this.deriveConnectionMode();

    return Promise.resolve(details);
  }

  /**
   * Protocol era of the connection: 'modern' for 2026-07-28+ (negotiated via
   * server/discover), 'legacy' for the 2025-era initialize handshake.
   */
  getProtocolEra(): ProtocolEra | undefined {
    return this.client.getProtocolEra();
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
  private deriveConnectionMode(): ConnectionMode {
    if (!this.hasConnected) return 'unknown';
    // Only the Streamable HTTP transport exposes terminateSession() (it sends an HTTP DELETE);
    // its absence indicates a stdio transport. The method exists on the HTTP transport
    // regardless of whether a session id was issued, so it reliably distinguishes the two.
    const isHttpTransport = typeof this.transport?.terminateSession === 'function';
    if (!isHttpTransport) return 'stateful';
    return this.mcpSessionId ? 'stateful' : 'stateless';
  }

  /**
   * Ping the server.
   * The `ping` method was removed in protocol 2026-07-28, so on modern connections the
   * liveness probe is a `server/discover` request instead (same round-trip semantics).
   */
  async ping(): Promise<void> {
    try {
      if (this.getProtocolEra() === 'modern') {
        this.logger.debug('Sending server/discover (2026-07-28 liveness probe)...');
        await this.client.discover(this.getRequestOptions());
      } else {
        this.logger.debug('Sending ping...');
        await this.client.ping(this.getRequestOptions());
      }
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

    const allTools: Tool[] = await fetchAllPages(
      (cursor) => this.listTools(cursor),
      (page) => page.tools
    );

    this.cachedTools = allTools;
    // Stateless connections get a time-based expiry as a fallback for absent list_changed
    // pushes; stateful connections keep no expiry (notifications/explicit invalidation drive it).
    this.cachedToolsExpiresAt =
      this.deriveConnectionMode() === 'stateless'
        ? Date.now() + STATELESS_TOOLS_CACHE_TTL_MILLIS
        : null;
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
      const result = await this.client.callTool(callParams, this.getRequestOptions());
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
   * Subscribe to resource updates.
   * On 2025-era connections this issues `resources/subscribe`; protocol 2026-07-28 replaced
   * that with a `subscriptions/listen` stream, so on modern connections one listen stream
   * is maintained carrying all subscribed URIs (re-opened whenever the set changes).
   */
  async subscribeResource(uri: string): Promise<void> {
    try {
      this.logger.debug(`Subscribing to resource: ${uri}`);
      if (this.getProtocolEra() === 'modern') {
        this.modernSubscribedUris.add(uri);
        await this.reopenModernListen();
      } else {
        await this.client.subscribeResource({ uri }, this.getRequestOptions());
      }
      this.logger.debug(`Subscribed to resource ${uri}`);
    } catch (error) {
      this.logger.error(`Failed to subscribe to resource ${uri}:`, error);
      throw new ServerError(`Failed to subscribe to resource ${uri}: ${(error as Error).message}`, {
        originalError: error,
      });
    }
  }

  /**
   * Unsubscribe from resource updates (see subscribeResource for the per-era mechanics)
   */
  async unsubscribeResource(uri: string): Promise<void> {
    try {
      this.logger.debug(`Unsubscribing from resource: ${uri}`);
      if (this.getProtocolEra() === 'modern') {
        this.modernSubscribedUris.delete(uri);
        await this.reopenModernListen();
      } else {
        await this.client.unsubscribeResource({ uri }, this.getRequestOptions());
      }
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
   * (Re-)open the `subscriptions/listen` stream so it carries exactly the current
   * modernSubscribedUris set. Notifications delivered on the stream dispatch to the
   * handlers registered via setNotificationHandler, same as 2025-era unsolicited ones.
   */
  private async reopenModernListen(): Promise<void> {
    const previous = this.modernListen;
    this.modernListen = undefined;
    if (previous) {
      await previous.close().catch((error) => {
        this.logger.debug('Error closing previous listen stream (ignored):', error);
      });
    }
    if (this.modernSubscribedUris.size === 0 || this.isClosing) return;

    const subscription = await this.client.listen(
      { resourceSubscriptions: [...this.modernSubscribedUris] },
      this.getRequestOptions()
    );
    this.modernListen = subscription;

    // Re-listen only on unexpected drops; 'local' and 'graceful' closes are deliberate.
    void subscription.closed.then((reason) => {
      if (reason !== 'remote' || this.modernListen !== subscription || this.isClosing) return;
      this.modernListen = undefined;
      void this.relistenWithBackoff();
    });
  }

  /** Re-establish the listen stream after a remote drop, backing off 1s → 30s. */
  private async relistenWithBackoff(): Promise<void> {
    let delayMillis = RELISTEN_INITIAL_DELAY_MILLIS;
    while (!this.isClosing && this.modernSubscribedUris.size > 0 && !this.modernListen) {
      await new Promise((resolve) => setTimeout(resolve, delayMillis));
      try {
        await this.reopenModernListen();
        this.logger.debug('Listen stream re-established');
        return;
      } catch (error) {
        this.logger.debug(`Re-listen failed, retrying in ${delayMillis * 2}ms:`, error);
        delayMillis = Math.min(delayMillis * 2, RELISTEN_MAX_DELAY_MILLIS);
      }
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
   * Set the logging level on the server.
   * Protocol 2026-07-28 removed `logging/setLevel` (log level is per-request `_meta` there),
   * so this only works on 2025-era connections.
   */
  async setLoggingLevel(level: LoggingLevel): Promise<void> {
    if (this.getProtocolEra() === 'modern') {
      throw new ServerError(
        `logging/setLevel was removed in MCP ${this.negotiatedProtocolVersion}; ` +
          `this server no longer supports a session-wide log level. ` +
          `Use --verbose for client-side logging instead.`
      );
    }
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
    if (this.getProtocolEra() === 'modern') return false;
    const capabilities = this.client.getServerCapabilities();
    return !!capabilities?.tasks?.requests?.tools?.call;
  }

  /**
   * Tasks were an experimental core feature in `2025-11-25` and moved to the
   * `io.modelcontextprotocol/tasks` extension in `2026-07-28` (SEP-2663). The v2 SDK
   * dropped the v1 experimental client API and does not implement the extension yet, so
   * mcpc issues the `2025-11-25` task requests directly via `client.request()` — the wire
   * vocabulary is still part of the SDK's legacy-era schema set. All task traffic is
   * funnelled through the few methods below, so adopting the SDK's tasks extension API
   * once it ships is a change to these methods only.
   */
  private assertTasksAvailable(): void {
    if (this.getProtocolEra() === 'modern') {
      throw new ServerError(
        `Tasks are not available on this connection: MCP ${this.negotiatedProtocolVersion} moved tasks ` +
          `to the io.modelcontextprotocol/tasks extension, which is not supported yet. ` +
          `Task commands currently work only on servers using protocol 2025-11-25.`
      );
    }
  }

  /**
   * Issue a task-augmented `tools/call` and return the created task.
   * The tool keeps running on the server after this returns.
   */
  private async createToolTask(
    name: string,
    args?: Record<string, unknown>,
    meta?: Record<string, unknown>
  ): Promise<TaskUpdate> {
    this.assertTasksAvailable();
    const params: Record<string, unknown> = {
      name,
      arguments: args || {},
      task: {},
    };
    if (meta) {
      params._meta = meta;
    }
    const result = await this.client.request(
      { method: 'tools/call', params },
      CreateTaskResultSchema,
      this.getRequestOptions()
    );
    this.logger.debug(`Task created: ${result.task.taskId}`);
    return taskToUpdate(result.task);
  }

  /**
   * Call a tool with task-augmented execution: create the task, poll its status until it
   * reaches a terminal state, then fetch the tool result.
   */
  async callToolWithTask(
    name: string,
    args?: Record<string, unknown>,
    onUpdate?: (update: TaskUpdate) => void,
    meta?: Record<string, unknown>
  ): Promise<CallToolResult> {
    try {
      this.logger.debug(`Calling tool with task: ${name}`, args);
      const created = await this.createToolTask(name, args, meta);
      onUpdate?.(created);
      return await this.pollTask(created.taskId, onUpdate);
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
      return await this.createToolTask(name, args, meta);
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
    const POLL_INTERVAL_MILLIS = 2000;

    try {
      this.logger.debug(`Polling task: ${taskId}`);

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
          if (task.status === 'completed') {
            // Fetch the actual tool result — the task status only carries a
            // human-readable message, not the tool output.
            return await this.getTaskResult(taskId);
          }
          throw new ServerError(
            `Task ${taskId} ${task.status}: ${task.statusMessage || 'no details'}`
          );
        }

        // input_required: tasks/result delivers the queued server messages and
        // blocks until the task reaches a terminal state.
        if (task.status === 'input_required') {
          return await this.getTaskResult(taskId);
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MILLIS));
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
      this.assertTasksAvailable();
      const result = await this.client.request(
        { method: 'tasks/list', ...(cursor ? { params: { cursor } } : {}) },
        ListTasksResultSchema,
        this.getRequestOptions()
      );
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
      this.assertTasksAvailable();
      const result = await this.client.request(
        { method: 'tasks/get', params: { taskId } },
        GetTaskResultSchema,
        this.getRequestOptions()
      );
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
      this.assertTasksAvailable();
      const result = await this.client.request(
        { method: 'tasks/result', params: { taskId } },
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
      this.assertTasksAvailable();
      const result = await this.client.request(
        { method: 'tasks/cancel', params: { taskId } },
        CancelTaskResultSchema,
        this.getRequestOptions()
      );
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
