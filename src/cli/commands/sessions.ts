/**
 * Sessions command handlers
 */

import { OutputMode, isValidSessionName, validateProfileName } from '../../lib/index.js';
import { formatOutput, formatSuccess, formatError } from '../output.js';
import { listAuthProfiles } from '../../lib/auth/auth-profiles.js';
import { listSessions, sessionExists, deleteSession, saveSession, updateSession } from '../../lib/sessions.js';
import { startBridge, stopBridge } from '../../lib/bridge-manager.js';
import { removeKeychainSessionHeaders, storeKeychainSessionHeaders } from '../../lib/auth/keychain.js';
import { resolveTarget } from '../helpers.js';
import { ClientError } from '../../lib/index.js';
import { createLogger } from '../../lib/logger.js';

const logger = createLogger('sessions');

/**
 * Connect to an MCP server and create a session
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
    if (await sessionExists(name)) {
      throw new ClientError(
        `Session already exists: ${name}\n` +
        `Use "mcpc ${name} close" to close it first, or choose a different name.`
      );
    }

    // Resolve target to transport config
    const transportConfig = await resolveTarget(target, options);

    // Store headers in OS keychain (secure storage) before starting bridge
    let headers: Record<string, string> | undefined;
    if (transportConfig.type === 'http' && transportConfig.headers && Object.keys(transportConfig.headers).length > 0) {
      headers = transportConfig.headers;
      logger.debug(`Storing ${Object.keys(headers).length} headers for session ${name} in keychain`);
      await storeKeychainSessionHeaders(name, headers);
    }

    // Create initial session record (without pid/socketPath - those come from startBridge)
    const now = new Date().toISOString();
    const sessionData: Parameters<typeof saveSession>[1] = {
      target: transportConfig.url || transportConfig.command || 'unknown',
      transport: transportConfig.type,
      createdAt: now,
      updatedAt: now,
      headerCount: Object.keys(headers || {}).length,
    };
    if (options.profile) {
      sessionData.profileName = options.profile;
    }
    await saveSession(name, sessionData);
    logger.debug(`Initial session record created for: ${name}`);

    // Start bridge process (handles spawning and IPC credential delivery)
    try {
      const bridgeOptions: Parameters<typeof startBridge>[0] = {
        sessionName: name,
        target: transportConfig,
        verbose: options.verbose || false,
      };
      if (headers) {
        bridgeOptions.headers = headers;
      }
      if (options.profile) {
        bridgeOptions.profileName = options.profile;
      }

      const { pid, socketPath } = await startBridge(bridgeOptions);

      // Update session with bridge info
      await updateSession(name, { pid, socketPath });
      logger.debug(`Session ${name} updated with bridge PID: ${pid}`);
    } catch (error) {
      // Clean up session record and headers on bridge start failure
      logger.debug(`Bridge start failed, cleaning up session ${name}`);
      try {
        await deleteSession(name);
      } catch {
        // Ignore cleanup errors
      }
      try {
        await removeKeychainSessionHeaders(name);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }

    // Success!
    if (options.outputMode === 'human') {
      console.log(formatSuccess(`Session ${name} created successfully`));
      // TODO: print MCP protocol version if available
      console.log(`  Server: ${transportConfig.url || target}`);
      console.log(`  Transport: ${transportConfig.type}`);
      console.log(`\nUse "mcpc ${name} tools-list" to list available tools.`);
      console.log(`Use "mcpc ${name} close" to terminate the session.`);
    } else {
      console.log(
        formatOutput(
          {
            sessionName: name,
            target,
            transport: transportConfig.type,
            created: true,
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
 * List active sessions and authentication profiles
 */
export async function listSessionsAndAuthProfiles(options: { outputMode: OutputMode }): Promise<void> {
  // Load sessions from disk
  const sessions = await listSessions();

  // Load auth profiles from disk
  const profiles = await listAuthProfiles();

  if (options.outputMode === 'json') {
    console.log(
      formatOutput(
        {
          sessions,
          profiles,
        },
        'json'
      )
    );
  } else {
    // Display sessions
    if (sessions.length === 0) {
      console.log('No active MCP sessions.');
    } else {
      console.log('Active MCP sessions:');
      for (const session of sessions) {
        const statusInfo = session.status === 'expired' ? ' [EXPIRED]' : '';
        console.log(`  ${session.name} → ${session.target} (${session.transport})${statusInfo}`);
      }
    }

    // Display auth profiles
    console.log('');
    if (profiles.length === 0) {
      console.log('No authentication profiles.');
    } else {
      console.log('Authentication profiles:');
      for (const profile of profiles) {
        console.log(`  ${profile.name} → ${profile.serverUrl} (OAuth)`);
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
    logger.debug(`Deleted session record: ${name}`);

    // Delete headers from keychain (if any)
    try {
      await removeKeychainSessionHeaders(name);
      logger.debug(`Deleted headers from keychain for session: ${name}`);
    } catch {
      // Ignore errors - headers may not exist
    }

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
    const serverInfo = await client.getServerVersion();
    const capabilities = await client.getServerCapabilities();
    const instructions = await client.getInstructions();
    const protocolVersion = await client.getProtocolVersion();

    // Get tools if supported
    let toolNames: string[] = [];
    if (capabilities?.tools) {
      const toolsResult = await client.listTools();
      toolNames = toolsResult.tools.map((tool) => tool.name);
    }

    if (options.outputMode === 'human') {
      console.log('');

      // Server info
      if (serverInfo) {
        const versionInfo = protocolVersion ? ` (MCP version: ${protocolVersion})` : '';
        console.log(`Server: ${serverInfo.name} v${serverInfo.version}${versionInfo}`);
        console.log('');
      }

      // Capabilities - only show what the server actually exposes
      console.log('Capabilities:');

      const capabilityList: string[] = [];

      if (capabilities?.tools) {
        capabilityList.push(
          `  • tools ${capabilities.tools.listChanged ? '(dynamic)' : '(static)'}`
        );
        if (toolNames.length > 0) {
          capabilityList[capabilityList.length - 1] += `: ` + toolNames.join(', ');
        }
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
          names: toolNames,
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
            server: serverInfo,
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
