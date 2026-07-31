/**
 * Connect command handlers.
 *
 * Everything here *creates* sessions: connecting a single target, every entry in a
 * config file, or every server found by config discovery. The lifecycle of sessions
 * that already exist (list, close, restart, show details) lives in sessions.ts, from
 * which this module borrows the shared status/display helpers.
 */

import { createServer } from 'net';
import {
  OutputMode,
  isValidSessionName,
  generateSessionName,
  normalizeServerUrl,
  validateProfileName,
  redactHeaders,
  AuthError,
  ClientError,
  isAuthenticationError,
  createServerAuthError,
} from '../../lib/index.js';
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
  formatPath,
  formatConnectStatusBadge,
  theme,
} from '../output.js';
import { withMcpClient, resolveTarget, resolveAuthProfile } from '../helpers.js';
// Imported directly (not via the core barrel) so the CLI doesn't eagerly load the MCP SDK
import { isSupportedProtocolVersion, SUPPORTED_PROTOCOL_VERSIONS } from '../../core/protocol.js';
import {
  deleteSession,
  saveSession,
  updateSession,
  getSession,
  loadSessions,
} from '../../lib/sessions.js';
import { startBridge, StartBridgeOptions, stopBridge } from '../../lib/bridge-manager.js';
import {
  storeKeychainSessionHeaders,
  storeKeychainProxyBearerToken,
} from '../../lib/auth/keychain.js';
import { getWallet } from '../../lib/wallets.js';
import chalk from 'chalk';
// ora is loaded lazily at the spinner call site — it is only needed for
// human-mode bulk connects and costs ~50 ms at import.
import { createLogger } from '../../lib/logger.js';
import { parseProxyArg } from '../parser.js';
import {
  loadConfig,
  listServers,
  isStdioEntry,
  scanMcpConfigFiles,
  getStandardMcpConfigPaths,
  type DiscoveredConfig,
  type McpConfigScan,
} from '../../lib/config.js';
import { getBridgeStatus, showServerDetails, statelessField } from './sessions.js';

const logger = createLogger('connect');

/**
 * Check if a port is available for binding
 */
async function checkPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once('error', () => {
      // EADDRINUSE, permission denied, etc. — treat as unavailable
      resolve(false);
    });

    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.listen(port, host);
  });
}

// =============================================================================
// Single-target connect
// =============================================================================

/**
 * One entry in the unified JSON array returned by `mcpc connect`.
 * Mirrors the server's handshake result — MCP `InitializeResult` on 2025-11-25
 * connections, `DiscoverResult` on 2026-07-28 ones (see `ServerDetails`) — extended with
 * `toolNames` and an `_mcpc` metadata block. The same shape is used for both
 * single-server and multi-server connects so consumers can always treat the output as an
 * array.
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
    stateless?: boolean | null; // true=stateless, false=stateful, null=not yet determined
  };
} & Partial<
  Pick<
    ServerDetails,
    | 'protocolVersion'
    | 'supportedVersions'
    | 'capabilities'
    | 'serverInfo'
    | 'instructions'
    | '_meta'
  >
> & {
    toolNames?: string[];
  };

/**
 * Options accepted by `connectSession`.
 */
type ConnectSessionOptions = {
  outputMode: OutputMode;
  verbose?: boolean;
  config?: string;
  headers?: string[];
  timeoutSecs?: number;
  profile?: string;
  noProfile?: boolean;
  proxy?: string;
  proxyBearerToken?: string;
  protocolVersion?: string;
  x402?: X402SchemePreference;
  insecure?: boolean;
  skipDetails?: boolean;
  quiet?: boolean;
};

/**
 * Connect to a session via the bridge and build a populated ConnectResultEntry from its
 * server details and tools list. The entry's `_mcpc.server` headers are redacted.
 */
async function buildConnectResultEntry(
  sessionName: string,
  status: 'created' | 'active',
  options: {
    verbose?: boolean;
    timeoutSecs?: number;
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
      ...(options.timeoutSecs !== undefined && { timeoutSecs: options.timeoutSecs }),
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
          ...(serverDetails.transport && { transport: serverDetails.transport }),
          ...statelessField(serverDetails.connectionMode),
        },
        ...(serverDetails.protocolVersion && { protocolVersion: serverDetails.protocolVersion }),
        ...(serverDetails.supportedVersions && {
          supportedVersions: serverDetails.supportedVersions,
        }),
        ...(serverDetails.capabilities && { capabilities: serverDetails.capabilities }),
        ...(serverDetails.serverInfo && { serverInfo: serverDetails.serverInfo }),
        ...(serverDetails.instructions && { instructions: serverDetails.instructions }),
        ...(serverDetails._meta && { _meta: serverDetails._meta }),
        ...(tools.length > 0 && { toolNames: tools.map((t) => t.name) }),
      };
    }
  );
}

/**
 * Render a freshly connected (or already-active) session's details: a single-element
 * ConnectResultEntry array in JSON mode, or human-readable server details. Both branches
 * block until the bridge has finished its MCP handshake, so this throws if the server
 * never responds.
 */
async function renderConnectedSession(
  name: string,
  status: 'created' | 'active',
  options: ConnectSessionOptions
): Promise<void> {
  if (options.outputMode === 'json') {
    const entry = await buildConnectResultEntry(name, status, {
      ...(options.verbose && { verbose: options.verbose }),
      ...(options.timeoutSecs !== undefined && { timeoutSecs: options.timeoutSecs }),
    });
    console.log(formatOutput([entry], 'json'));
  } else {
    await showServerDetails(name, { ...options, hideTarget: false });
  }
}

/**
 * Reject a pinned protocol version that mcpc cannot speak, before any connection is attempted.
 * A pin can come from `--protocol-version` or from a config entry's `protocolVersion` field,
 * so both are checked and get the same error.
 */
function assertSupportedProtocolVersion(version: string | undefined): void {
  if (version && !isSupportedProtocolVersion(version)) {
    throw new ClientError(
      `Unsupported MCP protocol version: ${version}\n` +
        `Supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`
    );
  }
}

/**
 * Creates a new session, starts a bridge process, and instructs it to connect an MCP server.
 * If session already exists with crashed bridge, reconnects it automatically
 */
export async function connectSession(
  target: string,
  name: string,
  options: ConnectSessionOptions
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

  // Validate --protocol-version (if provided)
  assertSupportedProtocolVersion(options.protocolVersion);

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
        await renderConnectedSession(name, 'active', options);
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

  // Re-check the effective pin, which may come from a config entry's `protocolVersion`
  assertSupportedProtocolVersion(serverConfig.protocolVersion);

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
  if (serverConfig.headers && Object.keys(serverConfig.headers).length > 0) {
    headers = { ...serverConfig.headers };
    logger.debug(`Storing ${Object.keys(headers).length} headers for session ${name} in keychain`);
    await storeKeychainSessionHeaders(name, headers);
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
      serverConfig,
      verbose: options.verbose || false,
      ...(headers && { headers }),
      ...(profileName && { profileName }),
      ...(proxyConfig && { proxyConfig }),
      ...(options.x402 && { x402: options.x402 }),
      ...(options.insecure && { insecure: true }),
    };

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

  // When skipDetails is set (bulk connect), return as soon as the bridge is spawned, without
  // printing server details or waiting for the MCP handshake here. The bulk caller waits for
  // readiness afterward (bounded by --timeout) and reports each session as live or failed.
  if (options.skipDetails) {
    if (options.outputMode === 'human' && !options.quiet) {
      console.log(formatSuccess(`Session ${name} ${isReconnect ? 'reconnected' : 'created'}`));
    }
    return;
  }

  // Verify the connection works by rendering server details: renderConnectedSession blocks
  // until the bridge has connected (same health check in both human and JSON modes), so by
  // the time it returns or throws we have definitive bridge status.
  try {
    await renderConnectedSession(name, 'created', options);
    if (options.outputMode === 'human') {
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
      throw createServerAuthError(serverConfig.url || target, { sessionName: name });
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
      const pinHint = serverConfig.protocolVersion
        ? `  The session is pinned to MCP ${serverConfig.protocolVersion}. If the server does not\n` +
          `  support that version, reconnect without --protocol-version to auto-negotiate.\n`
        : '';
      console.log(
        formatWarning(
          `Session ${name} created but server is not responding: ${errorMsg}\n` +
            pinHint +
            `  The session will auto-recover when the server becomes available.\n` +
            `  Check status with: mcpc ${name}`
        )
      );
    }
    logger.debug(`showServerDetails failed for new session ${name}: ${errorMsg}`);
  }
}

// =============================================================================
// Session-name resolution (when @session is omitted)
// =============================================================================

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

// =============================================================================
// Bulk connect (config file / discovery)
// =============================================================================

/**
 * Shared options for bulk connect commands.
 */
type BulkConnectOptions = {
  outputMode: OutputMode;
  verbose?: boolean;
  headers?: string[];
  timeoutSecs?: number;
  profile?: string;
  noProfile?: boolean;
  proxy?: string;
  proxyBearerToken?: string;
  stdio?: boolean;
  protocolVersion?: string;
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
 * Build a `skipped` ConnectResultEntry for a config entry that wasn't connected
 * (stdio servers skipped without --stdio, or duplicate session names).
 */
function skippedConnectEntry(
  entry: { sessionName: string; configFile: string; entry: string },
  skipReason: 'stdio' | 'duplicate'
): ConnectResultEntry {
  return {
    _mcpc: {
      sessionName: entry.sessionName,
      configFile: entry.configFile,
      entry: entry.entry,
      status: 'skipped',
      skipReason,
    },
  };
}

/**
 * Wait for a freshly-spawned session's bridge to finish its MCP handshake.
 *
 * `getServerDetails` blocks until the bridge's MCP client connects, so this resolves once the
 * server has responded (or rejects on handshake failure / timeout). The wait is bounded by
 * `options.timeoutSecs` (the `--timeout` value, in seconds); without it the bridge's default
 * request timeout applies. Output is suppressed (json + hideTarget) so callers control all
 * rendering.
 */
async function waitForSessionReady(
  sessionName: string,
  options: { verbose?: boolean; timeoutSecs?: number }
): Promise<{ ready: true } | { ready: false; error: string }> {
  try {
    await withMcpClient(
      sessionName,
      {
        outputMode: 'json',
        hideTarget: true,
        ...(options.verbose && { verbose: options.verbose }),
        ...(options.timeoutSecs !== undefined && { timeoutSecs: options.timeoutSecs }),
      },
      async (client) => {
        await client.getServerDetails();
      }
    );
    return { ready: true };
  } catch (error) {
    return { ready: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Wait for each freshly-spawned ('created') session to finish its MCP handshake, resolving its
 * status to a terminal state: it stays 'created' if the server responded, or becomes 'failed'
 * (with the error) otherwise. Already-active and spawn-failed results pass through unchanged.
 * Waits run in parallel; `onSettled` fires as each entry settles so callers can show progress.
 */
async function waitForBulkConnectReady(
  results: BulkConnectResult[],
  options: { verbose?: boolean; timeoutSecs?: number },
  onSettled?: () => void
): Promise<BulkConnectResult[]> {
  return Promise.all(
    results.map(async (r): Promise<BulkConnectResult> => {
      try {
        if (r.status !== 'created') return r;
        const ready = await waitForSessionReady(r.sessionName, options);
        return ready.ready ? r : { ...r, status: 'failed', error: ready.error };
      } finally {
        onSettled?.();
      }
    })
  );
}

/**
 * Connect a list of entries in parallel, printing compact status badges when done.
 * Returns the per-entry results so callers can build summaries and exit codes.
 */
async function bulkConnectEntries(
  entries: BulkConnectEntry[],
  options: BulkConnectOptions,
  { printBadges = true }: { printBadges?: boolean } = {}
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

  let results: BulkConnectResult[] = settled.map((outcome, i) => {
    const base = entries[i]!;
    if (outcome.status === 'fulfilled') {
      return { ...base, status: liveSet.has(base.sessionName) ? 'active' : 'created' };
    }
    const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    return { ...base, status: 'failed', error };
  });

  // Wait for newly-spawned sessions to finish their MCP handshake before reporting status, so
  // human output matches --json (which waits in buildBulkConnectEntries) and single-target
  // connect. The wait is bounded by --timeout; a spinner shows live progress. JSON callers
  // resolve readiness later, so we only do the explicit wait here for human output.
  if (options.outputMode === 'human' && results.some((r) => r.status === 'created')) {
    const total = results.length;
    let done = 0;
    const { default: ora } = await import('ora');
    const spinner = ora(`Connecting to ${total} server${total === 1 ? '' : 's'}...`).start();
    results = await waitForBulkConnectReady(results, options, () => {
      done += 1;
      spinner.text = `Connecting to servers... (${done}/${total})`;
    });
    spinner.stop();
  }

  // Display badges in human mode (callers that render their own per-entry status,
  // e.g. config discovery, pass printBadges: false to suppress this block).
  if (options.outputMode === 'human' && printBadges) {
    for (const r of results) {
      const name = theme.cyan(r.sessionName);
      switch (r.status) {
        case 'created':
          console.log(`  ${theme.green('●')} ${name} ${theme.green('live')}`);
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
): { active: number; connected: number; failed: number } {
  const active = results.filter((r) => r.status === 'active').length;
  const connected = results.filter((r) => r.status === 'created').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  if (options.outputMode === 'human' && results.length > 1) {
    const parts: string[] = [];
    if (connected > 0) parts.push(`${connected} connected`);
    if (active > 0) parts.push(`${active} already active`);
    if (failed > 0) parts.push(`${failed} failed`);
    const summary = parts.join(', ');

    if (failed === 0) {
      console.log(formatSuccess(summary));
    } else if (active + connected > 0) {
      console.log(formatWarning(summary));
    }
  }

  return { active, connected, failed };
}

/**
 * For each bulk-connect result, build a ConnectResultEntry. Successful entries
 * fetch the InitializeResult via the bridge in parallel; failed entries get a
 * minimal `_mcpc`-only entry. If a successful entry's bridge isn't responsive
 * yet, it's downgraded to `failed`.
 */
async function buildBulkConnectEntries(
  results: BulkConnectResult[],
  options: { verbose?: boolean; timeoutSecs?: number }
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
          ...(options.timeoutSecs !== undefined && { timeoutSecs: options.timeoutSecs }),
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

  const toSkippedStdioEntry = (entry: string): ConnectResultEntry =>
    skippedConnectEntry(
      {
        sessionName: generateSessionName({ type: 'config', file: configFile, entry }),
        configFile,
        entry,
      },
      'stdio'
    );

  if (serverNames.length === 0) {
    if (options.outputMode === 'json') {
      console.log(formatOutput(stdioSkipped.map(toSkippedStdioEntry), 'json'));
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
    console.log(formatOutput([...resultEntries, ...stdioSkipped.map(toSkippedStdioEntry)], 'json'));
    // Same all-failed rule as human mode, signaled via exit code (rule: JSON
    // output stays clean; errors are indicated via exit codes)
    if (results.length > 0 && results.every((r) => r.status === 'failed')) {
      process.exitCode = 1;
    }
    return;
  }

  const { active, connected, failed } = printBulkConnectSummary(results, options);

  // If ALL servers failed, exit with error
  if (active + connected === 0 && failed > 0) {
    throw new ClientError(`Failed to connect any servers from ${configFile}`);
  }
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
 * Build the error shown when `mcpc connect` (no args) finds nothing to connect.
 *
 * Distinguishes "a config file exists but defines no servers" from "no config file exists
 * at all". The former is common — e.g. a freshly-created `{ "mcpServers": {} }` skeleton —
 * and must not be misreported as "No MCP config files found", which is confusing when the
 * file is sitting right there among the searched paths.
 */
function buildNoServersError(scan: McpConfigScan): string {
  if (scan.empty.length > 0 || scan.errors.length > 0) {
    const lines: string[] = [];
    if (scan.empty.length > 0) {
      lines.push(
        scan.empty.length === 1
          ? `Found a config file, but it defines no servers:`
          : `Found config files, but they define no servers:`
      );
      for (const c of scan.empty) lines.push(`  ${formatPath(c.path)}`);
    }
    if (scan.errors.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(
        scan.errors.length === 1
          ? `Found a config file, but it couldn't be used:`
          : `Found config files, but they couldn't be used:`
      );
      for (const c of scan.errors) lines.push(`  ${formatPath(c.path)} — ${c.error}`);
    }
    return (
      `No MCP servers to connect.\n\n` +
      `${lines.join('\n')}\n\n` +
      `Add a server under "mcpServers" and re-run mcpc connect, or connect one now:\n` +
      `  mcpc connect mcp.example.com @myserver`
    );
  }

  const searchPaths = getStandardMcpConfigPaths()
    .map((c) => `  ${formatPath(c.path)}`)
    .join('\n');
  return (
    `No MCP config files found in standard locations.\n\n` +
    `Searched:\n${searchPaths}\n\n` +
    `Connect a specific server:    mcpc connect mcp.example.com\n` +
    `Connect from a specific file: mcpc connect /path/to/mcp.json`
  );
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
  const scan = scanMcpConfigFiles();
  const { discovered } = scan;

  if (discovered.length === 0) {
    if (options.outputMode === 'json') {
      console.log(formatOutput([] as ConnectResultEntry[], 'json'));
      return;
    }
    throw new ClientError(buildNoServersError(scan));
  }

  const { entries, skippedDuplicates, skippedStdio } = aggregateDiscoveredEntries(discovered, {
    ...(options.stdio && { stdio: true }),
  });

  // Connect all non-skipped entries (quietly) so each server's result can be shown inline
  // next to its config entry. In human mode bulkConnectEntries waits for each handshake to
  // finish (bounded by --timeout), so the inline status reflects the real result (live/failed).
  const results =
    entries.length > 0 ? await bulkConnectEntries(entries, options, { printBadges: false }) : [];

  if (options.outputMode === 'json') {
    const skippedJsonEntries = [
      ...skippedStdio.map((s) => skippedConnectEntry(s, 'stdio')),
      ...skippedDuplicates.map((s) => skippedConnectEntry(s, 'duplicate')),
    ];
    if (entries.length === 0) {
      console.log(formatOutput(skippedJsonEntries, 'json'));
      return;
    }
    const resultEntries = await buildBulkConnectEntries(results, options);
    console.log(formatOutput([...resultEntries, ...skippedJsonEntries], 'json'));
    // Same all-failed rule as human mode, signaled via exit code
    if (results.length > 0 && results.every((r) => r.status === 'failed')) {
      process.exitCode = 1;
    }
    return;
  }

  // Human output: list each discovered config file and annotate every server entry with
  // its connection result (or skip reason) inline, within the context of its config file.
  const totalEntries = entries.length + skippedDuplicates.length + skippedStdio.length;
  const fileCount = discovered.length + scan.empty.length + scan.errors.length;
  console.log(
    theme.cyan(
      `Found ${fileCount} MCP config file${fileCount === 1 ? '' : 's'} ` +
        `with ${totalEntries} server${totalEntries === 1 ? '' : 's'}:`
    )
  );

  const statusByName = new Map(results.map((r) => [r.sessionName, r] as const));

  // A stdio server skipped (no --stdio) may already be live from an earlier
  // `mcpc connect --stdio`. Detect those so we show their real status instead of "skipped",
  // and only suggest --stdio when a stdio server is genuinely unconnected.
  const liveSkippedStdio = new Set<string>();
  for (const s of skippedStdio) {
    const session = await getSession(s.sessionName);
    if (session && getBridgeStatus(session) === 'live') {
      liveSkippedStdio.add(s.sessionName);
    }
  }
  const unconnectedStdio = skippedStdio.length - liveSkippedStdio.size;

  for (const d of discovered) {
    console.log(
      `  ${formatPath(d.path)} ${chalk.dim(`(${d.serverCount} server${d.serverCount === 1 ? '' : 's'})`)}`
    );
    for (const entryName of Object.keys(d.config.mcpServers)) {
      const sessionName = generateSessionName({ type: 'config', file: d.path, entry: entryName });
      const serverCfg = d.config.mcpServers[entryName];
      const target = serverCfg?.url ?? [serverCfg?.command, ...(serverCfg?.args ?? [])].join(' ');
      const truncated = target && target.length > 72 ? target.slice(0, 72) + '…' : target;

      let marker: string;
      if (skippedStdio.some((s) => s.configFile === d.path && s.entry === entryName)) {
        // Show a live badge for stdio servers that are already running; otherwise "skipped".
        marker = liveSkippedStdio.has(sessionName)
          ? formatConnectStatusBadge('active')
          : theme.yellow('○ skipped (stdio)');
      } else if (skippedDuplicates.some((s) => s.configFile === d.path && s.entry === entryName)) {
        marker = chalk.dim('○ skipped (duplicate)');
      } else {
        const r = statusByName.get(sessionName);
        marker = r ? formatConnectStatusBadge(r.status, r.error) : '';
      }

      console.log(
        `    ${theme.cyan(sessionName)} → ${chalk.dim(truncated ?? entryName)}${marker ? ` ${marker}` : ''}`
      );
    }
  }

  // Config files that exist but define no servers — list them so they're visibly
  // accounted for rather than silently dropped.
  for (const c of scan.empty) {
    console.log(`  ${formatPath(c.path)} ${chalk.dim('(0 servers)')}`);
  }

  // Config files that exist but couldn't be used (bad JSON, no servers, unreadable) — show
  // the reason inline.
  for (const c of scan.errors) {
    console.log(`  ${formatPath(c.path)} ${chalk.dim('(invalid)')}`);
    console.log(`    ${chalk.dim(c.error)}`);
  }

  // Nothing connectable and nothing already live — guide the user to --stdio.
  if (entries.length === 0 && liveSkippedStdio.size === 0) {
    throw new ClientError(
      `All servers in discovered config files use stdio transport.\n` +
        `Pass --stdio to include them: mcpc connect --stdio`
    );
  }

  // Only suggest --stdio when a stdio server isn't already connected.
  if (unconnectedStdio > 0) {
    console.log('\nTo include stdio servers, run: mcpc connect --stdio');
  }

  // If ALL connectable servers failed, exit with error
  const failed = results.filter((r) => r.status === 'failed').length;
  const succeeded = results.filter((r) => r.status === 'active' || r.status === 'created').length;
  if (entries.length > 0 && succeeded === 0 && failed > 0) {
    throw new ClientError(`Failed to connect any servers from discovered config files`);
  }
}
