/**
 * Prompts command handlers
 */

import type { CommandOptions } from '../../lib/types.js';
import { formatOutput } from '../output.js';
import { withMcpClient } from '../helpers.js';
import { readCommandArgs, stringifyArgValues } from '../parser.js';
import { fetchAllPages } from '../../lib/utils.js';

/**
 * List available prompts
 * Automatically fetches all pages if pagination is present
 */
export async function listPrompts(target: string, options: CommandOptions): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    // Fetch all prompts across all pages
    const allPrompts = await fetchAllPages(
      (cursor) => client.listPrompts(cursor),
      (page) => page.prompts
    );

    console.log(
      formatOutput(allPrompts, options.outputMode, {
        ...(options.maxChars && { maxChars: options.maxChars }),
      })
    );
  });
}

/**
 * Get a prompt by name
 * Arguments can be provided via:
 * 1. Positional args: key:=value pairs or inline JSON
 * 2. Stdin: pipe JSON input (echo '{"key":"value"}' | mcpc ...)
 */
export async function getPrompt(
  target: string,
  name: string,
  options: CommandOptions & {
    args?: string[];
  }
): Promise<void> {
  // Prompt arguments are string-only on the wire, so auto-parsed values go back to text
  const promptArgs = stringifyArgValues(await readCommandArgs(options.args));

  await withMcpClient(target, options, async (client, _context) => {
    const result = await client.getPrompt(name, promptArgs);

    console.log(
      formatOutput(result, options.outputMode, {
        ...(options.maxChars && { maxChars: options.maxChars }),
      })
    );
  });
}
