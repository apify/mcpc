/**
 * Logging command handlers
 */

import type { LoggingLevel, CommandOptions } from '../../lib/types.js';
import { formatOutput, formatSuccess } from '../output.js';
import { ClientError } from '../../lib/errors.js';
import { withMcpClient } from '../helpers.js';

const VALID_LOG_LEVELS: LoggingLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];

/**
 * Set server logging level
 */
export async function setLogLevel(target: string, level: string, options: CommandOptions): Promise<void> {
  // Validate log level
  if (!VALID_LOG_LEVELS.includes(level as LoggingLevel)) {
    throw new ClientError(
      `Invalid log level: ${level}. Must be one of: ${VALID_LOG_LEVELS.join(', ')}`
    );
  }

  await withMcpClient(target, options, async (client, _context) => {
    // After validation above, we know level is a valid LoggingLevel
    await client.setLoggingLevel(level as LoggingLevel);

    if (options.outputMode === 'human') {
      console.log(formatSuccess(`Server log level set to: ${level}`));
    } else {
      console.log(
        formatOutput(
          {
            level,
            success: true,
          },
          'json'
        )
      );
    }
  });
}
