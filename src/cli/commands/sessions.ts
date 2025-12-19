/**
 * Sessions command handlers
 */

import type { OutputMode } from '../../lib/types.js';
import { formatOutput, formatSuccess, logTarget } from '../output.js';
import { listAuthProfiles } from '../../lib/auth-profiles.js';
import { listSessions } from '../../lib/sessions.js';

/**
 * Connect to an MCP server and create a session
 */
export async function connectSession(
  name: string,
  target: string,
  options: { outputMode: OutputMode }
): Promise<void> {
  // TODO: Create bridge process and session

  if (options.outputMode === 'human') {
    console.log(formatSuccess(`Session '${name}' created successfully`));
    console.log(`  MCP server: ${target}`);
    console.log(`\nUse "mcpc ${name} tools-list" to list available tools.`);
  } else {
    console.log(
      formatOutput(
        {
          sessionName: name,
          server: target,
          created: true,
        },
        'json'
      )
    );
  }
}

/**
 * List active sessions and authentication profiles
 */
export async function listSessionsAndAuthProfiles(options: { outputMode: OutputMode }): Promise<void> {
  // Load sessions from disk
  const sessions = await listSessions();

  // Load auth profiles from disk
  const authProfiles = await listAuthProfiles();

  if (options.outputMode === 'json') {
    console.log(
      formatOutput(
        {
          sessions,
          authProfiles,
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
        console.log(`  @${session.name} → ${session.target} (${session.transport})`);
      }
    }

    // Display auth profiles
    console.log('');
    if (authProfiles.length === 0) {
      console.log('No authentication profiles.');
    } else {
      console.log('Authentication profiles:');
      for (const profile of authProfiles) {
        const expiryInfo =
          profile.expiresAt && new Date(profile.expiresAt) > new Date()
            ? ` (expires ${new Date(profile.expiresAt).toLocaleDateString()})`
            : profile.expiresAt
              ? ' (expired)'
              : '';
        console.log(`  ${profile.name} → ${profile.serverUrl} (OAuth${expiryInfo})`);
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
  // TODO: Terminate bridge process and clean up

  if (options.outputMode === 'human') {
    console.log(formatSuccess(`Session '${name}' closed`));
  } else {
    console.log(
      formatOutput(
        {
          session: name,
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
export async function showServerInfo(
  target: string,
  options: {
    outputMode: OutputMode;
    config?: string;
    headers?: string[];
    timeout?: number;
    verbose?: boolean;
  }
): Promise<void> {
  const { withMcpClient } = await import('../helpers.js');

  await withMcpClient(target, options, async (client) => {
    const serverInfo = client.getServerVersion();
    const capabilities = client.getServerCapabilities();
    const instructions = client.getInstructions();
    const protocolVersion = client.getProtocolVersion();

    // Get tool count if tools are supported
    let toolCount = 0;
    if (capabilities?.tools) {
      const toolsResult = await client.listTools();
      toolCount = toolsResult.tools.length;
    }

    if (options.outputMode === 'human') {
      logTarget(target, options.outputMode);
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
          `  • tools: ${toolCount} available${capabilities.tools.listChanged ? ' (supports list change notifications)' : ''}`
        );
      }

      if (capabilities?.resources) {
        const features: string[] = [];
        if (capabilities.resources.subscribe) features.push('subscribe');
        if (capabilities.resources.listChanged) features.push('list change notifications');
        const featureStr = features.length > 0 ? ` (supports ${features.join(', ')})` : '';
        capabilityList.push(`  • resources${featureStr}`);
      }

      if (capabilities?.prompts) {
        const featureStr = capabilities.prompts.listChanged
          ? ' (supports list change notifications)'
          : '';
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
        commands.push(`  mcpc ${target} tools-call <name>`);
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
        console.log('Server instructions');
        console.log(instructions);
        console.log('');
      }
    } else {
      // JSON output - only include capabilities that are present
      const jsonCapabilities: Record<string, any> = {};

      if (capabilities?.tools) {
        jsonCapabilities.tools = {
          count: toolCount,
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
export async function openShell(
  target: string,
  options: { outputMode: OutputMode }
): Promise<void> {
  // TODO: Implement interactive shell using @inquirer/prompts

  logTarget(target, options.outputMode);
  console.log('Interactive shell not implemented yet.');
  console.log('This would provide a REPL interface with:');
  console.log('  - Command history (saved to ~/.mcpc/history)');
  console.log('  - Tab completion for commands and tool names');
  console.log('  - Multi-line editing');
  console.log('  - Prompt showing session name');
}
