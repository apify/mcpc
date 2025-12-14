/**
 * Sessions command handlers
 */

import type { OutputMode } from '../../lib/types.js';
import { formatOutput, formatSuccess, logTarget } from '../output.js';

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
    console.log(`  Target: ${target}`);
    console.log(`\nUse "mcpc ${name} tools-list" to list available tools.`);
  } else {
    console.log(
      formatOutput(
        {
          session: name,
          target,
          created: true,
        },
        'json'
      )
    );
  }
}

/**
 * List active sessions
 */
export async function listSessions(options: { outputMode: OutputMode }): Promise<void> {
  // TODO: Read from sessions.json

  const mockSessions: Array<{
    sessionName: string;
    server: string;
    transport: string;
    createdAt: Date;
  }> = [
    {
      sessionName: 'apify',
      server: 'https://mcp.apify.com',
      transport: 'http',
      createdAt: new Date(),
    },
    {
      sessionName: 'local',
      server: 'node server.js',
      transport: 'stdio',
      createdAt: new Date(),
    },
  ];

  if (options.outputMode === 'json') {
    console.log(formatOutput(mockSessions, 'json'));
  } else {
    if (mockSessions.length === 0) {
      console.log('No active sessions.');
    } else {
      console.log('Active sessions:');
      for (const session of mockSessions) {
        console.log(`  @${session.sessionName} → ${session.server} (${session.transport})`);
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
 * Get server instructions
 */
export async function getInstructions(
  target: string,
  options: { outputMode: OutputMode }
): Promise<void> {
  // TODO: Connect to MCP server using target and get instructions

  const mockInstructions = `Instructions for ${target}:

This is a placeholder for server-provided instructions.
Instructions would typically explain how to use the server's tools and resources.`;

  if (options.outputMode === 'human') {
    logTarget(target, options.outputMode);
    console.log('');
    console.log(mockInstructions);
  } else {
    console.log(
      formatOutput(
        {
          target,
          instructions: mockInstructions,
        },
        'json'
      )
    );
  }
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
