/**
 * Bridge process lifecycle management
 * Spawns, monitors, and manages bridge processes for persistent MCP sessions
 */

import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import type { TransportConfig } from './types.js';
import { getBridgesDir, waitForFile, isProcessAlive } from './utils.js';
import { saveSession, deleteSession } from './sessions.js';
import { createLogger } from './logger.js';
import { ClientError } from './errors.js';

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
}

/**
 * Start a bridge process for a session
 * Creates the session record and spawns the bridge process
 */
export async function startBridge(options: StartBridgeOptions): Promise<void> {
  const { sessionName, target, verbose } = options;

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
      await waitForFile(socketPath, { timeout: 5000 });
    } catch (error) {
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

    // Save session to storage
    await saveSession(sessionName, {
      target: target.url || target.command || 'unknown',
      transport: target.type,
      pid: bridgeProcess.pid,
      socketPath,
      // Protocol version will be populated on first command
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

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
  const { exists } = await import('./utils.js');
  if (session.socketPath && !(await exists(session.socketPath))) {
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

    // Start a new bridge
    await startBridge({
      sessionName,
      target,
    });
  }
}
