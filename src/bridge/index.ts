#!/usr/bin/env node
/**
 * Bridge process for maintaining persistent MCP connections
 * This executable is spawned by the CLI and maintains a long-running connection to an MCP server
 * It communicates with the CLI via Unix domain sockets
 */

import { createServer, type Server as NetServer, type Socket } from 'net';
import { unlink } from 'fs/promises';
import { createMcpClient } from '../core/index.js';
import type { McpClient } from '../core/index.js';
import type { TransportConfig, IpcMessage } from '../lib/index.js';
import { createLogger, setVerbose } from '../lib/index.js';
import { fileExists, getBridgesDir, ensureDir } from '../lib/index.js';
import { ClientError, NetworkError } from '../lib/index.js';

const logger = createLogger('bridge');

interface BridgeOptions {
  sessionName: string;
  target: TransportConfig;
  socketPath: string;
  verbose?: boolean;
}

/**
 * Bridge process class
 * Manages MCP connection and Unix socket server
 */
class BridgeProcess {
  private client: McpClient | null = null;
  private server: NetServer | null = null;
  private connections: Set<Socket> = new Set();
  private options: BridgeOptions;
  private isShuttingDown = false;

  constructor(options: BridgeOptions) {
    this.options = options;

    if (options.verbose) {
      setVerbose(true);
    }
  }

  /**
   * Start the bridge process
   */
  async start(): Promise<void> {
    logger.info(`Starting bridge for session: ${this.options.sessionName}`);

    try {
      // 1. Connect to MCP server
      await this.connectToMcp();

      // 2. Create Unix socket server
      await this.createSocketServer();

      // 3. Set up signal handlers
      this.setupSignalHandlers();

      logger.info('Bridge process started successfully');
    } catch (error) {
      logger.error('Failed to start bridge:', error);
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Connect to the MCP server
   */
  private async connectToMcp(): Promise<void> {
    logger.debug('Connecting to MCP server...');

    const clientConfig = {
      clientInfo: { name: 'mcpc-bridge', version: '0.1.0' },
      transport: this.options.target,
      capabilities: {
        roots: { listChanged: true },
        sampling: {},
      },
      autoConnect: true,
      verbose: this.options.verbose || false,
    };

    this.client = await createMcpClient(clientConfig);

    logger.info('Connected to MCP server');
  }

  /**
   * Create Unix domain socket server for IPC
   */
  private async createSocketServer(): Promise<void> {
    const { socketPath } = this.options;

    // Ensure bridges directory exists
    await ensureDir(getBridgesDir());

    // Remove existing socket file if it exists
    if (await fileExists(socketPath)) {
      logger.debug(`Removing existing socket: ${socketPath}`);
      await unlink(socketPath);
    }

    // Create server
    this.server = createServer((socket) => this.handleConnection(socket));

    // Listen on Unix socket
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(socketPath, () => {
        logger.info(`Socket server listening: ${socketPath}`);
        resolve();
      });

      this.server!.on('error', (error) => {
        logger.error('Socket server error:', error);
        reject(error);
      });
    });
  }

  /**
   * Handle a new client connection
   */
  private handleConnection(socket: Socket): void {
    logger.debug('New client connected');
    this.connections.add(socket);

    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      // Process complete JSON messages (newline-delimited)
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.trim()) {
          this.handleMessage(socket, line).catch((error) => {
            logger.error('Error handling message:', error);
          });
        }
      }
    });

    socket.on('end', () => {
      logger.debug('Client disconnected');
      this.connections.delete(socket);
    });

    socket.on('error', (error) => {
      logger.error('Socket error:', error);
      this.connections.delete(socket);
    });
  }

  /**
   * Handle an IPC message from the CLI
   */
  private async handleMessage(socket: Socket, data: string): Promise<void> {
    try {
      const message = JSON.parse(data) as IpcMessage;

      logger.debug('Received message:', { type: message.type, method: message.method });

      // Handle different message types
      switch (message.type) {
        case 'health-check':
          this.sendResponse(socket, { type: 'health-ok' });
          break;

        case 'request':
          await this.handleMcpRequest(socket, message);
          break;

        case 'shutdown':
          logger.info('Received shutdown request');
          if (message.id) {
            this.sendResponse(socket, { type: 'response', id: message.id });
          }
          await this.shutdown();
          break;

        default:
          throw new ClientError(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      logger.error('Failed to handle message:', error);
      this.sendError(socket, error as Error);
    }
  }

  /**
   * Forward an MCP request to the server
   */
  private async handleMcpRequest(socket: Socket, message: IpcMessage): Promise<void> {
    if (!this.client) {
      throw new NetworkError('MCP client not connected');
    }

    if (!message.method) {
      throw new ClientError('Missing method in request');
    }

    try {
      let result: unknown;

      // Route to appropriate client method
      switch (message.method) {
        case 'ping':
          result = await this.client.ping();
          break;

        case 'listTools':
          result = await this.client.listTools(message.params as string | undefined);
          break;

        case 'callTool': {
          const params = message.params as { name: string; arguments?: Record<string, unknown> };
          result = await this.client.callTool(params.name, params.arguments);
          break;
        }

        case 'listResources':
          result = await this.client.listResources(message.params as string | undefined);
          break;

        case 'readResource': {
          const params = message.params as { uri: string };
          result = await this.client.readResource(params.uri);
          break;
        }

        case 'listResourceTemplates':
          result = await this.client.listResourceTemplates(message.params as string | undefined);
          break;

        case 'subscribeResource': {
          const params = message.params as { uri: string };
          result = await this.client.subscribeResource(params.uri);
          break;
        }

        case 'unsubscribeResource': {
          const params = message.params as { uri: string };
          result = await this.client.unsubscribeResource(params.uri);
          break;
        }

        case 'listPrompts':
          result = await this.client.listPrompts(message.params as string | undefined);
          break;

        case 'getPrompt': {
          const params = message.params as { name: string; arguments?: Record<string, string> };
          result = await this.client.getPrompt(params.name, params.arguments);
          break;
        }

        case 'setLoggingLevel': {
          const params = message.params as string;
          result = await this.client.setLoggingLevel(params as any);
          break;
        }

        case 'getServerCapabilities':
          result = await this.client.getServerCapabilities();
          break;

        case 'getServerVersion':
          result = await this.client.getServerVersion();
          break;

        case 'getInstructions':
          result = await this.client.getInstructions();
          break;

        case 'getProtocolVersion':
          result = await this.client.getProtocolVersion();
          break;

        default:
          throw new ClientError(`Unknown MCP method: ${message.method}`);
      }

      if (message.id) {
        this.sendResponse(socket, {
          type: 'response',
          id: message.id,
          result,
        });
      }
    } catch (error) {
      this.sendError(socket, error as Error, message.id);
    }
  }

  /**
   * Send a response message to the CLI
   */
  private sendResponse(socket: Socket, message: IpcMessage): void {
    const data = JSON.stringify(message) + '\n';
    socket.write(data);
  }

  /**
   * Send an error response to the CLI
   */
  private sendError(socket: Socket, error: Error, id?: string): void {
    const message: IpcMessage = {
      type: 'response',
      error: {
        code: error instanceof ClientError ? 1 : error instanceof NetworkError ? 3 : 2,
        message: error.message,
      },
    };

    if (id) {
      message.id = id;
    }

    this.sendResponse(socket, message);
  }

  /**
   * Set up signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const handleSignal = (signal: string) => {
      logger.info(`Received ${signal}, shutting down...`);
      this.shutdown().catch((error) => {
        logger.error('Error during shutdown:', error);
        process.exit(1);
      });
    };

    process.on('SIGTERM', () => handleSignal('SIGTERM'));
    process.on('SIGINT', () => handleSignal('SIGINT'));
  }

  /**
   * Gracefully shutdown the bridge
   */
  private async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    logger.info('Shutting down bridge...');

    await this.cleanup();

    process.exit(0);
  }

  /**
   * Clean up resources
   */
  private async cleanup(): Promise<void> {
    // Close all client connections
    for (const socket of this.connections) {
      socket.end();
    }
    this.connections.clear();

    // Close socket server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          logger.debug('Socket server closed');
          resolve();
        });
      });

      // Remove socket file
      try {
        if (await fileExists(this.options.socketPath)) {
          await unlink(this.options.socketPath);
          logger.debug('Socket file removed');
        }
      } catch (error) {
        logger.warn('Failed to remove socket file:', error);
      }
    }

    // Close MCP client
    if (this.client) {
      try {
        await this.client.close();
        logger.debug('MCP client closed');
      } catch (error) {
        logger.warn('Failed to close MCP client:', error);
      }
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.error('Usage: mcpc-bridge <sessionName> <socketPath> <transportConfigJson> [--verbose]');
    process.exit(1);
  }

  const sessionName = args[0]!;
  const socketPath = args[1]!;
  const transportConfigJson = args[2]!;
  const verbose = args.includes('--verbose');

  try {
    const target = JSON.parse(transportConfigJson) as TransportConfig;

    const bridge = new BridgeProcess({
      sessionName,
      target,
      socketPath,
      verbose,
    });

    await bridge.start();
  } catch (error) {
    console.error('Bridge failed to start:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
