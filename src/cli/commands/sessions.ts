/**
 * Sessions command handlers
 */

import { createServer } from 'net';
import {
  OutputMode,
  isValidSessionName,
  generateSessionName,
  normalizeServerUrl,
  validateProfileName,
  isProcessAlive,
  getServerHost,
  getLogsDir,
  redactHeaders,
} from '../../lib/index.js';
import { DISCONNECTED_THRESHOLD_MS } from '../../lib/types.js';
import type {
  ServerConfig,
  ProxyConfig,
  ServerDetails,
  X402SchemePreference,
} from '../../lib/types.js';
import {
  formatOutput,
  formatSuccess,
  formatWarning,
  formatError,
  formatSessionLine,
  formatServerDetails,
  theme,
} from '../output.js';
import { withMcpClient, resolveTarget, resolveAuthProfile } from '../helpers.js';
import { listAuthProfiles } from '../../lib/auth/profiles.js';
import {
  sessionExists,
  deleteSession,
  saveSession,
  updateSession,
  consolidateSessions,
  getSession,
  loadSessions,
} from '../../lib/sessions.js';
import {
  startBridge,
  StartBridgeOptions,
  stopBridge,
  reconnectCrashedSessions,
} from '../../lib/bridge-manager.js';
import {
  storeKeychainSessionHeaders,
  storeKeychainProxyBearerToken,
} from '../../lib/auth/keychain.js';
import {
  AuthError,
  ClientError,
  isAuthenticationError,
  createServerAuthError,
} from '../../lib/index.js';
import { getWallet } from '../../lib/wallets.js';
import chalk from 'chalk';
import { createLogger } from '../../lib/logger.js';
import { parseProxyArg } from '../parser.js';
import {
  loadConfig,
  listServers,
  isStdioEntry,
  discoverMcpConfigFiles,
  getStandardMcpConfigPaths,
  type DiscoveredConfig,
} from '../../lib/config.js';

const logger = createLogger('sessions');

/**
 * Check if a port is available for binding
 */
async function checkPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        // Other errors (like permission denied) - treat as unavailable
        resolve(false);
      }
    });

    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.listen(port, host);
  });
}

/**
 * Find an existing session that matches the given server target and authentication settings.
 * Used when auto-generating session names to reuse existing sessions instead of creating duplicates.
 *
 * @returns The matching session name (with @ prefix), or undefined if no match found
 */
async function findMatchingSession(
  parsed: { type: 'url'; url: string } | { type: 'config'; file: string; entry: string },
  options: { profile?: string; headers?: string[]; noProfile?: boolean }
): Promise<string | undefined> {
  const storage = await loadSessions();
  const sessions = Object.values(storage.sessions);

  if (sessions.length === 0) return undefined;

  // Determine the effective profile name for comparison
  const effectiveProfile = options.noProfile ? undefined : (options.profile ?? 'default');

  for (const session of sessions) {
    if (!session.server) continue;

    // Match server target
    if (parsed.type === 'url') {
      if (!session.server.url) continue;
      // Compare normalized URLs
      try {
        const existingUrl = normalizeServerUrl(session.server.url);
        const newUrl = normalizeServerUrl(parsed.url);
        if (existingUrl !== newUrl) continue;
      } catch {
        continue;
      }
    } else {
      // Config entry: match by command (stdio transport)
      // Config entries produce stdio configs with command/args, so we can't easily
      // compare them. Instead, just compare generated session names for config targets.
      // This is handled by the caller (resolveSessionName) via name-based dedup.
      continue;
    }

    // Match profile
    const sessionProfile = session.profileName ?? 'default';
    if (effectiveProfile !== sessionProfile) continue;

    // Match header keys (values are redacted, so we only compare key sets)
    const existingHeaderKeys = Object.keys(session.server.headers || {}).sort();
    const newHeaderKeys = (options.headers || [])
      .map((h) => h.split(':')[0]?.trim() || '')
      .filter(Boolean)
      .sort();
    if (existingHeaderKeys.join(',') !== newHeaderKeys.join(',')) continue;

    // Found a match
    return session.name;
  }

  return undefined;
}

/**
 * Resolve the session name when @session is omitted from `mcpc connect`.
 * Finds an existing matching session or generates a new unique name.
 *
 * @returns Session name with @ prefix
 */
export async function resolveSessionName(
  parsed: { type: 'url'; url: string } | { type: 'config'; file: string; entry: string },
  options: {
    outputMode: OutputMode;
    profile?: string;
    headers?: string[];
    noProfile?: boolean;
  }
): Promise<string> {
  // First, check if an existing session matches this server + auth settings
  const existingName = await findMatchingSession(parsed, options);
  if (existingName) {
    return existingName;
  }

  // Generate a new session name
  const candidateName = generateSessionName(parsed);

  // Check if the candidate name is already taken by a different server
  const storage = await loadSessions();
  if (!(candidateName in storage.sessions)) {
    if (options.outputMode === 'human') {
      console.log(theme.cyan(`Using session name: ${candidateName}`));
    }
    return candidateName;
  }

  // Name is taken - try suffixed variants
  for (let i = 2; i <= 99; i++) {
    const suffixed = `${candidateName}-${i}`;
    if (isValidSessionName(suffixed) && !(suffixed in storage.sessions)) {
      if (options.outputMode === 'human') {
        console.log(theme.cyan(`Using session name: ${suffixed}`));
      }
      return suffixed;
    }
  }

  throw new ClientError(
    `Cannot auto-generate session name: too many sessions for this server.\n` +
      `Specify a name explicitly: mcpc connect ${parsed.type === 'url' ? parsed.url : `${parsed.file}:${parsed.entry}`} @my-session`
  );
}

/**
 * One entry in the unified JSON array returned by `mcpc connect`.
 * Mirrors MCP `InitializeResult` (protocolVersion/capabilities/serverInfo/instructions),
 * extended with `toolNames` and an `_mcpc` metadata block. The same shape is used for
 * both single-server and multi-server connects so consumers can always treat the output
 * as an array.
 *
 * For failed/skipped entries only the `_mcpc` block is populated.
 */
export type ConnectResultEntry = {
  _mcpc: {
    sessionName: string;
    profileName?: string;
    server?: ServerConfig;
    configFile?: string;
    entry?: string;
    status: 'created' | 'active' | 'failed' | 'skipped';
    skipReason?: 'stdio' | 'duplicate';
    error?: string;
  };
} & Partial<
  Pick<ServerDetails, 'protocolVersion' | 'capabilities' | 'serverInfo' | 'instructions'>
> & {
    toolNames?: string[];
  };

/**
 * Connect to a session via the bridge and build a populated ConnectResultEntry from
 * its InitializeResult and tools list. The entry's `_mcpc.server` headers are redacted.
 */
async function buildConnectResultEntry(
  sessionName: string,
  status: 'created' | 'active',
  options: {
    verbose?: boolean;
    timeout?: number;
    configFile?: string;
    entry?: string;
  }
): Promise<ConnectResultEntry> {
  return await withMcpClient(
    sessionName,
    {
      outputMode: 'json',
      hideTarget: true,
      ...(options.verbose && { verbose: options.verbose }),
      ...(options.timeout !== undefined && { timeout: options.timeout }),
    },
    async (client, context) => {
      const serverDetails = await client.getServerDetails();
      const tools = (await client.listAllTools()).tools;

      const server: ServerConfig | undefined = context.serverConfig
        ? {
            ...context.serverConfig,
            ...(context.serverConfig.headers && {
              headers: redactHeaders(context.serverConfig.headers),
            }),
          }
        : undefined;

      return {
        _mcpc: {
          sessionName: context.sessionName ?? sessionName,
          ...(context.profileName && { profileName: context.profileName }),
          ...(server && { server }),
          ...(options.configFile && { configFile: options.configFile }),
          ...(options.entry && { entry: options.entry }),
          status,
        },
        ...(serverDetails.protocolVersion && { protocolVersion: serverDetails.protocolVersion }),
        ...(serverDetails.capabilities && { capabilities: serverDetails.capabilities }),
        ...(serverDetails.serverInfo && { serverInfo: serverDetails.serverInfo }),
        ...(serverDetails.instructions && { instructions: serverDetails.instructions }),
        ...(tools.length > 0 && { toolNames: tools.map((t) => t.name) }),
      };
    }
  );
}

/**
 * Creates a new session, starts a bridge process, and instructs it to connect an MCP server.
 * If session already exists with crashed bridge, reconnects it automatically
 */
export async function connectSession(
  target: string,
  name: string,
  options: {
    outputMode: OutputMode;
    verbose?: boolean;
    config?: string;
    headers?: string[];
    timeout?: number;
    profile?: string;
    noProfile?: boolean;
    proxy?: string;
    proxyBearerToken?: string;
    x402?: X402SchemePreference;
    insecure?: boolean;
    skipDetails?: boolean;
    quiet?: boolean;
  }
): Promise<void> {
  // Validate session name
  if (!isValidSessionName(name)) {
    throw new ClientError(
      `Invalid session name: ${name}\n` +
        `Session names must start with @ and be followed by 1-64 characters, alphanumeric with hyphens or underscores only (e.g., @my-session).`
    );
  }

  // Validate profile name (if provided)
  if (options.profile) {
    validateProfileName(options.profile);
  }

  // Parse proxy configuration (if provided)
  let proxyConfig: ProxyConfig | undefined;
  if (options.proxy) {
    proxyConfig = parseProxyArg(options.proxy);
    logger.debug(`Proxy config: ${proxyConfig.host}:${proxyConfig.port}`);

    // Validate port is available before starting bridge
    const portAvailable = await checkPortAvailable(proxyConfig.host, proxyConfig.port);
    if (!portAvailable) {
      throw new ClientError(
        `Port ${proxyConfig.port} is already in use on ${proxyConfig.host}. ` +
          `Choose a different port with --proxy [host:]port`
      );
    }
  }

  // Validate proxy-bearer-token is only used with --proxy
  if (options.proxyBearerToken && !options.proxy) {
    throw new ClientError('--proxy-bearer-token requires --proxy to be specified');
  }

  // Check if session already exists
  const existingSession = await getSession(name);
  if (existingSession) {
    const bridgeStatus = getBridgeStatus(existingSession);

    if (bridgeStatus === 'live') {
      // Session exists and bridge is running - just show server info
      if (options.outputMode === 'human' && !options.quiet) {
        console.log(formatSuccess(`Session ${name} is already active`));
      }
      if (!options.skipDetails) {
        if (options.outputMode === 'json') {
          const entry = await buildConnectResultEntry(name, 'active', {
            ...(options.verbose && { verbose: options.verbose }),
            ...(options.timeout !== undefined && { timeout: options.timeout }),
          });
          console.log(formatOutput([entry], 'json'));
        } else {
          await showServerDetails(name, { ...options, hideTarget: false });
        }
      }
      return;
    }

    // Bridge has crashed or expired - reconnect with warning
    if (options.outputMode === 'human' && !options.quiet) {
      console.log(
        theme.yellow(`Session ${name} exists but bridge is ${bridgeStatus}, reconnecting...`)
      );
    }

    // Clean up old bridge resources before reconnecting
    try {
      await stopBridge(name);
    } catch {
      // Bridge may already be stopped
    }
  }

  // Resolve target to transport config
  const serverConfig = await resolveTarget(target, options);

  // Detect conflicting auth flags: --profile and --header "Authorization: ..." are mutually exclusive
  const hasExplicitAuthHeader = serverConfig.headers?.Authorization !== undefined;
  const hasExplicitProfile = options.profile !== undefined;

  if (hasExplicitAuthHeader && hasExplicitProfile) {
    throw new ClientError(
      `Cannot combine --profile with --header "Authorization: ...".\n\n` +
        `Use either:\n` +
        `  --profile ${options.profile}  (OAuth authentication via saved profile)\n` +
        `  --header "Authorization: Bearer <token>"  (static bearer token)`
    );
  }

  // For HTTP targets, resolve auth profile (with helpful errors if none available)
  // Skip OAuth profile resolution when:
  // - --no-profile is specified (explicit anonymous connection)
  // - --header "Authorization: ..." is provided (explicit bearer token)
  // - --x402 is specified (x402 payment auth instead of OAuth)
  let profileName: string | undefined;
  if (serverConfig.url) {
    if (options.noProfile) {
      logger.debug('Skipping OAuth profile: --no-profile specified');
    } else if (hasExplicitAuthHeader) {
      logger.debug(
        'Skipping OAuth profile auto-detection: explicit Authorization header provided via --header'
      );
    } else if (options.x402 && !options.profile) {
      // When using --x402 without explicit --profile, don't try to auto-discover default profile
      // since x402 itself serves as the authentication mechanism
      logger.debug('Skipping OAuth profile auto-detection: --x402 specified');
    } else {
      profileName = await resolveAuthProfile(serverConfig.url, target, options.profile, {
        sessionName: name,
      });
    }
  }

  // Store headers in OS keychain (secure storage) before starting bridge
  let headers: Record<string, string> | undefined;
  if (Object.keys(serverConfig.headers || {}).length > 0) {
    headers = { ...serverConfig.headers };

    if (Object.keys(headers).length > 0) {
      logger.debug(
        `Storing ${Object.keys(headers).length} headers for session ${name} in keychain`
      );
      await storeKeychainSessionHeaders(name, headers);
    } else {
      headers = undefined;
    }
  }

  // Store proxy bearer token in keychain (if provided)
  if (options.proxyBearerToken) {
    logger.debug(`Storing proxy bearer token for session ${name} in keychain`);
    await storeKeychainProxyBearerToken(name, options.proxyBearerToken);
  }

  // Validate x402 wallet (if provided)
  if (options.x402) {
    const wallet = await getWallet();
    if (!wallet) {
      throw new ClientError('x402 wallet not found. Create one with: mcpc x402 init');
    }
    logger.debug(`Using x402 wallet: ${wallet.address}`);
  }

  // Create or update session record (without pid - that comes from startBridge)
  // Store serverConfig with headers redacted (actual values in keychain)
  const isReconnect = !!existingSession;
  const { headers: _originalHeaders, ...baseTransportConfig } = serverConfig;
  const sessionTransportConfig: ServerConfig = {
    ...baseTransportConfig,
    ...(headers && { headers: redactHeaders(headers) }),
  };

  const sessionUpdate: Parameters<typeof updateSession>[1] = {
    server: sessionTransportConfig,
    ...(profileName && { profileName }),
    ...(proxyConfig && { proxy: proxyConfig }),
    ...(options.x402 && { x402: options.x402 }),
    ...(options.insecure && { insecure: true }),
    // Clear any previous error status (unauthorized, expired) when reconnecting
    ...(isReconnect && { status: 'active' }),
  };

  if (isReconnect) {
    await updateSession(name, sessionUpdate);
    logger.debug(`Session record updated for reconnect: ${name}`);
  } else {
    await saveSession(name, {
      server: sessionTransportConfig,
      createdAt: new Date().toISOString(),
      status: 'connecting',
      lastConnectionAttemptAt: new Date().toISOString(),
      ...sessionUpdate,
    });
    logger.debug(`Initial session record created for: ${name}`);
  }

  // Start bridge process (handles spawning and IPC credential delivery)
  try {
    const bridgeOptions: StartBridgeOptions = {
      sessionName: name,
      serverConfig: serverConfig,
      verbose: options.verbose || false,
    };
    if (headers) {
      bridgeOptions.headers = headers;
    }
    if (profileName) {
      bridgeOptions.profileName = profileName;
    }
    if (proxyConfig) {
      bridgeOptions.proxyConfig = proxyConfig;
    }
    if (options.x402) {
      bridgeOptions.x402 = options.x402;
    }
    if (options.insecure) {
      bridgeOptions.insecure = true;
    }

    const { pid } = await startBridge(bridgeOptions);

    // Update session with bridge info and mark as active (clears 'connecting' status)
    await updateSession(name, { pid, status: 'active' });
    logger.debug(`Session ${name} updated with bridge PID: ${pid}`);
  } catch (error) {
    // Clean up on bridge start failure
    logger.debug(`Bridge start failed, cleaning up session ${name}`);
    if (!isReconnect) {
      // Only delete session record for new sessions (not reconnects)
      try {
        await deleteSession(name);
      } catch {
        // Ignore cleanup errors
      }
    }
    throw error;
  }

  // When skipDetails is set (bulk connect from config file), print success immediately
  // without waiting for the bridge to complete MCP handshake. The session will auto-recover
  // if the server is slow or unreachable; the user can check status with `mcpc @session`.
  if (options.skipDetails) {
    if (options.outputMode === 'human' && !options.quiet) {
      console.log(formatSuccess(`Session ${name} ${isReconnect ? 'reconnected' : 'created'}`));
    }
    return;
  }

  // Verify the connection works by fetching server details. Both the human-mode
  // showServerDetails() call and the JSON-mode buildConnectResultEntry() call below
  // block until the bridge is connected (via the same health check), so by the time
  // they return or throw we have definitive bridge status.
  try {
    if (options.outputMode === 'json') {
      const entry = await buildConnectResultEntry(name, 'created', {
        ...(options.verbose && { verbose: options.verbose }),
        ...(options.timeout !== undefined && { timeout: options.timeout }),
      });
      console.log(formatOutput([entry], 'json'));
    } else {
      await showServerDetails(name, {
        ...options,
        hideTarget: false, // Show session info prefix
      });

      // Server responded — now we can print success
      console.log(formatSuccess(`Session ${name} ${isReconnect ? 'reconnected' : 'created'}`));
    }
  } catch (detailsError) {
    if (detailsError instanceof AuthError) {
      throw detailsError;
    }
    // Fallback: check error message for auth patterns (error may have been wrapped
    // as ClientError/ServerError during bridge IPC serialization)
    if (detailsError instanceof Error && isAuthenticationError(detailsError.message)) {
      const logPath = `${getLogsDir()}/bridge-${name}.log`;
      throw createServerAuthError(serverConfig.url || target, { sessionName: name, logPath });
    }

    // Non-auth failure: session was created but server didn't respond properly.
    // Show a warning (human mode) or emit a `failed` entry (json mode) so the user
    // knows something is wrong while keeping the JSON shape uniform.
    const errorMsg = detailsError instanceof Error ? detailsError.message : String(detailsError);
    if (options.outputMode === 'json') {
      const failed: ConnectResultEntry = {
        _mcpc: {
          sessionName: name,
          status: 'failed',
          error: errorMsg,
        },
      };
      console.log(formatOutput([failed], 'json'));
    } else {
      console.log(
        formatWarning(
          `Session ${name} created but server is not responding: ${errorMsg}\n` +
            `  The session will auto-recover when the server becomes available.\n` +
            `  Check status with: mcpc ${name}`
        )
      );
    }
    logger.debug(`showServerDetails failed for new session ${name}: ${errorMsg}`);
  }
}

// DISCONNECTED_THRESHOLD_MS imported from ../../lib/types.js

export type DisplayStatus =
  | 'live'
  | 'connecting'
  | 'reconnecting'
  | 'disconnected'
  | 'crashed'
  | 'unauthorized'
  | 'expired';

/**
 * Determine bridge status for a session
 */
export function getBridgeStatus(session: {
  status?: string;
  pid?: number;
  lastSeenAt?: string;
}): DisplayStatus {
  if (session.status === 'unauthorized') {
    return 'unauthorized';
  }
  if (session.status === 'expired') {
    return 'expired';
  }
  // Transient states: connecting (initial) or reconnecting (after crash)
  if (session.status === 'connecting' || session.status === 'reconnecting') {
    return session.status;
  }
  if (!session.pid || !isProcessAlive(session.pid)) {
    return 'crashed';
  }
  // Bridge is alive — check if server is actually responding
  if (session.lastSeenAt) {
    const lastSeenMs = Date.now() - new Date(session.lastSeenAt).getTime();
    if (lastSeenMs > DISCONNECTED_THRESHOLD_MS) {
      return 'disconnected';
    }
  }
  return 'live';
}

/**
 * Format bridge status for display with dot indicator
 */
export function formatBridgeStatus(status: DisplayStatus): { dot: string; text: string } {
  switch (status) {
    case 'live':
      return { dot: theme.green('●'), text: theme.green('live') };
    case 'connecting':
      return { dot: theme.yellow('●'), text: theme.yellow('connecting') };
    case 'reconnecting':
      return { dot: theme.yellow('●'), text: theme.yellow('reconnecting') };
    case 'disconnected':
      return { dot: theme.yellow('●'), text: theme.yellow('disconnected') };
    case 'crashed':
      return { dot: theme.yellow('○'), text: theme.yellow('crashed') };
    case 'unauthorized':
      return { dot: theme.red('○'), text: theme.red('unauthorized') };
    case 'expired':
      return { dot: theme.red('○'), text: theme.red('expired') };
  }
}

/**
 * Format time ago in human-friendly way
 */
export function formatTimeAgo(isoDate: string | undefined): string {
  if (!isoDate) return '';

  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  return `${Math.floor(diffDays / 30)} months ago`;
}

/**
 * List active sessions and authentication profiles
 * Consolidates session state first (cleans up crashed bridges, removes expired sessions)
 */
export async function listSessionsAndAuthProfiles(options: {
  outputMode: OutputMode;
}): Promise<void> {
  // Consolidate sessions first (cleans up crashed bridges, removes expired sessions)
  const consolidateResult = await consolidateSessions(false);
  const sessions = Object.values(consolidateResult.sessions);

  // Auto-restart crashed bridges in the background (fire-and-forget)
  reconnectCrashedSessions(consolidateResult.sessionsToRestart);

  // Load auth profiles from disk
  const profiles = await listAuthProfiles();

  if (options.outputMode === 'json') {
    // Add bridge status to JSON output
    const sessionsWithStatus = sessions.map((session) => ({
      ...session,
      status: getBridgeStatus(session),
    }));
    console.log(
      formatOutput(
        {
          sessions: sessionsWithStatus,
          profiles,
        },
        'json'
      )
    );
  } else {
    // Display sessions
    if (sessions.length === 0) {
      console.log(chalk.bold('No active MCP sessions.'));
      console.log(chalk.dim('  ↳ run: mcpc connect mcp.example.com @test'));
    } else {
      console.log(chalk.bold('MCP sessions:'));
      for (const session of sessions) {
        const status = getBridgeStatus(session);
        const { dot, text } = formatBridgeStatus(status);

        // Format status with time ago info (show for non-live states and stale live sessions)
        let statusStr = `${dot} ${text}`;
        if (session.lastSeenAt) {
          const lastSeenMs = Date.now() - new Date(session.lastSeenAt).getTime();
          const isStale = lastSeenMs > 5 * 60 * 1000; // 5 minutes
          if (status !== 'live' || isStale) {
            const timeAgo = formatTimeAgo(session.lastSeenAt);
            if (timeAgo) {
              statusStr += chalk.dim(`, ${timeAgo}`);
            }
          }
        }

        console.log(`  ${formatSessionLine(session)} ${statusStr}`);

        // Show recovery hints for non-live sessions
        if (status === 'unauthorized') {
          console.log(chalk.dim(`    ↳ run: mcpc ${session.name} restart`));
        } else if (status === 'crashed') {
          console.log(chalk.dim(`    ↳ run: mcpc ${session.name}`));
        } else if (status === 'expired') {
          console.log(chalk.dim(`    ↳ run: mcpc ${session.name} restart`));
        }
      }
    }

    // Display auth profiles
    console.log('');
    if (profiles.length === 0) {
      console.log(chalk.bold('No OAuth profiles.'));
      console.log(chalk.dim('  ↳ run: mcpc login mcp.example.com'));
    } else {
      console.log(chalk.bold('Saved OAuth profiles:'));
      for (const profile of profiles) {
        const hostStr = getServerHost(profile.serverUrl);
        const nameStr = theme.magenta(profile.name);
        const userStr = profile.userEmail || profile.userName || '';
        // Show refreshedAt if available, otherwise createdAt
        const timeAgo = formatTimeAgo(profile.refreshedAt || profile.createdAt);
        const timeLabel = profile.refreshedAt ? 'refreshed' : 'created';

        let line = `  ${hostStr} / ${nameStr}`;
        if (userStr) {
          line += chalk.dim(` (${userStr})`);
        }
        if (timeAgo) {
          line += chalk.dim(`, ${timeLabel} ${timeAgo}`);
        }
        console.log(line);
      }
    }
  }
}

/**
 * Close a session
 */
export async function closeSession(
  name: string,
  options: { outputMode: OutputMode }
): Promise<void> {
  try {
    // Check if session exists
    if (!(await sessionExists(name))) {
      throw new ClientError(`Session not found: ${name}`);
    }

    // Stop the bridge process (graceful: send IPC shutdown on Windows so
    // the bridge can send HTTP DELETE to the server before exiting)
    await stopBridge(name, { graceful: true });

    // Delete session record from storage
    await deleteSession(name);

    // Success!
    if (options.outputMode === 'human') {
      console.log(formatSuccess(`Session ${name} closed successfully\n`));
    } else {
      console.log(
        formatOutput(
          {
            sessionName: name,
            closed: true,
          },
          'json'
        )
      );
    }
  } catch (error) {
    if (options.outputMode === 'human') {
      console.error(formatError((error as Error).message));
    } else {
      console.error(
        formatOutput(
          {
            sessionName: name,
            closed: false,
            error: (error as Error).message,
          },
          'json'
        )
      );
    }
    throw error;
  }
}

/**
 * Get server instructions and capabilities (also used for help command)
 */
export async function showServerDetails(
  target: string,
  options: {
    outputMode: OutputMode;
    config?: string;
    headers?: string[];
    timeout?: number;
    verbose?: boolean;
    hideTarget?: boolean;
  }
): Promise<void> {
  await withMcpClient(target, options, async (client, context) => {
    const serverDetails = await client.getServerDetails();
    const { serverInfo, capabilities, instructions, protocolVersion } = serverDetails;

    // Get tools list (uses bridge cache when available, no extra server call)
    const cachedToolsResult = await client.listAllTools();
    const tools = cachedToolsResult.tools;

    if (options.outputMode === 'human') {
      console.log(formatServerDetails(serverDetails, target, tools));
    } else {
      // JSON output MUST match MCP InitializeResult structure!
      // See https://modelcontextprotocol.io/specification/2025-11-25/schema#initializeresult
      // Build _mcpc.server with redacted headers for security
      const server: ServerConfig = {
        ...context.serverConfig,
        ...(context.serverConfig?.headers && {
          headers: redactHeaders(context.serverConfig.headers),
        }),
      };

      console.log(
        formatOutput(
          {
            _mcpc: {
              sessionName: context.sessionName,
              profileName: context.profileName,
              server,
            },
            protocolVersion,
            capabilities,
            serverInfo,
            instructions,
            ...(tools.length > 0 && { toolNames: tools.map((t) => t.name) }),
          },
          'json'
        )
      );
    }
  });
}

/**
 * Restart a session by stopping and restarting the bridge process
 */
export async function restartSession(
  name: string,
  options: { outputMode: OutputMode; verbose?: boolean }
): Promise<void> {
  try {
    // Get existing session
    const session = await getSession(name);

    if (!session) {
      throw new ClientError(`Session not found: ${name}`);
    }

    if (options.outputMode === 'human') {
      console.log(theme.yellow(`Restarting session ${name}...`));
    }

    // Stop the bridge (even if it's alive)
    try {
      await stopBridge(name);
    } catch {
      // Bridge may already be stopped
    }

    // Get server config from session
    const serverConfig = session.server;
    if (!serverConfig) {
      throw new ClientError(`Session ${name} has no server configuration`);
    }

    // Load headers from keychain if present
    const { readKeychainSessionHeaders } = await import('../../lib/auth/keychain.js');
    const headers = await readKeychainSessionHeaders(name);

    // Start bridge process
    const bridgeOptions: StartBridgeOptions = {
      sessionName: name,
      serverConfig: { ...serverConfig, ...(headers && { headers }) },
      verbose: options.verbose || false,
    };

    if (headers) {
      bridgeOptions.headers = headers;
    }

    // Resolve auth profile: use stored profile, or auto-detect a "default" profile.
    // This handles the case where user creates a session without auth, then later runs
    // `mcpc login <server>` to create a default profile, and restarts the session.
    const hasExplicitAuthHeader = headers?.Authorization !== undefined;
    let profileName = session.profileName;
    if (!profileName && serverConfig.url && !hasExplicitAuthHeader && !session.x402) {
      profileName = await resolveAuthProfile(serverConfig.url, serverConfig.url, undefined, {
        sessionName: name,
      });
      if (profileName) {
        logger.debug(`Discovered auth profile "${profileName}" for session ${name}`);
        await updateSession(name, { profileName });
      }
    }

    if (profileName) {
      bridgeOptions.profileName = profileName;
    }

    if (session.proxy) {
      bridgeOptions.proxyConfig = session.proxy;
    }

    if (session.x402) {
      bridgeOptions.x402 = session.x402;
    }

    if (session.insecure) {
      bridgeOptions.insecure = session.insecure;
    }

    // NOTE: Do NOT pass mcpSessionId on explicit restart.
    // Explicit restart should create a fresh session, not try to resume the old one.
    // Session resumption is only attempted on automatic bridge restart (when bridge crashes
    // and CLI detects it). If server rejects the session ID, session is marked as expired.

    const { pid } = await startBridge(bridgeOptions);

    // Update session with new bridge PID and clear any expired/crashed status
    await updateSession(name, { pid, status: 'active' });
    logger.debug(`Session ${name} restarted with bridge PID: ${pid}`);

    // Success message
    if (options.outputMode === 'human') {
      console.log(formatSuccess(`Session ${name} restarted`));
      console.log(
        chalk.dim(
          'Note: previous session state was lost (e.g. added tools, resource subscriptions, async tasks)'
        )
      );
    }

    // Show server details (like when creating a session)
    await showServerDetails(name, {
      ...options,
      hideTarget: false,
    });
  } catch (error) {
    if (options.outputMode === 'human') {
      console.error(formatError((error as Error).message));
    } else {
      console.error(
        formatOutput(
          {
            sessionName: name,
            restarted: false,
            error: (error as Error).message,
          },
          'json'
        )
      );
    }
    throw error;
  }
}

/**
 * Shared options for bulk connect commands.
 */
type BulkConnectOptions = {
  outputMode: OutputMode;
  verbose?: boolean;
  headers?: string[];
  timeout?: number;
  profile?: string;
  noProfile?: boolean;
  proxy?: string;
  proxyBearerToken?: string;
  stdio?: boolean;
  x402?: X402SchemePreference;
  insecure?: boolean;
};

/**
 * A single entry to connect in a bulk operation.
 */
type BulkConnectEntry = {
  /** Config file path that defines this entry. */
  configFile: string;
  /** Entry name inside the config's `mcpServers` object. */
  entry: string;
  /** Resolved session name (with @ prefix). */
  sessionName: string;
};

type BulkConnectResult = BulkConnectEntry & {
  status: 'created' | 'active' | 'failed';
  error?: string;
};

/**
 * Connect a list of entries in parallel, printing compact status badges when done.
 * Returns the per-entry results so callers can build summaries and exit codes.
 */
async function bulkConnectEntries(
  entries: BulkConnectEntry[],
  options: BulkConnectOptions
): Promise<BulkConnectResult[]> {
  // Pre-check which sessions are already live (for accurate status badges)
  const liveSet = new Set<string>();
  for (const { sessionName } of entries) {
    const session = await getSession(sessionName);
    if (session && getBridgeStatus(session) === 'live') {
      liveSet.add(sessionName);
    }
  }

  // Launch all connections in parallel (quiet mode — we display results below)
  const settled = await Promise.allSettled(
    entries.map(async ({ entry, sessionName, configFile }) =>
      connectSession(entry, sessionName, {
        ...options,
        config: configFile,
        skipDetails: true,
        quiet: true,
      })
    )
  );

  const results: BulkConnectResult[] = settled.map((outcome, i) => {
    const base = entries[i]!;
    if (outcome.status === 'fulfilled') {
      return { ...base, status: liveSet.has(base.sessionName) ? 'active' : 'created' };
    }
    const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    return { ...base, status: 'failed', error };
  });

  // Display badges in human mode
  if (options.outputMode === 'human') {
    for (const r of results) {
      const name = theme.cyan(r.sessionName);
      switch (r.status) {
        case 'created':
          console.log(`  ${theme.yellow('●')} ${name} ${theme.yellow('connecting')}`);
          break;
        case 'active':
          console.log(`  ${theme.green('●')} ${name} ${chalk.dim('already active')}`);
          break;
        case 'failed':
          console.log(
            `  ${theme.red('●')} ${name} ${theme.red('failed')}${r.error ? chalk.dim(` — ${r.error}`) : ''}`
          );
          break;
      }
    }
  }

  return results;
}

/**
 * Build a summary string and print it in human mode.
 */
function printBulkConnectSummary(
  results: BulkConnectResult[],
  options: { outputMode: OutputMode }
): { active: number; connecting: number; failed: number } {
  const active = results.filter((r) => r.status === 'active').length;
  const connecting = results.filter((r) => r.status === 'created').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  if (options.outputMode === 'human' && results.length > 1) {
    const parts: string[] = [];
    if (active > 0) parts.push(`${active} already active`);
    if (connecting > 0) parts.push(`${connecting} connecting`);
    if (failed > 0) parts.push(`${failed} failed`);
    const summary = parts.join(', ');

    if (failed === 0) {
      console.log(formatSuccess(summary));
    } else if (active + connecting > 0) {
      console.log(formatWarning(summary));
    }
  }

  return { active, connecting, failed };
}

/**
 * Connect all servers defined in a config file, auto-generating session names from entry names.
 * Launches all bridge processes in parallel and displays status badges when done.
 */
export async function connectAllFromConfig(
  configFile: string,
  options: BulkConnectOptions
): Promise<void> {
  const config = loadConfig(configFile);
  const allNames = listServers(config);

  if (allNames.length === 0) {
    throw new ClientError(`No servers found in config file: ${configFile}`);
  }

  // Filter out stdio entries unless --stdio is passed. Stdio entries execute
  // arbitrary local commands via child_process.spawn(), so bulk-connect
  // operations default to skipping them to mitigate supply-chain risk from
  // malicious config files.
  const stdioSkipped: string[] = [];
  const serverNames = allNames.filter((name) => {
    if (!options.stdio && isStdioEntry(config, name)) {
      stdioSkipped.push(name);
      return false;
    }
    return true;
  });

  if (serverNames.length === 0) {
    if (options.outputMode === 'json') {
      const skippedEntries: ConnectResultEntry[] = stdioSkipped.map((entry) => ({
        _mcpc: {
          sessionName: generateSessionName({ type: 'config', file: configFile, entry }),
          configFile,
          entry,
          status: 'skipped',
          skipReason: 'stdio',
        },
      }));
      console.log(formatOutput(skippedEntries, 'json'));
      return;
    }
    throw new ClientError(
      `All ${allNames.length} server${allNames.length === 1 ? '' : 's'} in ${configFile} use stdio transport.\n` +
        `Pass --stdio to include them: mcpc connect ${configFile} --stdio`
    );
  }

  if (options.outputMode === 'human') {
    console.log(
      theme.cyan(
        `Connecting ${serverNames.length} server${serverNames.length === 1 ? '' : 's'} from ${configFile}...`
      )
    );
    if (stdioSkipped.length > 0) {
      console.log(
        chalk.dim(
          `  skipping ${stdioSkipped.length} stdio server${stdioSkipped.length === 1 ? '' : 's'} ` +
            `(${stdioSkipped.join(', ')}), pass --stdio to include`
        )
      );
    }
  }

  // Prepare entries with deterministic session names derived from entry names.
  // Re-running `mcpc connect <file>` reuses existing sessions via connectSession's
  // "already active" path instead of creating @entry-2 duplicates.
  const entries: BulkConnectEntry[] = serverNames.map((entry) => ({
    configFile,
    entry,
    sessionName: generateSessionName({ type: 'config', file: configFile, entry }),
  }));

  const results = await bulkConnectEntries(entries, options);

  if (options.outputMode === 'json') {
    const resultEntries = await buildBulkConnectEntries(results, options);
    const skippedEntries: ConnectResultEntry[] = stdioSkipped.map((entry) => ({
      _mcpc: {
        sessionName: generateSessionName({ type: 'config', file: configFile, entry }),
        configFile,
        entry,
        status: 'skipped',
        skipReason: 'stdio',
      },
    }));
    console.log(formatOutput([...resultEntries, ...skippedEntries], 'json'));
    return;
  }

  const { active, connecting, failed } = printBulkConnectSummary(results, options);

  // If ALL servers failed, exit with error
  if (active + connecting === 0 && failed > 0) {
    throw new ClientError(`Failed to connect any servers from ${configFile}`);
  }
}

/**
 * For each bulk-connect result, build a ConnectResultEntry. Successful entries
 * fetch the InitializeResult via the bridge in parallel; failed entries get a
 * minimal `_mcpc`-only entry. If a successful entry's bridge isn't responsive
 * yet, it's downgraded to `failed`.
 */
async function buildBulkConnectEntries(
  results: BulkConnectResult[],
  options: { verbose?: boolean; timeout?: number }
): Promise<ConnectResultEntry[]> {
  return await Promise.all(
    results.map(async (r): Promise<ConnectResultEntry> => {
      if (r.status === 'failed') {
        return {
          _mcpc: {
            sessionName: r.sessionName,
            configFile: r.configFile,
            entry: r.entry,
            status: 'failed',
            ...(r.error && { error: r.error }),
          },
        };
      }
      try {
        return await buildConnectResultEntry(r.sessionName, r.status, {
          ...(options.verbose && { verbose: options.verbose }),
          ...(options.timeout !== undefined && { timeout: options.timeout }),
          configFile: r.configFile,
          entry: r.entry,
        });
      } catch (err) {
        return {
          _mcpc: {
            sessionName: r.sessionName,
            configFile: r.configFile,
            entry: r.entry,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          },
        };
      }
    })
  );
}

type SkippedEntry = { configFile: string; entry: string; sessionName: string };

/**
 * Aggregate config entries from multiple discovered config files into a flat list of
 * bulk-connect entries. Resolves session-name collisions by taking the first occurrence
 * (project-scoped configs win over global ones due to discovery order).
 * When `stdio` is false/omitted, entries with a `command` field are filtered out.
 */
function aggregateDiscoveredEntries(
  discovered: DiscoveredConfig[],
  options: { stdio?: boolean }
): {
  entries: BulkConnectEntry[];
  skippedDuplicates: SkippedEntry[];
  skippedStdio: SkippedEntry[];
} {
  const entries: BulkConnectEntry[] = [];
  const skippedDuplicates: SkippedEntry[] = [];
  const skippedStdio: SkippedEntry[] = [];
  const seenNames = new Set<string>();

  for (const d of discovered) {
    for (const entry of Object.keys(d.config.mcpServers)) {
      const sessionName = generateSessionName({ type: 'config', file: d.path, entry });
      if (!options.stdio && isStdioEntry(d.config, entry)) {
        skippedStdio.push({ configFile: d.path, entry, sessionName });
        continue;
      }
      if (seenNames.has(sessionName)) {
        skippedDuplicates.push({ configFile: d.path, entry, sessionName });
        continue;
      }
      seenNames.add(sessionName);
      entries.push({
        configFile: d.path,
        entry,
        sessionName,
      });
    }
  }

  return { entries, skippedDuplicates, skippedStdio };
}

/**
 * Discover MCP config files in standard locations and connect all servers defined in them.
 *
 * Locations searched (in priority order):
 *   1. Project-level files in the current directory (.mcp.json, .cursor/mcp.json, ...)
 *   2. Global files in the user's home dir (~/.claude.json, ~/.cursor/mcp.json, ...)
 *   3. Platform-specific Claude Desktop config
 *
 * Entries with the same auto-generated session name across multiple configs are deduplicated —
 * the first occurrence wins. Re-running the command reuses existing sessions.
 */
export async function connectAllFromStandardConfigs(options: BulkConnectOptions): Promise<void> {
  const discovered = discoverMcpConfigFiles();

  const hasApifyToken = !!process.env.APIFY_API_TOKEN;

  if (discovered.length === 0 && !hasApifyToken) {
    if (options.outputMode === 'json') {
      console.log(formatOutput([] as ConnectResultEntry[], 'json'));
      return;
    }
    const searchPaths = getStandardMcpConfigPaths()
      .map((c) => `  ${c.path}`)
      .join('\n');
    throw new ClientError(
      `No MCP config files found in standard locations.\n\n` +
        `Searched:\n${searchPaths}\n\n` +
        `Connect a specific server:    mcpc connect mcp.example.com\n` +
        `Connect from a specific file: mcpc connect /path/to/mcp.json`
    );
  }

  // No config files but APIFY_API_TOKEN present — connect to Apify only
  if (discovered.length === 0) {
    await maybeConnectApify([], [], options);
    return;
  }

  const { entries, skippedDuplicates, skippedStdio } = aggregateDiscoveredEntries(discovered, {
    ...(options.stdio && { stdio: true }),
  });

  if (options.outputMode === 'human') {
    const totalEntries = entries.length + skippedDuplicates.length + skippedStdio.length;
    console.log(
      theme.cyan(
        `Found ${discovered.length} MCP config file${discovered.length === 1 ? '' : 's'} ` +
          `with ${totalEntries} server${totalEntries === 1 ? '' : 's'}:`
      )
    );

    // Group all entries (connected + skipped) by config file for display
    for (const d of discovered) {
      console.log(
        `  ${d.path} ${chalk.dim(`(${d.serverCount} server${d.serverCount === 1 ? '' : 's'})`)}`
      );
      for (const entryName of Object.keys(d.config.mcpServers)) {
        const sessionName = generateSessionName({ type: 'config', file: d.path, entry: entryName });
        const serverCfg = d.config.mcpServers[entryName];
        const target = serverCfg?.url ?? [serverCfg?.command, ...(serverCfg?.args ?? [])].join(' ');
        const truncated = target && target.length > 72 ? target.slice(0, 72) + '…' : target;

        const isStdio = skippedStdio.some((s) => s.configFile === d.path && s.entry === entryName);
        const isDuplicate = skippedDuplicates.some(
          (s) => s.configFile === d.path && s.entry === entryName
        );

        if (isStdio) {
          console.log(
            `    ${theme.cyan(sessionName)} → ${chalk.dim(truncated ?? entryName)} ${theme.yellow('○ skipped (stdio)')}`
          );
        } else if (isDuplicate) {
          console.log(
            `    ${theme.cyan(sessionName)} → ${chalk.dim(truncated ?? entryName)} ${chalk.dim('○ skipped (duplicate)')}`
          );
        } else {
          console.log(`    ${theme.cyan(sessionName)} → ${chalk.dim(truncated ?? entryName)}`);
        }
      }
    }

    if (entries.length === 0 && !hasApifyToken) {
      throw new ClientError(
        `All servers in discovered config files use stdio transport.\n` +
          `Pass --stdio to include them: mcpc connect --stdio`
      );
    }

    // Summary line
    const parts: string[] = [];
    if (entries.length > 0) {
      parts.push(`Connecting ${entries.length} server${entries.length === 1 ? '' : 's'}`);
    }
    if (skippedStdio.length > 0) {
      parts.push(
        `skipped ${skippedStdio.length} stdio server${skippedStdio.length === 1 ? '' : 's'}, pass --stdio to include`
      );
    }
    if (parts.length > 0) {
      console.log(theme.cyan(`\n${parts.join('. ')}.`));
    }
  }

  const skippedJsonEntries: ConnectResultEntry[] = [
    ...skippedStdio.map(
      (s): ConnectResultEntry => ({
        _mcpc: {
          sessionName: s.sessionName,
          configFile: s.configFile,
          entry: s.entry,
          status: 'skipped',
          skipReason: 'stdio',
        },
      })
    ),
    ...skippedDuplicates.map(
      (s): ConnectResultEntry => ({
        _mcpc: {
          sessionName: s.sessionName,
          configFile: s.configFile,
          entry: s.entry,
          status: 'skipped',
          skipReason: 'duplicate',
        },
      })
    ),
  ];

  if (entries.length === 0) {
    // No connectable entries from config files. If APIFY_API_TOKEN is set,
    // maybeConnectApify will still run below; otherwise we already threw above.
    if (!hasApifyToken && options.outputMode === 'json') {
      console.log(formatOutput(skippedJsonEntries, 'json'));
      return;
    }
    await maybeConnectApify([], [], options);
    return;
  }

  const results = await bulkConnectEntries(entries, options);

  if (options.outputMode === 'json') {
    const resultEntries = await buildBulkConnectEntries(results, options);
    console.log(formatOutput([...resultEntries, ...skippedJsonEntries], 'json'));
    return;
  }

  const { active, connecting, failed } = printBulkConnectSummary(results, options);

  // Auto-connect to mcp.apify.com when APIFY_API_TOKEN is set
  await maybeConnectApify(entries, results, options);

  // If ALL servers failed (excluding Apify), exit with error
  if (active + connecting === 0 && failed > 0) {
    throw new ClientError(`Failed to connect any servers from discovered config files`);
  }
}

const APIFY_MCP_URL = 'https://mcp.apify.com';
const APIFY_SESSION_NAME = '@apify';

/**
 * If APIFY_API_TOKEN is set and no @apify session was already handled by config discovery,
 * auto-connect to mcp.apify.com with the token as a Bearer header.
 */
async function maybeConnectApify(
  configEntries: BulkConnectEntry[],
  configResults: BulkConnectResult[],
  options: BulkConnectOptions
): Promise<void> {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return;

  // Skip if config discovery already produced an @apify session
  if (configEntries.some((e) => e.sessionName === APIFY_SESSION_NAME)) return;
  if (configResults.some((r) => r.sessionName === APIFY_SESSION_NAME)) return;

  // Check if session is already live
  const existing = await getSession(APIFY_SESSION_NAME);
  const isLive = existing && getBridgeStatus(existing) === 'live';

  if (options.outputMode === 'human') {
    console.log(theme.cyan(`\nAPIFY_API_TOKEN detected, connecting to ${APIFY_MCP_URL}...`));
  }

  if (isLive) {
    if (options.outputMode === 'human') {
      console.log(
        `  ${theme.green('●')} ${theme.cyan(APIFY_SESSION_NAME)} ${chalk.dim('already active')}`
      );
    }
    return;
  }

  try {
    await connectSession(APIFY_MCP_URL, APIFY_SESSION_NAME, {
      outputMode: options.outputMode,
      ...(options.verbose && { verbose: true }),
      headers: [`Authorization: Bearer ${token}`],
      skipDetails: true,
      quiet: true,
      noProfile: true,
    });
    if (options.outputMode === 'human') {
      console.log(
        `  ${theme.yellow('●')} ${theme.cyan(APIFY_SESSION_NAME)} ${theme.yellow('connecting')}`
      );
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (options.outputMode === 'human') {
      console.log(
        `  ${theme.red('●')} ${theme.cyan(APIFY_SESSION_NAME)} ${theme.red('failed')}${chalk.dim(` — ${msg}`)}`
      );
    }
  }
}

/**
 * Open an interactive shell for a target
 */
export async function openShell(target: string): Promise<void> {
  console.error(
    formatWarning('The "shell" command is deprecated and will be removed in a future release.')
  );
  // Import shell dynamically to avoid circular dependencies
  const { startShell } = await import('../shell.js');
  await startShell(target);
}
