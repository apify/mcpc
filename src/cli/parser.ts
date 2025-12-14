/**
 * CLI argument parser using Commander.js
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { Command } from 'commander';
import type { ParsedArgs } from '../lib/types.js';

// Get version from package.json
const packageJson = { version: '0.1.0' }; // TODO: Import from package.json dynamically

/**
 * Create and configure the CLI parser
 */
export function createParser(): Command {
  const program = new Command();

  program
    .name('mcpc')
    .description('Command-line client for the Model Context Protocol (MCP)')
    .version(packageJson.version, '-v, --version', 'Output the version number')
    .option('-j, --json', 'Output in JSON format')
    .option('--verbose', 'Enable verbose logging')
    .option('-c, --config <path>', 'Path to MCP server config file')
    .helpOption('-h, --help', 'Display general help');

  // Connect command
  program
    .command('connect <name> <target>')
    .description('Connect to an MCP server and create a session')
    .action((name, target) => {
      // Will be implemented in command handlers
      console.log(`Connect: ${name} → ${target}`);
    });

  // Sessions command
  program
    .command('sessions')
    .description('List active sessions')
    .action(() => {
      console.log('List sessions (not implemented yet)');
    });

  // Tools commands
  const tools = program.command('tools').description('Manage MCP tools');

  tools
    .command('list')
    .description('List available tools')
    .option('--cursor <cursor>', 'Pagination cursor')
    .action(() => {
      console.log('List tools (not implemented yet)');
    });

  tools
    .command('get <name>')
    .description('Get information about a specific tool')
    .action((name) => {
      console.log(`Get tool: ${name} (not implemented yet)`);
    });

  tools
    .command('call <name>')
    .description('Call a tool with arguments')
    .option('-a, --args <json>', 'Tool arguments as JSON')
    .action((name) => {
      console.log(`Call tool: ${name} (not implemented yet)`);
    });

  // Resources commands
  const resources = program.command('resources').description('Manage MCP resources');

  resources
    .command('list')
    .description('List available resources')
    .option('--cursor <cursor>', 'Pagination cursor')
    .action(() => {
      console.log('List resources (not implemented yet)');
    });

  resources
    .command('get <uri>')
    .description('Get a resource by URI')
    .action((uri) => {
      console.log(`Get resource: ${uri} (not implemented yet)`);
    });

  resources
    .command('subscribe <uri>')
    .description('Subscribe to resource updates')
    .action((uri) => {
      console.log(`Subscribe to resource: ${uri} (not implemented yet)`);
    });

  resources
    .command('unsubscribe <uri>')
    .description('Unsubscribe from resource updates')
    .action((uri) => {
      console.log(`Unsubscribe from resource: ${uri} (not implemented yet)`);
    });

  // Prompts commands
  const prompts = program.command('prompts').description('Manage MCP prompts');

  prompts
    .command('list')
    .description('List available prompts')
    .option('--cursor <cursor>', 'Pagination cursor')
    .action(() => {
      console.log('List prompts (not implemented yet)');
    });

  prompts
    .command('get <name>')
    .description('Get a prompt by name')
    .option('-a, --args <json>', 'Prompt arguments as JSON')
    .action((name) => {
      console.log(`Get prompt: ${name} (not implemented yet)`);
    });

  return program;
}

/**
 * Parse command-line arguments into a structured format
 * This is a helper function for testing and internal use
 */
export function parseArguments(argv: string[]): ParsedArgs {
  const program = createParser();

  // Parse without executing (for testing)
  program.exitOverride();
  try {
    program.parse(argv, { from: 'user' });
  } catch (error) {
    // Handle parse errors
  }

  const opts = program.opts();
  const args = program.args;

  const result: ParsedArgs = {
    args: args.slice(2),
    flags: opts,
    json: opts.json || false,
    verbose: opts.verbose || false,
    help: opts.help || false,
    version: opts.version || false,
  };

  // Only set optional properties if they have values
  if (args[0] !== undefined) result.command = args[0];
  if (args[1] !== undefined) result.subcommand = args[1];
  if (opts.config !== undefined) result.config = opts.config;

  return result;
}
