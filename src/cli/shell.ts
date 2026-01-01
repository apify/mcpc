/**
 * Interactive shell for MCP sessions
 * Provides REPL-style interface with command history and tab completion
 */

import * as readline from 'readline';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { fileExists, getMcpcHome } from '../lib/utils.js';
import { formatError, logTarget } from './output.js';
import chalk from 'chalk';
import type { OutputMode, CommandOptions, NotificationData } from '../lib/types.js';
import * as tools from './commands/tools.js';
import * as resources from './commands/resources.js';
import * as prompts from './commands/prompts.js';
import * as logging from './commands/logging.js';
import { ping } from './commands/utilities.js';
import { createSessionClient } from '../lib/session-client.js';
import type { SessionClient } from '../lib/session-client.js';
import { parseShellCommand } from './shell-parser.js';

const HISTORY_MAX_COMMANDS = 1000;
const HISTORY_FILE = 'shell-history';


/**
 * Shell context
 */
interface ShellContext {
  target: string;
  history: string[];
  running: boolean;
  notificationClient?: SessionClient; // For receiving notifications
}

/**
 * Load command history from file
 */
async function loadHistory(): Promise<string[]> {
  const historyPath = join(getMcpcHome(), HISTORY_FILE);

  if (!(await fileExists(historyPath))) {
    return [];
  }

  try {
    const content = await readFile(historyPath, 'utf-8');
    return content.split('\n').filter((line) => line.trim().length > 0);
  } catch {
    // Ignore errors reading history
    return [];
  }
}

/**
 * Save command history to file
 */
async function saveHistory(history: string[]): Promise<void> {
  const historyPath = join(getMcpcHome(), HISTORY_FILE);

  // Ensure directory exists
  await mkdir(getMcpcHome(), { recursive: true });

  // Keep only last HISTORY_MAX_COMMANDS commands
  const toSave = history.slice(-HISTORY_MAX_COMMANDS);

  try {
    await writeFile(historyPath, toSave.join('\n') + '\n', 'utf-8');
  } catch {
    // Ignore errors saving history
  }
}

/**
 * Add command to history
 */
function addToHistory(ctx: ShellContext, line: string): void {
  const trimmed = line.trim();
  if (!trimmed || trimmed === ctx.history[ctx.history.length - 1]) {
    return;
  }
  ctx.history.push(trimmed);
}

/**
 * Format and display a notification
 */
function displayNotification(notification: NotificationData): void {
  const timestamp = new Date().toLocaleTimeString();
  let message = '';

  switch (notification.method) {
    case 'tools/list_changed':
      message = chalk.yellow(`[${timestamp}] Server tools list changed`);
      break;
    case 'resources/list_changed':
      message = chalk.yellow(`[${timestamp}] Server resources list changed`);
      break;
    case 'prompts/list_changed':
      message = chalk.yellow(`[${timestamp}] Server prompts list changed`);
      break;
    case 'resources/updated':
      message = chalk.yellow(`[${timestamp}] Resource updated`);
      break;
    case 'progress':
      message = chalk.blue(`[${timestamp}] Progress: ${JSON.stringify(notification.params)}`);
      break;
    case 'logging/message':
      message = chalk.gray(`[${timestamp}] Server log: ${JSON.stringify(notification.params)}`);
      break;
    default:
      message = chalk.dim(`[${timestamp}] Notification: ${String(notification.method)}`);
  }

  console.log(message);
}

/**
 * Set up notification listener for the shell
 * Creates a persistent client connection to receive notifications
 */
async function setupNotificationListener(ctx: ShellContext): Promise<void> {
  try {
    // Only set up notifications for session targets (start with @)
    if (!ctx.target.startsWith('@')) {
      return;
    }

    // Create a persistent client for receiving notifications
    ctx.notificationClient = await createSessionClient(ctx.target);

    // Set up notification handler
    ctx.notificationClient.on('notification', (notification: NotificationData) => {
      displayNotification(notification);
    });
  } catch {
    // Silently ignore errors setting up notifications
    // The shell will still work for commands
  }
}

/**
 * Show shell help
 */
function showShellHelp(): void {
  console.log(chalk.bold('\nAvailable commands:'));
  console.log('');
  console.log(chalk.cyan('  MCP commands:'));
  console.log('    tools-list');
  console.log('    tools-get <name>');
  console.log('    tools-call <name> [--args ...]');
  console.log('    resources-list');
  console.log('    resources-read <uri>');
  console.log('    resources-templates-list');
  console.log('    prompts-list');
  console.log('    prompts-get <name> [--args ...]');
  console.log('    logging-set-level <level>');
  console.log('    ping');
  console.log('');
  console.log(chalk.cyan('  Shell commands:'));
  console.log('    help              Show this help message');
  console.log('    exit, quit        Exit the shell');
  console.log('    clear             Clear the screen');
  console.log('');
}

/**
 * Execute a shell command
 */
async function executeCommand(ctx: ShellContext, line: string): Promise<void> {
  const { command, args } = parseShellCommand(line);

  if (!command) {
    return;
  }

  // Shell-specific commands
  if (command === 'help') {
    showShellHelp();
    return;
  }

  if (command === 'exit' || command === 'quit') {
    ctx.running = false;
    return;
  }

  if (command === 'clear') {
    console.clear();
    return;
  }

  // Build command options
  const options: CommandOptions = {
    outputMode: 'human' as OutputMode,
    hideTarget: true, // Don't show session info in shell
  };

  try {
    // MCP commands
    switch (command) {
      case 'ping':
        await ping(ctx.target, options);
        break;

      case 'tools':
      case 'tools-list':
        await tools.listTools(ctx.target, options);
        break;

      case 'tools-get': {
        if (args.length === 0) {
          console.log(chalk.red('Error: tools-get requires a tool name'));
          console.log('Usage: tools-get <name>');
          return;
        }
        await tools.getTool(ctx.target, args[0] as string, options);
        break;
      }

      case 'tools-call': {
        if (args.length === 0) {
          console.log(chalk.red('Error: tools-call requires a tool name'));
          console.log('Usage: tools-call <name> [--args ...]');
          return;
        }

        // Parse --args flag
        const toolName = args[0] as string;
        const argsIndex = args.indexOf('--args');
        const toolArgs = argsIndex !== -1 ? args.slice(argsIndex + 1) : undefined;

        await tools.callTool(ctx.target, toolName, {
          ...options,
          ...(toolArgs ? { args: toolArgs } : {}),
        });
        break;
      }

      case 'resources':
      case 'resources-list':
        await resources.listResources(ctx.target, options);
        break;

      case 'resources-read': {
        if (args.length === 0) {
          console.log(chalk.red('Error: resources-read requires a URI'));
          console.log('Usage: resources-read <uri>');
          return;
        }
        await resources.getResource(ctx.target, args[0] as string, options);
        break;
      }

      case 'resources-templates-list':
        await resources.listResourceTemplates(ctx.target, options);
        break;

      case 'prompts':
      case 'prompts-list':
        await prompts.listPrompts(ctx.target, options);
        break;

      case 'prompts-get': {
        if (args.length === 0) {
          console.log(chalk.red('Error: prompts-get requires a prompt name'));
          console.log('Usage: prompts-get <name> [--args ...]');
          return;
        }

        // Parse --args flag
        const promptName = args[0] as string;
        const argsIndex = args.indexOf('--args');
        const promptArgs = argsIndex !== -1 ? args.slice(argsIndex + 1) : undefined;

        await prompts.getPrompt(ctx.target, promptName, {
          ...options,
          ...(promptArgs ? { args: promptArgs } : {}),
        });
        break;
      }

      case 'logging-set-level': {
        if (args.length === 0) {
          console.log(chalk.red('Error: logging-set-level requires a level'));
          console.log('Usage: logging-set-level <level>');
          return;
        }
        await logging.setLogLevel(ctx.target, args[0] as string, options);
        break;
      }

      case 'shell': {
        // Easter egg: shell inside shell
        const shellMessages = [
          '🐚 Shell-ception! You\'re already in a shell.',
          '🪆 It\'s shells all the way down...',
          '🎭 Ha, nice try!',
          '🔄 Yo dawg, I heard you like shells...',
          '🌀 Recursion limit reached. Just kidding.',
          '🐢 A shell inside a shell? How very turtles-all-the-way-down of you.',
          '🎪 Welcome to shell² — same great shell, same great location!',
          '🪞 *shell stares back at you*',
        ];
        const message = shellMessages[Math.floor(Math.random() * shellMessages.length)];
        console.log(chalk.yellow(message));
        break;
      }

      default:
        console.log(chalk.red(`Unknown command: ${command}`));
        console.log(chalk.dim('Type "help" for available commands'));
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(formatError(errorMessage));
  }
}

/**
 * Main shell loop using readline for proper history support
 */
async function shellLoop(ctx: ShellContext): Promise<void> {
  // readline expects history in reverse order (most recent first)
  const historyReversed = ctx.history.slice(-HISTORY_MAX_COMMANDS).reverse();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history: historyReversed,
    historySize: HISTORY_MAX_COMMANDS,
    prompt: chalk.cyan(`mcpc(${ctx.target})> `),
    terminal: true,
  });

  // Handle line input
  rl.on('line', (line: string) => {
    addToHistory(ctx, line);
    void executeCommand(ctx, line).then(() => {
      if (ctx.running) {
        rl.prompt();
      } else {
        rl.close();
      }
    });
  });

  // Handle Ctrl+C
  rl.on('SIGINT', () => {
    console.log(''); // New line after ^C
    rl.prompt();
  });

  // Handle Ctrl+D or close
  rl.on('close', () => {
    ctx.running = false;
    console.log(chalk.dim('Goodbye!'));
  });

  // Start prompting
  rl.prompt();

  // Wait for shell to finish
  await new Promise<void>((resolve) => {
    rl.on('close', resolve);
  });
}

/**
 * Start interactive shell
 */
export async function startShell(target: string): Promise<void> {
  const ctx: ShellContext = {
    target,
    history: await loadHistory(),
    running: true,
  };

  // Show target info and welcome message
  await logTarget(target, { outputMode: 'human' });
  console.log(chalk.bold(`Welcome to mcpc shell`));
  console.log(chalk.dim('Type "help" for available commands, "exit" to quit\n'));

  // Set up notification listener for session targets
  await setupNotificationListener(ctx);

  // Set up cleanup on exit
  const cleanup = async (): Promise<void> => {
    await saveHistory(ctx.history);
    // Close notification client if it exists
    if (ctx.notificationClient) {
      await ctx.notificationClient.close();
    }
  };

  process.on('SIGINT', () => {
    ctx.running = false;
  });

  process.on('SIGTERM', () => {
    ctx.running = false;
  });

  try {
    await shellLoop(ctx);
  } finally {
    await cleanup();
  }
}
