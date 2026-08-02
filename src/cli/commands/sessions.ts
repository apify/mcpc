/**
 * Session command handlers.
 *
 * These operate on sessions that already exist — listing them, showing server details,
 * closing, and restarting — plus the shared status/display helpers used across the CLI.
 * Creating sessions (single, config-file, and discovery connects) lives in connect.ts.
 */

import {
  OutputMode,
  isProcessAlive,
  getServerHost,
  redactHeaders,
  ClientError,
} from '../../lib/index.js';
import { DISCONNECTED_THRESHOLD_MILLIS } from '../../lib/types.js';
import type { ServerConfig, ConnectionMode } from '../../lib/types.js';
import {
  formatOutput,
  formatSuccess,
  formatSessionLine,
  formatServerDetails,
  formatTimeAgo,
  theme,
} from '../output.js';
import { withMcpClient, resolveAuthProfile } from '../helpers.js';
import { listAuthProfiles } from '../../lib/auth/profiles.js';
import {
  sessionExists,
  deleteSession,
  updateSession,
  consolidateSessions,
  getSession,
} from '../../lib/sessions.js';
import {
  startBridge,
  StartBridgeOptions,
  stopBridge,
  reconnectCrashedSessions,
} from '../../lib/bridge-manager.js';
import chalk from 'chalk';
import { createLogger } from '../../lib/logger.js';
import { getBridgeLogPath } from '../../lib/log-reader.js';

const logger = createLogger('sessions');

// Re-exported for existing importers (moved to output.ts so formatServerDetails can use it)
export { formatTimeAgo } from '../output.js';

/**
 * Map the internal `connectionMode` enum to the public `--json` `stateless` field:
 * `true` for stateless connections, `false` for stateful ones, and `null` when the mode
 * is unknown / not yet determined. The field is always present, so consumers see a stable
 * schema (`stateless` is `true | false | null`, never absent on connected targets).
 */
export function statelessField(connectionMode: ConnectionMode | undefined): {
  stateless: boolean | null;
} {
  if (connectionMode === 'stateless') return { stateless: true };
  if (connectionMode === 'stateful') return { stateless: false };
  return { stateless: null };
}

export type DisplayStatus =
  'live' | 'connecting' | 'reconnecting' | 'disconnected' | 'crashed' | 'unauthorized' | 'expired';

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
    const lastSeenMillis = Date.now() - new Date(session.lastSeenAt).getTime();
    if (lastSeenMillis > DISCONNECTED_THRESHOLD_MILLIS) {
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
 * List active sessions and authentication profiles
 * Consolidates session state first (cleans up crashed bridges, removes expired sessions)
 */
export async function listSessionsAndAuthProfiles(options: {
  outputMode: OutputMode;
}): Promise<{ hasSessions: boolean }> {
  // Consolidate sessions first (cleans up crashed bridges, removes expired sessions)
  const consolidateResult = await consolidateSessions(false);
  const sessions = Object.values(consolidateResult.sessions);

  // Auto-restart crashed bridges in the background (fire-and-forget)
  reconnectCrashedSessions(consolidateResult.sessionsToRestart);

  // Load auth profiles from disk
  const profiles = await listAuthProfiles();

  if (options.outputMode === 'json') {
    // Add bridge status to JSON output. The persisted `connectionMode` enum (stored in
    // sessions.json) is mapped to the public `stateless` field here so the list output
    // matches `mcpc @<session>` and `mcpc connect` (null until the mode is known).
    // Server instructions are persisted for session resumption but kept out of the list —
    // they can be kilobytes per session. Only their presence is reported, as
    // `hasInstructions` (they are not part of the advertised capabilities); read the text
    // itself with `mcpc --json @<session>`.
    const sessionsWithStatus = sessions.map(({ connectionMode, instructions, ...session }) => ({
      ...session,
      status: getBridgeStatus(session),
      ...statelessField(connectionMode),
      hasInstructions: !!instructions,
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
      console.log(chalk.dim('↳ run: mcpc connect mcp.example.com @test'));
    } else {
      console.log(chalk.bold('MCP sessions:'));
      for (const session of sessions) {
        const status = getBridgeStatus(session);
        const { dot, text } = formatBridgeStatus(status);

        // Format status with time ago info (show for non-live states and stale live sessions)
        let statusStr = `${dot} ${text}`;
        if (session.lastSeenAt) {
          const lastSeenMillis = Date.now() - new Date(session.lastSeenAt).getTime();
          const isStale = lastSeenMillis > 5 * 60 * 1000; // 5 minutes
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
        } else if (status === 'disconnected') {
          // Bridge is alive and auto-recovers when the server responds again;
          // a restart forces a fresh connection if it stays stuck.
          console.log(chalk.dim(`    ↳ run: mcpc ${session.name} restart`));
        }
      }
    }

    // Display auth profiles
    console.log('');
    if (profiles.length === 0) {
      console.log(chalk.bold('No OAuth profiles.'));
      console.log(chalk.dim('↳ run: mcpc login mcp.example.com'));
    } else {
      console.log(chalk.bold('Saved OAuth profiles:'));
      for (const profile of profiles) {
        const hostStr = getServerHost(profile.serverUrl);
        const nameStr = theme.magenta(profile.name);
        // Client-credentials profiles have no user identity; label the grant instead.
        // Enterprise (id_jag) profiles carry the user identity from the IdP SSO —
        // append "enterprise" so they are distinguishable from plain OAuth logins.
        let annotation =
          profile.userEmail ||
          profile.userName ||
          (profile.oauthGrant === 'client_credentials' ? 'client credentials' : '');
        if (profile.oauthGrant === 'id_jag') {
          annotation = annotation ? `${annotation}, enterprise` : 'enterprise';
        }
        // Show refreshedAt if available, otherwise createdAt
        const timeAgo = formatTimeAgo(profile.refreshedAt || profile.createdAt);
        const timeLabel = profile.refreshedAt ? 'refreshed' : 'created';

        let line = `  ${hostStr} / ${nameStr}`;
        if (annotation) {
          line += chalk.dim(` (${annotation})`);
        }
        if (timeAgo) {
          line += chalk.dim(`, ${timeLabel} ${timeAgo}`);
        }
        console.log(line);
      }
    }
  }

  return { hasSessions: sessions.length > 0 };
}

/**
 * Close a session
 */
export async function closeSession(
  name: string,
  options: { outputMode: OutputMode }
): Promise<void> {
  // Errors propagate to the central handler in cli/index.ts, which owns error
  // rendering — printing here too would show every failure twice.

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
    timeoutSecs?: number;
    verbose?: boolean;
    hideTarget?: boolean;
  }
): Promise<void> {
  await withMcpClient(target, options, async (client, context) => {
    const serverDetails = await client.getServerDetails();
    const {
      serverInfo,
      capabilities,
      instructions,
      protocolVersion,
      supportedVersions,
      connectionMode,
      _meta,
    } = serverDetails;

    // Get tools list (uses bridge cache when available, no extra server call)
    const cachedToolsResult = await client.listAllTools();
    const tools = cachedToolsResult.tools;

    // Active resource→file syncs (resources-subscribe), maintained by the bridge
    // in sessions.json — read from disk, no server round-trip needed
    const sessionData = target.startsWith('@') ? await getSession(target) : undefined;
    const resourceSubscriptions = Object.values(sessionData?.resourceSubscriptions ?? {});

    if (options.outputMode === 'human') {
      console.log(
        formatServerDetails(
          serverDetails,
          target,
          tools,
          resourceSubscriptions,
          context.serverConfig?.protocolVersion
        )
      );
    } else {
      // JSON output MUST match the server's handshake result: MCP `InitializeResult` on
      // 2025-11-25 connections, `DiscoverResult` (`supportedVersions`, `_meta`) on
      // 2026-07-28 ones. `ServerDetails` reconciles the two — see its doc comment.
      // https://modelcontextprotocol.io/specification/2025-11-25/schema#initializeresult
      // https://modelcontextprotocol.io/specification/2026-07-28/schema#discoverresult
      // Build _mcpc.server with redacted headers for security
      const server: ServerConfig = {
        ...context.serverConfig,
        ...(context.serverConfig?.headers && {
          headers: redactHeaders(context.serverConfig.headers),
        }),
      };

      // The bridge log path is useful debug context for callers — only meaningful for
      // session targets (those starting with "@"); ad-hoc URL/config targets have no
      // persistent bridge log. The size is deliberately not emitted: it's a snapshot
      // that goes stale as the bridge keeps writing, and callers can stat `logPath`
      // (or run `mcpc @<session> logs`) for a fresh value when they actually need it.
      let logPath: string | undefined;
      if (target.startsWith('@')) {
        logPath = getBridgeLogPath(target);
      }

      console.log(
        formatOutput(
          {
            _mcpc: {
              sessionName: context.sessionName,
              profileName: context.profileName,
              server,
              ...(serverDetails.transport && { transport: serverDetails.transport }),
              ...statelessField(connectionMode),
              ...(logPath && { logPath }),
              ...(resourceSubscriptions.length > 0 && { resourceSubscriptions }),
            },
            protocolVersion,
            ...(supportedVersions && { supportedVersions }),
            capabilities,
            serverInfo,
            instructions,
            ...(_meta && { _meta }),
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
  // Get existing session
  const session = await getSession(name);

  if (!session) {
    throw new ClientError(`Session not found: ${name}`);
  }

  if (options.outputMode === 'human') {
    console.log(theme.yellow(`Restarting session ${name}...`));
  }

  // Stop the bridge (even if it's alive). Graceful so the old bridge sends an HTTP DELETE
  // to terminate its MCP session before exiting: an explicit restart starts a *fresh*
  // session (see the note below), so the previous server-side session must be released
  // rather than orphaned. On Windows SIGTERM is an immediate kill, so graceful mode sends
  // an IPC shutdown first; on Unix SIGTERM already triggers graceful shutdown.
  try {
    await stopBridge(name, { graceful: true });
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

  // Start bridge process.
  // NOTE: Do NOT pass mcpSessionId on explicit restart — a restart starts a fresh session
  // rather than resuming the old one. Session resumption is only attempted on automatic
  // bridge restart (when the bridge crashes and the CLI detects it); if the server rejects
  // the session ID, the session is marked as expired.
  const bridgeOptions: StartBridgeOptions = {
    sessionName: name,
    serverConfig: { ...serverConfig, ...(headers && { headers }) },
    verbose: options.verbose || false,
    ...(headers && { headers }),
    ...(profileName && { profileName }),
    ...(session.proxy && { proxyConfig: session.proxy }),
    ...(session.x402 && { x402: session.x402 }),
    ...(session.insecure && { insecure: session.insecure }),
  };

  const { pid } = await startBridge(bridgeOptions);

  // Update session with new bridge PID and clear any expired/crashed status
  await updateSession(name, { pid, status: 'active' });
  logger.debug(`Session ${name} restarted with bridge PID: ${pid}`);

  // Success message
  if (options.outputMode === 'human') {
    console.log(formatSuccess(`Session ${name} restarted`));
    console.log(
      chalk.dim(
        'Note: previous session state was lost (e.g. added tools, async tasks); resource subscriptions are re-established automatically'
      )
    );
  }

  // Show server details (like when creating a session)
  await showServerDetails(name, {
    ...options,
    hideTarget: false,
  });
}
