/**
 * Server-level commands (ping, etc.)
 */

import type { OutputMode } from '../../lib/index.js';
import { formatSuccess, formatOutput, logTarget } from '../output.js';
import { withMcpClient } from '../helpers.js';

interface CommandOptions {
  outputMode: OutputMode;
  config?: string;
  headers?: string[];
  timeout?: number;
  verbose?: boolean;
}

/**
 * Ping the MCP server to check if it's alive
 */
export async function ping(target: string, options: CommandOptions): Promise<void> {
  await withMcpClient(target, options, async (client) => {
    const startTime = performance.now();
    await client.ping();
    const endTime = performance.now();
    const durationMs = Math.round(endTime - startTime);

    logTarget(target, options.outputMode);
    if (options.outputMode === 'human') {
      console.log(formatSuccess(`Ping successful (${durationMs}ms)`));
    } else {
      console.log(
        formatOutput(
          {
            success: true,
            durationMs,
          },
          'json'
        )
      );
    }
  });
}
