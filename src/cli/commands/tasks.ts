/**
 * Tasks command handlers
 * Manage async tasks on MCP servers that support them: the core tasks feature of MCP
 * 2025-11-25, or the `io.modelcontextprotocol/tasks` extension of MCP 2026-07-28. The
 * client hides the wire differences; what shows through here is that the extension has
 * no task listing (so `tasks-list` shows the tasks this session created) and that its
 * cancellation is cooperative (so `tasks-cancel` reports what the server made of it).
 */

import chalk from 'chalk';
import {
  formatOutput,
  formatSuccess,
  formatError,
  formatInfo,
  formatTaskCommandsHint,
} from '../output.js';
import { isExtensionTask, type CommandOptions } from '../../lib/types.js';
import { withMcpClient } from '../helpers.js';
import { formatTask, formatTasks } from '../output.js';
import { renderCallToolResult } from './tools.js';
import { fetchAllPages } from '../../lib/utils.js';
import { isModernProtocolVersion } from '../../core/protocol.js';

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
 * List tasks: the server's own list on 2025-11-25 connections; on 2026-07-28 ones — where
 * the tasks extension has no listing — the tasks this session created.
 */
export async function listTasks(target: string, options: CommandOptions): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    // Fetch all tasks across all pages
    const [details, allTasks] = await Promise.all([
      client.getServerDetails(),
      fetchAllPages(
        (cursor) => client.listTasks(cursor),
        (page) => page.tasks
      ),
    ]);
    const tracked = !!details.protocolVersion && isModernProtocolVersion(details.protocolVersion);

    if (options.outputMode === 'human') {
      if (allTasks.length === 0) {
        console.log(
          formatSuccess(tracked ? 'No tasks started from this session' : 'No active tasks')
        );
        console.log(
          chalk.dim(`To start a new task, run: mcpc ${target} tools-call <name> [args] --task`)
        );
      } else {
        console.log(formatTasks(allTasks, { tracked }));
        if (tracked) {
          console.log(
            chalk.dim(
              'MCP 2026-07-28 servers keep no task listing: these are the tasks this session ' +
                'created and the server still knows.'
            )
          );
        }
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
      console.log(formatTask(result, { sessionName: target }));
      console.log(formatTaskCommandsHint(target, taskId, result.status));
    } else {
      console.log(formatOutput(result, 'json'));
    }
  });
}

/**
 * Cancel a running task.
 *
 * On 2025-11-25 connections the server answers with the task, cancelled or not. Under the
 * 2026-07-28 extension cancellation is cooperative: the server acknowledges the request
 * and the task may still be `working` for a while (or finish anyway), so a non-terminal
 * status after the acknowledgement is the request in flight, not a failure.
 */
export async function cancelTask(
  target: string,
  taskId: string,
  options: CommandOptions
): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    const result = await client.cancelTask(taskId);
    const cooperative = isExtensionTask(result);
    const pending =
      cooperative && (result.status === 'working' || result.status === 'input_required');

    // Exit-code contract: a cancel that did not (and will not) result in cancellation is
    // a server-side failure (exit 2), in both output modes.
    if (result.status !== 'cancelled' && !pending) {
      process.exitCode = 2;
    }

    if (options.outputMode === 'human') {
      if (result.status === 'cancelled') {
        console.log(formatSuccess(`Task ${taskId} cancelled`));
      } else if (pending) {
        console.log(
          formatInfo(
            `Cancellation of task ${taskId} requested; the server still reports it as ` +
              `${result.status} (cancellation is cooperative, check again with tasks-get)`
          )
        );
      } else {
        console.log(formatError(`Task ${taskId} is in status: ${result.status}`));
      }
    } else {
      console.log(formatOutput(result, 'json'));
    }
  });
}
