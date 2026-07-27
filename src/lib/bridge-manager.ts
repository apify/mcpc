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
  readKeychainClientCredentials,
  readKeychainIdJagCredentials,
  readKeychainSessionHeaders,
  readKeychainProxyBearerToken,
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
    throw new ClientError(
      `Session ${sessionName} expired (server rejected session ID). ` +
        `Use "mcpc ${sessionName} restart" to start a new session. ` +
        `For details, run: mcpc ${sessionName} logs`
    );
  }
  if (isAuthenticationError(errorMessage)) {
    await updateSession(sessionName, { status: 'unauthorized' }).catch((e) =>
      logger.warn(`Failed to mark session ${sessionName} as unauthorized:`, e)
    );
    const target = session.server.url || session.server.command || sessionName;
    throw createServerAuthError(target, {
      sessionName,
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

/**
 * How long to wait for a freshly spawned bridge to open its IPC socket. The
 * bridge must boot Node and load its (sizeable) module graph first; on
 * resource-constrained machines, or when many bridges are spawned in parallel
 * (e.g. `connect` against a multi-server config), this can take several
 * seconds. With the old 5s window the CLI killed the bridge before it had even
 * initialized its file logger, leaving the user with a "check bridge logs"
 * error pointing at logs that were never written. 15s is generous enough that
 * any failure to hit it is pathological.
 */
const BRIDGE_STARTUP_TIMEOUT_MILLIS = 15_000;

export interface StartBridgeOptions {
  sessionName: string;
  serverConfig: ServerConfig;
  verbose?: boolean;
  profileName?: string; // Auth profile name for token refresh
  headers?: Record<string, string>; // Headers to send via IPC (caller stores in keychain)
  proxyConfig?: ProxyConfig; // Proxy server configuration
  mcpSessionId?: string; // MCP session ID for resumption (Streamable HTTP only)
  protocolVersion?: string; // Protocol version negotiated by the resumed session (only pass with mcpSessionId)
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
    protocolVersion,
    x402,
    insecure,
  } = options;

  logger.debug(`Launching bridge for session: ${sessionName}`);

  // Read all keychain values BEFORE spawning the bridge.
  // The bridge starts a 5s timer for IPC credentials as soon as it boots, and on
  // macOS the Keychain access dialog can block a CLI for far longer than that.
  // Loading credentials here ensures the bridge timer does not race a foreground
  // password prompt — see https://github.com/apify/mcpc/issues/55.
  // The proxy bearer token is read here (under the CLI's runtime) and delivered to
  // the bridge via IPC, so the bridge never reads it from the keychain itself — its
  // only keychain access stays on the sanctioned OAuth-refresh path (see #55).
  const proxyBearerToken = proxyConfig
    ? ((await readKeychainProxyBearerToken(sessionName)) ?? undefined)
    : undefined;

  const authCredentials =
    profileName || headers || proxyBearerToken
      ? await loadAuthCredentials(
          serverConfig.url || serverConfig.command || '',
          profileName,
          headers,
          proxyBearerToken
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
  // Use a dummy placeholder when headers or a proxy bearer token are provided (no
  // OAuth profile), so the bridge waits for the IPC credentials — which also carry
  // the proxy bearer token — before connecting and starting its proxy server.
  if (profileName) {
    args.push('--profile', profileName);
  } else if ((headers && Object.keys(headers).length > 0) || proxyBearerToken) {
    args.push('--profile', 'dummy');
  }

  // Pass proxy config to bridge (if enabled)
  if (proxyConfig) {
    args.push('--proxy-host', proxyConfig.host);
    args.push('--proxy-port', String(proxyConfig.port));
  }

  // Pass MCP session ID for resumption (if available), along with the protocol version
  // negotiated by the original session — the SDK skips the handshake on resumption, so
  // the bridge must seed the transport with the version to keep the required
  // MCP-Protocol-Version header on all requests
  if (mcpSessionId) {
    args.push('--mcp-session-id', mcpSessionId);
    logger.debug(`Passing MCP session ID for resumption: ${mcpSessionId}`);
    if (protocolVersion) {
      args.push('--protocol-version', protocolVersion);
      logger.debug(`Passing negotiated protocol version for resumption: ${protocolVersion}`);
    }
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

  // Spawn the bridge under the SAME runtime as the CLI (process.execPath), not a
  // hardcoded "node". The bridge reads OS-keychain items the CLI wrote (e.g. the
  // proxy bearer token, session headers on reconnect); macOS keychain ACLs are
  // per-binary, so a different binary reading the item triggers a Security access
  // prompt — which blocks forever in headless contexts (CI hung here for 6h with
  // a bun CLI + node bridge). Matching runtimes keeps a single keychain identity.
  // It also means a Bun user no longer needs Node on PATH for the bridge to start.
  //
  // --insecure disables TLS certificate verification in the bridge. initProxy()'s
  // undici dispatcher (rejectUnauthorized: false) covers Node's fetch, but Bun's
  // fetch ignores it; NODE_TLS_REJECT_UNAUTHORIZED=0 in the bridge's environment
  // covers Bun (and is a harmless no-op alongside the dispatcher on Node). Scoped
  // to this one bridge process. Set via the spawn env so it is in place before the
  // runtime initializes TLS (a post-startup assignment could be read too late).
  //
  // stderr is dropped: piping it (to capture a tail for failure diagnostics) made
  // rapid CLI invocations destabilize the bridge — child_process pipes are
  // net.Sockets, and the close-from-parent semantics interacted badly with the
  // bridge's connection handling. The 15s startup window already gives the bridge
  // time to initialize its file logger, so the per-session log file is sufficient.
  const bridgeProcess: ChildProcess = spawn(process.execPath, [bridgeExecutable, ...args], {
    detached: true,
    stdio: 'ignore',
    ...(insecure && { env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' } }),
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

  // Wait for the bridge to open its IPC socket. Race the wait against the
  // process exiting: a crash during startup then fails fast (reporting the exit
  // code) instead of stalling for the full timeout, while a bridge that is
  // merely slow to boot is given a generous window so it is not killed before it
  // can initialize logging and connect.
  const socketReady = Symbol('socket-ready');
  let resolveExit!: (detail: string) => void;
  const exitInfo = new Promise<string>((resolve) => {
    resolveExit = resolve;
  });
  const onBridgeExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    resolveExit(signal != null ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`);
  };
  bridgeProcess.once('exit', onBridgeExit);

  let outcome: string | symbol;
  try {
    outcome = await Promise.race([
      waitForFile(socketPath, { timeoutMillis: BRIDGE_STARTUP_TIMEOUT_MILLIS }).then(
        () => socketReady
      ),
      exitInfo,
    ]);
  } catch {
    // waitForFile timed out while the process is still alive — kill it.
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Ignore errors killing process
    }
    throw new ClientError(
      `Bridge failed to start: socket not created within ${BRIDGE_STARTUP_TIMEOUT_MILLIS} ms. ` +
        `For details, run: mcpc ${sessionName} logs`
    );
  } finally {
    bridgeProcess.removeListener('exit', onBridgeExit);
  }

  if (typeof outcome === 'string') {
    // Bridge process exited before it opened its socket (startup crash).
    throw new ClientError(
      `Bridge process exited during startup (${outcome}). For details, run: mcpc ${sessionName} logs`
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
        // For graceful shutdown (closeSession / explicit restart), send an IPC message
        // first so the bridge can send HTTP DELETE to terminate its MCP session before
        // exiting. Without it the server-side session (and its subscriptions) is orphaned.
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
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('shutdown timeout')), 2000)
    );
    // Fail fast: this targets an already-running bridge, and we force-kill if it's
    // unreachable — no point retrying a not-yet-listening socket here.
    await Promise.race([client.connect({ retryTimeoutMillis: 0 }), timeoutPromise]);
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
async function waitForProcessExit(pid: number, timeoutMillis: number): Promise<void> {
  const start = Date.now();
  const interval = 500;
  while (Date.now() - start < timeoutMillis) {
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
    if (session.protocolVersion) {
      bridgeOptions.protocolVersion = session.protocolVersion;
      logger.debug(`Using saved protocol version for resumption: ${session.protocolVersion}`);
    }
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
  headers?: Record<string, string>,
  proxyBearerToken?: string
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
    if (profile?.oauthGrant === 'id_jag') {
      // Enterprise-managed authorization: load the stored IdP + client material so
      // the bridge can build the SDK cross-app-access provider.
      const idJag = await readKeychainIdJagCredentials(profile.serverUrl, profileName);
      if (idJag) {
        credentials.serverUrl = profile.serverUrl;
        credentials.oauthGrant = 'id_jag';
        credentials.idJag = idJag;
        logger.debug(`Found id-jag material for profile ${profileName}`);
      } else {
        logger.warn(
          `Profile ${profileName} uses the id-jag grant but no material was found in the keychain`
        );
      }
    } else if (profile?.oauthGrant === 'client_credentials') {
      // Client-credentials grant: load the stored secret/key so the bridge can
      // build the SDK provider that fetches and refreshes tokens itself.
      const cc = await readKeychainClientCredentials(profile.serverUrl, profileName);
      if (cc?.clientId) {
        credentials.serverUrl = profile.serverUrl;
        credentials.oauthGrant = 'client_credentials';
        credentials.clientId = cc.clientId;
        if (cc.clientSecret) credentials.clientSecret = cc.clientSecret;
        if (cc.privateKeyPem) credentials.privateKeyPem = cc.privateKeyPem;
        if (cc.keyAlg) credentials.keyAlg = cc.keyAlg;
        if (cc.scope) credentials.scope = cc.scope;
        if (cc.tokenEndpoint) credentials.tokenEndpoint = cc.tokenEndpoint;
        logger.debug(`Found client-credentials material for profile ${profileName}`);
      } else {
        logger.warn(
          `Profile ${profileName} uses the client-credentials grant but no material was found in the keychain`
        );
      }
    } else if (profile) {
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

  // Add the proxy bearer token if provided, so the bridge configures its proxy
  // server's auth from the IPC credentials instead of reading the keychain.
  if (proxyBearerToken) {
    credentials.proxyBearerToken = proxyBearerToken;
    logger.debug('Including proxy bearer token in credentials');
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
    // connect() retries while the freshly-spawned bridge finishes (re)creating its socket.
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
 * @param timeoutSecs - Optional request timeout in seconds (the `--timeout` value). Without it the
 *   bridge client's default request timeout applies. The health check is what blocks while a
 *   server completes (or fails) its handshake, so this is where `--timeout` must take effect.
 * @returns Health check result with error details if unhealthy
 */
async function checkBridgeHealth(
  socketPath: string,
  timeoutSecs?: number
): Promise<BridgeHealthResult> {
  const client = new BridgeClient(socketPath);
  try {
    await client.connect();
    // getServerDetails blocks until MCP client is connected, then returns info
    // If MCP connection fails, the bridge will return an error via IPC
    await client.request('getServerDetails', undefined, timeoutSecs);
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
 * @param timeoutSecs - Optional request timeout in seconds (the `--timeout` value), used to bound the
 *   health-check `getServerDetails` call so a slow/unreachable server doesn't block past it.
 * @returns The socket path of the healthy bridge
 * @throws ClientError if bridge cannot be made healthy
 */
export async function ensureBridgeReady(
  sessionName: string,
  timeoutSecs?: number
): Promise<string> {
  const session = await getSession(sessionName);

  if (!session) {
    throw new ClientError(`Session not found: ${sessionName}`);
  }

  if (session.status === 'unauthorized') {
    const target = session.server.url || session.server.command || sessionName;
    throw createServerAuthError(target, { sessionName });
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
    const result = await checkBridgeHealth(socketPath, timeoutSecs);
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
  const result = await checkBridgeHealth(newSocketPath, timeoutSecs);
  if (result.healthy) {
    await updateSession(sessionName, { status: 'active' });
    logger.debug(`Bridge for ${sessionName} passed health check`);
    return newSocketPath;
  }

  // Not healthy after restart - classify the error
  const errorMsg = result.error?.message || 'unknown error';
  await classifyAndThrowSessionError(sessionName, session, errorMsg, result.error);

  // Other errors - provide enriched error with hint to view logs
  const serverUrl = session.server.url;
  throw new ClientError(
    `${enrichErrorMessage(errorMsg, serverUrl)}\n` + `For details, run: mcpc ${sessionName} logs`
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
