/**
 * Tools command handlers
 */

import type { OutputMode } from '../../lib/types.js';
import { formatOutput, formatToolDetail, formatSuccess, logTarget } from '../output.js';
import { ClientError } from '../../lib/errors.js';
import { withMcpClient } from '../helpers.js';
import { parseCommandArgs, loadArgsFromFile } from '../parser.js';

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
  // Parse args from inline JSON, key=value pairs, key:=json pairs, or load from file
  let parsedArgs: Record<string, unknown>;

  if (options.argsFile && options.args && options.args.length > 0) {
    throw new ClientError('Cannot use both --args and --args-file');
  }

  if (options.argsFile) {
    parsedArgs = loadArgsFromFile(options.argsFile);
  } else {
    parsedArgs = parseCommandArgs(options.args);
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
