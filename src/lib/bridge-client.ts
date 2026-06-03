/**
 * Bridge client for CLI-to-bridge IPC communication
 * Simple low-level client - connects to Unix socket and sends messages
 *
 * Responsibilities:
 * - Socket connection/disconnection
 * - Sending requests and receiving responses
 * - Message framing (newline-delimited JSON)
 *
 * NOT responsible for:
 * - Bridge process and socket lifecycle (that's bridge-manager's job)
 * - Health checking (that's bridge-manager's job)
 * - Retry/restart logic (that's SessionClient's job)
 */

import { connect, type Socket } from 'net';
import { EventEmitter } from 'events';
import type { IpcMessage, NotificationData, TaskUpdate, X402WalletCredentials } from './types.js';
import { createLogger } from './logger.js';
import { NetworkError, ClientError, ServerError, AuthError } from './errors.js';
import { generateRequestId, sleep } from './utils.js';

const logger = createLogger('bridge-client');

// Timeout for MCP requests (3 minutes as per CLAUDE.md)
const REQUEST_TIMEOUT = 3 * 60 * 1000;

// Timeout for initial socket connection (5 seconds)
const CONNECT_TIMEOUT = 5 * 1000;

// Maximum IPC buffer size (10 MB) — destroy socket if exceeded
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

export class BridgeClient extends EventEmitter {
  private socket: Socket | null = null;
  private socketPath: string;
  private buffer = '';
  private pendingRequests = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timeoutId: NodeJS.Timeout;
    }
  >();

  constructor(socketPath: string) {
    super();
    this.socketPath = socketPath;
  }

  /**
   * Connect to the bridge socket.
   *
   * @param options.retryTimeoutMs - When set, transient failures (ECONNREFUSED /
   *   ENOENT) are retried until this budget elapses. This covers the brief window
   *   right after a bridge is spawned where its socket file may exist but not yet
   *   accept connections — notably a stale socket left behind by a prior bridge
   *   that reused the same PID, which the new bridge removes and recreates during
   *   startup. Callers connecting to an established bridge (per-command requests)
   *   omit it and fail fast.
   *
   * Throws NetworkError if connection fails or times out.
   */
  async connect(options?: { retryTimeoutMs?: number }): Promise<void> {
    if (this.socket) {
      return; // Already connected
    }

    const deadline = options?.retryTimeoutMs ? Date.now() + options.retryTimeoutMs : 0;

    for (;;) {
      try {
        await this.connectOnce();
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const transient = code === 'ECONNREFUSED' || code === 'ENOENT';
        if (deadline > 0 && transient && Date.now() < deadline) {
          logger.debug(`Bridge socket not ready yet (${code}), retrying...`);
          await sleep(75);
          continue;
        }
        // Preserve an already-typed NetworkError (e.g. timeout); wrap raw socket errors.
        if (error instanceof NetworkError) {
          throw error;
        }
        throw new NetworkError(`Failed to connect to bridge: ${(error as Error).message}`);
      }
    }
  }

  /**
   * A single connection attempt. Rejects with the raw socket error (preserving
   * its `.code`) so connect() can decide whether the failure is retryable.
   */
  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      logger.debug(`Connecting to bridge socket: ${this.socketPath}`);

      let settled = false;
      const settle = (fn: () => void): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          fn();
        }
      };

      // Connection timeout
      const timeoutId = setTimeout(() => {
        settle(() => {
          logger.debug(`Socket connection timeout after ${CONNECT_TIMEOUT}ms`);
          if (this.socket) {
            this.socket.destroy();
            this.socket = null;
          }
          reject(new NetworkError(`Connection to bridge timed out`));
        });
      }, CONNECT_TIMEOUT);

      this.socket = connect(this.socketPath);

      this.socket.on('connect', () => {
        settle(() => {
          logger.debug('Connected to bridge socket');
          this.setupSocket();
          resolve();
        });
      });

      this.socket.on('error', (error) => {
        settle(() => {
          logger.debug('Socket connection error:', error.message);
          this.socket = null;
          reject(error);
        });
      });
    });
  }

  /**
   * Set up socket event handlers for ongoing communication
   */
  private setupSocket(): void {
    if (!this.socket) return;

    this.socket.on('data', (data) => {
      this.buffer += data.toString();

      if (this.buffer.length > MAX_BUFFER_SIZE) {
        logger.error(`IPC buffer exceeded ${MAX_BUFFER_SIZE} bytes, destroying socket`);
        this.socket?.destroy();
        this.cleanup();
        return;
      }

      // Process complete JSON messages (newline-delimited)
      let newlineIndex: number;
      while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newlineIndex);
        this.buffer = this.buffer.slice(newlineIndex + 1);

        if (line.trim()) {
          try {
            const message = JSON.parse(line) as IpcMessage;
            this.handleMessage(message);
          } catch (error) {
            logger.error('Failed to parse message:', error);
          }
        }
      }
    });

    this.socket.on('end', () => {
      logger.debug('Socket disconnected');
      this.cleanup();
    });

    this.socket.on('error', (error) => {
      logger.debug('Socket error:', error);
      this.cleanup();
    });
  }

  /**
   * Handle an incoming message from the bridge
   */
  private handleMessage(message: IpcMessage): void {
    logger.debug('Received message:', { type: message.type, id: message.id });

    if (message.type === 'response' && message.id) {
      const pending = this.pendingRequests.get(message.id);

      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          // Convert error code to appropriate error type
          let error: Error;
          switch (message.error.code) {
            case 1:
              error = new ClientError(message.error.message);
              break;
            case 2:
              error = new ServerError(message.error.message);
              break;
            case 3:
              error = new NetworkError(message.error.message);
              break;
            case 4:
              error = new AuthError(message.error.message);
              break;
            default:
              error = new Error(message.error.message);
          }
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
      }
    } else if (message.type === 'task-update' && message.id && message.taskUpdate) {
      // Emit task update keyed by request ID so the right caller gets it
      const update: TaskUpdate = message.taskUpdate;
      logger.debug(`Received task update for request ${message.id}:`, update.status);
      this.emit(`task-update:${message.id}`, update);
    } else if (message.type === 'notification' && message.notification) {
      // Emit notification event
      const notification: NotificationData = message.notification;
      logger.debug('Received notification:', notification.method);
      this.emit('notification', notification);
    }
    // Ignore other message types (health-ok, etc.)
  }

  /**
   * Send a request to the bridge and wait for response
   * Uses 3-minute timeout for MCP operations by default, or custom timeout if provided
   * @param requestId - Optional custom request ID (used for task-update event correlation)
   */
  async request(
    method: string,
    params?: unknown,
    timeout?: number,
    requestId?: string
  ): Promise<unknown> {
    if (!this.socket) {
      throw new NetworkError('Not connected to bridge');
    }

    const id = requestId || generateRequestId();

    const message: IpcMessage = {
      type: 'request',
      id,
      method,
      params,
      ...(timeout !== undefined && { timeout }),
    };

    logger.debug('Sending request:', { id, method });

    // Use custom timeout (in seconds, convert to ms) or default
    const timeoutMs = timeout !== undefined ? timeout * 1000 : REQUEST_TIMEOUT;

    // Create promise for response
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new NetworkError(`Request timeout: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeoutId });
    });

    // Send message
    const data = JSON.stringify(message) + '\n';
    this.socket.write(data);

    return promise;
  }

  /**
   * Send a one-way message (no response expected)
   */
  send(message: IpcMessage): void {
    if (!this.socket) {
      throw new NetworkError('Not connected to bridge');
    }

    logger.debug('Sending message:', { type: message.type });
    const data = JSON.stringify(message) + '\n';
    this.socket.write(data);
  }

  /**
   * Send auth credentials to bridge (one-way, no response expected)
   */
  sendAuthCredentials(credentials: {
    serverUrl: string;
    profileName: string;
    refreshToken?: string;
    accessToken?: string;
    headers?: Record<string, string>;
  }): void {
    this.send({
      type: 'set-auth-credentials',
      authCredentials: credentials,
    });
  }

  /**
   * Send x402 wallet credentials to bridge (one-way, no response expected)
   */
  sendX402Wallet(wallet: X402WalletCredentials): void {
    this.send({
      type: 'set-x402-wallet',
      x402Wallet: wallet,
    });
  }

  /**
   * Close the connection
   */
  close(): Promise<void> {
    logger.debug('Closing bridge client');
    this.cleanup();
    return Promise.resolve();
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new NetworkError('Connection closed'));
      this.pendingRequests.delete(id);
    }

    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }

    this.buffer = '';
  }
}
