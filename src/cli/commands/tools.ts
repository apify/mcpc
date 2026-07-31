/**
 * Tools command handlers
 */

// ora is loaded lazily at the spinner call site — it is only needed for
// long-running human-mode calls and costs ~50 ms at import.
import type { Ora } from 'ora';
import chalk from 'chalk';
import {
  formatOutput,
  formatToolDetail,
  formatToolCallExample,
  formatCallToolResultHuman,
  truncateOutput,
  formatSuccess,
  formatError,
  formatWarning,
  formatInfo,
  formatTaskCommandsHint,
} from '../output.js';
import { ClientError, ServerError } from '../../lib/errors.js';
import type { CallToolResult, CommandOptions, TaskUpdate } from '../../lib/types.js';
import { withMcpClient } from '../helpers.js';
// Imported directly (not via the core barrel) so the CLI doesn't eagerly load the MCP SDK
import {
  isModernProtocolVersion,
  tasksUnavailableMessage,
  tasksUnsupportedByServerMessage,
} from '../../core/protocol.js';
import { parseCommandArgs, hasStdinData, readStdinArgs } from '../parser.js';
import {
  loadSchemaFromFile,
  validateToolSchema,
  formatValidationError,
  type ToolSchema,
  type SchemaMode,
} from '../../lib/schema-validator.js';

/**
 * Render a `CallToolResult` payload.
 *
 * In human mode, prints a success/error banner followed by a structured view:
 * Metadata (from `_meta`), Content (text blocks, resource links, etc.), and
 * a hint when `structuredContent` is available. In `--json` mode, only the
 * raw payload is printed. Honors `--max-chars` truncation.
 *
 * Shared by `tools-call` and `tasks-result` so both commands render results
 * identically.
 */
export function renderCallToolResult(
  result: CallToolResult,
  options: Pick<CommandOptions, 'outputMode' | 'maxChars'>,
  banners?: {
    success?: string;
    error?: string;
    /** Hint shown only in human mode when the result is an error */
    errorHint?: string;
  }
): void {
  // Honor the documented exit-code contract: a tool that reports failure via
  // isError exits with code 2 (server error), so scripts chaining on `&&` stop.
  // The result is still rendered normally in both output modes.
  if (result.isError) {
    process.exitCode = 2;
  }

  if (options.outputMode === 'human') {
    if (banners) {
      if (result.isError && banners.error) {
        console.log(formatError(banners.error));
      } else if (!result.isError && banners.success) {
        console.log(formatSuccess(banners.success));
      }
    }

    let output = formatCallToolResultHuman(result);
    if (options.maxChars) {
      output = truncateOutput(output, options.maxChars);
    }
    console.log('\n' + output);

    if (result.isError && banners?.errorHint) {
      console.log(formatInfo(banners.errorHint));
    }
    return;
  }

  // JSON mode — raw payload
  console.log(
    formatOutput(result, options.outputMode, {
      ...(options.maxChars && { maxChars: options.maxChars }),
    })
  );
}

/**
 * List available tools
 * Automatically fetches all pages if pagination is present
 * By default shows compact format; use --full for complete details
 */
export async function listTools(
  target: string,
  options: CommandOptions & { full?: boolean }
): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    const result = await client.listAllTools({ refreshCache: true });
    console.log(
      formatOutput(result.tools, options.outputMode, {
        ...(options.full && { full: true }),
        ...(options.maxChars && { maxChars: options.maxChars }),
        sessionName: target,
      })
    );
  });
}

/**
 * Get information about a specific tool
 */
export async function getTool(
  target: string,
  name: string,
  options: CommandOptions
): Promise<void> {
  // Load expected schema if provided
  let expectedSchema: ToolSchema | undefined;
  if (options.schema) {
    expectedSchema = (await loadSchemaFromFile(options.schema)) as ToolSchema;
  }

  await withMcpClient(target, options, async (client, _context) => {
    // Use cached tools first, then re-fetch from server if tool not found
    let result = await client.listAllTools();
    let tool = result.tools.find((t) => t.name === name);

    if (!tool) {
      // Tool not in cache — force a fresh fetch in case the cache is stale
      result = await client.listAllTools({ refreshCache: true });
      tool = result.tools.find((t) => t.name === name);
    }

    if (!tool) {
      throw new ClientError(`Tool not found: ${name}`);
    }

    // Validate schema if provided
    if (expectedSchema) {
      const schemaMode: SchemaMode = options.schemaMode || 'compatible';
      const validation = validateToolSchema(tool as ToolSchema, expectedSchema, schemaMode);

      if (!validation.valid) {
        throw new ClientError(formatValidationError(validation, `tool "${name}"`));
      }

      // Show warnings in human mode
      if (validation.warnings.length > 0 && options.outputMode === 'human') {
        for (const warning of validation.warnings) {
          console.log(formatWarning(`Schema warning: ${warning}`));
        }
      }
    }

    if (options.outputMode === 'human') {
      console.log(formatToolDetail(tool));
      const example = formatToolCallExample(tool, target);
      if (example) {
        console.log('\n' + example + '\n');
      }
    } else {
      console.log(formatOutput(tool, 'json'));
    }
  });
}

/**
 * Format elapsed time as M:SS or H:MM:SS
 */
function formatElapsed(millis: number): string {
  const totalSeconds = Math.floor(millis / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Decide whether task-augmented execution applies to a tool call, and fail when the
 * caller asked for it but this connection cannot deliver it.
 *
 * `--task`/`--detach` change the shape of the output — `--detach` returns
 * `{ taskId, status }` instead of a `CallToolResult` — so quietly running the tool
 * synchronously instead would leave callers parsing a `taskId` that is not there, with
 * exit code 0. Either reason to fail gets its own message: the protocol has no tasks at
 * all (2026-07-28 moved them to an extension mcpc does not support yet), or the server
 * does not advertise the capability.
 */
async function shouldUseTask(
  client: import('../../lib/types.js').IMcpClient,
  async_: boolean | undefined
): Promise<boolean> {
  if (!async_) return false;
  const details = await client.getServerDetails();
  if (details.protocolVersion && isModernProtocolVersion(details.protocolVersion)) {
    throw new ServerError(tasksUnavailableMessage(details.protocolVersion));
  }
  if (!details.capabilities?.tasks?.requests?.tools?.call) {
    throw new ServerError(tasksUnsupportedByServerMessage());
  }
  return true;
}

/**
 * Set up ESC key listener for detaching from an async task.
 * Returns a promise that resolves when ESC is pressed, and a cleanup function.
 * Only activates when enabled=true and stdin is a TTY.
 */
function setupEscListener(
  enabled: boolean,
  canDetach: () => boolean
): { promise: Promise<'detached'> | null; cleanup: () => void } {
  if (!enabled || !process.stdin.isTTY) {
    return { promise: null, cleanup: () => {} };
  }

  const ESC = '\x1b';
  let cleaned = false;

  let cleanupFn = (): void => {};
  const promise = new Promise<'detached'>((resolve) => {
    const onData = (key: Buffer): void => {
      if (key.toString() === ESC && canDetach()) {
        cleanupFn();
        resolve('detached');
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);

    cleanupFn = () => {
      if (cleaned) return;
      cleaned = true;
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
  });

  return { promise, cleanup: () => cleanupFn() };
}

/**
 * Call a tool with arguments
 * Arguments can be provided via:
 * 1. Positional args: key:=value pairs or inline JSON
 * 2. Stdin: pipe JSON input (echo '{"key":"value"}' | mcpc ...)
 *
 * Use --task for task-augmented execution with progress spinner.
 * Use --detach to start a task and return the task ID immediately.
 */
export async function callTool(
  target: string,
  name: string,
  options: CommandOptions & {
    args?: string[];
    task?: boolean;
    detach?: boolean;
  }
): Promise<void> {
  // Parse args from positional arguments or stdin
  let parsedArgs: Record<string, unknown>;

  // Prefer positional arguments; only read stdin if no args provided and stdin has data
  if (options.args && options.args.length > 0) {
    // Parse from positional arguments (key:=value pairs or inline JSON)
    parsedArgs = parseCommandArgs(options.args);
  } else if (hasStdinData()) {
    // Read arguments from stdin (piped JSON)
    parsedArgs = await readStdinArgs();
  } else {
    // No arguments provided
    parsedArgs = {};
  }

  // Load expected schema if provided
  let expectedSchema: ToolSchema | undefined;
  if (options.schema) {
    expectedSchema = (await loadSchemaFromFile(options.schema)) as ToolSchema;
  }

  await withMcpClient(target, options, async (client, _context) => {
    // Validate schema if provided (skip entirely in ignore mode)
    const schemaMode: SchemaMode = options.schemaMode || 'compatible';
    if (expectedSchema && schemaMode !== 'ignore') {
      const result = await client.listTools();
      const actualTool = result.tools.find((t) => t.name === name);

      if (!actualTool) {
        throw new ClientError(`Tool not found: ${name}`);
      }

      const validation = validateToolSchema(
        actualTool as ToolSchema,
        expectedSchema,
        schemaMode,
        parsedArgs
      );

      if (!validation.valid) {
        throw new ClientError(formatValidationError(validation, `tool "${name}"`));
      }

      // Show warnings in human mode
      if (validation.warnings.length > 0 && options.outputMode === 'human') {
        for (const warning of validation.warnings) {
          console.log(formatWarning(`Schema warning: ${warning}`));
        }
      }
    }

    // --detach implies --task. Throws when this connection cannot run tasks — the flags
    // change the output shape, so falling back silently is never the right answer.
    const useTask = await shouldUseTask(client, options.detach || options.task);

    let result;

    if (useTask && options.detach) {
      // Detached execution: start async task and return task ID immediately
      const taskUpdate = await client.callToolDetached(name, parsedArgs);

      if (options.outputMode === 'human') {
        console.log(formatSuccess(`Task started: ${taskUpdate.taskId}`));
        console.log(formatTaskCommandsHint(target, taskUpdate.taskId, taskUpdate.status));
      } else {
        console.log(formatOutput({ taskId: taskUpdate.taskId, status: taskUpdate.status }, 'json'));
      }
      return;
    } else if (useTask) {
      // Task-augmented execution with progress display
      const startTime = Date.now();
      let spinner: Ora | null = null;
      let timerInterval: ReturnType<typeof setInterval> | null = null;
      let lastStatusMessage: string | undefined;
      let lastProgressMessage: string | undefined;
      let capturedTaskId: string | undefined;
      let capturedTaskStatus: TaskUpdate['status'] | undefined;

      // Set up ESC key listener for detaching (TTY + human mode only)
      const escListener = setupEscListener(options.outputMode === 'human', () => !!capturedTaskId);

      const escHintText = escListener.promise ? ` ${chalk.dim('(ESC to detach)')}` : '';

      const printDetachedHint = (taskId: string): void => {
        if (spinner) {
          spinner.info(`Detached. Task ${chalk.bold(`\`${taskId}\``)} continues in background`);
        }
        console.log(formatTaskCommandsHint(target, taskId, capturedTaskStatus ?? 'working'));
      };

      // Set up SIGINT handler to print task ID hint on Ctrl+C (human mode only)
      const sigintHandler = (): void => {
        escListener.cleanup();
        if (timerInterval) clearInterval(timerInterval);
        if (capturedTaskId && options.outputMode === 'human') {
          printDetachedHint(capturedTaskId);
        }
        process.exit(0);
      };
      process.on('SIGINT', sigintHandler);

      const updateSpinnerText = (): void => {
        if (!spinner) return;
        const elapsed = formatElapsed(Date.now() - startTime);
        const progressSuffix = lastProgressMessage ? ` ${chalk.dim(lastProgressMessage)}` : '';
        const statusSuffix =
          !lastProgressMessage && lastStatusMessage ? ` ${chalk.dim(lastStatusMessage)}` : '';
        spinner.text = `Running tool ${chalk.bold(name)}... (${elapsed})${progressSuffix}${statusSuffix}${escHintText}`;
      };

      if (options.outputMode === 'human') {
        const { default: ora } = await import('ora');
        spinner = ora({
          text: `Running tool ${chalk.bold(name)}... (0:00)${escHintText}`,
          color: 'cyan',
        }).start();
        timerInterval = setInterval(updateSpinnerText, 1000);
      }

      const onUpdate = (update: TaskUpdate): void => {
        if (update.taskId) {
          capturedTaskId = update.taskId;
        }
        if (update.status) {
          capturedTaskStatus = update.status;
        }
        if (update.statusMessage) {
          lastStatusMessage = update.statusMessage;
        }
        if (update.progressMessage) {
          lastProgressMessage = update.progressMessage;
        }
        if (spinner) {
          updateSpinnerText();
        }
      };

      try {
        const taskPromise = client.callToolWithTask(name, parsedArgs, onUpdate);

        if (escListener.promise) {
          const raceResult = await Promise.race([
            taskPromise.then((r) => ({ type: 'completed' as const, result: r })),
            escListener.promise.then(() => ({ type: 'detached' as const })),
          ]);

          escListener.cleanup();

          if (raceResult.type === 'detached') {
            if (timerInterval) clearInterval(timerInterval);
            printDetachedHint(capturedTaskId!);
            return;
          }

          result = raceResult.result;
        } else {
          result = await taskPromise;
        }

        const elapsed = formatElapsed(Date.now() - startTime);
        if (spinner) {
          if (result && (result as Record<string, unknown>).isError) {
            spinner.fail(`Tool ${chalk.bold(name)} returned an error (${elapsed})`);
          } else {
            spinner.succeed(
              `Tool ${chalk.bold(name)} executed successfully (${elapsed}) with these results:`
            );
          }
        }
      } catch (error) {
        escListener.cleanup();
        const elapsed = formatElapsed(Date.now() - startTime);
        if (spinner) {
          spinner.fail(`Tool ${chalk.bold(name)} failed (${elapsed})`);
        }
        throw error;
      } finally {
        process.off('SIGINT', sigintHandler);
        if (timerInterval) clearInterval(timerInterval);
      }
    } else {
      // Synchronous execution (default)
      result = await client.callTool(name, parsedArgs);
    }

    // Render the result using the shared CallToolResult renderer.
    // The --task branch already shows success/fail via spinner, so suppress
    // the duplicate banners in that case.
    renderCallToolResult(result, options, {
      ...(!useTask && {
        success: `Tool ${name} executed successfully with these results:`,
        error: `Tool ${name} returned an error`,
      }),
      errorHint: `Run ${chalk.bold(`mcpc ${target} tools-get ${name}`)} to see the tool schema and usage`,
    });
  });
}
