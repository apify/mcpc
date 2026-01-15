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
import { setVerbose, setJsonMode, closeFileLogger } from '../lib/index.js';
import { isMcpError, formatHumanError } from '../lib/index.js';
import { formatJson, formatJsonError, rainbow } from './output.js';
import * as tools from './commands/tools.js';
import * as resources from './commands/resources.js';
import * as prompts from './commands/prompts.js';
import * as sessions from './commands/sessions.js';
import * as logging from './commands/logging.js';
import * as utilities from './commands/utilities.js';
import * as auth from './commands/auth.js';
import { clean } from './commands/clean.js';
import type { OutputMode } from '../lib/index.js';
import { findTarget, extractOptions, hasCommandAfterTarget, getVerboseFromEnv, getJsonFromEnv, validateOptions, validateCleanTypes, validateArgValues } from './parser.js';
import packageJson from '../../package.json' with { type: 'json' };

/**
 * Options passed to command handlers
 */
interface HandlerOptions {
  outputMode: OutputMode;
  config?: string;
  headers?: string[];
  timeout?: number;
  verbose?: boolean;
  profile?: string;
  schema?: string;
  schemaMode?: 'strict' | 'compatible' | 'ignore';
}

/**
 * Extract options from Commander's Command object
 * Used by command handlers to get parsed options in consistent format
 * Environment variables MCPC_VERBOSE and MCPC_JSON are used as defaults
 */
function getOptionsFromCommand(command: Command): HandlerOptions {
  const opts = command.optsWithGlobals ? command.optsWithGlobals() : command.opts();

  // Check for verbose from flag or environment variable
  const verbose = opts.verbose || getVerboseFromEnv();
  if (verbose) setVerbose(true);

  // Check for JSON mode from flag or environment variable
  const json = opts.json || getJsonFromEnv();
  if (json) setJsonMode(true);

  const options: HandlerOptions = {
    outputMode: (json ? 'json' : 'human') as OutputMode,
  };

  // Only include optional properties if they're present
  if (opts.config) options.config = opts.config;
  if (opts.header) {
    // Commander stores repeated options as arrays, but single values as strings
    // Always convert to array for consistent handling
    options.headers = Array.isArray(opts.header) ? opts.header : [opts.header];
  }
  if (opts.timeout) options.timeout = parseInt(opts.timeout, 10);
  if (opts.profile) options.profile = opts.profile;
  if (verbose) options.verbose = verbose;
  if (opts.schema) options.schema = opts.schema;
  if (opts.schemaMode) {
    const mode = opts.schemaMode as string;
    if (mode !== 'strict' && mode !== 'compatible' && mode !== 'ignore') {
      throw new Error(`Invalid schema mode: ${mode}. Must be 'strict', 'compatible', or 'ignore'.`);
    }
    options.schemaMode = mode;
  }

  return options;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Set up cleanup handlers for graceful shutdown
  const handleExit = (): void => {
    void closeFileLogger().then(() => {
      process.exit(0);
    });
  };

  process.on('SIGTERM', handleExit);
  process.on('SIGINT', handleExit);
  process.on('exit', () => {
    // Synchronous cleanup on exit (file logger handles this gracefully)
    void closeFileLogger();
  });

  // Check for version flag - handle JSON output specially
  if (args.includes('--version') || args.includes('-v')) {
    const options = extractOptions(args);
    if (options.json) {
      setJsonMode(true);
      console.log(formatJson({ version: packageJson.version }));
    } else {
      console.log(packageJson.version);
    }
    return;
  }

  // Check for help flag
  if (args.includes('--help') || args.includes('-h')) {
    const program = createProgram();
    await program.parseAsync(process.argv);
    return;
  }

  // Validate all options are known (before any processing)
  // Argument validation errors are always plain text - --json only applies to command output
  try {
    validateOptions(args);
    validateArgValues(args);
  } catch (error) {
    console.error(formatHumanError(error as Error, false));
    process.exit(1);
  }

  // Handle --clean option (global command, no target needed)
  const cleanArg = args.find((arg) => arg === '--clean' || arg.startsWith('--clean='));
  if (cleanArg) {
    const options = extractOptions(args);
    if (options.verbose) setVerbose(true);
    if (options.json) setJsonMode(true);

    // Parse --clean value: --clean or --clean=all,sessions,profiles,logs
    const cleanValue = cleanArg.includes('=') ? cleanArg.split('=')[1] : '';
    const cleanTypes = cleanValue ? cleanValue.split(',').map((s) => s.trim()) : [];

    // Validate clean types (argument validation - always plain text)
    try {
      validateCleanTypes(cleanTypes);
    } catch (error) {
      console.error(formatHumanError(error as Error, false));
      process.exit(1);
    }

    await clean({
      outputMode: options.json ? 'json' : 'human',
      sessions: cleanTypes.includes('sessions'),
      profiles: cleanTypes.includes('profiles'),
      logs: cleanTypes.includes('logs'),
      all: cleanTypes.includes('all'),
    });

    await closeFileLogger();
    return;
  }

  // Find the target
  const targetInfo = findTarget(args);

  // If no target found, list sessions
  if (!targetInfo) {
    const { json } = extractOptions(args);
    if (json) setJsonMode(true);
    await sessions.listSessionsAndAuthProfiles({ outputMode: json ? 'json' : 'human' });
    if (!json) {
      console.log('\nRun "mcpc --help" for usage information.\n');
    }

    await closeFileLogger();
    return;
  }

  const { target, targetIndex } = targetInfo;

  // Build modified argv without the target
  const modifiedArgs = [
    ...process.argv.slice(0, 2),
    ...args.slice(0, targetIndex),
    ...args.slice(targetIndex + 1),
  ];

  // Handle commands
  try {
    await handleCommands(target, modifiedArgs);
  } finally {
    await closeFileLogger();
  }

  // Explicit exit to avoid waiting for stdio child processes to close
  // (the MCP SDK's StdioClientTransport keeps handles in the event loop)
  process.exit(0);
}

function createProgram(): Command {
  const program = new Command();

  // Configure help output width to avoid wrapping (default is 80)
  program.configureOutput({
    outputError: (str, write) => write(str),
    getOutHelpWidth: () => 100,
    getErrHelpWidth: () => 100,
  });

  program
    .name('mcpc')
    .description(
      `${rainbow('Universal')} command-line client for the Model Context Protocol (MCP).`
    )
    .usage('[options] <target> [command]')
    .helpOption('-h, --help', 'Display general help')
    .option('-j, --json', 'Output in JSON format for scripting')
    .option('-c, --config <file>', 'Path to MCP config JSON file (e.g. ".vscode/mcp.json")')
    .option('-H, --header <header>', 'HTTP header for remote MCP server (can be repeated)')
    .version(packageJson.version, '-v, --version', 'Output the version number')
    .option('--verbose', 'Enable debug logging')
    .option('--profile <name>', 'OAuth profile for the server ("default" if not provided)')
    .option('--schema <file>', 'Validate tool/prompt schema against expected schema')
    .option('--schema-mode <mode>', 'Schema validation mode: strict, compatible (default), ignore')
    .option('--timeout <seconds>', 'Request timeout in seconds (default: 300)')
    .option('--proxy <[host:]port>', 'Start proxy MCP server for session (with "connect" command)')
    .option('--proxy-bearer-token <token>', 'Require authentication for access to proxy server')
    .option('--clean[=types]', 'Clean up mcpc data (types: sessions, logs, profiles, all)');

  // Add help text to match README
  // Use raw Markdown URL for pipes (AI agents), GitHub UI for TTY (humans)
  const docsUrl = process.stdout.isTTY
    ? `https://github.com/apify/mcpc/tree/v${packageJson.version}`
    : `https://raw.githubusercontent.com/apify/mcpc/v${packageJson.version}/README.md`;

  program.addHelpText(
    'after',
    `
Targets:
  @<session>                    Named persistent session (e.g. "@apify")
  <config-entry>                Entry in MCP config file specified by --config (e.g. "fs")
  <server-url>                  Remote MCP server URL (e.g. "mcp.apify.com")

Management commands:
  login                         Create OAuth profile with credentials for remote server
  logout                        Remove OAuth profile for remote server
  connect @<session>            Connect to server and create named persistent session
  restart                       Kill and restart a session
  close                         Close a session

MCP server commands:
  help                          Show server info ("help" can be omitted)
  shell                         Open interactive shell
  tools-list                    Send "tools/list" MCP request...
  tools-get <tool-name>
  tools-call <tool-name> [arg1:=val1 arg2:=val2 ... | <args-json> | <stdin]
  prompts-list
  prompts-get <prompt-name> [arg1:=val1 arg2:=val2 ... | <args-json> | <stdin]
  resources
  resources-list
  resources-read <uri>
  resources-subscribe <uri>
  resources-unsubscribe <uri>
  resources-templates-list
  logging-set-level <level>
  ping
  
Run "mcpc" (without <target>) to show available sessions and profiles.

Full docs: ${docsUrl}`
  );

  return program;
}

async function handleCommands(target: string, args: string[]): Promise<void> {
  const program = createProgram();
  program.argument('<target>', 'Target (session @name, MCP config entry, or server URL)');

  // Check if no command provided - show server info and instructions
  if (!hasCommandAfterTarget(args)) {
    const options = extractOptions(args);
    if (options.verbose) setVerbose(true);
    if (options.json) setJsonMode(true);

    await sessions.showServerDetails(target, {
      outputMode: options.json ? 'json' : 'human',
      ...(options.verbose && { verbose: true }),
      ...(options.config && { config: options.config }),
      ...(options.headers && { headers: options.headers }),
      ...(options.timeout !== undefined && { timeout: options.timeout }),
    });
    return;
  }

  // Help command
  program
    .command('help')
    .description('Show server instructions and available capabilities')
    .action(async (_options, command) => {
      await sessions.showHelp(target, getOptionsFromCommand(command));
    });

  // Shell command
  program
    .command('shell')
    .description('Interactive shell for the target')
    .action(async () => {
      await sessions.openShell(target);
    });

  // Close command
  program
    .command('close')
    .description('Close the session')
    .action(async (_options, command) => {
      await sessions.closeSession(target, getOptionsFromCommand(command));
    });

  // Restart command
  program
    .command('restart')
    .description('Restart the session (stop and start the bridge)')
    .action(async (_options, command) => {
      await sessions.restartSession(target, getOptionsFromCommand(command));
    });

  // Connect command: mcpc <target> connect @<name>
  // Creates a new session or reconnects if session exists but bridge has crashed
  program
    .command('connect <name>')
    .description('Create or reconnect a named session to an MCP server')
    .action(async (name, _options, command) => {
      const opts = command.optsWithGlobals();
      await sessions.connectSession(name, target, {
        ...getOptionsFromCommand(command),
        proxy: opts.proxy,
        proxyBearerToken: opts.proxyBearerToken,
      });
    });

  // Authentication commands
  program
    .command('login')
    .description('Login to a server using OAuth and save authentication profile')
    .option('--profile <name>', 'Profile name (default: default)')
    .option('--scope <scope>', 'OAuth scope(s) to request')
    .action(async (options, command) => {
      await auth.login(target, {
        profile: options.profile,
        scope: options.scope,
        ...getOptionsFromCommand(command),
      });
    });

  program
    .command('logout')
    .description('Delete an authentication profile')
    .option('--profile <name>', 'Profile name (default: default)')
    .action(async (options, command) => {
      await auth.logout(target, {
        profile: options.profile,
        ...getOptionsFromCommand(command),
      });
    });

  // Tools commands (keep these short aliases undocumented, they serve just as fallback)
  program
    .command('tools')
    .description('List available tools (shorthand for tools-list)')
    .action(async (_options, command) => {
      await tools.listTools(target, getOptionsFromCommand(command));
    });

  program
    .command('tools-list')
    .description('List available tools')
    .action(async (_options, command) => {
      await tools.listTools(target, getOptionsFromCommand(command));
    });

  program
    .command('tools-get <name>')
    .description('Get information about a specific tool')
    .action(async (name, _options, command) => {
      await tools.getTool(target, name, getOptionsFromCommand(command));
    });

  program
    .command('tools-call <name> [args...]')
    .description('Call a tool with arguments (key:=value pairs or JSON)')
    .action(async (name, args, _options, command) => {
      await tools.callTool(target, name, {
        args,
        ...getOptionsFromCommand(command),
      });
    });

  // Resources commands (keep these short aliases undocumented, they serve just as fallback)
  program
    .command('resources')
    .description('List available resources (shorthand for resources-list)')
    .action(async (_options, command) => {
      await resources.listResources(target, getOptionsFromCommand(command));
    });

  program
    .command('resources-list')
    .description('List available resources')
    .action(async (_options, command) => {
      await resources.listResources(target, getOptionsFromCommand(command));
    });

  program
    .command('resources-read <uri>')
    .description('Get a resource by URI')
    .option('-o, --output <file>', 'Write resource to file')
    .option('--max-size <bytes>', 'Maximum resource size in bytes')
    .action(async (uri, options, command) => {
      await resources.getResource(target, uri, {
        output: options.output,
        raw: options.raw,
        maxSize: options.maxSize,
        ...getOptionsFromCommand(command),
      });
    });

  program
    .command('resources-subscribe <uri>')
    .description('Subscribe to resource updates')
    .action(async (uri, _options, command) => {
      await resources.subscribeResource(target, uri, getOptionsFromCommand(command));
    });

  program
    .command('resources-unsubscribe <uri>')
    .description('Unsubscribe from resource updates')
    .action(async (uri, _options, command) => {
      await resources.unsubscribeResource(target, uri, getOptionsFromCommand(command));
    });

  program
    .command('resources-templates-list')
    .description('List available resource templates')
    .action(async (_options, command) => {
      await resources.listResourceTemplates(target, getOptionsFromCommand(command));
    });

  // Prompts commands (keep these short aliases undocumented, they serve just as fallback)
  program
    .command('prompts')
    .description('List available prompts (shorthand for prompts-list)')
    .action(async (_options, command) => {
      await prompts.listPrompts(target, getOptionsFromCommand(command));
    });

  program
    .command('prompts-list')
    .description('List available prompts')
    .action(async (_options, command) => {
      await prompts.listPrompts(target, getOptionsFromCommand(command));
    });

  program
    .command('prompts-get <name> [args...]')
    .description('Get a prompt by name with arguments (key:=value pairs or JSON)')
    .action(async (name, args, _options, command) => {
      await prompts.getPrompt(target, name, {
        args,
        ...getOptionsFromCommand(command),
      });
    });

  // Logging commands
  program
    .command('logging-set-level <level>')
    .description(
      'Set server logging level (debug, info, notice, warning, error, critical, alert, emergency)'
    )
    .action(async (level, _options, command) => {
      await logging.setLogLevel(target, level, getOptionsFromCommand(command));
    });

  // Server commands
  program
    .command('ping')
    .description('Ping the MCP server to check if it is alive')
    .action(async (_options, command) => {
      await utilities.ping(target, getOptionsFromCommand(command));
    });

  // Parse and execute
  try {
    await program.parseAsync(args);
  } catch (error) {
    const opts = program.opts();
    const outputMode: OutputMode = opts.json ? 'json' : 'human';

    if (isMcpError(error)) {
      if (outputMode === 'json') {
        console.error(formatJsonError(error, error.code));
      } else {
        console.error(formatHumanError(error, opts.verbose));
      }
      process.exit(error.code);
    }

    // Unknown error
    console.error(
      outputMode === 'json'
        ? formatJsonError(error as Error, 1)
        : formatHumanError(error as Error, opts.verbose)
    );
    process.exit(1);
  }
}

// Run main function
main().catch(async (error) => {
  console.error('Fatal error:', error);
  await closeFileLogger();
  process.exit(1);
});
