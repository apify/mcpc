/**
 * Prompts command handlers
 */

import type { OutputMode } from '../../lib/types.js';
import { formatOutput, logTarget } from '../output.js';
import { withMcpClient } from '../helpers.js';
import { parseCommandArgs } from '../../lib/args-parser.js';

/**
 * List available prompts
 * Automatically fetches all pages if pagination is present
 */
export async function listPrompts(
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
    // Fetch all prompts across all pages
    const allPrompts = [];
    let cursor: string | undefined = undefined;

    do {
      const result = await client.listPrompts(cursor);
      allPrompts.push(...result.prompts);
      cursor = result.nextCursor;
    } while (cursor);

    logTarget(target, options.outputMode);
    console.log(formatOutput(allPrompts, options.outputMode));
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
  const parsedArgs = parseCommandArgs(options.args);

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
