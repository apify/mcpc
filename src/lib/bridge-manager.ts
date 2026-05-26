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
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  ServerConfig,
  AuthCredentials,
  ProxyConfig,
  X402WalletCredentials,
  X402SchemePreference,
} from './types.js';
import {
  getSocketPath,
  waitForFile,
  isProcessAlive,
  invalidateProcessAliveCache,
  getLogsDir,
  isSessionExpiredError,
  enrichErrorMessage,
} from './utils.js';
import { updateSession, getSession } from './sessions.js';
import { createLogger } from './logger.js';
import {
  ClientError,
  NetworkError,
  isAuthenticationError,
  createServerAuthError,
} from './errors.js';
import { BridgeClient } from './bridge-client.js';
import {
  readKeychainOAuthTokenInfo,
  readKeychainOAuthClientInfo,
  readKeychainSessionHeaders,
} from './auth/keychain.js';
import { getAuthProfile } from './auth/profiles.js';
import { getWallet } from './wallets.js';

const logger = createLogger('bridge-manager');

/**
 * Classify a bridge health check error as session expiry or auth failure and throw.
 * Session expiry (404/session-not-found) is checked first since it's more specific
 * than auth errors (401/403/unauthorized). Does nothing if neither pattern matches.
 */
async function classifyAndThrowSessionError(
  sessionName: string,
  session: { server: ServerConfig; mcpSessionId?: string },
  errorMessage: string,
  originalError?: Error
): Promise<void> {
  const hadActiveSession = !!session.mcpSessionId;
  if (isSessionExpiredError(errorMessage, { hadActiveSession })) {
    await updateSession(sessionName, { status: 'expired' }).catch((e) =>
      logger.warn(`Failed to mark session ${sessionName} as expired:`, e)
    );
    const logPath = `${getLogsDir()}/bridge-${sessionName}.log`;
    throw new ClientError(
      `Session ${sessionName} expired (server rejected session ID). ` +
        `Use "mcpc ${sessionName} restart" to start a new session. ` +
        `For details, check logs at ${logPath}`
    );
  }
  if (isAuthenticationError(errorMessage)) {
    await updateSession(sessionName, { status: 'unauthorized' }).catch((e) =>
      logger.warn(`Failed to mark session ${sessionName} as unauthorized:`, e)
    );
    const target = session.server.url || session.server.command || sessionName;
    const logPath = `${getLogsDir()}/bridge-${sessionName}.log`;
    throw createServerAuthError(target, {
      sessionName,
      logPath,
      ...(originalError && { originalError }),
    });
  }
}

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
  serverConfig: ServerConfig;
  verbose?: boolean;
  profileName?: string; // Auth profile name for token refresh
  headers?: Record<string, string>; // Headers to send via IPC (caller stores in keychain)
  proxyConfig?: ProxyConfig; // Proxy server configuration
  mcpSessionId?: string; // MCP session ID for resumption (Streamable HTTP only)
  /** x402 scheme preference; presence enables x402 auto-payment, absence disables. */
  x402?: X402SchemePreference;
  insecure?: boolean; // Skip TLS certificate verification
}

export interface StartBridgeResult {
  pid: number;
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
 * - Updating the session with pid after startBridge() returns
 *
 * @returns Bridge process PID
 */
export async function startBridge(options: StartBridgeOptions): Promise<StartBridgeResult> {
  const {
    sessionName,
    serverConfig,
    verbose,
    profileName,
    headers,
    proxyConfig,
    mcpSessionId,
    x402,
    insecure,
  } = options;

  logger.debug(`Launching bridge for session: ${sessionName}`);

  // Read all keychain values BEFORE spawning the bridge.
  // The bridge starts a 5s timer for IPC credentials as soon as it boots, and on
  // macOS the Keychain access dialog can block a CLI for far longer than that.
  // Loading credentials here ensures the bridge timer does not race a foreground
  // password prompt — see https://github.com/apify/mcpc/issues/55.
  const authCredentials =
    profileName || headers
      ? await loadAuthCredentials(
          serverConfig.url || serverConfig.command || '',
          profileName,
          headers
        )
      : null;
  const x402Credentials = x402 ? await loadX402WalletCredentials() : null;

  // Create a sanitized transport config without any headers
  // Headers will be sent to the bridge via IPC instead
  const sanitizedTarget: ServerConfig = { ...serverConfig };
  delete sanitizedTarget.headers; // Only exists for http, no-op for stdio

  // Prepare bridge arguments (with sanitized config - no headers)
  const bridgeExecutable = getBridgeExecutable();
  const targetJson = JSON.stringify(sanitizedTarget);
  const args = [sessionName, targetJson];

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

  // Pass proxy config to bridge (if enabled)
  if (proxyConfig) {
    args.push('--proxy-host', proxyConfig.host);
    args.push('--proxy-port', String(proxyConfig.port));
  }

  // Pass MCP session ID for resumption (if available)
  if (mcpSessionId) {
    args.push('--mcp-session-id', mcpSessionId);
    logger.debug(`Passing MCP session ID for resumption: ${mcpSessionId}`);
  }

  // Pass x402 scheme preference (presence enables x402).
  if (x402) {
    args.push('--x402', x402);
    logger.debug(`Passing x402 scheme preference: ${x402}`);
  }

  // Pass insecure flag (if enabled)
  if (insecure) {
    args.push('--insecure');
    logger.debug('Passing insecure flag to bridge');
  }

  logger.debug('Bridge executable:', bridgeExecutable);
  logger.debug('Bridge args:', args);

  // Spawn bridge process
  const bridgeProcess: ChildProcess = spawn('node', [bridgeExecutable, ...args], {
    detached: true,
    stdio: 'ignore', // Don't inherit stdio (run in background)
  });

  // Reset the Windows tasklist cache so the freshly spawned PID is observable
  // by subsequent isProcessAlive() checks within this CLI invocation (e.g. the
  // ensureBridgeReady health check run right after this in restart/connect).
  // Without this, a stale pre-spawn snapshot returns false for the new PID,
  // triggering a spurious double-restart that breaks explicit restart semantics.
  invalidateProcessAliveCache();

  // Allow the bridge to run independently
  bridgeProcess.unref();

  logger.debug(`Bridge process spawned with PID: ${bridgeProcess.pid}`);

  if (!bridgeProcess.pid) {
    throw new ClientError('Failed to spawn bridge process: no PID');
  }

  const pid = bridgeProcess.pid;

  // Each bridge gets a unique socket path based on its PID, so overlapping
  // bridges (e.g. background reconnect racing with explicit restart) never
  // conflict. The bridge process computes the same path via process.pid.
  const socketPath = getSocketPath(sessionName, pid);

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
  // Credentials were loaded from the keychain before spawn() — see comment above.
  if (authCredentials) {
    await sendAuthCredentialsToBridge(socketPath, authCredentials);
  }

  // Send x402 wallet credentials to bridge via IPC
  if (x402Credentials) {
    await sendX402WalletToBridge(socketPath, x402Credentials);
  }

  logger.debug(`Bridge started successfully for session: ${sessionName}`);

  return { pid };
}

/**
 * Stop a bridge process (does NOT delete session or headers)
 * Use closeSession() for full session cleanup
 *
 * @param graceful - If true, attempt graceful shutdown via IPC so the bridge
 *   can send HTTP DELETE to the server. Only needed for closeSession().
 *   On Unix, SIGTERM always allows graceful shutdown. On Windows, SIGTERM
 *   is equivalent to SIGKILL, so graceful mode sends an IPC message first.
 */
export async function stopBridge(
  sessionName: string,
  options?: { graceful?: boolean }
): Promise<void> {
  logger.debug(`Stopping bridge for: ${sessionName}`);

  const session = await getSession(sessionName);

  if (!session) {
    throw new ClientError(`Session not found: ${sessionName}`);
  }

  // Kill the bridge process if it's still running
  if (session.pid && isProcessAlive(session.pid)) {
    try {
      if (process.platform === 'win32') {
        // On Windows, SIGTERM calls TerminateProcess (immediate kill, no cleanup).
        // For graceful shutdown (closeSession), send IPC message first so bridge
        // can send HTTP DELETE. For restart, just kill immediately.
        if (options?.graceful) {
          const socketPath = getSocketPath(sessionName, session.pid);
          const shutdownOk = await sendBridgeShutdown(socketPath);
          if (shutdownOk) {
            await waitForProcessExit(session.pid, 2000);
          }
        }
      } else {
        logger.debug(`Sending SIGTERM to bridge process: ${session.pid}`);
        process.kill(session.pid, 'SIGTERM');

        // Wait for graceful shutdown (gives time for HTTP DELETE to be sent)
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Force kill if still alive
      if (isProcessAlive(session.pid)) {
        logger.debug('Bridge did not exit gracefully, force killing');
        try {
          process.kill(session.pid, 'SIGKILL');
        } catch {
          // Ignore - process may have exited between check and kill
        }
      }
    } catch (error) {
      logger.warn('Error stopping bridge process:', error);
    }

    logger.debug(`Bridge stopped for ${sessionName}`);
  }

  // Note: Session record and headers are NOT deleted here.
  // They are preserved for failover scenarios (bridge restart).
  // Full cleanup happens in closeSession().
}

/**
 * Send a shutdown command to the bridge via IPC socket.
 * Returns true if the message was sent successfully, false otherwise.
 */
async function sendBridgeShutdown(socketPath: string): Promise<boolean> {
  try {
    const client = new BridgeClient(socketPath);
    // Use a short timeout — if the bridge doesn't respond quickly,
    // we'll fall back to force kill anyway.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('shutdown timeout')), 2000)
    );
    await Promise.race([client.connect(), timeout]);
    client.send({ type: 'shutdown' });
    await client.close();
    logger.debug('Sent shutdown IPC message to bridge');
    return true;
  } catch (error) {
    logger.debug('Failed to send shutdown IPC message:', error);
    return false;
  }
}

/**
 * Wait for a process to exit, with a timeout.
 */
async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  const interval = 500;
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * Restart a bridge process for a session
 * Used for automatic recovery when connection to bridge fails
 *
 * Headers persist in keychain across bridge restarts, so they are
 * retrieved here and passed to startBridge() which sends them via IPC.
 */
export async function restartBridge(sessionName: string): Promise<StartBridgeResult> {
  logger.debug(`Trying to restart bridge for ${sessionName}...`);

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

  // Build transport config from session data (exclude redacted headers)
  const serverConfig: ServerConfig = { ...session.server };
  delete serverConfig.headers;

  // Retrieve transport headers from keychain for failover, and cross-check them
  let headers: Record<string, string> | undefined;
  const expectedHeaderKeys = session.server.headers ? Object.keys(session.server.headers) : [];
  if (expectedHeaderKeys.length > 0) {
    headers = await readKeychainSessionHeaders(sessionName);
    const retrievedHeaderKeys = new Set(Object.keys(headers || {}));
    const missingKeys = expectedHeaderKeys.filter((key) => !retrievedHeaderKeys.has(key));
    if (missingKeys.length > 0) {
      throw new ClientError(
        `Missing HTTP header(s) in keychain for session ${sessionName}: ${missingKeys.join(', ')}. ` +
          `The session may need to be recreated with "mcpc ${sessionName} close" followed by a new connect.`
      );
    }
    logger.debug(`Retrieved ${expectedHeaderKeys.length} headers from keychain for failover`);
  }

  // Start a new bridge, preserving auth profile, proxy config, MCP session ID, and wallet
  const bridgeOptions: StartBridgeOptions = {
    sessionName,
    serverConfig: serverConfig,
  };
  if (headers) {
    bridgeOptions.headers = headers;
  }
  if (session.profileName) {
    bridgeOptions.profileName = session.profileName;
  }
  if (session.proxy) {
    bridgeOptions.proxyConfig = session.proxy;
  }
  if (session.mcpSessionId) {
    bridgeOptions.mcpSessionId = session.mcpSessionId;
    logger.debug(`Using saved MCP session ID for resumption: ${session.mcpSessionId}`);
  }
  if (session.x402) {
    bridgeOptions.x402 = session.x402;
    logger.debug(`Using saved x402 scheme preference: ${session.x402}`);
  }
  if (session.insecure) {
    bridgeOptions.insecure = session.insecure;
    logger.debug('Using saved insecure flag');
  }

  const { pid } = await startBridge(bridgeOptions);

  // Update session with new PID
  await updateSession(sessionName, { pid });

  logger.debug(`Bridge restarted for ${sessionName} with PID: ${pid}`);

  return { pid };
}

/**
 * Read auth credentials from disk/keychain. Must be called BEFORE the bridge
 * is spawned: on macOS, Keychain access can block on a user dialog for longer
 * than the bridge's IPC startup timeout, so doing this read after spawn()
 * races the bridge timer (see https://github.com/apify/mcpc/issues/55).
 */
async function loadAuthCredentials(
  serverUrl: string,
  profileName?: string,
  headers?: Record<string, string>
): Promise<AuthCredentials> {
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
      if (tokens) {
        credentials.serverUrl = profile.serverUrl;
        if (tokens.refreshToken) {
          credentials.refreshToken = tokens.refreshToken;
          logger.debug(`Found OAuth refresh token for profile ${profileName}`);
        }
        if (tokens.accessToken) {
          credentials.accessToken = tokens.accessToken;
          logger.debug(`Found OAuth access token for profile ${profileName}`);
        }
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

  return credentials;
}

/**
 * Send pre-loaded auth credentials to a bridge process via IPC.
 * Credentials must be loaded with loadAuthCredentials() before the bridge spawns.
 */
async function sendAuthCredentialsToBridge(
  socketPath: string,
  credentials: AuthCredentials
): Promise<void> {
  // Always send credentials to the bridge (even if minimal)
  // The bridge waits for this message before connecting to MCP server
  logger.debug(
    'Sending auth credentials to bridge' +
      (credentials.refreshToken ? ' (with refresh token)' : '') +
      (credentials.accessToken ? ' (with access token)' : '') +
      (credentials.headers ? ` (with ${Object.keys(credentials.headers).length} headers)` : '') +
      (!credentials.refreshToken && !credentials.accessToken && !credentials.headers
        ? ' (minimal - no tokens or headers)'
        : '')
  );

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
 * Read x402 wallet credentials. Must be called BEFORE the bridge is spawned
 * for the same reason as loadAuthCredentials().
 */
async function loadX402WalletCredentials(): Promise<X402WalletCredentials> {
  const wallet = await getWallet();

  if (!wallet) {
    throw new ClientError('x402 wallet not found. Create one with: mcpc x402 init');
  }

  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
}

/**
 * Send pre-loaded x402 wallet credentials to a bridge process via IPC.
 */
async function sendX402WalletToBridge(
  socketPath: string,
  credentials: X402WalletCredentials
): Promise<void> {
  logger.debug(`Sending x402 wallet (${credentials.address}) to bridge`);

  const client = new BridgeClient(socketPath);
  try {
    await client.connect();
    client.sendX402Wallet(credentials);
    logger.debug('x402 wallet sent to bridge successfully');
  } finally {
    await client.close();
  }
}

/**
 * Result of bridge health check
 */
interface BridgeHealthResult {
  healthy: boolean;
  error?: Error;
}

/**
 * Test if bridge is responsive by calling getServerDetails
 * This blocks until MCP client is connected, then returns server info
 *
 * @param socketPath - Path to bridge's Unix socket
 * @returns Health check result with error details if unhealthy
 */
async function checkBridgeHealth(socketPath: string): Promise<BridgeHealthResult> {
  const client = new BridgeClient(socketPath);
  try {
    await client.connect();
    // getServerDetails blocks until MCP client is connected, then returns info
    // If MCP connection fails, the bridge will return an error via IPC
    await client.request('getServerDetails');
    return { healthy: true };
  } catch (error) {
    // Return error details so caller can provide informative message
    return { healthy: false, error: error as Error };
  } finally {
    await client.close();
  }
}

/**
 * Ensure bridge is ready for use
 * Uses getServerDetails() as the health check - it blocks until MCP is connected.
 *
 * This is the main entry point for ensuring a session's bridge is usable.
 * After this returns successfully, the bridge is guaranteed to be responding.
 *
 * The simplicity of this approach:
 * - getServerDetails() blocks until MCP client connects (no polling loop needed)
 * - If MCP connection fails, error details are propagated to caller
 * - If bridge process dies, socket connection fails and we restart
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

  if (session.status === 'unauthorized') {
    const target = session.server.url || session.server.command || sessionName;
    const logPath = `${getLogsDir()}/bridge-${sessionName}.log`;
    throw createServerAuthError(target, { sessionName, logPath });
  }

  if (session.status === 'expired') {
    throw new ClientError(
      `Session ${sessionName} has expired. ` +
        `The MCP server indicated the session is no longer valid.\n` +
        `To restart the session, run: mcpc ${sessionName} restart\n` +
        `To remove the expired session, run: mcpc ${sessionName} close`
    );
  }

  // Socket path is PID-based: each bridge instance gets its own unique path
  const socketPath = session.pid ? getSocketPath(sessionName, session.pid) : null;

  // Quick check: is the process alive?
  const processAlive = session.pid ? isProcessAlive(session.pid) : false;

  if (processAlive && socketPath) {
    // Process alive, try getServerDetails (blocks until MCP connected)
    const result = await checkBridgeHealth(socketPath);
    if (result.healthy) {
      logger.debug(`Bridge for ${sessionName} is healthy`);
      return socketPath;
    }
    // Not healthy - check error type
    if (result.error) {
      const errorMessage = result.error.message || '';
      await classifyAndThrowSessionError(sessionName, session, errorMessage, result.error);
      if (result.error instanceof NetworkError) {
        logger.debug(`Bridge process alive but socket not responding for ${sessionName}`);
      } else {
        // Other MCP errors - propagate with enriched message
        const serverUrl = session.server.url;
        throw new ClientError(enrichErrorMessage(result.error.message, serverUrl));
      }
    }
  } else {
    logger.debug(`Bridge process not alive for ${sessionName}, will try to restart it`);
  }

  // Bridge not healthy - restart it
  // Use 'connecting' if the session has never successfully connected (no lastSeenAt),
  // 'reconnecting' if it was previously active.
  // Set lastConnectionAttemptAt to prevent parallel CLI processes from
  // also triggering a restart via consolidateSessions/reconnectCrashedSessions.
  const restartStatus = session.lastSeenAt ? 'reconnecting' : 'connecting';
  await updateSession(sessionName, {
    status: restartStatus,
    lastConnectionAttemptAt: new Date().toISOString(),
  });
  const { pid: newPid } = await restartBridge(sessionName);

  const newSocketPath = getSocketPath(sessionName, newPid);

  // Try getServerDetails on restarted bridge (blocks until MCP connected)
  const result = await checkBridgeHealth(newSocketPath);
  if (result.healthy) {
    await updateSession(sessionName, { status: 'active' });
    logger.debug(`Bridge for ${sessionName} passed health check`);
    return newSocketPath;
  }

  // Not healthy after restart - classify the error
  const errorMsg = result.error?.message || 'unknown error';
  await classifyAndThrowSessionError(sessionName, session, errorMsg, result.error);

  // Other errors - provide enriched error with log path
  const serverUrl = session.server.url;
  const logPath = `${getLogsDir()}/bridge-${sessionName}.log`;
  throw new ClientError(
    `${enrichErrorMessage(errorMsg, serverUrl)}\n` + `For details, check logs at ${logPath}`
  );
}

/**
 * Reconnect crashed bridge sessions in the background.
 * Fire-and-forget: does not wait for reconnections to complete.
 * Called after consolidateSessions() identifies crashed sessions eligible for reconnection.
 *
 * Unlike explicit "restart" (which creates a fresh MCP session), this preserves
 * the existing MCP session ID for resumption when possible.
 *
 * @param sessionNames - Names of sessions to reconnect (from consolidateSessions result)
 */
export function reconnectCrashedSessions(sessionNames: string[]): void {
  for (const name of sessionNames) {
    logger.debug(`Reconnecting crashed bridge for session: ${name}`);
    // Fire-and-forget: the bridge process itself will set the final status
    // ('active' on success, 'expired' if server forgot session, 'unauthorized' on auth error)
    restartBridge(name).catch(async (err) => {
      logger.debug(`Reconnection failed for ${name}: ${(err as Error).message}`);
      // Revert to 'crashed' only if the bridge hasn't already set a terminal status
      try {
        const session = await getSession(name);
        if (session?.status === 'reconnecting' || session?.status === 'connecting') {
          await updateSession(name, { status: 'crashed' });
        }
      } catch {
        // Ignore - session may have been deleted
      }
    });
  }
}
