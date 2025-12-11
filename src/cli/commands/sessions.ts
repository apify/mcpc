/**
 * Sessions command handlers
 */

import type { OutputMode } from '../../lib/types.js';
import { formatOutput, formatSuccess } from '../output.js';

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
    name: string;
    target: string;
    transport: string;
    createdAt: string;
  }> = [
    {
      name: 'apify',
      target: 'https://mcp.apify.com',
      transport: 'http',
      createdAt: new Date().toISOString(),
    },
    {
      name: 'local',
      target: 'node server.js',
      transport: 'stdio',
      createdAt: new Date().toISOString(),
    },
  ];

  if (options.outputMode === 'json') {
    // Rename fields for JSON output
    const sessionsForJson = mockSessions.map((s) => ({
      sessionName: s.name,
      server: s.target,
      transport: s.transport,
      createdAt: s.createdAt,
    }));
    console.log(formatOutput(sessionsForJson, 'json'));
  } else {
    if (mockSessions.length === 0) {
      console.log('No active sessions.');
    } else {
      console.log('Active sessions:');
      for (const session of mockSessions) {
        console.log(`  @${session.name} → ${session.target} (${session.transport})`);
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
    console.log(`[Using target: ${target}]\n`);
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
  _options: { outputMode: OutputMode }
): Promise<void> {
  // TODO: Implement interactive shell using @inquirer/prompts

  console.log(`[Using target: ${target}]`);
  console.log('Interactive shell not implemented yet.');
  console.log('This would provide a REPL interface with:');
  console.log('  - Command history (saved to ~/.mcpc/history)');
  console.log('  - Tab completion for commands and tool names');
  console.log('  - Multi-line editing');
  console.log('  - Prompt showing session name');
}
