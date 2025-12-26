/**
 * Bridge process lifecycle management
 * Spawns, monitors, and manages bridge processes for persistent MCP sessions
 */

import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import type { TransportConfig } from './types.js';
import { getBridgesDir, waitForFile, isProcessAlive, fileExists } from './utils.js';
import { updateSession } from './sessions.js';
import { createLogger } from './logger.js';
import { ClientError } from './errors.js';
import { BridgeClient } from './bridge-client.js';
import { readKeychainOAuthTokenInfo, readKeychainSessionHeaders } from './auth/keychain.js';
import { getAuthProfile } from './auth/auth-profiles.js';

const logger = createLogger('bridge-manager');

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

  // Pass auth profile if specified
  if (profileName) {
    args.push('--profile', profileName);
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

  const { getSession } = await import('./sessions.js');
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
 * Check if a bridge is healthy
 * Returns true if the process is alive and socket exists
 */
export async function isBridgeHealthy(sessionName: string): Promise<boolean> {
  const { getSession } = await import('./sessions.js');
  const session = await getSession(sessionName);

  if (!session) {
    return false;
  }

  // Check if process is alive
  if (session.pid && !isProcessAlive(session.pid)) {
    logger.warn(`Bridge process ${session.pid} is not alive`);
    return false;
  }

  // Check if socket exists
  if (session.socketPath && !(await fileExists(session.socketPath))) {
    logger.warn(`Bridge socket ${session.socketPath} does not exist`);
    return false;
  }

  // TODO: Send ping message and check the bridge responds

  return true;
}

/**
 * Restart a bridge if it's unhealthy
 * Used for automatic recovery (failover)
 *
 * Headers persist in keychain across bridge restarts, so they are
 * retrieved here and passed to startBridge() which sends them via IPC.
 */
export async function ensureBridgeHealthy(sessionName: string): Promise<void> {
  const healthy = await isBridgeHealthy(sessionName);

  if (!healthy) {
    logger.warn(`Bridge for session ${sessionName} is unhealthy, restarting...`);

    const { getSession } = await import('./sessions.js');
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

    logger.debug(`Session ${sessionName} updated with new bridge PID: ${pid}`);
  }
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
  const credentials: {
    serverUrl: string;
    profileName: string;
    refreshToken?: string;
    headers?: Record<string, string>;
  } = {
    serverUrl,
    profileName: profileName || 'headers', // Use 'headers' as placeholder for headers-only auth
  };

  // Try to get OAuth refresh token if profile is specified
  if (profileName) {
    logger.debug(`Looking up auth profile ${profileName} for ${serverUrl}`);

    const profile = await getAuthProfile(serverUrl, profileName);
    if (profile) {
      const tokens = await readKeychainOAuthTokenInfo(profile.serverUrl, profileName);
      if (tokens?.refreshToken) {
        credentials.refreshToken = tokens.refreshToken;
        credentials.serverUrl = profile.serverUrl;
        logger.debug(`Found OAuth refresh token for profile ${profileName}`);
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
