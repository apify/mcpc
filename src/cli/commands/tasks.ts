/**
 * Tasks command handlers
 * Manage async tasks on MCP servers that support the tasks capability
 */

import chalk from 'chalk';
import { formatOutput, formatSuccess, formatError, formatTaskCommandsHint } from '../output.js';
import type { CommandOptions } from '../../lib/types.js';
import { withMcpClient } from '../helpers.js';
import { formatTask, formatTasks } from '../output.js';
import { renderCallToolResult } from './tools.js';
import { fetchAllPages } from '../../lib/utils.js';

/**
 * Get the final result of a task (wraps MCP `tasks/result`).
 * Blocks on the server until the task reaches a terminal state, then prints
 * the `CallToolResult` payload using the same renderer as `tools-call`.
 */
export async function getTaskResult(
  target: string,
  taskId: string,
  options: CommandOptions
): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    const result = await client.getTaskResult(taskId);
    renderCallToolResult(result, options, {
      success: `Task ${taskId} completed with these results:`,
      error: `Task ${taskId} returned an error`,
    });
  });
}

/**
 * List active tasks on the server
 */
export async function listTasks(target: string, options: CommandOptions): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    // Fetch all tasks across all pages
    const allTasks = await fetchAllPages(
      (cursor) => client.listTasks(cursor),
      (page) => page.tasks
    );

    if (options.outputMode === 'human') {
      if (allTasks.length === 0) {
        console.log(formatSuccess('No active tasks'));
        console.log(
          chalk.dim(`To start a new task, run: mcpc ${target} tools-call <name> [args] --task`)
        );
      } else {
        console.log(formatTasks(allTasks));
        console.log(formatTaskCommandsHint(target));
      }
    } else {
      console.log(formatOutput({ tasks: allTasks }, 'json'));
    }
  });
}

/**
 * Get status of a specific task
 */
export async function getTask(
  target: string,
  taskId: string,
  options: CommandOptions
): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    const result = await client.getTask(taskId);

    if (options.outputMode === 'human') {
      console.log(formatTask(result));
      console.log(formatTaskCommandsHint(target, taskId, result.status));
    } else {
      console.log(formatOutput(result, 'json'));
    }
  });
}

/**
 * Cancel a running task
 */
export async function cancelTask(
  target: string,
  taskId: string,
  options: CommandOptions
): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    const result = await client.cancelTask(taskId);

    // Exit-code contract: a cancel that did not result in cancellation is a
    // server-side failure (exit 2), in both output modes.
    if (result.status !== 'cancelled') {
      process.exitCode = 2;
    }

    if (options.outputMode === 'human') {
      if (result.status === 'cancelled') {
        console.log(formatSuccess(`Task ${taskId} cancelled`));
      } else {
        console.log(formatError(`Task ${taskId} is in status: ${result.status}`));
      }
    } else {
      console.log(formatOutput(result, 'json'));
    }
  });
}
