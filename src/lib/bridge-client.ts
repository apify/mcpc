/**
 * Bridge client for CLI-to-bridge IPC communication
 * Connects to bridge via Unix domain socket and sends MCP requests
 */

import { connect, type Socket } from 'net';
import { EventEmitter } from 'events';
import type { IpcMessage, NotificationData } from './types.js';
import { createLogger } from './logger.js';
import { NetworkError } from './errors.js';
import { generateRequestId } from './utils.js';

const logger = createLogger('bridge-client');

// Timeout for bridge requests (3 minutes as per CLAUDE.md)
const REQUEST_TIMEOUT = 3 * 60 * 1000;

export class BridgeClient extends EventEmitter {
  private socket: Socket | null = null;
  private socketPath: string;
  private pendingRequests = new Map<string, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timeoutId: NodeJS.Timeout;
  }>();

  constructor(socketPath: string) {
    super();
    this.socketPath = socketPath;
  }

  /**
   * Connect to the bridge socket
   */
  async connect(): Promise<void> {
    if (this.socket) {
      return; // Already connected
    }

    return new Promise<void>((resolve, reject) => {
      logger.debug(`Connecting to bridge socket: ${this.socketPath}`);

      this.socket = connect(this.socketPath);

      this.socket.on('connect', () => {
        logger.debug('Connected to bridge');
        this.setupSocket();
        resolve();
      });

      this.socket.on('error', (error) => {
        logger.error('Socket connection error:', error);
        reject(new NetworkError(`Failed to connect to bridge: ${error.message}`));
      });
    });
  }

  /**
   * Set up socket event handlers
   */
  private setupSocket(): void {
    if (!this.socket) return;

    let buffer = '';

    this.socket.on('data', (data) => {
      buffer += data.toString();

      // Process complete JSON messages (newline-delimited)
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.trim()) {
          try {
            const message = JSON.parse(line) as IpcMessage;
            this.handleResponse(message);
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
      logger.error('Socket error:', error);
      this.cleanup();
    });
  }

  /**
   * Handle a response message from the bridge
   */
  private handleResponse(message: IpcMessage): void {
    logger.debug('Received message:', { type: message.type, id: message.id });

    if (message.type === 'response' && message.id) {
      const pending = this.pendingRequests.get(message.id);

      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          const error = new Error(message.error.message) as Error & { code: number };
          error.code = message.error.code;
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
      }
    } else if (message.type === 'notification' && message.notification) {
      // Emit notification event
      const notification: NotificationData = message.notification;
      logger.debug('Received notification:', notification.method);
      this.emit('notification', notification);
    }
  }

  /**
   * Send a request to the bridge and wait for response
   */
  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.socket) {
      throw new NetworkError('Not connected to bridge');
    }

    const id = generateRequestId();

    const message: IpcMessage = {
      type: 'request',
      id,
      method,
      params,
    };

    logger.debug('Sending request:', { id, method });

    // Create promise for response
    const promise = new Promise<unknown>((resolve, reject) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new NetworkError(`Request timeout: ${method}`));
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set(id, { resolve, reject, timeoutId });
    });

    // Send message
    const data = JSON.stringify(message) + '\n';
    this.socket.write(data);

    return promise;
  }

  /**
   * Check if bridge is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.socket) {
        await this.connect();
      }

      // After connect(), socket should be set
      const socket = this.socket;
      if (!socket) {
        return false;
      }

      const message: IpcMessage = {
        type: 'health-check',
      };

      const data = JSON.stringify(message) + '\n';
      socket.write(data);

      // Wait for health-ok response with timeout
      return new Promise<boolean>((resolve) => {
        const timeoutId = setTimeout(() => resolve(false), 1000);

        const handler = (data: Buffer): void => {
          const response = JSON.parse(data.toString()) as IpcMessage;
          if (response.type === 'health-ok') {
            clearTimeout(timeoutId);
            socket.off('data', handler);
            resolve(true);
          }
        };

        socket.on('data', handler);
      });
    } catch {
      return false;
    }
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    logger.debug('Closing bridge client');

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new NetworkError('Connection closed'));
      this.pendingRequests.delete(id);
    }

    if (this.socket) {
      // Do not wait for socket to close
      this.socket.end();
      this.socket = null;
    }

    return Promise.resolve();
  }

  /**
   * Clean up on disconnect
   */
  private cleanup(): void {
    this.socket = null;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new NetworkError('Connection lost'));
      this.pendingRequests.delete(id);
    }
  }
}

/**
 * Helper function to execute a request with a bridge
 */
export async function withBridgeClient<T>(
  socketPath: string,
  callback: (client: BridgeClient) => Promise<T>
): Promise<T> {
  const client = new BridgeClient(socketPath);

  try {
    await client.connect();
    return await callback(client);
  } finally {
    await client.close();
  }
}
