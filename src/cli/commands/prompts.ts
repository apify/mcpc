/**
 * Prompts command handlers
 */

import type { OutputMode } from '../../lib/types.js';
import { formatOutput, logTarget } from '../output.js';
import { ClientError } from '../../lib/errors.js';
import { withMcpClient } from '../helpers.js';

/**
 * List available prompts
 */
export async function listPrompts(
  target: string,
  options: {
    cursor?: string;
    outputMode: OutputMode;
    config?: string;
    headers?: string[];
    timeout?: number;
    verbose?: boolean;
  }
): Promise<void> {
  await withMcpClient(target, options, async (client) => {
    const result = await client.listPrompts(options.cursor);

    logTarget(target, options.outputMode);
    console.log(formatOutput(result.prompts, options.outputMode));

    // Show pagination info if there's a next cursor
    if (result.nextCursor && options.outputMode === 'human') {
      console.log(`\nMore prompts available. Use --cursor "${result.nextCursor}" to see more.`);
    }
  });
}

/**
 * Get a prompt by name
 */
export async function getPrompt(
  target: string,
  name: string,
  options: {
    args?: string[];
    outputMode: OutputMode;
    config?: string;
    headers?: string[];
    timeout?: number;
    verbose?: boolean;
  }
): Promise<void> {
  // Parse args from inline JSON, key=value pairs, or key:=json pairs
  let parsedArgs: Record<string, unknown> = {};
  if (options.args && options.args.length > 0) {
    // Check if first arg is inline JSON object/array
    const firstArg = options.args[0];
    if (firstArg && (firstArg.startsWith('{') || firstArg.startsWith('['))) {
      // Parse as inline JSON
      if (options.args.length > 1) {
        throw new ClientError('When using inline JSON, only one argument is allowed');
      }
      try {
        parsedArgs = JSON.parse(firstArg);
        if (typeof parsedArgs !== 'object' || parsedArgs === null) {
          throw new ClientError('Inline JSON must be an object or array');
        }
      } catch (error) {
        throw new ClientError(`Invalid JSON: ${(error as Error).message}`);
      }
    } else {
      // Parse key=value or key:=json pairs
      for (const pair of options.args) {
        if (pair.includes(':=')) {
          const parts = pair.split(':=', 2);
          const key = parts[0];
          const jsonValue = parts[1];
          if (!key || jsonValue === undefined) {
            throw new ClientError(`Invalid argument format: ${pair}. Use key=value or key:=json`);
          }
          try {
            parsedArgs[key] = JSON.parse(jsonValue);
          } catch (error) {
            throw new ClientError(`Invalid JSON value for ${key}: ${(error as Error).message}`);
          }
        } else if (pair.includes('=')) {
          const parts = pair.split('=', 2);
          const key = parts[0];
          const value = parts[1];
          if (!key || value === undefined) {
            throw new ClientError(`Invalid argument format: ${pair}. Use key=value or key:=json`);
          }
          parsedArgs[key] = value;
        } else {
          throw new ClientError(`Invalid argument format: ${pair}. Use key=value, key:=json, or inline JSON`);
        }
      }
    }
  }

  // Convert all args to strings for prompt API
  const promptArgs: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsedArgs)) {
    promptArgs[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }

  await withMcpClient(target, options, async (client) => {
    const result = await client.getPrompt(name, promptArgs);

    logTarget(target, options.outputMode);
    console.log(formatOutput(result, options.outputMode));
  });
}
