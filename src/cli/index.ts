#!/usr/bin/env node

/**
 * Main CLI entry point for mcpc
 * Handles command parsing, routing, and output formatting
 */

import { initProxy } from '../lib/proxy.js';
import { Command, CommanderError, Help } from 'commander';
import { setVerbose, setJsonMode, closeFileLogger } from '../lib/index.js';
import { isMcpError, formatHumanError, ClientError } from '../lib/index.js';
import chalk from 'chalk';
import { formatJson, formatJsonError, jsonHelp, rainbow, theme } from './output.js';
import {
  SCHEMA_BASE,
  LEGACY_SCHEMA_BASE,
  SESSION_DETAILS_HELP,
  outputHelp,
  serverDetailsJsonHelp,
} from './help-text.js';
import * as tools from './commands/tools.js';
import * as resources from './commands/resources.js';
import * as skills from './commands/skills.js';
import * as help from './commands/help.js';
import * as prompts from './commands/prompts.js';
import * as sessions from './commands/sessions.js';
import * as connect from './commands/connect.js';
import * as logging from './commands/logging.js';
import * as utilities from './commands/utilities.js';
import * as logs from './commands/logs.js';
import * as auth from './commands/auth.js';
import * as tasks from './commands/tasks.js';
import * as grepCmd from './commands/grep.js';
import { clean } from './commands/clean.js';
import { MCPC_OAUTH_CALLBACK_HOSTS, MCPC_OAUTH_CALLBACK_PORTS } from '../lib/auth/oauth-utils.js';
import type { OutputMode, X402SchemePreference } from '../lib/index.js';
import { X402_SCHEME_PREFERENCES } from '../lib/index.js';
import {
  extractOptions,
  preProcessX402Argv,
  getVerboseFromEnv,
  getJsonFromEnv,
  validateOptions,
  validateArgValues,
  parseServerArg,
  hasSubcommand,
  optionTakesValue,
  suggestCommand,
  normalizeSlashCommand,
  normalizeSlashCommandArgs,
  KNOWN_COMMANDS,
  KNOWN_SESSION_COMMANDS,
} from './parser.js';
import { createRequire } from 'module';
const { version: mcpcVersion } = createRequire(import.meta.url)('../../package.json') as {
  version: string;
};

// Set up HTTP proxy from environment variables (HTTPS_PROXY, HTTP_PROXY, NO_PROXY, and lowercase variants)
// Also handle --insecure flag to disable TLS certificate verification (for self-signed certs)
{
  const insecure = process.argv.includes('--insecure');
  await initProxy({ insecure });
}

/**
 * The x402 command module pulls in the bundled viem (~1 MB of crypto code),
 * so load it only when an x402 command actually runs — every other command
 * would otherwise pay the import cost at startup.
 */
async function handleX402Command(args: string[]): Promise<void> {
  const { handleX402Command: run } = await import('./commands/x402.js');
  await run(args);
}

/**
 * Options passed to command handlers
 */
interface HandlerOptions {
  outputMode: OutputMode;
  headers?: string[];
  timeoutSecs?: number; // Per-request timeout in seconds (from --timeout)
  verbose?: boolean;
  profile?: string;
  noProfile?: boolean;
  /**
   * x402 scheme preference. Presence enables x402 for the run; value is the preference.
   * `--x402` (no value) resolves to `'auto'` (prefer upto, fall back to exact).
   */
  x402?: X402SchemePreference;
  insecure?: boolean;
  schema?: string;
  schemaMode?: 'strict' | 'compatible' | 'ignore';
  full?: boolean;
  maxChars?: number;
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
    outputMode: json ? 'json' : 'human',
  };

  // Only include optional properties if they're present
  if (opts.timeout) {
    const timeoutSecs = parseInt(opts.timeout as string, 10);
    if (isNaN(timeoutSecs) || timeoutSecs <= 0) {
      throw new ClientError(
        `Invalid --timeout value: "${opts.timeout as string}". Must be a positive number (seconds).`
      );
    }
    options.timeoutSecs = timeoutSecs;
  }
  if (opts.profile === false) {
    options.noProfile = true;
  } else if (opts.profile) {
    options.profile = opts.profile;
  }
  if (verbose) options.verbose = verbose;

  // Commander returns `true` for `--x402` (no value) and a string for `--x402 <scheme>`.
  // Normalise to the canonical scheme preference; reject other strings loudly so
  // commander's greedy [optional] arg parser can't silently eat a positional like a URL.
  if (opts.x402 === true) {
    options.x402 = 'auto';
  } else if (typeof opts.x402 === 'string') {
    if (!(X402_SCHEME_PREFERENCES as readonly string[]).includes(opts.x402)) {
      throw new ClientError(
        `Invalid --x402 value: "${opts.x402}". Expected one of ${X402_SCHEME_PREFERENCES.join(', ')}, or pass --x402 with no value for the default.`
      );
    }
    options.x402 = opts.x402 as X402SchemePreference;
  }
  if (opts.insecure) options.insecure = true;
  if (opts.schema) options.schema = opts.schema;
  if (opts.schemaMode) {
    const mode = opts.schemaMode as string;
    if (mode !== 'strict' && mode !== 'compatible' && mode !== 'ignore') {
      throw new ClientError(
        `Invalid --schema-mode value: "${mode}". Valid modes are: strict, compatible, ignore`
      );
    }
    options.schemaMode = mode;
  }
  if (opts.full) options.full = opts.full;
  if (opts.maxChars) {
    const maxChars = parseInt(opts.maxChars as string, 10);
    if (isNaN(maxChars) || maxChars <= 0) {
      throw new ClientError(
        `Invalid --max-chars value: "${opts.maxChars as string}". Must be a positive number (characters).`
      );
    }
    options.maxChars = maxChars;
  }

  return options;
}

async function main(): Promise<void> {
  // Disambiguate `--x402 <non-scheme>` (URL, @session, etc.) so Commander's
  // greedy [optional] arg parser doesn't eat the next positional as the value.
  process.argv = preProcessX402Argv(process.argv);
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
      console.log(formatJson({ version: mcpcVersion }));
    } else {
      console.log(mcpcVersion);
    }
    return;
  }

  // Check for help flag
  // x402 has its own Commander program with full subcommand help, so pass --help through
  // Session commands (@name ...) also handle --help via their own Commander program
  if (args.includes('--help') || args.includes('-h')) {
    // Check if this is a session command — let it fall through to session handling
    const hasSessionArg = args.some((a) => a.startsWith('@') && !a.startsWith('--'));
    if (hasSessionArg) {
      // Fall through — handleSessionCommands will parse --help via Commander
    } else if (args.includes('x402')) {
      const x402Index = args.indexOf('x402');
      const x402Args = args.slice(x402Index + 1);
      await handleX402Command(x402Args);
      await closeFileLogger();
      return;
    } else {
      // Check if the user is asking for help on a session subcommand (e.g. mcpc resources-list --help)
      const helpTarget = args.find(
        (a) => a !== '--help' && a !== '-h' && !a.startsWith('-') && !a.startsWith('@')
      );
      if (helpTarget && KNOWN_SESSION_COMMANDS.includes(helpTarget)) {
        showSessionCommandHelp(helpTarget);
        return;
      }
      const program = createTopLevelProgram();
      await program.parseAsync(process.argv);
      return;
    }
  }

  // Validate all options are known (before any processing)
  // Argument validation errors are always plain text - --json only applies to command output
  try {
    validateOptions(args);
    validateArgValues(args);
  } catch (error) {
    console.error(theme.red(formatHumanError(error, false)));
    process.exit(1);
  }

  // Find the first non-option argument to determine routing
  let firstNonOption: string | undefined;
  let firstNonOptionIndex = -1;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith('-')) {
      if (optionTakesValue(arg) && !arg.includes('=') && i + 1 < args.length) {
        i++; // skip value
      }
      continue;
    }
    firstNonOption = arg;
    firstNonOptionIndex = i;
    break;
  }

  // No args → list sessions
  if (!firstNonOption) {
    const { json } = extractOptions(args);
    if (json) setJsonMode(true);
    const { hasSessions } = await sessions.listSessionsAndAuthProfiles({
      outputMode: json ? 'json' : 'human',
    });
    if (!json) {
      console.log('');
      if (hasSessions) {
        console.log('To view server capabilities and tools, run: mcpc @session');
      }
      console.log('For usage and the agent guide, run: mcpc help [--skill]');
      console.log('');
    }
    await closeFileLogger();
    return;
  }

  // Session command: @name [subcommand]
  if (firstNonOption.startsWith('@')) {
    const session = firstNonOption;
    const modifiedArgs = [
      ...process.argv.slice(0, 2),
      ...args.slice(0, firstNonOptionIndex),
      ...args.slice(firstNonOptionIndex + 1),
    ];

    try {
      await handleSessionCommands(session, modifiedArgs);
    } catch (error) {
      if (isMcpError(error)) {
        const opts = extractOptions(args);
        const outputMode: OutputMode = opts.json ? 'json' : 'human';
        if (outputMode === 'json') {
          console.error(formatJsonError(error, error.code));
        } else {
          console.error(theme.red(formatHumanError(error, opts.verbose)));
        }
        process.exit(error.code);
      }
      throw error;
    } finally {
      await closeFileLogger();
    }

    // Flush stdout before exiting. Honor any exit code set by the command
    // handler (e.g. tools-call sets 2 when the tool result has isError).
    await flushStdout();
    process.exit(process.exitCode ?? 0);
  }

  // Top-level commands: login, logout, connect, clean, help, x402
  if (KNOWN_COMMANDS.includes(firstNonOption)) {
    // Handle x402 separately (legacy standalone handler)
    if (firstNonOption === 'x402') {
      const x402Args = args.slice(firstNonOptionIndex + 1);
      await handleX402Command(x402Args);
      await closeFileLogger();
      return;
    }

    try {
      const program = createTopLevelProgram();
      await program.parseAsync(process.argv);
    } catch (error) {
      if (isMcpError(error)) {
        const opts = extractOptions(args);
        const outputMode: OutputMode = opts.json ? 'json' : 'human';
        if (outputMode === 'json') {
          console.error(formatJsonError(error, error.code));
        } else {
          console.error(theme.red(formatHumanError(error, opts.verbose)));
        }
        process.exit(error.code);
      }
      throw error;
    } finally {
      await closeFileLogger();
    }
    return;
  }

  // Unknown command — provide helpful error
  const opts = extractOptions(args);
  const outputMode: OutputMode = opts.json ? 'json' : 'human';

  const allCommands = [...KNOWN_COMMANDS, ...KNOWN_SESSION_COMMANDS];
  // Accept MCP JSON-RPC-style method names (e.g. "tools/list") silently, in case
  // this is a session subcommand typed without a session target — undocumented,
  // never advertised in the message itself.
  const normalizedFirstNonOption = normalizeSlashCommand(firstNonOption);
  if (allCommands.includes(normalizedFirstNonOption)) {
    // It's a session subcommand used without @session
    if (outputMode === 'json') {
      console.error(
        formatJsonError(new Error(`Missing session target for command: ${firstNonOption}`), 1)
      );
    } else {
      console.error(`Error: Missing session target for command: ${firstNonOption}`);
      console.error(`\nDid you mean: mcpc <@session> ${normalizedFirstNonOption}`);
      console.error(`Run "mcpc --help" for usage information.\n`);
    }
  } else {
    // Try to suggest the closest matching command
    const suggestion = suggestCommand(normalizedFirstNonOption, allCommands);
    if (outputMode === 'json') {
      console.error(formatJsonError(new Error(`Unknown command: ${firstNonOption}`), 1));
    } else {
      console.error(`Error: Unknown command: ${firstNonOption}`);
      if (suggestion) {
        if (KNOWN_SESSION_COMMANDS.includes(suggestion)) {
          console.error(`\nDid you mean: mcpc <@session> ${suggestion}`);
        } else {
          console.error(`\nDid you mean: mcpc ${suggestion}`);
        }
      }
      console.error(`Run "mcpc --help" for usage information.\n`);
    }
  }
  await closeFileLogger();
  process.exit(1);
}

/**
 * Create the top-level Commander program with global commands
 * (login, logout, connect, clean, help)
 */
function createTopLevelProgram(): Command {
  const program = new Command();

  // Configure help output width to avoid wrapping (default is 80)
  program.configureOutput({
    outputError: (str, write) => write(str),
    getOutHelpWidth: () => 100,
    getErrHelpWidth: () => 100,
  });

  // Strip [options] from the commands list (options are shown per-command via `mcpc help <cmd>`)
  // Show Commands before Options in top-level help for better discoverability
  program.configureHelp({
    subcommandTerm: (cmd) =>
      `${cmd.name()} ${cmd.usage()}`.replace(/^\[options\]\s*|\s*\[options\]/g, '').trim(),
    styleTitle: (str) => chalk.bold(str),
    styleSubcommandText: (str) => theme.cyan(str),
    formatHelp: (cmd, helper) => {
      const output = Help.prototype.formatHelp.call(helper, cmd, helper);
      // Swap Options and Commands sections (separated by blank lines)
      const sections = output.split('\n\n');
      const optIdx = sections.findIndex((s: string) => s.includes('Options:'));
      const cmdIdx = sections.findIndex((s: string) => s.includes('Commands:'));
      if (optIdx >= 0 && cmdIdx >= 0 && optIdx < cmdIdx) {
        const tmp = sections[optIdx] as string;
        sections[optIdx] = sections[cmdIdx] as string;
        sections[cmdIdx] = tmp;
      }
      return (
        sections
          .map((s: string) => s.trimEnd())
          .filter((s: string) => s !== '')
          .join('\n\n') + '\n'
      );
    },
  });

  const docsUrl = `https://github.com/apify/mcpc/raw/refs/tags/v${mcpcVersion}/README.md`;

  program
    .name('mcpc')
    .description(
      `${rainbow('Universal')} command-line client for the Model Context Protocol (MCP).`
    )
    .usage('[<@session>] [<command>] [options]')
    .option('--json', 'Output in JSON format for scripting')
    .option('--verbose', 'Enable debug logging')
    .option('--profile <name>', 'OAuth profile for the server ("default" if not provided)')
    .option('--timeout <seconds>', 'Request timeout in seconds (default: 60)')
    .option('--max-chars <n>', 'Truncate output to n characters (ignored in --json mode)')
    .option('--insecure', 'Skip TLS certificate verification (for self-signed certs)')
    .version(mcpcVersion, '-v, --version', 'Output the version number')
    .helpOption('-h, --help', 'Display help');

  program.addHelpText(
    'after',
    `
${chalk.bold('MCP session commands (after connecting):')}
  <@session>                     Show MCP server info, capabilities, and tools overview
  <@session> ${theme.cyan('grep')} <pattern>      Search tools and instructions
  <@session> ${theme.cyan('tools-list')}          List all server tools
  <@session> ${theme.cyan('tools-get')} <name>    Get tool details and schema
  <@session> ${theme.cyan('tools-call')} <name> [arg:=val ... | <json> | <stdin]
  <@session> ${theme.cyan('tasks-list')}
  <@session> ${theme.cyan('tasks-get')} <taskId>
  <@session> ${theme.cyan('tasks-result')} <taskId>
  <@session> ${theme.cyan('tasks-cancel')} <taskId>
  <@session> ${theme.cyan('prompts-list')}
  <@session> ${theme.cyan('prompts-get')} <name> [arg:=val ... | <json> | <stdin]
  <@session> ${theme.cyan('resources-list')}
  <@session> ${theme.cyan('resources-read')} <uri> [-o <file> | --raw]
  <@session> ${theme.cyan('resources-subscribe')} <uri> <file>
  <@session> ${theme.cyan('resources-unsubscribe')} <uri>
  <@session> ${theme.cyan('resources-templates-list')}
  <@session> ${theme.cyan('skills-list')}
  <@session> ${theme.cyan('skills-get')} <name> [--raw]
  <@session> ${theme.cyan('logging-set-level')} <level>
  <@session> ${theme.cyan('ping')}
  <@session> ${theme.cyan('server-discover')}
  <@session> ${theme.cyan('logs')} [-n N] [--follow] [--since 1h]

Run "mcpc" without arguments to show active sessions and OAuth profiles.
Run "mcpc --json" to get the same data as \`{ sessions: [...], profiles: [...] }\`.

Agent guide: mcpc help --skill
Full docs: ${docsUrl}`
  );

  // connect command: mcpc connect [<server>] [@session]  (server optional — omit to auto-discover)
  program
    .command('connect [server] [@session]')
    .usage('[<server>] [@session] [options]')
    .description('Connect to an MCP server and start a new named @session') // keep this short
    .option('-H, --header <header>', 'HTTP header (can be repeated)')
    .option('--profile <name>', 'OAuth profile to use ("default" if skipped)')
    .option('--no-profile', 'Skip OAuth profile (connect anonymously)')
    .option('--proxy <[host:]port>', 'Start proxy MCP server for session')
    .option('--proxy-bearer-token <token>', 'Require authentication for access to proxy server')
    .option('--stdio', 'Launch all local stdio servers from selected config files')
    .option('--protocol-version <version>', 'Pin the MCP protocol version (see below)')
    .option('--x402 [scheme]', 'Enable x402 auto-payment (see below)')
    .addHelpText(
      'after',
      `
${chalk.bold('Server formats:')}
  mcp.apify.com                 Remote HTTP server (https:// auto-added)
  ~/.vscode/mcp.json:puppeteer  Config file entry (file:entry)
  ~/.vscode/mcp.json            Config file — connect every entry
  ${chalk.dim('(no server)'.padEnd(28))}  Auto-discover configs and connect everything

${chalk.bold('Auto-discovery (no server arg):')}
  Scans ./ and ~ for .mcp.json, mcp.json, mcp_config.json, .cursor/mcp.json,
  .vscode/mcp.json, .kiro/settings/mcp.json, ~/.claude.json,
  ~/.codeium/windsurf/mcp_config.json, plus VS Code & Claude Desktop configs.

${chalk.bold('Session name:')}
  Omit @session to auto-generate from the server (mcp.apify.com → @apify)
  or config entry. Matching sessions (same server, profile, header keys)
  are reused. Bulk connects don't accept @session.

${chalk.bold('Stdio servers (command-based, run locally):')}
  Config entries spawn the command on connect, even if the handshake
  later fails — only connect to configs you trust. Bulk connects skip
  stdio by default; pass --stdio to include them.

${chalk.bold('Protocol version:')}
  mcpc negotiates the newest MCP version both sides support, from
  2026-07-28 down to 2024-10-07. Pass --protocol-version to pin one exact
  version instead — the connection fails if the server does not offer it.
  Run mcpc @session to see the negotiated version.

${chalk.bold('x402 payments (experimental):')}
  --x402 pays for paid tool calls from the wallet set up with mcpc x402.
  Schemes: auto (default, prefers upto), upto, exact.
${outputHelp([
  'For a single server, shows session, server info, capabilities, and tools.',
  'Bulk connects list every session with its state, then a summary.',
])}${serverDetailsJsonHelp('array')}`
    )
    .action(async (server, sessionName, opts, command) => {
      const globalOpts = getOptionsFromCommand(command);

      // Extract --header from connect-specific opts
      const headers: string[] | undefined = opts.header
        ? Array.isArray(opts.header)
          ? (opts.header as string[])
          : [opts.header as string]
        : undefined;

      // No server argument — discover standard MCP config files and connect all
      if (!server) {
        if (sessionName) {
          throw new ClientError(
            `Cannot specify @session name when discovering and connecting all servers.\n` +
              `To connect a specific server, pass a URL or config entry: mcpc connect <server> ${sessionName}`
          );
        }
        await connect.connectAllFromStandardConfigs({
          ...globalOpts,
          ...(headers && { headers }),
          ...(opts.proxy && { proxy: opts.proxy as string }),
          ...(opts.proxyBearerToken && { proxyBearerToken: opts.proxyBearerToken as string }),
          ...(opts.stdio && { stdio: true }),
          ...(opts.protocolVersion && { protocolVersion: opts.protocolVersion as string }),
          ...(globalOpts.x402 && { x402: globalOpts.x402 }),
          ...(globalOpts.insecure && { insecure: true }),
        });
        // Trailing blank line to match the spacing of other commands (human mode only).
        if (globalOpts.outputMode === 'human') console.log('');
        return;
      }

      const parsed = parseServerArg(server);

      if (!parsed) {
        throw new ClientError(
          `Invalid server: "${server}"\n\n` +
            `Expected a URL (e.g. mcp.apify.com) or a config file entry (e.g. ~/.vscode/mcp.json:filesystem)`
        );
      }

      // Config file without :entry — connect all servers from the file
      if (parsed.type === 'config-file') {
        if (sessionName) {
          throw new ClientError(
            `Cannot specify @session name when connecting all servers from a config file.\n` +
              `To connect a specific entry, use: mcpc connect ${server}:<entry> ${sessionName}`
          );
        }
        await connect.connectAllFromConfig(parsed.file, {
          ...globalOpts,
          ...(headers && { headers }),
          ...(opts.proxy && { proxy: opts.proxy as string }),
          ...(opts.proxyBearerToken && { proxyBearerToken: opts.proxyBearerToken as string }),
          ...(opts.stdio && { stdio: true }),
          ...(opts.protocolVersion && { protocolVersion: opts.protocolVersion as string }),
          ...(globalOpts.x402 && { x402: globalOpts.x402 }),
          ...(globalOpts.insecure && { insecure: true }),
        });
        return;
      }

      // Auto-generate session name if not provided
      if (!sessionName) {
        sessionName = await connect.resolveSessionName(parsed, {
          outputMode: globalOpts.outputMode,
          ...(globalOpts.profile && { profile: globalOpts.profile }),
          ...(headers && { headers }),
          ...(globalOpts.noProfile && { noProfile: globalOpts.noProfile }),
        });
      }

      if (parsed.type === 'config') {
        // Config file entry: pass entry name as target with config file path
        await connect.connectSession(parsed.entry, sessionName, {
          ...globalOpts,
          ...(headers && { headers }),
          config: parsed.file,
          proxy: opts.proxy,
          proxyBearerToken: opts.proxyBearerToken,
          ...(opts.protocolVersion && { protocolVersion: opts.protocolVersion as string }),
          ...(globalOpts.x402 && { x402: globalOpts.x402 }),
          ...(globalOpts.insecure && { insecure: true }),
        });
      } else {
        await connect.connectSession(server, sessionName, {
          ...globalOpts,
          ...(headers && { headers }),
          proxy: opts.proxy,
          proxyBearerToken: opts.proxyBearerToken,
          ...(opts.protocolVersion && { protocolVersion: opts.protocolVersion as string }),
          ...(globalOpts.x402 && { x402: globalOpts.x402 }),
          ...(globalOpts.insecure && { insecure: true }),
        });
      }
    });

  // close command: mcpc close @<session>
  program
    .command('close [@session]')
    .usage('<@session> [options]')
    .description('Close a session')
    .addHelpText('after', jsonHelp('`{ sessionName, closed: true }`'))
    .action(async (sessionName, _opts, command) => {
      if (!sessionName) {
        throw new ClientError('Missing required argument: @session\n\nExample: mcpc close @myapp');
      }
      await sessions.closeSession(sessionName, getOptionsFromCommand(command));
    });

  // restart command: mcpc restart @<session>
  program
    .command('restart [@session]')
    .usage('<@session> [options]')
    .description('Restart a session (losing all state)')
    .addHelpText(
      'after',
      outputHelp('After restarting, shows session, server info, capabilities, and tools.') +
        serverDetailsJsonHelp('object')
    )
    .action(async (sessionName, _opts, command) => {
      if (!sessionName) {
        throw new ClientError(
          'Missing required argument: @session\n\nExample: mcpc restart @myapp'
        );
      }
      await sessions.restartSession(sessionName, getOptionsFromCommand(command));
    });

  // login command: mcpc login <server>
  program
    .command('login [server]')
    .usage('<server> [options]')
    .description('Log in to a server and save an OAuth profile')
    .option('--profile <name>', 'Profile name (default: "default")')
    .option('--scope <scopes>', 'OAuth scopes to request (e.g. --scope "read write")')
    .option('--grant <type>', 'Grant: authorization-code (default), client-credentials, id-jag')
    .option('--client-id <id>', 'Pre-registered OAuth client ID (skips CIMD and DCR)')
    .option('--client-secret <secret>', 'Pre-registered OAuth client secret (requires --client-id)')
    .option(
      '--client-key <pem-or-path>',
      'Private key (PEM path or literal) for private_key_jwt auth'
    )
    .option('--client-key-alg <alg>', 'JWT signing algorithm for --client-key (default: RS256)')
    .option(
      '--token-endpoint <url>',
      'OAuth token endpoint (client-credentials only, auto-discovered)'
    )
    .option('--idp <url>', 'Enterprise IdP issuer URL (id-jag only)')
    .option('--idp-client-id <id>', 'Client ID pre-registered at the enterprise IdP (id-jag only)')
    .option('--idp-client-secret <secret>', 'Client secret for the enterprise IdP (id-jag only)')
    .option('--idp-scope <scopes>', 'OIDC scopes for the IdP SSO (id-jag only, see below)')
    .option('--client-metadata-url <url>', 'HTTPS URL of an OAuth CIMD (default: mcpc CIMD)')
    .option('--no-client-metadata-url', 'Disable CIMD; force DCR on CIMD-capable servers')
    .option(
      '--callback-port <port>',
      `Loopback port for OAuth callback (default: ${MCPC_OAUTH_CALLBACK_PORTS.join('/')})`
    )
    .option('--callback-host <host>', 'OAuth callback host: 127.0.0.1 (default) or localhost')
    .addHelpText(
      'after',
      `
${chalk.bold('Interactive login:')}
  By default, the command opens your browser to authorize the server,
  then saves the credentials as a reusable profile any session can use:

  default profile: mcpc login mcp.apify.com
  named profile:   mcpc login mcp.apify.com --profile work
  then connect:    mcpc connect mcp.apify.com @app --profile work

${chalk.bold('Client registration (how mcpc identifies itself to the server):')}
  1. Client ID Metadata Documents (CIMD): the default. mcpc's hosted CIMD at
     https://apify.github.io/mcpc/client-metadata.json identifies all mcpc
     installs as one client. Override with --client-metadata-url <url>, or
     disable with --no-client-metadata-url.
  2. Pre-registration: pass --client-id (and --client-secret if issued). If the
     client's redirect URI uses localhost (e.g. localhost:3118), match it with
     --callback-host localhost --callback-port 3118.
  3. Dynamic Client Registration (DCR): fallback when CIMD is unsupported or
     disabled and the server exposes a registration_endpoint.

  See https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

${chalk.bold('Machine-to-machine authentication (for CI/CD and daemons):')}
  Pass --grant client-credentials, --client-id, and one credential:

  mcpc login mcp.example.com --grant client-credentials \\
    --client-id my-svc --client-secret s3cr3t --scope "read write"
  mcpc login mcp.example.com --grant client-credentials \\
    --client-id my-svc --client-key ./key.pem

  --client-secret uses client_secret_basic; --client-key signs a private_key_jwt
  assertion (RFC 7523). The token endpoint is auto-discovered; pin it with
  --token-endpoint <url> for servers without discoverable metadata.

  See https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials

${chalk.bold("Enterprise-managed authorization (SSO via your organization's IdP):")}
  Pass --grant id-jag when your organization controls MCP server access
  centrally through its identity provider (e.g. Okta). You sign in once with
  your corporate SSO; mcpc then obtains MCP tokens via identity assertion
  grants (ID-JAG) without any per-server consent screens:

  mcpc login mcp.example.com --grant id-jag \\
    --idp https://acme.okta.com --idp-client-id <idp-client> \\
    --client-id <mcp-as-client> --client-secret <secret>

  Both clients are pre-registered by your IT team: --idp-client-id at the
  enterprise IdP (add --idp-client-secret if it is a confidential client),
  --client-id/--client-secret at the MCP server's authorization server.
  --scope requests MCP-server scopes; --idp-scope overrides the OIDC scopes
  used for the SSO itself (default: "openid profile email offline_access").

  See https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization
${jsonHelp('Interactive prompts go to stderr; stdout is a clean JSON object', '`{ profile, serverUrl, scopes }`')}`
    )
    .action(async (server, opts, command) => {
      if (!server) {
        throw new ClientError(
          'Missing required argument: server\n\nExample: mcpc login mcp.apify.com'
        );
      }
      let callbackPort: number | undefined;
      if (opts.callbackPort) {
        const parsed = parseInt(opts.callbackPort as string, 10);
        if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
          throw new ClientError(
            `Invalid --callback-port value: "${opts.callbackPort as string}". Must be an integer between 1 and 65535.`
          );
        }
        callbackPort = parsed;
      }
      let callbackHost: string | undefined;
      if (opts.callbackHost) {
        // URI hosts are case-insensitive (RFC 3986 §3.2.2), but redirect_uri
        // matching at the authorization server is an exact string comparison,
        // so normalize to lowercase rather than passing the casing through.
        callbackHost = (opts.callbackHost as string).toLowerCase();
        if (!MCPC_OAUTH_CALLBACK_HOSTS.includes(callbackHost)) {
          throw new ClientError(
            `Invalid --callback-host value: "${opts.callbackHost as string}". ` +
              `Must be one of: ${MCPC_OAUTH_CALLBACK_HOSTS.join(', ')} ` +
              '(loopback only — a non-loopback host would send the OAuth callback off this machine).'
          );
        }
      }
      await auth.login(server, {
        profile: opts.profile,
        scope: opts.scope,
        grant: opts.grant,
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        clientKey: opts.clientKey,
        clientKeyAlg: opts.clientKeyAlg,
        tokenEndpoint: opts.tokenEndpoint,
        clientMetadataUrl: opts.clientMetadataUrl,
        idp: opts.idp,
        idpClientId: opts.idpClientId,
        idpClientSecret: opts.idpClientSecret,
        idpScope: opts.idpScope,
        ...(callbackPort !== undefined ? { callbackPort } : {}),
        ...(callbackHost ? { callbackHost } : {}),
        ...getOptionsFromCommand(command),
      });
    });

  // logout command: mcpc logout <server>
  program
    .command('logout [server]')
    .usage('<server> [options]')
    .description('Delete an OAuth profile for a server')
    .option('--profile <name>', 'Profile name (default: "default")')
    .addHelpText('after', jsonHelp('`{ profile, serverUrl, deleted: true, affectedSessions }`'))
    .action(async (server, opts, command) => {
      if (!server) {
        throw new ClientError(
          'Missing required argument: server\n\nExample: mcpc logout mcp.apify.com'
        );
      }
      await auth.logout(server, {
        profile: opts.profile,
        ...getOptionsFromCommand(command),
      });
    });

  // clean command: mcpc clean [resources...]
  program
    .command('clean [resources...]')
    .description('Clean up mcpc data (sessions, profiles, logs, all)')
    .addHelpText(
      'after',
      `
${chalk.bold('Resources:')}
  sessions    Remove stale/crashed session records
  profiles    Remove authentication profiles
  logs        Remove bridge log files
  all         Remove all of the above

  Without arguments, performs safe cleanup of stale data only.
${jsonHelp('`{ crashedBridges, expiredSessions, orphanedBridgeLogs, sessions, profiles, logs }`')}`
    )
    .action(async (resources: string[], _opts, command) => {
      const globalOpts = getOptionsFromCommand(command);

      // Validate clean types
      const VALID_CLEAN_TYPES = ['sessions', 'profiles', 'logs', 'all'];
      for (const r of resources) {
        if (!VALID_CLEAN_TYPES.includes(r)) {
          throw new ClientError(
            `Invalid clean resource: "${r}". Valid resources are: ${VALID_CLEAN_TYPES.join(', ')}`
          );
        }
      }

      await clean({
        outputMode: globalOpts.outputMode,
        sessions: resources.includes('sessions'),
        profiles: resources.includes('profiles'),
        logs: resources.includes('logs'),
        all: resources.includes('all'),
      });
    });

  // grep command: mcpc grep <pattern>
  program
    .command('grep [pattern]')
    .usage('<pattern> [options]')
    .description('Search tools and instructions across all active sessions')
    .option('--tools', 'Search tools')
    .option('--resources', 'Search resources')
    .option('--prompts', 'Search prompts')
    .option('--instructions', 'Search server instructions')
    .option('-E, --regex', 'Treat pattern as a regular expression')
    .option('-s, --case-sensitive', 'Case-sensitive matching')
    .option('-m, --max-results <n>', 'Limit the number of results')
    .addHelpText(
      'after',
      `
${chalk.bold('Type filters:')}
  By default, tools and instructions are searched. Use --resources or --prompts
  to search those instead. Combine flags to search multiple types (e.g. --tools --resources).

${chalk.bold('Examples:')}
  mcpc grep "search"                        Search tools and instructions in all sessions
  mcpc grep "search" --resources            Search resources only
  mcpc grep "search" --tools --prompts      Search tools and prompts
  mcpc grep "search|find" -E                Regex search across tools and instructions
  mcpc @apify grep "actor"                  Search within a single session
  mcpc grep "file" --json                   JSON output for scripting
  mcpc grep "actor" -m 5                    Show at most 5 results

${chalk.bold('Exit codes:')}
  0 = matches found, 1 = no matches (grep convention)
${jsonHelp('`[{ sessionName, tools?: Tool[], resources?: Resource[], prompts?: Prompt[], instructions?: string[] }]`')}`
    )
    .action(async (pattern, opts, command) => {
      if (!pattern) {
        throw new ClientError(
          'Missing required argument: pattern\n\nUsage: mcpc grep <pattern>\n\nExample: mcpc grep "search"'
        );
      }
      const globalOpts = getOptionsFromCommand(command);
      const maxResults = opts.maxResults ? parseInt(opts.maxResults as string, 10) : undefined;
      const exitCode = await grepCmd.grepAllSessions(pattern, {
        tools: opts.tools as boolean | undefined,
        resources: opts.resources as boolean | undefined,
        prompts: opts.prompts as boolean | undefined,
        instructions: opts.instructions as boolean | undefined,
        regex: opts.regex as boolean | undefined,
        caseSensitive: opts.caseSensitive as boolean | undefined,
        maxResults,
        ...globalOpts,
      });
      process.exit(exitCode);
    });

  // x402 command: mcpc x402 <subcommand>
  // Note: x402 is handled before Commander in main() — this registration exists only for help text
  program
    .command('x402 [subcommand] [args...]')
    .description('Configure an x402 payment wallet (EXPERIMENTAL)')
    .action(() => {});

  // help command: mcpc help [command] (supports "help x402 sign"); --skill prints the agent guide
  program
    .command('help [command] [subcommand]')
    .description('Show help for a command')
    .option('--skill', 'Print the agent skill (mental model, workflows, examples)')
    .action(async (cmdName?: string, subcommand?: string, opts?: { skill?: boolean }) => {
      if (opts?.skill) {
        if (cmdName) {
          throw new ClientError(
            'mcpc help --skill prints the agent skill and takes no command name'
          );
        }
        help.printGuide();
        return;
      }
      if (!cmdName) {
        program.outputHelp();
        return;
      }

      // Raw MCP method names ("server/discover") are accepted wherever a command name
      // is expected, so `help` must resolve them too — otherwise looking up the alias
      // you just used successfully reports it as an unknown command.
      const slashAlias = normalizeSlashCommand(cmdName);
      if (
        slashAlias !== cmdName &&
        [...KNOWN_COMMANDS, ...KNOWN_SESSION_COMMANDS].includes(slashAlias)
      ) {
        cmdName = slashAlias;
      }

      // x402 has its own Commander program with full subcommand help
      if (cmdName === 'x402') {
        const helpArgs = subcommand ? [subcommand, '--help'] : ['--help'];
        await handleX402Command(helpArgs);
        return;
      }

      // Check top-level commands
      const topLevelCmd = program.commands.find(
        (c) => c.name() === cmdName || c.aliases().includes(cmdName)
      );
      if (topLevelCmd) {
        tuneCommandHelp(topLevelCmd);
        topLevelCmd.outputHelp();
        return;
      }

      // Check session subcommands
      if (showSessionCommandHelp(cmdName)) return;

      console.error(`Unknown command: ${cmdName}`);
      const suggestion = suggestCommand(cmdName, [...KNOWN_COMMANDS, ...KNOWN_SESSION_COMMANDS]);
      if (suggestion) {
        console.error(`\nDid you mean: mcpc help ${suggestion}`);
      }
      console.error(`Run "mcpc --help" for usage information.`);
      process.exit(1);
    });

  return program;
}

/**
 * Tune a command's help display: add --json option and hide --help.
 */
function tuneCommandHelp(cmd: Command): void {
  if (!cmd.options.some((o) => o.long === '--json')) {
    cmd.option('--json', 'Output in JSON format');
  }
  // A command that disabled its help option did so deliberately (e.g. tools-call
  // intercepts --help in its action to show the tool's schema) — re-registering
  // it here would make Commander swallow --help before the action ever runs.
  // Commander marks a disabled help option with `_helpOption === null`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((cmd as any)._helpOption === null) {
    return;
  }
  cmd.helpOption('-h, --help', 'Display help');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const helpOpt = (cmd as any)._getHelpOption?.();
  if (helpOpt) helpOpt.hidden = true;
}

/**
 * Show help for a session subcommand by name.
 * Returns true if the command was found and help was displayed.
 */
function showSessionCommandHelp(cmdName: string): boolean {
  const dummyProgram = createSessionProgram();
  registerSessionCommands(dummyProgram, '<@session>');
  for (const cmd of dummyProgram.commands) {
    tuneCommandHelp(cmd);
  }
  const sessionCmd = dummyProgram.commands.find(
    (c) => c.name() === cmdName || c.aliases().includes(cmdName)
  );
  if (sessionCmd) {
    sessionCmd.outputHelp();
    return true;
  }
  return false;
}

/**
 * Register all session subcommands on a Commander program
 * Extracted so it can be reused for both execution and help lookup
 */
function registerSessionCommands(program: Command, session: string): void {
  // Help command — show same output as --help (hidden: already shown via --help)
  program
    .command('help', { hidden: true })
    .description('Show available commands and options.')
    .action((_options, command) => {
      command.parent.outputHelp();
    });

  // Close command
  program
    .command('close')
    .description('Close MCP session.')
    .addHelpText('after', jsonHelp('`{ sessionName, closed: true }`'))
    .action(async (_options, command) => {
      await sessions.closeSession(session, getOptionsFromCommand(command));
    });

  // Restart command
  program
    .command('restart')
    .description('Restart MCP session (losing all state).')
    .addHelpText(
      'after',
      outputHelp('After restarting, shows session, server info, capabilities, and tools.') +
        serverDetailsJsonHelp('object')
    )
    .action(async (_options, command) => {
      await sessions.restartSession(session, getOptionsFromCommand(command));
    });

  // Grep command: @session grep <pattern>
  program
    .command('grep <pattern>')
    .usage('<pattern> [options]')
    .description('Search MCP session objects.')
    .option('--tools', 'Search tools')
    .option('--resources', 'Search resources')
    .option('--prompts', 'Search prompts')
    .option('--instructions', 'Search server instructions')
    .option('-E, --regex', 'Treat pattern as a regular expression')
    .option('-s, --case-sensitive', 'Case-sensitive matching')
    .option('-m, --max-results <n>', 'Limit the number of results')
    .addHelpText(
      'after',
      `
${chalk.bold('Type filters:')}
  By default, tools and instructions are searched. Use --resources or --prompts
  to search those instead. Combine flags to search multiple types.

${chalk.bold('Examples:')}
  mcpc ${session} grep "search"                  Search tools and instructions
  mcpc ${session} grep "search" --resources      Search resources only
  mcpc ${session} grep "search|find" -E          Regex search

${chalk.bold('Exit codes:')}
  0 = matches found, 1 = no matches (grep convention)
${jsonHelp('`{ tools?: Tool[], resources?: Resource[], prompts?: Prompt[], instructions?: string[] }`')}`
    )
    .action(async (pattern, opts, command) => {
      const globalOpts = getOptionsFromCommand(command);
      const maxResults = opts.maxResults ? parseInt(opts.maxResults as string, 10) : undefined;
      const exitCode = await grepCmd.grepSession(session, pattern, {
        tools: opts.tools as boolean | undefined,
        resources: opts.resources as boolean | undefined,
        prompts: opts.prompts as boolean | undefined,
        instructions: opts.instructions as boolean | undefined,
        regex: opts.regex as boolean | undefined,
        caseSensitive: opts.caseSensitive as boolean | undefined,
        maxResults,
        ...globalOpts,
      });
      process.exit(exitCode);
    });

  // Tools commands
  program
    .command('tools-list')
    .description('List all MCP tools.')
    .option('--full', 'Show full tool details including schema')
    .addHelpText(
      'after',
      jsonHelp(
        'Array of `Tool` objects',
        '`[{ name, description?, inputSchema, outputSchema?, annotations? }, ...]`',
        `${SCHEMA_BASE}#tool`
      )
    )
    .action(async (_options, command) => {
      await tools.listTools(session, getOptionsFromCommand(command));
    });

  program
    .command('tools-get <name>')
    .description('Get details and schema for an MCP tool.')
    .option('--schema <file>', 'Validate tool schema against expected schema')
    .option('--schema-mode <mode>', 'Schema validation mode: strict, compatible (default), ignore')
    .addHelpText(
      'after',
      `
${chalk.bold('Schema validation:')}
  --schema <file>       Validate against expected schema (save with tools-get --json)
  --schema-mode <mode>  strict | compatible (default) | ignore
${jsonHelp(
  '`Tool` object',
  '`{ name, description?, inputSchema, outputSchema?, annotations? }`',
  `${SCHEMA_BASE}#tool`
)}`
    )
    .action(async (name, _options, command) => {
      await tools.getTool(session, name, getOptionsFromCommand(command));
    });

  // Keep the CallToolResult line consistent across tools-call and tasks-result!
  const toolsCallJsonHelp = jsonHelp(
    '`CallToolResult` object',
    '`{ content: [{ type, text?, ... }], isError?, structuredContent?: { ... } }`',
    `${SCHEMA_BASE}#calltoolresult`
  );

  // TODO: CreateTaskResult/Task only exist on the 2025-11-25 schema page — tasks moved to the
  // io.modelcontextprotocol/tasks extension for 2026-07-28, which the SDK doesn't implement yet
  // (see CLAUDE.md). Once the SDK adds it, point this (and the #task links on tasks-list/
  // tasks-get/tasks-result) at wherever that extension's schema ends up living.
  const toolsCallCombinedJsonHelp = `
${chalk.bold('JSON output (--json):')}
  \`CallToolResult\` object:
  \`{ content: [{ type, text?, ... }], isError?, structuredContent?: { ... } }\`
  Schema: ${SCHEMA_BASE}#calltoolresult

  With \`--detach\`: \`CreateTaskResult\` object:
  \`{ taskId: string, status: string }\`
  Schema: ${LEGACY_SCHEMA_BASE}#createtaskresult
`;

  program
    .command('tools-call <name> [args...]')
    .description('Call an MCP tool with arguments.')
    .option(
      '--task',
      'Use async task execution; Ctrl+C prints the task ID and exits (experimental)'
    )
    .option('--detach', 'Start task and return immediately with task ID (implies --task)')
    .option('--schema <file>', 'Validate tool schema against expected schema before calling')
    .option('--schema-mode <mode>', 'Schema validation mode: strict, compatible (default), ignore')
    .addHelpText(
      'after',
      `
${chalk.bold('Arguments:')}
  key:=value pairs    mcpc ${session} tools-call search query:=hello limit:=10
  Inline JSON         mcpc ${session} tools-call search '{"query":"hello"}'
  Stdin pipe          echo '{"query":"hello"}' | mcpc ${session} tools-call search

  Values are auto-parsed: strings, numbers, booleans, JSON objects/arrays.
  To force a string, wrap in quotes: id:='"123"'
  Tip: mcpc ${session} tools-call <tool> --help prints the tool's parameter schema.

${chalk.bold('Async tasks (--task, --detach):')}
  --task shows a progress spinner while the task runs on the server.
  If you press Ctrl+C, the task keeps running and a hint with the task ID
  is printed so you can fetch or cancel it later.
  --detach returns the task ID immediately without waiting.
  Both flags require a server that advertises the tasks capability and uses
  MCP protocol 2025-11-25 (on 2026-07-28 servers tasks are an extension not
  yet supported by mcpc). If it does not, the command fails instead of
  running the tool synchronously — the flags change the output shape, so the
  fallback would silently return a result where a task ID is expected.
  Check per-tool support in tools-list: [task:optional|required|forbidden].

${chalk.bold('Schema validation:')}
  --schema <file>       Validate tool schema before calling (save with tools-get --json)
  --schema-mode <mode>  strict | compatible (default) | ignore
${toolsCallCombinedJsonHelp}`
    )
    .action(async (name, args, options, command) => {
      // Note: "tools-call <tool> --help" (tool schema shortcut) is intercepted
      // before Commander parses — see extractToolsCallHelpTarget().
      await tools.callTool(session, name, {
        args,
        task: options.task,
        detach: options.detach,
        ...getOptionsFromCommand(command),
      });
    });

  // Tasks commands
  program
    .command('tasks-list')
    .description('List all MCP tasks.')
    .addHelpText(
      'after',
      jsonHelp(
        '`{ tasks: Task[] }`',
        '`{ tasks: [{ taskId, status, ttl, createdAt, lastUpdatedAt, statusMessage?, pollInterval? }] }`',
        `${LEGACY_SCHEMA_BASE}#task`
      )
    )
    .action(async (_options, command) => {
      await tasks.listTasks(session, getOptionsFromCommand(command));
    });

  program
    .command('tasks-get <taskId>')
    .description('Get MCP task status.')
    .addHelpText(
      'after',
      jsonHelp(
        '`Task` object',
        '`{ taskId, status, ttl, createdAt, lastUpdatedAt, statusMessage?, pollInterval? }`',
        `${LEGACY_SCHEMA_BASE}#task`
      )
    )
    .action(async (taskId, _options, command) => {
      await tasks.getTask(session, taskId, getOptionsFromCommand(command));
    });

  program
    .command('tasks-result <taskId>')
    .description('Get MCP task final result (blocks until the task finishes).')
    .addHelpText('after', toolsCallJsonHelp)
    .action(async (taskId, _options, command) => {
      await tasks.getTaskResult(session, taskId, getOptionsFromCommand(command));
    });

  program
    .command('tasks-cancel <taskId>')
    .description('Cancel an MCP task.')
    .addHelpText(
      'after',
      jsonHelp(
        '`Task` object',
        '`{ taskId, status, ttl, createdAt, lastUpdatedAt, statusMessage?, pollInterval? }`',
        `${LEGACY_SCHEMA_BASE}#task`
      )
    )
    .action(async (taskId, _options, command) => {
      await tasks.cancelTask(session, taskId, getOptionsFromCommand(command));
    });

  // Resources commands
  program
    .command('resources-list')
    .description('List all MCP resources.')
    .addHelpText(
      'after',
      jsonHelp(
        'Array of `Resource` objects',
        '`[{ uri, name, description?, mimeType? }, ...]`',
        `${SCHEMA_BASE}#resource`
      )
    )
    .action(async (_options, command) => {
      await resources.listResources(session, getOptionsFromCommand(command));
    });

  program
    .command('resources-read <uri>')
    .description('Read an MCP resource by URI.')
    .option('-o, --output <file>', 'Save the resource to a file (decodes binary content)')
    .option('--raw', 'Print only the resource content, suitable for piping')
    .addHelpText(
      'after',
      `
${chalk.bold('Output:')}
  Default: pretty view; binary (blob) content is summarized, never dumped.
  --raw prints the bare content (binary requires a redirect or -o).
  -o <file> saves the content; base64 \`blob\` data is decoded to bytes.
  If the server returns multiple content items, --raw and -o use the item
  matching <uri> (or the first one) — use --json to get all items.
${jsonHelp(
  '`ReadResourceResult` object',
  '`{ contents: [{ uri, mimeType?, text? | blob? }], ttlMs?, cacheScope? }`',
  `${SCHEMA_BASE}#readresourceresult`
)}
  \`ttlMs\`/\`cacheScope\` are caching hints only present on 2026-07-28 connections.
  With \`-o\`: \`{ uri, file, bytes, mimeType? }\` summary instead.
`
    )
    .action(async (uri, options, command) => {
      await resources.getResource(session, uri, {
        output: options.output,
        ...(options.raw && { raw: true }),
        ...getOptionsFromCommand(command),
      });
    });

  program
    .command('resources-subscribe <uri> <file>')
    .description('Subscribe to an MCP resource and sync it to a local file.')
    .addHelpText(
      'after',
      `
${chalk.bold('Behavior:')}
  Downloads the resource to <file> now; afterwards the session bridge rewrites
  the file whenever the server announces a change for <uri> (the MCP
  notifications/resources/updated flow). Requires the server capability
  \`resources.subscribe\` — check with \`mcpc ${session}\`. Subscriptions are
  re-established automatically when the session reconnects or restarts.
  Subscribing to the same <uri> again just changes the target <file>.

${chalk.bold('Example:')}
  mcpc ${session} resources-subscribe file:///app/config.json ./config.json
${jsonHelp('`{ subscribed: true, uri, file, bytes, mimeType? }`')}`
    )
    .action(async (uri, file, _options, command) => {
      await resources.subscribeResource(session, uri, file, getOptionsFromCommand(command));
    });

  program
    .command('resources-unsubscribe <uri>')
    .description('Stop syncing a subscribed MCP resource (keeps the local file).')
    .addHelpText('after', jsonHelp('`{ unsubscribed: true, uri, file }`'))
    .action(async (uri, _options, command) => {
      await resources.unsubscribeResource(session, uri, getOptionsFromCommand(command));
    });

  program
    .command('resources-templates-list')
    .description('List MCP resource templates.')
    .addHelpText(
      'after',
      jsonHelp(
        'Array of `ResourceTemplate` objects',
        '`[{ uriTemplate, name, description?, mimeType? }, ...]`',
        `${SCHEMA_BASE}#resourcetemplate`
      )
    )
    .action(async (_options, command) => {
      await resources.listResourceTemplates(session, getOptionsFromCommand(command));
    });

  // Skills commands (experimental MCP extension: io.modelcontextprotocol/skills)
  // Sugar over resources-read using the `skill://` URI convention.
  // Spec: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640
  // NOTE: This extension is still in draft (SEP-2640) and may change. The
  // command surface here is marked EXPERIMENTAL accordingly.
  program
    .command('skills-list')
    .description('[EXPERIMENTAL] List agent skills from the server (SEP-2640).')
    .addHelpText(
      'after',
      `
${chalk.bold('Discovery:')}
  Tries \`skill://index.json\`, else scans \`skill://*/SKILL.md\`. Types:
  \`skill-md\`, \`mcp-resource-template\`, \`archive\` (use \`resources-read <url>\`).
${jsonHelp(
  '`[{ name, description, type, url }, ...]`',
  undefined,
  'https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640'
)}`
    )
    .action(async (_options, command) => {
      await skills.listSkills(session, getOptionsFromCommand(command));
    });

  program
    .command('skills-get <name>')
    .description("[EXPERIMENTAL] Read a skill's SKILL.md by name (SEP-2640).")
    .option('--raw', 'Print only the SKILL.md text (Markdown), suitable for piping')
    .addHelpText(
      'after',
      `
${chalk.bold('Names:')}
  \`name\`, \`nested/path\`, or \`skill://...\` URI. For \`archive\` skills, use
  \`resources-read <url>\`. With --json, --raw is ignored.
${jsonHelp(
  '`ReadResourceResult`: `{ contents: [{ uri, mimeType?, text? | blob? }], ttlMs?, cacheScope? }`',
  undefined,
  `${SCHEMA_BASE}#readresourceresult`
)}`
    )
    .action(async (name, options, command) => {
      await skills.getSkill(session, name, {
        ...(options.raw && { raw: true }),
        ...getOptionsFromCommand(command),
      });
    });

  // Prompts commands
  program
    .command('prompts-list')
    .description('List all MCP prompts.')
    .addHelpText(
      'after',
      jsonHelp(
        'Array of `Prompt` objects',
        '`[{ name, description?, arguments?: [{ name, required? }] }, ...]`',
        `${SCHEMA_BASE}#prompt`
      )
    )
    .action(async (_options, command) => {
      await prompts.listPrompts(session, getOptionsFromCommand(command));
    });

  program
    .command('prompts-get <name> [args...]')
    .description('Get an MCP prompt with arguments.')
    .addHelpText(
      'after',
      `
${chalk.bold('Arguments:')}
  key:=value pairs    mcpc ${session} prompts-get summarize style:=brief lang:=en
  Inline JSON         mcpc ${session} prompts-get summarize '{"style":"brief"}'
  Stdin pipe          echo '{"style":"brief"}' | mcpc ${session} prompts-get summarize

  Values are auto-parsed: strings, numbers, booleans, JSON objects/arrays.
  To force a string, wrap in quotes: id:='"123"'
${jsonHelp('`GetPromptResult` object', '`{ description?, messages: [{ role, content: { type, text?, ... } }] }`', `${SCHEMA_BASE}#getpromptresult`)}`
    )
    .action(async (name, args, _options, command) => {
      await prompts.getPrompt(session, name, {
        args,
        ...getOptionsFromCommand(command),
      });
    });

  // Logging commands
  program
    .command('logging-set-level <level>')
    .description('Set MCP server logging level (deprecated).')
    .addHelpText(
      'after',
      `
${chalk.bold('Deprecated:')}
  MCP 2026-07-28 removed logging/setLevel, so this works on 2025-11-25 (and older)
  servers only and will be removed in a future mcpc release. Use --verbose for
  client-side logging instead.
${jsonHelp('`{ level: string }`')}`
    )
    .action(async (level, _options, command) => {
      await logging.setLogLevel(session, level, getOptionsFromCommand(command));
    });

  // Server commands
  program
    .command('ping')
    .description('Ping the MCP server.')
    .addHelpText(
      'after',
      `
${chalk.bold('Notes:')}
  Measures the request roundtrip. MCP 2026-07-28 removed \`ping\`, so on modern
  connections the liveness probe is \`server/discover\` instead — run
  \`mcpc ${session} server-discover\` to see what that request returns.
${jsonHelp('`{ success: true, durationMs: number }`')}`
    )
    .action(async (_options, command) => {
      await utilities.ping(session, getOptionsFromCommand(command));
    });

  program
    .command('server-discover')
    .description('Ask the server what it supports (MCP 2026-07-28+).')
    .addHelpText(
      'after',
      `
${chalk.bold('Notes:')}
  A live \`server/discover\` request; \`mcpc ${session}\` shows the cached connect-time
  answer instead — use it on 2025-11-25 (and older) connections, where this fails.
${jsonHelp(
  '`DiscoverResult` object, verbatim',
  '`{ supportedVersions: [...], capabilities: { ... }, instructions?, _meta? }`',
  `${SCHEMA_BASE}#discoverresult`
)}`
    )
    .action(async (_options, command) => {
      await utilities.serverDiscover(session, getOptionsFromCommand(command));
    });

  // Logs command
  program
    .command('logs')
    .description('Show or follow the bridge log file for this session.')
    .option('-n, --tail <n>', 'Number of recent lines to show (default: 50)')
    .option('--follow', 'Stream new log lines as they are written')
    .option(
      '--since <value>',
      'Only show entries newer than a duration (30s, 5m, 2h, 1d) or ISO timestamp'
    )
    .addHelpText(
      'after',
      `
${chalk.bold('Examples:')}
  mcpc ${session} logs                  Last 50 lines
  mcpc ${session} logs -n 200           Last 200 lines
  mcpc ${session} logs --follow         Stream new lines (ESC/Ctrl+C/q to stop)
  mcpc ${session} logs --since 1h       Lines from the last hour
  mcpc ${session} logs --since 30m -n 50

${chalk.bold('Notes:')}
  Reads ~/.mcpc/logs/bridge-${session}.log and transparently spans
  rotated files (.log.1 … .log.5) when -n or --since needs older lines.
  Continuation lines (e.g. stack traces) fold into the preceding entry's msg.
${jsonHelp(
  'Array of log records (JSONL when streaming with --follow)',
  '`[{ time, level, context?, msg } | { raw }, ...]`'
)}`
    )
    .action(async (opts, command) => {
      const tail = opts.tail !== undefined ? parseInt(opts.tail as string, 10) : undefined;
      if (tail !== undefined && (isNaN(tail) || tail < 0)) {
        throw new ClientError(
          `Invalid --tail value: "${opts.tail as string}". Must be a non-negative integer.`
        );
      }
      await logs.showLogs(session, {
        ...getOptionsFromCommand(command),
        ...(tail !== undefined && { tail }),
        ...(opts.follow && { follow: true }),
        ...(opts.since && { since: opts.since as string }),
      });
    });
}

/**
 * Create a Commander program for session subcommands
 * Separate from top-level program to avoid command name conflicts
 */
function createSessionProgram(): Command {
  const program = new Command();

  program.configureOutput({
    // Suppress Commander's default error output; we handle errors in the catch block
    outputError: () => {},
    getOutHelpWidth: () => 100,
    getErrHelpWidth: () => 100,
  });

  // Match the top-level help styling: bold titles, cyan subcommand text
  program.configureHelp({
    subcommandTerm: (cmd) =>
      `${cmd.name()} ${cmd.usage()}`.replace(/^\[options\]\s*|\s*\[options\]/g, '').trim(),
    styleTitle: (str) => chalk.bold(str),
    styleSubcommandText: (str) => theme.cyan(str),
  });

  program
    .name('mcpc <@session>')
    .description('Show MCP session info or execute commands.')
    .helpOption('-h, --help', 'Display help')
    .option('--json', 'Output in JSON format for scripting and code mode')
    .option('--verbose', 'Enable debug logging')
    .option('--profile <name>', 'OAuth profile override')
    .option('--timeout <seconds>', 'Request timeout in seconds (default: 60)')
    .option('--max-chars <n>', 'Truncate output to n characters (ignored in --json mode)')
    .option('--insecure', 'Skip TLS certificate verification (for self-signed certs)')
    .addHelpText('after', SESSION_DETAILS_HELP);

  return program;
}

/**
 * Detect the "tools-call <tool> --help" shortcut. Returns the tool name when the
 * invocation is a tools-call carrying both a tool name and a help flag; undefined
 * otherwise (a plain "tools-call --help" falls through to Commander's command help).
 */
function extractToolsCallHelpTarget(args: string[]): string | undefined {
  if (!args.includes('--help') && !args.includes('-h')) return undefined;
  const positionals: string[] = [];
  for (let i = 2; i < args.length && positionals.length < 2; i++) {
    const arg = args[i];
    if (!arg || arg === '--help' || arg === '-h') continue;
    if (arg.startsWith('-')) {
      if (optionTakesValue(arg) && !arg.includes('=')) i++; // skip option value
      continue;
    }
    positionals.push(arg);
  }
  return positionals[0] === 'tools-call' ? positionals[1] : undefined;
}

/**
 * Handle commands for a session target (@name)
 */
async function handleSessionCommands(session: string, rawArgs: string[]): Promise<void> {
  // Accept MCP JSON-RPC-style method names (e.g. "tools/list", "logging/setLevel")
  // as silent aliases for the hyphenated command form — undocumented, never
  // advertised in help or suggestions. Must happen before any other parsing below
  // so hasSubcommand/extractToolsCallHelpTarget/Commander all see the normalized form.
  const args = normalizeSlashCommandArgs(rawArgs, KNOWN_SESSION_COMMANDS, 2);

  // Check if no subcommand provided - show server info (unless --help is requested)
  const argsSlice = args.slice(2);
  if (!hasSubcommand(args) && !argsSlice.includes('--help') && !argsSlice.includes('-h')) {
    const options = extractOptions(args);
    if (options.verbose) setVerbose(true);
    if (options.json) setJsonMode(true);

    await sessions.showServerDetails(session, {
      outputMode: options.json ? 'json' : 'human',
      ...(options.verbose && { verbose: true }),
      ...(options.timeoutSecs !== undefined && { timeoutSecs: options.timeoutSecs }),
    });
    return;
  }

  // "tools-call <tool> --help" shortcut: print the tool's parameter schema
  // (same as tools-get <tool>). Must be intercepted before Commander parses —
  // Commander consumes --help itself and would show the generic command help.
  const toolHelpName = extractToolsCallHelpTarget(args);
  if (toolHelpName) {
    const options = extractOptions(args);
    if (options.verbose) setVerbose(true);
    if (options.json) setJsonMode(true);
    await tools.getTool(session, toolHelpName, {
      outputMode: options.json ? 'json' : 'human',
      ...(options.verbose && { verbose: true }),
      ...(options.timeoutSecs !== undefined && { timeoutSecs: options.timeoutSecs }),
    });
    return;
  }

  const program = createSessionProgram();
  program.name(`mcpc ${session}`);

  // Override exit so Commander throws instead of calling process.exit()
  program.exitOverride();

  // Register all session subcommands
  registerSessionCommands(program, session);

  // Tune sub-command help display:
  // - Show --json so users/agents know it's available
  // - Hide the redundant -h/--help (you already need it to see this screen)
  for (const cmd of program.commands) {
    tuneCommandHelp(cmd);
  }

  // Parse and execute
  try {
    await program.parseAsync(args);
  } catch (error) {
    const opts = program.opts();
    const outputMode: OutputMode = opts.json ? 'json' : 'human';

    // Commander unknown command error — provide "Did you mean?" suggestion
    if (error instanceof CommanderError && error.code === 'commander.unknownCommand') {
      const unknownCmd = args.find(
        (a, i) => i >= 2 && !a.startsWith('-') && !KNOWN_SESSION_COMMANDS.includes(a)
      );
      if (unknownCmd) {
        const suggestion = suggestCommand(unknownCmd, KNOWN_SESSION_COMMANDS);
        if (outputMode === 'json') {
          console.error(formatJsonError(new Error(`Unknown command: ${unknownCmd}`), 1));
        } else {
          console.error(`Error: Unknown command: ${unknownCmd}`);
          if (suggestion) {
            console.error(`\nDid you mean: mcpc ${session} ${suggestion}`);
          }
          console.error(`Run "mcpc ${session} --help" for available commands.\n`);
        }
        process.exit(1);
      }
    }

    // Commander help/version display — exit cleanly
    if (error instanceof CommanderError && error.code === 'commander.helpDisplayed') {
      process.exit(0);
    }

    if (isMcpError(error)) {
      if (outputMode === 'json') {
        console.error(formatJsonError(error, error.code));
      } else {
        console.error(theme.red(formatHumanError(error, opts.verbose)));
      }
      process.exit(error.code);
    }

    // Unknown error
    console.error(
      outputMode === 'json'
        ? formatJsonError(error as Error, 1)
        : theme.red(formatHumanError(error, opts.verbose))
    );
    process.exit(1);
  }
}

/**
 * Flush stdout before exiting to prevent truncation with pipes
 */
async function flushStdout(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (process.stdout.writableFinished) {
      resolve();
    } else {
      process.stdout.once('finish', resolve);
      process.stdout.end();
    }
  });
}

// Run main function
main().catch(async (error) => {
  console.error('Fatal error:', error);
  await closeFileLogger();
  process.exit(1);
});
