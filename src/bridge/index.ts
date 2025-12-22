#!/usr/bin/env node
/**
 * Bridge process for maintaining persistent MCP connections
 * This executable is spawned by the CLI and maintains a long-running connection to an MCP server
 * It communicates with the CLI via Unix domain sockets
 */

import { createServer, type Server as NetServer, type Socket } from 'net';
import { unlink, readdir, stat } from 'fs/promises';
import { createMcpClient } from '../core/index.js';
import type { McpClient } from '../core/index.js';
import type { TransportConfig, IpcMessage, LoggingLevel } from '../lib/index.js';
import { createLogger, setVerbose, initFileLogger, closeFileLogger } from '../lib/index.js';
import { fileExists, getBridgesDir, ensureDir, getLogsDir } from '../lib/index.js';
import { ClientError, NetworkError } from '../lib/index.js';
import { loadSessions } from '../lib/sessions.js';
import { join } from 'path';

const logger = createLogger('bridge');

interface BridgeOptions {
  sessionName: string;
  target: TransportConfig;
  socketPath: string;
  verbose?: boolean;
}

/**
 * Bridge process class
 * Manages MCP connection and Unix socket server for a single session
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
   * Clean up log files for sessions that no longer exist
   * This prevents unlimited growth of log files over time
   * Only deletes files older than 7 days
   * Runs asynchronously without blocking bridge startup
   */
  private cleanupOrphanedLogFiles(): void {
    // Run cleanup asynchronously without blocking startup
    void (async () => {
      try {
        logger.debug('Starting cleanup of orphaned log files');

        // Load active sessions using existing function (with lock)
        const sessionsStorage = await loadSessions();
        const activeSessions = sessionsStorage.sessions;

        // List all bridge log files
        const logsDir = getLogsDir();
        await ensureDir(logsDir);

        const files = await readdir(logsDir);

        // Find all bridge log files (including rotated ones)
        // Matches: bridge-<session>.log, bridge-<session>.log.1, bridge-<session>.log.2, etc.
        const bridgeLogPattern = /^bridge-(@.+?)\.log(?:\.\d+)?$/;

        // Calculate the cutoff date (7 days ago)
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

        logger.debug(`Found ${files.length} files in logs directory, cutoff date: ${new Date(sevenDaysAgo).toISOString()}`);

        for (const file of files) {
          const match = file.match(bridgeLogPattern);
          if (!match || !match[1]) continue;

          const sessionName = match[1];

          logger.debug(`Checking log file: ${file} (session: ${sessionName})`);

          // Skip the current session's log files
          if (sessionName === this.options.sessionName) {
            logger.debug(`Skipping current session's log file: ${file}`);
            continue;
          }

          // Check if session still exists
          if (!activeSessions[sessionName]) {
            const filePath = join(logsDir, file);

            // Check file modification time
            try {
              const fileStats = await stat(filePath);
              const fileAge = fileStats.mtime.getTime();
              const ageInDays = Math.floor((Date.now() - fileAge) / (24 * 60 * 60 * 1000));

              logger.debug(`File ${file} age: ${ageInDays} days (mtime: ${new Date(fileAge).toISOString()})`);

              // Only delete if older than 7 days
              if (fileAge < sevenDaysAgo) {
                await unlink(filePath);
                logger.debug(`Cleaned up orphaned log file: ${file} (age: ${ageInDays} days)`);
              } else {
                logger.debug(`Keeping recent orphaned log file: ${file} (age: ${ageInDays} days)`);
              }
            } catch (error) {
              // If stat fails, skip this file
              logger.debug(`Failed to stat log file ${file}:`, error);
            }
          } else {
            logger.debug(`Session ${sessionName} still exists, keeping log file: ${file}`);
          }
        }

        logger.debug('Finished cleanup of orphaned log files');
      } catch (error) {
        // Don't fail startup if cleanup fails
        logger.warn('Failed to clean up orphaned log files:', error);
      }
    })();
  }

  /**
   * Start the bridge process for a specific session.
   */
  async start(): Promise<void> {
    logger.info(`Starting bridge for session: ${this.options.sessionName}`);

    // 1. Clean up orphaned log files (runs asynchronously in background)
    this.cleanupOrphanedLogFiles();

    // 2. Initialize file logger
    await initFileLogger(`bridge-${this.options.sessionName}.log`, this.options.sessionName);

    try {
      // 3. Connect to MCP server
      await this.connectToMcp();

      // 4. Create Unix socket server
      await this.createSocketServer();

      // 5. Set up signal handlers
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
    const server = createServer((socket) => this.handleConnection(socket));
    this.server = server;

    // Listen on Unix socket
    await new Promise<void>((resolve, reject) => {
      server.listen(socketPath, () => {
        logger.info(`Socket server listening: ${socketPath}`);
        resolve();
      });

      server.on('error', (error) => {
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
   * Forward an MCP request to the MCP server
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
          const params = message.params as LoggingLevel;
          result = await this.client.setLoggingLevel(params);
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
    const handleSignal = (signal: string): void => {
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
      const server = this.server;
      await new Promise<void>((resolve) => {
        server.close(() => {
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

    // Close file logger
    try {
      await closeFileLogger();
      logger.debug('File logger closed');
    } catch (error) {
      logger.warn('Failed to close file logger:', error);
    }
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Parse command line arguments
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.error('Usage: mcpc-bridge <sessionName> <socketPath> <transportConfigJson> [--verbose]');
    process.exit(1);
  }

  const sessionName = args[0] as string;
  const socketPath = args[1] as string;
  const transportConfigJson = args[2] as string;
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
