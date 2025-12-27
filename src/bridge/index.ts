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
import { loadSessions, updateSession } from '../lib/sessions.js';
import type { AuthCredentials } from '../lib/types.js';
import { OAuthTokenManager } from '../lib/auth/oauth-token-manager.js';
import { join } from 'path';
import packageJson from '../../package.json' with { type: 'json' };

// Keepalive ping interval in milliseconds (30 seconds)
const KEEPALIVE_INTERVAL_MS = 30_000;

const logger = createLogger('bridge');

interface BridgeOptions {
  sessionName: string;
  target: TransportConfig;
  socketPath: string;
  verbose?: boolean;
  profileName?: string; // Auth profile name for token refresh
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
  private keepaliveInterval: NodeJS.Timeout | null = null;

  // OAuth token manager (created when CLI sends auth credentials via IPC)
  private tokenManager: OAuthTokenManager | null = null;

  // HTTP headers (received via IPC, stored in memory only)
  private headers: Record<string, string> | null = null;

  // Promise to track when auth credentials are received (for startup sequencing)
  private authCredentialsReceived: Promise<void> | null = null;
  private authCredentialsResolver: (() => void) | null = null;

  // Promise to track when MCP client is connected (for blocking requests until ready)
  private mcpClientReady: Promise<void>;
  private mcpClientReadyResolver!: () => void;
  private mcpClientReadyRejecter!: (error: Error) => void;

  constructor(options: BridgeOptions) {
    this.options = options;

    // Create promise that resolves when MCP client connects
    this.mcpClientReady = new Promise<void>((resolve, reject) => {
      this.mcpClientReadyResolver = resolve;
      this.mcpClientReadyRejecter = reject;
    });

    if (options.verbose) {
      setVerbose(true);
    }
  }

  /**
   * Set auth credentials received from CLI via IPC
   * Handles both OAuth (with refresh token) and HTTP headers
   */
  setAuthCredentials(credentials: AuthCredentials): void {
    logger.info(`Received auth credentials for profile: ${credentials.profileName}`);

    // Set up OAuth token manager if refresh token and client ID are provided
    if (credentials.refreshToken && credentials.clientId) {
      this.tokenManager = new OAuthTokenManager({
        serverUrl: credentials.serverUrl,
        profileName: credentials.profileName,
        clientId: credentials.clientId,
        refreshToken: credentials.refreshToken,
        // TODO: Should we notify CLI when tokens are rotated?
        // onTokenRefresh: (tokens) => { ... }
      });
      logger.debug('OAuth token manager initialized');
    } else if (credentials.refreshToken && !credentials.clientId) {
      logger.warn('Refresh token provided but client ID is missing - token refresh will not work');
    }

    // Store headers if provided (used when no OAuth refresh token available)
    if (credentials.headers) {
      this.headers = credentials.headers;
      logger.debug(`Stored ${Object.keys(this.headers).length} headers in memory`);
    }

    // Signal that auth credentials have been received (unblocks startup)
    if (this.authCredentialsResolver) {
      this.authCredentialsResolver();
      this.authCredentialsResolver = null;
    }
  }

  /**
   * Get a valid access token, refreshing if necessary,
   * and update transport config with headers
   *
   * Priority:
   * 1. OAuth token manager (uses refresh token to get fresh access token)
   * 2. HTTP headers (static headers from --header flags)
   */
  private async updateTransportAuth(): Promise<TransportConfig> {
    const config = { ...this.options.target };

    // Only update auth for HTTP transport
    if (config.type !== 'http') {
      return config;
    }

    try {
      // Priority 1: Use OAuth token manager if available (can refresh tokens)
      if (this.tokenManager) {
        const token = await this.tokenManager.getValidAccessToken();
        config.headers = {
          ...this.headers, // Include any other headers from --header flags
          ...config.headers,
          Authorization: `Bearer ${token}`, // OAuth token takes priority
        };
        logger.debug('Updated transport config with fresh OAuth access token');
        return config;
      }

      // Priority 2: Use static headers if available
      if (this.headers) {
        config.headers = {
          ...config.headers,
          ...this.headers,
        };
        logger.debug(`Updated transport config with ${Object.keys(this.headers).length} headers`);
        return config;
      }
    } catch (error) {
      logger.error('Failed to get access token:', error);
      // Mark session as expired if token refresh fails
      await this.markSessionExpiredAndExit();
      throw error;
    }

    return config;
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

        logger.debug(
          `Found ${files.length} files in logs directory, cutoff date: ${new Date(sevenDaysAgo).toISOString()}`
        );

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

              logger.debug(
                `File ${file} age: ${ageInDays} days (mtime: ${new Date(fileAge).toISOString()})`
              );

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
    // 1. First, initialize file logger to see what's going on
    await initFileLogger(`bridge-${this.options.sessionName}.log`);

    logger.info(`Bridge process starting for session: ${this.options.sessionName}`);

    // 2. Clean up orphaned log files (runs asynchronously in background)
    this.cleanupOrphanedLogFiles();

    try {
      // 3. Create Unix socket server FIRST (so CLI can send auth credentials)
      await this.createSocketServer();

      // 4. Wait for auth credentials from CLI if auth profile is specified
      // The CLI sends credentials via IPC immediately after detecting the socket file
      if (this.options.profileName) {
        logger.debug(`Waiting for auth credentials (profile: ${this.options.profileName})...`);

        // Create a promise that resolves when credentials are received
        this.authCredentialsReceived = new Promise<void>((resolve) => {
          this.authCredentialsResolver = resolve;
        });

        // Wait with timeout (5 seconds should be plenty for local IPC)
        const timeout = new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('Timeout waiting for auth credentials')), 5000);
        });

        await Promise.race([this.authCredentialsReceived, timeout]);
        logger.debug('Auth credentials received, proceeding with MCP connection');
      }

      // 5. Connect to MCP server (now with auth credentials if provided)
      try {
        await this.connectToMcp();
        // Signal that MCP client is ready (unblocks pending requests)
        this.mcpClientReadyResolver();
      } catch (error) {
        // Signal that MCP connection failed (rejects pending requests)
        this.mcpClientReadyRejecter(error as Error);
        throw error;
      }

      // 6. Start keepalive ping
      this.startKeepalive();

      // 7. Set up signal handlers
      this.setupSignalHandlers();

      logger.info('Bridge process started successfully');
    } catch (error) {
      logger.error('Failed to start bridge:', error);
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Broadcast a notification to all connected clients
   */
  private broadcastNotification(method: string, params?: unknown): void {
    const notification: IpcMessage = {
      type: 'notification',
      notification: {
        method: method as IpcMessage['notification'] extends { method: infer M } ? M : never,
        params,
      },
    };

    const data = JSON.stringify(notification) + '\n';

    for (const socket of this.connections) {
      try {
        socket.write(data);
      } catch (error) {
        logger.error('Failed to send notification to client:', error);
      }
    }
  }

  /**
   * Connect to the MCP server
   */
  private async connectToMcp(): Promise<void> {
    logger.debug('Connecting to MCP server...');

    // Get transport config with fresh auth token if using auth profile
    const transport = await this.updateTransportAuth();

    const clientConfig = {
      clientInfo: { name: 'mcpc', version: packageJson.version },
      transport,
      capabilities: {
        roots: { listChanged: true },
        sampling: {},
      },
      listChanged: {
        tools: {
          autoRefresh: true, // Let SDK handle automatic refresh
          onChanged: () => {
            logger.debug('Tools list changed');
            // Broadcast notification to all connected clients
            this.broadcastNotification('tools/list_changed');
          },
        },
        resources: {
          autoRefresh: true,
          onChanged: () => {
            logger.debug('Resources list changed');
            // Broadcast notification to all connected clients
            this.broadcastNotification('resources/list_changed');
          },
        },
        prompts: {
          autoRefresh: true,
          onChanged: () => {
            logger.debug('Prompts list changed');
            // Broadcast notification to all connected clients
            this.broadcastNotification('prompts/list_changed');
          },
        },
      },
      autoConnect: true,
      verbose: this.options.verbose || false,
    };

    this.client = await createMcpClient(clientConfig);

    logger.info('Connected to MCP server');

    // Update lastSeenAt on successful connection
    await this.updateLastSeenAt();
  }

  /**
   * Start periodic keepalive ping to maintain connection
   */
  private startKeepalive(): void {
    logger.debug(`Starting keepalive ping every ${KEEPALIVE_INTERVAL_MS / 1000}s`);

    this.keepaliveInterval = setInterval(() => {
      this.sendKeepalivePing().catch((error) => {
        logger.error('Keepalive ping failed:', error);
        // If ping fails, the session might be expired - check and handle
        this.handlePossibleExpiration(error as Error);
      });
    }, KEEPALIVE_INTERVAL_MS);

    // Don't block process exit waiting for this interval
    this.keepaliveInterval.unref();
  }

  /**
   * Send a single keepalive ping to the MCP server
   */
  private async sendKeepalivePing(): Promise<void> {
    if (!this.client || this.isShuttingDown) {
      return;
    }

    logger.debug('Sending keepalive ping');
    await this.client.ping();
    logger.debug('Keepalive ping successful');

    // Update lastSeenAt on successful ping
    await this.updateLastSeenAt();
  }

  /**
   * Update lastSeenAt timestamp to track when server was last responsive
   */
  private async updateLastSeenAt(): Promise<void> {
    try {
      await updateSession(this.options.sessionName, {
        lastSeenAt: new Date().toISOString(),
      });
    } catch (error) {
      // Don't fail operations if timestamp update fails
      logger.error('Failed to update lastSeenAt:', error);
    }
  }

  /**
   * Check if an error indicates session expiration and handle accordingly
   */
  private handlePossibleExpiration(error: Error): void {
    // Check for session expiration indicators:
    // - HTTP 404 (session not found)
    // - Specific error messages indicating session is no longer valid
    // TODO: we could use a more robust check for expiration error, this seems flakey - ideally check the real HTTP status code
    const errorMessage = error.message.toLowerCase();
    const isExpired =
      errorMessage.includes('404') ||
      errorMessage.includes('-32000') ||
      errorMessage.includes('not found') ||
      errorMessage.includes('session expired') ||
      errorMessage.includes('invalid session');

    if (isExpired) {
      logger.warn('Session appears to be expired, marking as expired and shutting down');
      this.markSessionExpiredAndExit().catch((e) => {
        logger.error('Failed to mark session as expired:', e);
        process.exit(1);
      });
    }
  }

  /**
   * Mark the session as expired in sessions.json and exit
   */
  private async markSessionExpiredAndExit(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    try {
      await updateSession(this.options.sessionName, { status: 'expired' });
      logger.info(`Session ${this.options.sessionName} marked as expired`);
    } catch (error) {
      logger.error('Failed to update session status:', error);
    }

    // Gracefully shutdown
    await this.shutdown();
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
    let messageId: string | undefined;

    try {
      const message = JSON.parse(data) as IpcMessage;
      messageId = message.id;

      logger.debug('Received message:', { type: message.type, method: message.method });

      // Handle different message types
      switch (message.type) {
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

        case 'set-auth-credentials':
          if (message.authCredentials) {
            this.setAuthCredentials(message.authCredentials);
            if (message.id) {
              this.sendResponse(socket, {
                type: 'response',
                id: message.id,
                result: { success: true },
              });
            }
          } else {
            throw new ClientError('Missing authCredentials in set-auth-credentials message');
          }
          break;

        default:
          throw new ClientError(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      logger.error('Failed to handle message:', error);
      this.sendError(socket, error as Error, messageId);
    }
  }

  /**
   * Forward an MCP request to the MCP server
   * Blocks until MCP client is connected, propagates connection errors to caller
   */
  private async handleMcpRequest(socket: Socket, message: IpcMessage): Promise<void> {
    // Wait for MCP client to be ready (blocks if still connecting, throws if connection failed)
    await this.mcpClientReady;

    if (!this.client) {
      // Should never happen after mcpClientReady resolves, but TypeScript needs this check
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

        case 'listTools': {
          const cursor = message.params as string | undefined;
          result = await this.client.listTools(cursor);
          break;
        }

        case 'callTool': {
          const params = message.params as { name: string; arguments?: Record<string, unknown> };
          result = await this.client.callTool(params.name, params.arguments);
          break;
        }

        case 'listResources': {
          const cursor = message.params as string | undefined;
          result = await this.client.listResources(cursor);
          break;
        }

        case 'readResource': {
          const params = message.params as { uri: string };
          result = await this.client.readResource(params.uri);
          break;
        }

        case 'listResourceTemplates': {
          const cursor = message.params as string | undefined;
          result = await this.client.listResourceTemplates(cursor);
          break;
        }

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

        case 'listPrompts': {
          const cursor = message.params as string | undefined;
          result = await this.client.listPrompts(cursor);
          break;
        }

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

        case 'getServerInfo':
          result = await this.client.getServerInfo();
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
      logger.error('Failed to forward MCP request to server:', error);

      this.sendError(socket, error as Error, message.id);

      // Check if this error indicates session expiration
      this.handlePossibleExpiration(error as Error);
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
    // Stop keepalive ping
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
      logger.debug('Keepalive interval stopped');
    }

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
    console.error('Usage: mcpc-bridge <sessionName> <socketPath> <transportConfigJson> [--verbose] [--profile <name>]');
    process.exit(1);
  }

  const sessionName = args[0] as string;
  const socketPath = args[1] as string;
  const transportConfigJson = args[2] as string;
  const verbose = args.includes('--verbose');

  // Parse --profile argument
  let profileName: string | undefined;
  const profileIndex = args.indexOf('--profile');
  if (profileIndex !== -1 && args[profileIndex + 1]) {
    profileName = args[profileIndex + 1];
  }

  try {
    const target = JSON.parse(transportConfigJson) as TransportConfig;

    const bridgeOptions: BridgeOptions = {
      sessionName,
      target,
      socketPath,
      verbose,
    };
    if (profileName) {
      bridgeOptions.profileName = profileName;
    }

    const bridge = new BridgeProcess(bridgeOptions);

    await bridge.start();
  } catch (error) {
    console.error('Bridge failed to start:', error);
    process.exit(1);
  }
}

// Run main function
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
