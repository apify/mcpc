/**
 * Server-level commands (ping, etc.)
 */

import { formatSuccess, formatOutput } from '../output.js';
import { withMcpClient } from '../helpers.js';
import type { CommandOptions } from '../../lib/types.js';

/**
 * Ping the MCP server to check if it's alive
 */
export async function ping(target: string, options: CommandOptions): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    const startTime = performance.now();
    await client.ping();
    const endTime = performance.now();
    const durationMs = Math.round(endTime - startTime);

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
