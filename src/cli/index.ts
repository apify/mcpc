#!/usr/bin/env node

/**
 * Main CLI entry point for mcpc
 * Handles command parsing, routing, and output formatting
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

import { Command } from 'commander';
import { setVerbose } from '../lib/logger.js';
import { isMcpError, formatError } from '../lib/errors.js';
import { formatJsonError } from './output.js';
import * as tools from './commands/tools.js';
import * as resources from './commands/resources.js';
import * as prompts from './commands/prompts.js';
import * as sessions from './commands/sessions.js';
import type { OutputMode } from '../lib/types.js';

// Get version from package.json
const packageJson = { version: '0.1.0' }; // TODO: Import dynamically

// Options that take a value (not boolean flags)
const OPTIONS_WITH_VALUES = [
  '-c',
  '--config',
  '-H',
  '--header',
  '--timeout',
  '--protocol-version',
  '--schema',
  '--schema-mode',
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Check for help or version flags first
  if (args.includes('--help') || args.includes('-h') || args.includes('--version') || args.includes('-v')) {
    const program = createProgram();
    await program.parseAsync(process.argv);
    return;
  }

  // Find first non-option argument (the target)
  let target: string | undefined;
  let targetIndex = -1;
  let hasJsonFlag = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    // Track --json flag
    if (arg === '--json' || arg === '-j') {
      hasJsonFlag = true;
    }

    // Skip options and their values
    if (arg.startsWith('-')) {
      // Check if this option takes a value
      const optionName = arg.includes('=') ? arg.substring(0, arg.indexOf('=')) : arg;
      const takesValue = OPTIONS_WITH_VALUES.includes(optionName);

      // If option takes a value and value is not inline (no =), skip next arg
      if (takesValue && !arg.includes('=') && i + 1 < args.length) {
        i++; // Skip the value
      }
      continue;
    }
    target = arg;
    targetIndex = i;
    break;
  }

  // If no target found, list sessions (special case: no positional arguments)
  if (!target) {
    await sessions.listSessions({ outputMode: hasJsonFlag ? 'json' : 'human' });
    if (!hasJsonFlag) {
      console.log('\nRun "mcpc --help" for usage information.');
    }
    return;
  }

  // Build modified argv without the target
  const modifiedArgv = [
    ...process.argv.slice(0, 2),
    ...args.slice(0, targetIndex),
    ...args.slice(targetIndex + 1),
  ];

  // Handle commands
  await handleCommands(target, modifiedArgv);
}

function createProgram(): Command {
  const program = new Command();

  program
    .name('mcpc')
    .description('Command-line client for the Model Context Protocol (MCP).')
    .usage('[options] <target> [command]')
    .version(packageJson.version, '-v, --version', 'Output the version number')
    .option('-j, --json', 'Output in JSON format')
    .option('--verbose', 'Enable verbose logging')
    .option('-c, --config <path>', 'Path to MCP server config file')
    .option('-H, --header <header>', 'Add HTTP header (can be repeated)')
    .option('--timeout <seconds>', 'Request timeout in seconds (default 30 secs)')
    .option('--protocol-version <version>', 'Force specific MCP protocol version')
    .option('--schema <file>', 'Validate against expected tool/prompt schema')
    .option('--schema-mode <mode>', 'Schema validation mode: strict, compatible (default), or ignore')
    .option('--insecure', 'Disable SSL certificate validation');

  // Add examples to help
  program.addHelpText(
    'after',
    `
Where <target> can be:
  @<name>           Named session (e.g., @apify)
  https://...       Remote MCP server URL
  <config-entry>    Entry from config file (with --config)
  <package>         Local MCP server package

Examples:
  $ mcpc                                                # List all sessions
  $ mcpc https://mcp.apify.com connect --name @apify    # Create a session
  $ mcpc @apify                                         # Show server info and capabilities
  $ mcpc @apify tools-list                              # List tools
  $ mcpc https://example.com tools-call search --args query="hello"
  $ mcpc --json @apify resources-list                   # JSON output
`
  );

  return program;
}

async function handleCommands(target: string, argv: string[]): Promise<void> {
  const program = createProgram();
  program.argument('<target>', 'Target (session @name, server URL, config entry, or package)');

  // Get options to pass to handlers
  const getOptions = (command: Command) => {
    const opts = command.optsWithGlobals ? command.optsWithGlobals() : command.opts();
    if (opts.verbose) setVerbose(true);
    return { outputMode: (opts.json ? 'json' : 'human') as OutputMode };
  };

  // Check if no command provided - show server info and instructions
  const hasCommand = argv.some((arg, i) => {
    if (i < 2) return false; // Skip node and script path
    return !arg.startsWith('-'); // First non-option arg after target
  });

  if (!hasCommand) {
    // No command provided, show server info and instructions
    // Parse options from argv to get flags like --json
    const hasJsonFlag = argv.includes('--json') || argv.includes('-j');
    const hasVerboseFlag = argv.includes('--verbose');
    if (hasVerboseFlag) setVerbose(true);

    await sessions.getInstructions(target, {
      outputMode: hasJsonFlag ? 'json' : 'human',
    });
    return;
  }

  // Help command
  program
    .command('help')
    .description('Show server instructions and available capabilities')
    .action(async (_options, command) => {
      await sessions.showHelp(target, getOptions(command));
    });

  // Shell command
  program
    .command('shell')
    .description('Interactive shell for the target')
    .action(async (_options, command) => {
      await sessions.openShell(target, getOptions(command));
    });

  // Close command
  program
    .command('close')
    .description('Close the session')
    .action(async (_options, command) => {
      await sessions.closeSession(target, getOptions(command));
    });

  // Connect command: mcpc <target> connect --name <name>
  program
    .command('connect')
    .description('Connect to an MCP server and create a session')
    .requiredOption('--name <name>', 'Session name (e.g., @apify)')
    .action(async (options, command) => {
      await sessions.connectSession(options.name, target, getOptions(command));
    });

  // Tools commands (hyphenated)
  program
    .command('tools')
    .description('List available tools (shorthand for tools-list)')
    .option('--cursor <cursor>', 'Pagination cursor')
    .action(async (options, command) => {
      await tools.listTools(target, {
        cursor: options.cursor,
        ...getOptions(command),
      });
    });

  program
    .command('tools-list')
    .description('List available tools')
    .option('--cursor <cursor>', 'Pagination cursor')
    .action(async (options, command) => {
      await tools.listTools(target, {
        cursor: options.cursor,
        ...getOptions(command),
      });
    });

  program
    .command('tools-get <name>')
    .description('Get information about a specific tool')
    .action(async (name, _options, command) => {
      await tools.getTool(target, name, getOptions(command));
    });

  program
    .command('tools-call <name>')
    .description('Call a tool with arguments')
    .option('--args [pairs...]', 'Tool arguments as key=val or key:=json pairs')
    .option('--args-file <file>', 'Load arguments from JSON file')
    .action(async (name, options, command) => {
      await tools.callTool(target, name, {
        args: options.args,
        argsFile: options.argsFile,
        ...getOptions(command),
      });
    });

  // Resources commands (hyphenated)
  program
    .command('resources')
    .description('List available resources (shorthand for resources-list)')
    .option('--cursor <cursor>', 'Pagination cursor')
    .action(async (options, command) => {
      await resources.listResources(target, {
        cursor: options.cursor,
        ...getOptions(command),
      });
    });

  program
    .command('resources-list')
    .description('List available resources')
    .option('--cursor <cursor>', 'Pagination cursor')
    .action(async (options, command) => {
      await resources.listResources(target, {
        cursor: options.cursor,
        ...getOptions(command),
      });
    });

  program
    .command('resources-get <uri>')
    .description('Get a resource by URI')
    .option('-o, --output <file>', 'Write resource to file')
    .option('--raw', 'Output raw resource content')
    .option('--max-size <bytes>', 'Maximum resource size in bytes')
    .action(async (uri, options, command) => {
      await resources.getResource(target, uri, {
        output: options.output,
        raw: options.raw,
        maxSize: options.maxSize,
        ...getOptions(command),
      });
    });

  program
    .command('resources-subscribe <uri>')
    .description('Subscribe to resource updates')
    .action(async (uri, _options, command) => {
      await resources.subscribeResource(target, uri, getOptions(command));
    });

  program
    .command('resources-unsubscribe <uri>')
    .description('Unsubscribe from resource updates')
    .action(async (uri, _options, command) => {
      await resources.unsubscribeResource(target, uri, getOptions(command));
    });

  // Prompts commands (hyphenated)
  program
    .command('prompts')
    .description('List available prompts (shorthand for prompts-list)')
    .option('--cursor <cursor>', 'Pagination cursor')
    .action(async (options, command) => {
      await prompts.listPrompts(target, {
        cursor: options.cursor,
        ...getOptions(command),
      });
    });

  program
    .command('prompts-list')
    .description('List available prompts')
    .option('--cursor <cursor>', 'Pagination cursor')
    .action(async (options, command) => {
      await prompts.listPrompts(target, {
        cursor: options.cursor,
        ...getOptions(command),
      });
    });

  program
    .command('prompts-get <name>')
    .description('Get a prompt by name')
    .option('--args [pairs...]', 'Prompt arguments as key=val or key:=json pairs')
    .action(async (name, options, command) => {
      await prompts.getPrompt(target, name, {
        args: options.args,
        ...getOptions(command),
      });
    });

  // Parse and execute
  try {
    await program.parseAsync(argv);
  } catch (error) {
    const opts = program.opts();
    const outputMode: OutputMode = opts.json ? 'json' : 'human';

    if (isMcpError(error)) {
      if (outputMode === 'json') {
        console.error(formatJsonError(error, error.code));
      } else {
        console.error(formatError(error, opts.verbose));
      }
      process.exit(error.code);
    }

    // Unknown error
    console.error(
      outputMode === 'json'
        ? formatJsonError(error as Error, 1)
        : formatError(error as Error, opts.verbose)
    );
    process.exit(1);
  }
}

// Run main function
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
