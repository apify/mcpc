/**
 * Bridge process lifecycle management
 * Spawns, monitors, and manages bridge processes for persistent MCP sessions
 *
 * Responsibilities:
 * - Start/stop/restart bridge processes
 * - Health checking (is bridge process responding?)
 * - Ensuring bridge is ready before returning to caller
 *
 * NOT responsible for:
 * - MCP protocol details (that's SessionClient's job)
 * - Low-level socket communication (that's BridgeClient's job)
 */

import { spawn, type ChildProcess } from 'child_process';
import { unlink } from 'fs/promises';
import { connect, type Socket } from 'net';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { TransportConfig, IpcMessage, AuthCredentials } from './types.js';
import { getBridgesDir, waitForFile, isProcessAlive, fileExists } from './utils.js';
import { updateSession, getSession } from './sessions.js';
import { createLogger } from './logger.js';
import { ClientError } from './errors.js';
import { BridgeClient } from './bridge-client.js';
import { readKeychainOAuthTokenInfo, readKeychainOAuthClientInfo, readKeychainSessionHeaders } from './auth/keychain.js';
import { getAuthProfile } from './auth/auth-profiles.js';

const logger = createLogger('bridge-manager');

// Timeout for health check - covers connect + response (3 seconds)
const HEALTH_CHECK_TIMEOUT = 3 * 1000;

// Get the path to the bridge executable
function getBridgeExecutable(): string {
  // In development, use the compiled bridge in dist/
  // In production, it will be in node_modules/.bin/mcpc-bridge
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Assuming we're in dist/lib/, bridge is in dist/bridge/
  return join(__dirname, '..', 'bridge', 'index.js');
}

export interface StartBridgeOptions {
  sessionName: string;
  target: TransportConfig;
  verbose?: boolean;
  profileName?: string; // Auth profile name for token refresh
  headers?: Record<string, string>; // Headers to send via IPC (caller stores in keychain)
}

export interface StartBridgeResult {
  pid: number;
  socketPath: string;
}

/**
 * Start a bridge process for a session
 * Spawns the bridge process and sends auth credentials via IPC
 *
 * SECURITY: All headers are treated as potentially sensitive:
 * 1. Caller stores headers in OS keychain before calling this function
 * 2. Headers are sent to bridge via IPC after startup
 * 3. Never exposed in process listings
 *
 * NOTE: This function does NOT manage session storage. The caller is responsible for:
 * - Creating the session record before calling startBridge()
 * - Updating the session with pid/socketPath after startBridge() returns
 *
 * @returns Bridge process PID and socket path
 */
export async function startBridge(options: StartBridgeOptions): Promise<StartBridgeResult> {
  const { sessionName, target, verbose, profileName, headers } = options;

  logger.debug(`Launching bridge for session: ${sessionName}`);

  // Get socket path
  const socketPath = join(getBridgesDir(), `${sessionName}.sock`);

  // Remove existing socket file if it exists
  // We MUST do it here, so waitForFile() below doesn't pick the old file!
  // Plus, if it fails, the user will see the error
  if (await fileExists(socketPath)) {
    logger.debug(`Removing existing socket: ${socketPath}`);
    await unlink(socketPath);
  }

  // Create a sanitized transport config without any headers
  // Headers will be sent to the bridge via IPC instead
  const sanitizedTarget: TransportConfig = { ...target };
  if (sanitizedTarget.type === 'http') {
    delete sanitizedTarget.headers;
  }

  // Prepare bridge arguments (with sanitized config - no headers)
  const bridgeExecutable = getBridgeExecutable();
  const targetJson = JSON.stringify(sanitizedTarget);
  const args = [sessionName, socketPath, targetJson];

  if (verbose) {
    args.push('--verbose');
  }

  // Pass auth profile to bridge
  // Use dummy placeholder also when headers are provided (no OAuth profile),
  // so the bridge process waits for headers before connecting to server
  if (profileName) {
    args.push('--profile', profileName);
  } else if (headers && Object.keys(headers).length > 0) {
    args.push('--profile', 'dummy');
  }

  logger.debug('Bridge executable:', bridgeExecutable);
  logger.debug('Bridge args:', args);

  // Spawn bridge process
  const bridgeProcess: ChildProcess = spawn('node', [bridgeExecutable, ...args], {
    detached: true,
    stdio: 'ignore', // Don't inherit stdio (run in background)
  });

  // Allow the bridge to run independently
  bridgeProcess.unref();

  logger.debug(`Bridge process spawned with PID: ${bridgeProcess.pid}`);

  if (!bridgeProcess.pid) {
    throw new ClientError('Failed to spawn bridge process: no PID');
  }

  const pid = bridgeProcess.pid;

  // Wait for socket file to be created (with timeout)
  try {
    await waitForFile(socketPath, { timeoutMs: 5000 });
  } catch {
    // Kill the process if socket wasn't created
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Ignore errors killing process
    }
    throw new ClientError(
      `Bridge failed to start: socket file not created within timeout. Check bridge logs.`
    );
  }

  // Send auth credentials to bridge via IPC (secure, not via command line)
  // This handles both OAuth profiles (refresh token) and HTTP headers
  if (profileName || headers) {
    await sendAuthCredentialsToBridge(
      socketPath,
      target.url || target.command || '',
      profileName,
      headers
    );
  }

  logger.debug(`Bridge started successfully for session: ${sessionName}`);

  return { pid, socketPath };
}

/**
 * Stop a bridge process (does NOT delete session or headers)
 * Use closeSession() for full session cleanup
 */
export async function stopBridge(sessionName: string): Promise<void> {
  logger.info(`Stopping bridge for session: ${sessionName}`);

  const session = await getSession(sessionName);

  if (!session) {
    throw new ClientError(`Session not found: ${sessionName}`);
  }

  // Kill the bridge process if it's still running
  if (session.pid && isProcessAlive(session.pid)) {
    try {
      logger.debug(`Killing bridge process: ${session.pid}`);
      process.kill(session.pid, 'SIGTERM');

      // Wait a bit for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Force kill if still alive
      if (isProcessAlive(session.pid)) {
        logger.debug('Bridge did not exit gracefully, sending SIGKILL');
        process.kill(session.pid, 'SIGKILL');
      }
    } catch (error) {
      logger.warn('Error killing bridge process:', error);
    }
  }

  // Note: Session record and headers are NOT deleted here.
  // They are preserved for failover scenarios (bridge restart).
  // Full cleanup happens in closeSession().

  logger.info(`Bridge stopped for session: ${sessionName}`);
}

/**
 * Restart a bridge process for a session
 * Used for automatic recovery when connection to bridge fails
 *
 * Headers persist in keychain across bridge restarts, so they are
 * retrieved here and passed to startBridge() which sends them via IPC.
 */
export async function restartBridge(sessionName: string): Promise<StartBridgeResult> {
  logger.warn(`Restarting bridge for session ${sessionName}...`);

  const session = await getSession(sessionName);

  if (!session) {
    throw new ClientError(`Session not found: ${sessionName}`);
  }

  // Stop the old bridge (cleanup)
  try {
    await stopBridge(sessionName);
  } catch {
    // Ignore errors, we're restarting anyway
  }

  // Determine target from session data
  const target: TransportConfig = {
    type: session.transport === 'http' ? 'http' : 'stdio',
    url: session.target,
  };

  // Retrieve transport headers from keychain for failover, and check their number
  let headers: Record<string, string> | undefined;
  if (session.transport === 'http' && session.headerCount && session.headerCount > 0) {
    headers = await readKeychainSessionHeaders(sessionName);
    const retrievedCount = Object.keys(headers || {}).length;
    if (retrievedCount !== session.headerCount) {
      throw new ClientError(
        `Failed to retrieve ${session.headerCount} HTTP header(s) from keychain for session ${sessionName}. ` +
          `The session may need to be recreated with "mcpc ${sessionName} close" followed by a new connect.`
      );
    }
    logger.debug(`Retrieved ${retrievedCount} headers from keychain for failover`);
  }

  // Start a new bridge, preserving auth profile
  const bridgeOptions: StartBridgeOptions = {
    sessionName,
    target,
  };
  if (headers) {
    bridgeOptions.headers = headers;
  }
  if (session.profileName) {
    bridgeOptions.profileName = session.profileName;
  }

  const { pid, socketPath } = await startBridge(bridgeOptions);

  // Update session with new PID and socket path
  await updateSession(sessionName, {
    pid,
    socketPath,
  });

  logger.info(`Bridge restarted for session ${sessionName} with PID: ${pid}`);

  return { pid, socketPath };
}

/**
 * Send auth credentials to a bridge process via IPC
 * Handles both OAuth profiles (refresh token) and HTTP headers
 *
 * @param socketPath - Path to bridge's Unix socket
 * @param serverUrl - Server URL for the session
 * @param profileName - Optional OAuth profile name
 * @param headers - Optional HTTP headers (from --header flags)
 */
async function sendAuthCredentialsToBridge(
  socketPath: string,
  serverUrl: string,
  profileName?: string,
  headers?: Record<string, string>
): Promise<void> {
  // Build credentials object
  const credentials: AuthCredentials = {
    serverUrl,
    // TODO: do we need this dummy hack for anything? I don't think so...
    profileName: profileName || 'dummy', // Use 'dummy' as placeholder for headers-only auth
  };

  // Try to get OAuth tokens and client info if profile is specified
  if (profileName) {
    logger.debug(`Looking up auth profile ${profileName} for ${serverUrl}`);

    const profile = await getAuthProfile(serverUrl, profileName);
    if (profile) {
      // Load tokens from keychain
      const tokens = await readKeychainOAuthTokenInfo(profile.serverUrl, profileName);
      if (tokens?.refreshToken) {
        credentials.refreshToken = tokens.refreshToken;
        credentials.serverUrl = profile.serverUrl;
        logger.debug(`Found OAuth refresh token for profile ${profileName}`);
      }

      // Load client info from keychain (needed for token refresh)
      const clientInfo = await readKeychainOAuthClientInfo(profile.serverUrl, profileName);
      if (clientInfo?.clientId) {
        credentials.clientId = clientInfo.clientId;
        logger.debug(`Found OAuth client ID for profile ${profileName}`);
      }
    }
  }

  // Add headers if provided
  if (headers) {
    credentials.headers = headers;
    logger.debug(`Including ${Object.keys(headers).length} headers in credentials`);
  }

  // Only send if we have some credentials
  if (!credentials.refreshToken && !credentials.headers) {
    logger.debug('No auth credentials to send to bridge');
    return;
  }

  // Connect to bridge and send credentials
  const client = new BridgeClient(socketPath);
  try {
    await client.connect();
    client.sendAuthCredentials(credentials);
    logger.debug('Auth credentials sent to bridge successfully');
  } finally {
    await client.close();
  }
}

/**
 * Check if bridge process responds to health-check message
 * Uses a simple socket connection without BridgeClient to avoid complexity
 * TODO: Not using BridgeClient() actually increases complexity and duplicates code
 *
 * @param socketPath - Path to bridge's Unix socket
 * @returns true if bridge responds to health-check, false otherwise
 */
async function testBridgeSocketHealth(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let socket: Socket | null = null;
    let settled = false;
    let buffer = '';

    const settle = (result: boolean): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        if (socket) {
          socket.destroy();
          socket = null;
        }
        resolve(result);
      }
    };

    // Single timeout for entire health check (connect + response)
    const timeout = setTimeout(() => {
      logger.debug('Health check: timeout');
      settle(false);
    }, HEALTH_CHECK_TIMEOUT);

    try {
      socket = connect(socketPath);

      socket.on('connect', () => {
        // Send health check immediately on connect
        const message: IpcMessage = { type: 'health-check' };
        socket?.write(JSON.stringify(message) + '\n');
      });

      socket.on('data', (data) => {
        buffer += data.toString();

        // Look for health-ok response
        for (const line of buffer.split('\n')) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line) as IpcMessage;
            if (message.type === 'health-ok') {
              logger.debug('Health check: bridge is healthy');
              settle(true);
              return;
            }
          } catch {
            // Ignore parse errors
          }
        }
      });

      socket.on('error', () => settle(false));
      socket.on('close', () => settle(false));
    } catch {
      settle(false);
    }
  });
}

/**
 * Ensure bridge is ready for use
 * Checks health and restarts if necessary
 *
 * This is the main entry point for ensuring a session's bridge is usable.
 * After this returns successfully, the bridge is guaranteed to be responding.
 *
 * @param sessionName - Name of the session
 * @returns The socket path of the healthy bridge
 * @throws ClientError if bridge cannot be made healthy
 */
export async function ensureBridgeReady(sessionName: string): Promise<string> {
  const session = await getSession(sessionName);

  if (!session) {
    throw new ClientError(`Session not found: ${sessionName}`);
  }

  if (session.status === 'expired') {
    throw new ClientError(
      `Session ${sessionName} has expired. ` +
      `The MCP server indicated the session is no longer valid.\n` +
      `To reconnect, run: mcpc ${sessionName} connect\n` +
      `To remove the expired session, run: mcpc ${sessionName} close`
    );
  }

  if (!session.socketPath) {
    throw new ClientError(`Session ${sessionName} has no socket path`);
  }

  // Quick check: is the process alive?
  const processAlive = session.pid ? isProcessAlive(session.pid) : false;

  if (processAlive) {
    // Process alive, check if it responds to health check
    const isHealthy = await testBridgeSocketHealth(session.socketPath);
    if (isHealthy) {
      logger.debug(`Bridge for ${sessionName} is healthy`);
      return session.socketPath;
    }
    logger.warn(`Bridge process alive but not responding for ${sessionName}`);
  } else {
    logger.warn(`Bridge process not alive for ${sessionName}`);
  }

  // Bridge not healthy - restart it
  logger.info(`Restarting bridge for ${sessionName}...`);
  const { socketPath: freshSocketPath, pid } = await restartBridge(sessionName);

  // Wait for bridge to become responsive
  // Bridge only responds to health-check when fully ready (MCP connected)
  const MAX_READY_ATTEMPTS = 10;
  const READY_RETRY_DELAY = 500; // ms

  for (let attempt = 1; attempt <= MAX_READY_ATTEMPTS; attempt++) {
    // Check if bridge process is still alive
    if (!isProcessAlive(pid)) {
      // Bridge died - likely MCP connection failed (auth error, network error, etc.)
      // Check logs for details
      throw new ClientError(
        `Bridge for ${sessionName} exited unexpectedly. ` +
        `Check logs at ~/.mcpc/logs/bridge-${sessionName}.log for details. ` +
        `Common causes: expired auth token, invalid credentials, server unreachable.`
      );
    }

    const isHealthy = await testBridgeSocketHealth(freshSocketPath);
    if (isHealthy) {
      logger.info(`Bridge for ${sessionName} is now ready`);
      return freshSocketPath;
    }
    if (attempt < MAX_READY_ATTEMPTS) {
      logger.debug(`Bridge not ready yet, waiting... (${attempt}/${MAX_READY_ATTEMPTS})`);
      await new Promise(resolve => setTimeout(resolve, READY_RETRY_DELAY));
    }
  }

  throw new ClientError(`Bridge for ${sessionName} not responding after restart`);
}
