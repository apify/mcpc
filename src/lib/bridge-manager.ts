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
import { saveSession, deleteSession } from './sessions.js';
import { createLogger } from './logger.js';
import { ClientError } from './errors.js';
import { BridgeClient } from './bridge-client.js';
import { getOAuthTokens } from './auth/keychain.js';
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
}

/**
 * Start a bridge process for a session
 * Creates the session record and spawns the bridge process
 */
export async function startBridge(options: StartBridgeOptions): Promise<void> {
  const { sessionName, target, verbose, profileName } = options;

  logger.info(`Starting bridge for session: ${sessionName}`);

  // Get socket path
  const socketPath = join(getBridgesDir(), `${sessionName}.sock`);

  // Prepare bridge arguments
  const bridgeExecutable = getBridgeExecutable();
  const targetJson = JSON.stringify(target);
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
  let bridgeProcess: ChildProcess;

  try {
    bridgeProcess = spawn('node', [bridgeExecutable, ...args], {
      detached: true,
      stdio: 'ignore', // Don't inherit stdio (run in background)
    });

    // Allow the bridge to run independently
    bridgeProcess.unref();

    logger.debug(`Bridge process spawned with PID: ${bridgeProcess.pid}`);

    if (!bridgeProcess.pid) {
      throw new ClientError('Failed to spawn bridge process: no PID');
    }

    // Wait for socket file to be created (with timeout)
    try {
      await waitForFile(socketPath, { timeoutMs: 5000 });
    } catch {
      // Kill the process if socket wasn't created
      try {
        process.kill(bridgeProcess.pid, 'SIGTERM');
      } catch {
        // Ignore errors killing process
      }
      throw new ClientError(
        `Bridge failed to start: socket file not created within timeout. Check bridge logs.`
      );
    }

    // If auth profile is specified, send refresh token to bridge via IPC
    if (profileName) {
      await sendAuthCredentialsToBridge(socketPath, target.url || target.command || '', profileName);
    }

    // Save session to storage
    const sessionData: Parameters<typeof saveSession>[1] = {
      target: target.url || target.command || 'unknown',
      transport: target.type,
      pid: bridgeProcess.pid,
      socketPath,
      // Protocol version will be populated on first command
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Store auth profile reference if specified
    if (profileName) {
      sessionData.profileName = profileName;
    }

    await saveSession(sessionName, sessionData);

    logger.info(`Bridge started successfully for session: ${sessionName}`);
  } catch (error) {
    logger.error('Failed to start bridge:', error);

    // Clean up on failure
    try {
      await deleteSession(sessionName);
    } catch {
      // Ignore cleanup errors
    }

    throw error;
  }
}

/**
 * Stop a bridge process and remove the session
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

  // Remove session from storage
  await deleteSession(sessionName);

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

  return true;
}

/**
 * Restart a bridge if it's unhealthy
 * Used for automatic recovery
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
    const target: TransportConfig =
      session.transport === 'http'
        ? {
            type: 'http' as const,
            url: session.target,
          }
        : {
            type: 'stdio' as const,
            command: session.target,
          };

    // Start a new bridge, preserving auth profile
    const bridgeOptions: StartBridgeOptions = {
      sessionName,
      target,
    };
    if (session.profileName) {
      bridgeOptions.profileName = session.profileName;
    }
    await startBridge(bridgeOptions);
  }
}

/**
 * Send auth credentials to a bridge process via IPC
 * Retrieves refresh token from keychain and sends it to the bridge
 */
async function sendAuthCredentialsToBridge(
  socketPath: string,
  serverUrl: string,
  profileName: string
): Promise<void> {
  logger.debug(`Sending auth credentials for profile ${profileName} to bridge`);

  // Get the auth profile to find the server URL
  const profile = await getAuthProfile(serverUrl, profileName);
  if (!profile) {
    logger.warn(`Auth profile ${profileName} not found for ${serverUrl}, skipping auth credentials`);
    return;
  }

  // Get tokens from keychain
  const tokens = await getOAuthTokens(profile.serverUrl, profileName);
  if (!tokens?.refreshToken) {
    logger.warn(`No refresh token found in keychain for profile ${profileName} of ${serverUrl}, skipping auth credentials`);
    return;
  }

  // Connect to bridge and send credentials
  const client = new BridgeClient(socketPath);
  try {
    await client.connect();
    client.sendAuthCredentials({
      refreshToken: tokens.refreshToken,
      serverUrl: profile.serverUrl,
      profileName,
    });
    logger.debug('Auth credentials sent to bridge successfully');
  } finally {
    await client.close();
  }
}
