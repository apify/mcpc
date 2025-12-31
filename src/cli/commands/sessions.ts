/**
 * Sessions command handlers
 */

import { OutputMode, isValidSessionName, validateProfileName, isProcessAlive, getServerHost, redactHeaders } from '../../lib/index.js';
import type { TransportConfig } from '../../lib/types.js';
import { formatOutput, formatSuccess, formatError, formatSessionLine, formatServerDetails } from '../output.js';
import { listAuthProfiles } from '../../lib/auth/profiles.js';
import {
  sessionExists,
  deleteSession,
  saveSession,
  updateSession,
  consolidateSessions,
} from '../../lib/sessions.js';
import { startBridge, StartBridgeOptions, stopBridge } from '../../lib/bridge-manager.js';
import { storeKeychainSessionHeaders } from '../../lib/auth/keychain.js';
import { resolveTarget, resolveAuthProfile } from '../helpers.js';
import { ClientError } from '../../lib/index.js';
import chalk from 'chalk';
import { createLogger } from '../../lib/logger.js';

const logger = createLogger('sessions');

/**
 * Creates a new session, starts a bridge process, and instructs it to connect an MCP server.
 * If session already exists with dead bridge, reconnects it automatically
 */
export async function connectSession(
  name: string,
  target: string,
  options: { outputMode: OutputMode; verbose?: boolean; config?: string; headers?: string[]; timeout?: number; profile?: string }
): Promise<void> {
  try {
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

    // Check if session already exists
    const existingSession = await import('../../lib/sessions.js').then((m) => m.getSession(name));
    if (existingSession) {
      const bridgeStatus = getBridgeStatus(existingSession);

      if (bridgeStatus === 'live') {
        // Session exists and bridge is running - just show server info
        if (options.outputMode === 'human') {
          console.log(formatSuccess(`Session ${name} is already active`));
        }
        await showServerDetails(name, { ...options, hideTarget: false });
        return;
      }

      // Bridge is dead or expired - reconnect with warning
      if (options.outputMode === 'human') {
        console.log(chalk.yellow(`Session ${name} exists but bridge is ${bridgeStatus}, reconnecting...`));
      }

      // Clean up old bridge resources before reconnecting
      try {
        await stopBridge(name);
      } catch {
        // Bridge may already be stopped
      }
    }

    // Resolve target to transport config
    const transportConfig = await resolveTarget(target, options);

    // For HTTP targets, resolve auth profile (with helpful errors if none available)
    let profileName: string | undefined;
    if (transportConfig.type === 'http' && transportConfig.url) {
      profileName = await resolveAuthProfile(
        transportConfig.url,
        target,
        options.profile,
        { sessionName: name }
      );
    }

    // Store headers in OS keychain (secure storage) before starting bridge
    // For OAuth sessions (with --profile), DON'T store the `Authorization` header
    // because it comes from the OAuth profile and may expire.
    // The bridge will get fresh tokens via the profile mechanism instead.
    let headers: Record<string, string> | undefined;
    if (transportConfig.type === 'http' && Object.keys(transportConfig.headers || {}).length > 0) {
      headers = { ...transportConfig.headers };

      // Remove OAuth-derived Authorization header - it will be handled via the profile
      if (profileName && headers.Authorization?.startsWith('Bearer ')) {
        logger.debug(`Skipping OAuth Authorization header storage for session ${name} (handled via profile)`);
        delete headers.Authorization;
      }

      // Only store remaining headers (from --header flags)
      if (Object.keys(headers).length > 0) {
        logger.debug(`Storing ${Object.keys(headers).length} headers for session ${name} in keychain`);
        await storeKeychainSessionHeaders(name, headers);
      } else {
        headers = undefined;
      }
    }

    // Create or update session record (without pid - that comes from startBridge)
    // Store transportConfig with headers redacted (actual values in keychain)
    const isReconnect = !!existingSession;
    const { headers: _originalHeaders, ...baseTransportConfig } = transportConfig;
    const sessionTransportConfig: TransportConfig = {
      ...baseTransportConfig,
      ...(headers && Object.keys(headers).length > 0 && { headers: redactHeaders(headers) }),
    };

    const sessionUpdate: Parameters<typeof updateSession>[1] = {
      transportConfig: sessionTransportConfig,
      ...(profileName && { profileName }),
    };

    if (isReconnect) {
      await updateSession(name, sessionUpdate);
      logger.debug(`Session record updated for reconnect: ${name}`);
    } else {
      await saveSession(name, { transportConfig: sessionTransportConfig, createdAt: new Date().toISOString(), ...sessionUpdate });
      logger.debug(`Initial session record created for: ${name}`);
    }

    // Start bridge process (handles spawning and IPC credential delivery)
    try {
      const bridgeOptions: StartBridgeOptions = {
        sessionName: name,
        transportConfig,
        verbose: options.verbose || false,
      };
      if (headers) {
        bridgeOptions.headers = headers;
      }
      if (profileName) {
        bridgeOptions.profileName = profileName;
      }

      const { pid } = await startBridge(bridgeOptions);

      // Update session with bridge info (socket path is computed from session name)
      await updateSession(name, { pid });
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

    // Success! Show server info like when running "mcpc <target>"
    console.log(formatSuccess(`Session ${name} ${isReconnect ? 'reconnected' : 'created'}`));

    // Display server info via the new session
    await showServerDetails(name, {
      ...options,
      hideTarget: false, // Show session info prefix
    });
  } catch (error) {
    if (options.outputMode === 'human') {
      console.error(formatError((error as Error).message));
    } else {
      console.log(
        formatOutput(
          {
            sessionName: name,
            target,
            created: false,
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
 * Determine bridge status for a session
 */
function getBridgeStatus(session: { status?: string; pid?: number }): 'live' | 'dead' | 'expired' {
  if (session.status === 'expired') {
    return 'expired';
  }
  if (!session.pid || !isProcessAlive(session.pid)) {
    return 'dead';
  }
  return 'live';
}

/**
 * Format bridge status for display with dot indicator
 */
function formatBridgeStatus(status: 'live' | 'dead' | 'expired'): { dot: string; text: string } {
  switch (status) {
    case 'live':
      return { dot: chalk.green('●'), text: chalk.green('live') };
    case 'dead':
      return { dot: chalk.yellow('○'), text: chalk.yellow('dead') };
    case 'expired':
      return { dot: chalk.red('○'), text: chalk.red('expired') };
  }
}

/**
 * Format time ago in human-friendly way
 */
function formatTimeAgo(isoDate: string | undefined): string {
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
 * Consolidates session state first (cleans up dead bridges, removes expired sessions)
 */
export async function listSessionsAndAuthProfiles(options: { outputMode: OutputMode }): Promise<void> {
  // Consolidate sessions first (cleans up dead bridges, removes expired sessions)
  const consolidateResult = await consolidateSessions(false);
  const sessions = Object.values(consolidateResult.sessions);

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
      console.log(chalk.dim('No active MCP sessions.'));
    } else {
      console.log(chalk.bold('MCP sessions:'));
      for (const session of sessions) {
        const status = getBridgeStatus(session);
        const { dot, text } = formatBridgeStatus(status);

        // Format status with time ago info (only show if not live or last seen > 5 min ago)
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
      }
    }

    // Display auth profiles
    console.log('');
    if (profiles.length === 0) {
      console.log(chalk.dim('No OAuth profiles.'));
    } else {
      console.log(chalk.bold('Available OAuth profiles:'));
      for (const profile of profiles) {
        const hostStr = getServerHost(profile.serverUrl);
        const nameStr = chalk.magenta(profile.name);
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

    // Stop the bridge process
    await stopBridge(name);

    // Delete session record from storage
    await deleteSession(name);

    // Success!
    if (options.outputMode === 'human') {
      console.log(formatSuccess(`Session ${name} closed successfully`));
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
      console.log(
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
  const { withMcpClient } = await import('../helpers.js');

  await withMcpClient(target, options, async (client) => {
    const serverDetails = await client.getServerDetails();
    const { serverInfo, capabilities, instructions, protocolVersion } = serverDetails;

    if (options.outputMode === 'human') {
      console.log(formatServerDetails(serverDetails, target));
    } else {
      // JSON output - structure matches MCP InitializeResult for consistency
      // Only include capabilities that are present
      const jsonCapabilities: Record<string, unknown> = {};

      if (capabilities?.tools) {
        jsonCapabilities.tools = {
          listChanged: capabilities.tools.listChanged || false,
        };
      }

      if (capabilities?.resources) {
        jsonCapabilities.resources = {
          subscribe: capabilities.resources.subscribe || false,
          listChanged: capabilities.resources.listChanged || false,
        };
      }

      if (capabilities?.prompts) {
        jsonCapabilities.prompts = {
          listChanged: capabilities.prompts.listChanged || false,
        };
      }

      if (capabilities?.logging) {
        jsonCapabilities.logging = {};
      }

      if (capabilities?.completions) {
        jsonCapabilities.completions = {};
      }

      // Build available commands list based on capabilities
      const availableCommands: string[] = [];

      if (capabilities?.tools) {
        availableCommands.push('tools-list', 'tools-schema', 'tools-call');
      }

      if (capabilities?.resources) {
        availableCommands.push('resources-list', 'resources-read');
        if (capabilities.resources.subscribe) {
          availableCommands.push('resources-subscribe', 'resources-unsubscribe');
        }
      }

      if (capabilities?.prompts) {
        availableCommands.push('prompts-list', 'prompts-get');
      }

      if (capabilities?.logging) {
        availableCommands.push('logging-set-level');
      }

      availableCommands.push('shell');

      // Output matches MCP InitializeResult structure
      console.log(
        formatOutput(
          {
            // mcpc-specific additions
            // TODO: I think we should prefix them with "mcpc" or "x-"
            target,
            availableCommands,
            // MCP specs fields
            protocolVersion: protocolVersion || null,
            capabilities: jsonCapabilities,
            serverInfo: serverInfo || null,
            instructions: instructions || null,
          },
          'json'
        )
      );
    }
  });
}

/**
 * Show help for a server (alias for getInstructions)
 */
export async function showHelp(
  target: string,
  options: { outputMode: OutputMode }
): Promise<void> {
  await showServerDetails(target, options);
}

/**
 * Open an interactive shell for a target
 */
export async function openShell(target: string): Promise<void> {
  // Import shell dynamically to avoid circular dependencies
  const { startShell } = await import('../shell.js');
  await startShell(target);
}
