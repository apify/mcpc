/**
 * Sessions command handlers
 */

import { OutputMode, isValidSessionName, validateProfileName, isProcessAlive, getServerHost } from '../../lib/index.js';
import { formatOutput, formatSuccess, formatError } from '../output.js';
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
 * Connect to an MCP server and create a session
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
        await showServerInfo(name, { ...options, hideTarget: false });
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
    const isReconnect = !!existingSession;
    if (isReconnect) {
      // Update existing session, preserving createdAt
      const updateData: Parameters<typeof updateSession>[1] = {
        target: transportConfig.url || transportConfig.command || 'unknown',
        transport: transportConfig.type,
        httpHeaderCount: Object.keys(headers || {}).length,
      };
      if (profileName) {
        updateData.profileName = profileName;
      }
      if (transportConfig.args && transportConfig.args.length > 0) {
        updateData.stdioArgs = transportConfig.args;
      }
      await updateSession(name, updateData);
      logger.debug(`Session record updated for reconnect: ${name}`);
    } else {
      // Create new session
      const sessionData: Parameters<typeof saveSession>[1] = {
        target: transportConfig.url || transportConfig.command || 'unknown',
        transport: transportConfig.type,
        createdAt: new Date().toISOString(),
        httpHeaderCount: Object.keys(headers || {}).length,
      };
      if (profileName) {
        sessionData.profileName = profileName;
      }
      if (transportConfig.args && transportConfig.args.length > 0) {
        sessionData.stdioArgs = transportConfig.args;
      }
      await saveSession(name, sessionData);
      logger.debug(`Initial session record created for: ${name}`);
    }

    // Start bridge process (handles spawning and IPC credential delivery)
    try {
      const bridgeOptions: StartBridgeOptions = {
        sessionName: name,
        target: transportConfig,
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
    await showServerInfo(name, {
      ...options,
      hideTarget: false, // Show session name prefix
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
 * Truncate string with ellipsis, if longer than +3 chars maxLen to avoid weird cutoffs
 */
function truncateishStr(str: string, maxLen: number): string {
  if (str.length <= maxLen + 3) return str;
  return str.substring(0, maxLen - 1) + '…';
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

        // Format session name (cyan)
        const nameStr = chalk.cyan(session.name);

        // Format target (show host for HTTP, command + args for stdio)
        let target: string;
        if (session.transport === 'http') {
          target = getServerHost(session.target);
        } else {
          // For stdio: show command + truncated args
          target = session.target;
          const args = session.stdioArgs;
          if (args && args.length > 0) {
            const argsStr = args.join(' ');
            target += ' ' + argsStr;
          }
        }
        const targetStr = truncateishStr(target, 80);

        // Format transport/auth column
        let authStr: string;
        if (session.transport === 'stdio') {
          authStr = chalk.dim('(stdio)');
        } else if (session.profileName) {
          authStr = chalk.dim('(http, oauth: ') + chalk.magenta(session.profileName) + chalk.dim(')');
        } else {
          authStr = chalk.dim('(http)');
        }

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

        console.log(`  ${nameStr} → ${targetStr}  ${authStr}  ${statusStr}`);
      }
    }

    // Display auth profiles
    console.log('');
    if (profiles.length === 0) {
      console.log(chalk.dim('No OAuth profiles.'));
    } else {
      console.log(chalk.bold('OAuth profiles:'));
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
export async function showServerInfo(
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
    const { serverVersion, capabilities, instructions, protocolVersion } = await client.getServerInfo();

    if (options.outputMode === 'human') {
      console.log('');

      // Server info
      if (serverVersion) {
        const versionInfo = protocolVersion ? ` (MCP version: ${protocolVersion})` : '';
        console.log(`Server: ${serverVersion.name} v${serverVersion.version}${versionInfo}`);
        console.log('');
      }

      // Capabilities - only show what the server actually exposes
      console.log('Capabilities:');

      const capabilityList: string[] = [];

      if (capabilities?.tools) {
        capabilityList.push(
          `  • tools ${capabilities.tools.listChanged ? '(dynamic)' : '(static)'}`
        );
      }

      if (capabilities?.resources) {
        const features: string[] = [];
        if (capabilities.resources.subscribe) features.push('subscribe');
        if (capabilities.resources.listChanged) features.push('dynamic list');
        const featureStr = features.length > 0 ? ` (supports ${features.join(', ')})` : '';
        capabilityList.push(`  • resources${featureStr}`);
      }

      if (capabilities?.prompts) {
        const featureStr = capabilities.prompts.listChanged ? ' (dynamic list)' : '';
        capabilityList.push(`  • prompts${featureStr}`);
      }

      if (capabilities?.logging) {
        capabilityList.push('  • logging');
      }

      if (capabilities?.completions) {
        capabilityList.push('  • completions');
      }

      if (capabilityList.length > 0) {
        console.log(capabilityList.join('\n'));
      } else {
        console.log('  (none)');
      }
      console.log('');

      // Commands
      console.log('Available commands:');
      const commands: string[] = [];

      if (capabilities?.tools) {
        commands.push(`  mcpc ${target} tools-list`);
        commands.push(`  mcpc ${target} tools-schema <name>`);
        commands.push(`  mcpc ${target} tools-call <name> [--args key=val ...] [--args-file <file>]`);
      }

      if (capabilities?.resources) {
        commands.push(`  mcpc ${target} resources-list`);
        commands.push(`  mcpc ${target} resources-read <uri>`);
      }

      if (capabilities?.prompts) {
        commands.push(`  mcpc ${target} prompts-list`);
        commands.push(`  mcpc ${target} prompts-get <name>`);
      }

      if (capabilities?.logging) {
        commands.push(`  mcpc ${target} logging-set-level <lvl> Set server log level`);
      }

      commands.push(`  mcpc ${target} shell`);

      console.log(commands.join('\n'));
      console.log('');

      // Instructions
      if (instructions) {
        console.log('Server instructions:');
        console.log(instructions);
        console.log('');
      }
    } else {
      // JSON output - only include capabilities that are present
      const jsonCapabilities: Record<string, any> = {};

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

      console.log(
        formatOutput(
          {
            target,
            server: serverVersion,
            instructions: instructions || null,
            capabilities: jsonCapabilities,
            availableCommands,
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
  await showServerInfo(target, options);
}

/**
 * Open an interactive shell for a target
 */
export async function openShell(target: string): Promise<void> {
  // Import shell dynamically to avoid circular dependencies
  const { startShell } = await import('../shell.js');
  await startShell(target);
}
