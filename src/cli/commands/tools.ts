/**
 * Tools command handlers
 */

import type { OutputMode } from '../../lib/types.js';
import { formatOutput, formatToolDetail, formatSuccess, logTarget } from '../output.js';
import { ClientError } from '../../lib/errors.js';
import { withMcpClient } from '../helpers.js';

/**
 * List available tools
 * Automatically fetches all pages if pagination is present
 */
export async function listTools(
  target: string,
  options: {
    outputMode: OutputMode;
    config?: string;
    headers?: string[];
    timeout?: number;
    verbose?: boolean;
  }
): Promise<void> {
  await withMcpClient(target, options, async (client) => {
    // Fetch all tools across all pages
    const allTools = [];
    let cursor: string | undefined = undefined;

    do {
      const result = await client.listTools(cursor);
      allTools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);

    logTarget(target, options.outputMode);
    console.log(formatOutput(allTools, options.outputMode));
  });
}

/**
 * Get information about a specific tool
 */
export async function getTool(
  target: string,
  name: string,
  options: {
    outputMode: OutputMode;
    config?: string;
    headers?: string[];
    timeout?: number;
    verbose?: boolean;
  }
): Promise<void> {
  await withMcpClient(target, options, async (client) => {
    // List all tools and find the matching one
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === name);

    if (!tool) {
      throw new ClientError(`Tool not found: ${name}`);
    }

    logTarget(target, options.outputMode);
    if (options.outputMode === 'human') {
      console.log(formatToolDetail(tool));
    } else {
      console.log(formatOutput(tool, 'json'));
    }
  });
}

/**
 * Call a tool with arguments
 */
export async function callTool(
  target: string,
  name: string,
  options: {
    args?: string[];
    argsFile?: string;
    outputMode: OutputMode;
    config?: string;
    headers?: string[];
    timeout?: number;
    verbose?: boolean;
  }
): Promise<void> {
  // Parse args from inline JSON, key=value pairs, or key:=json pairs
  let parsedArgs: Record<string, unknown> = {};

  if (options.argsFile) {
    // TODO: Load args from file
    throw new ClientError('--args-file is not implemented yet');
  } else if (options.args && options.args.length > 0) {
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

  await withMcpClient(target, options, async (client) => {
    const result = await client.callTool(name, parsedArgs);

    logTarget(target, options.outputMode);
    if (options.outputMode === 'human') {
      console.log(formatSuccess(`Tool ${name} executed successfully`));
      console.log(formatOutput(result, 'human'));
    } else {
      console.log(formatOutput(result, 'json'));
    }
  });
}
