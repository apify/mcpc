/**
 * Prompts command handlers
 */

import type { CommandOptions } from '../../lib/types.js';
import { formatOutput, formatWarning } from '../output.js';
import { withMcpClient } from '../helpers.js';
import { parseCommandArgs } from '../parser.js';
import { ClientError } from '../../lib/errors.js';
import {
  loadSchemaFromFile,
  validatePromptSchema,
  formatValidationError,
  type PromptSchema,
  type SchemaMode,
} from '../../lib/schema-validator.js';

/**
 * List available prompts
 * Automatically fetches all pages if pagination is present
 */
export async function listPrompts(target: string, options: CommandOptions): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    // Fetch all prompts across all pages
    const allPrompts = [];
    let cursor: string | undefined = undefined;

    do {
      const result = await client.listPrompts(cursor);
      allPrompts.push(...result.prompts);
      cursor = result.nextCursor;
    } while (cursor);

    console.log(formatOutput(allPrompts, options.outputMode));
  });
}

/**
 * Get a prompt by name
 */
export async function getPrompt(
  target: string,
  name: string,
  options: CommandOptions & {
    args?: string[];
  }
): Promise<void> {
  // Parse args from inline JSON, key=value pairs, or key:=json pairs
  const parsedArgs = parseCommandArgs(options.args);

  // Convert all args to strings for prompt API
  const promptArgs: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsedArgs)) {
    promptArgs[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }

  // Load expected schema if provided
  let expectedSchema: PromptSchema | undefined;
  if (options.schema) {
    expectedSchema = (await loadSchemaFromFile(options.schema)) as PromptSchema;
  }

  await withMcpClient(target, options, async (client, _context) => {
    // Validate schema if provided (skip entirely in ignore mode)
    const schemaMode: SchemaMode = options.schemaMode || 'compatible';
    if (expectedSchema && schemaMode !== 'ignore') {
      const result = await client.listPrompts();
      const actualSchema = result.prompts.find((p) => p.name === name);

      if (!actualSchema) {
        throw new ClientError(`Prompt not found: ${name}`);
      }

      const validation = validatePromptSchema(actualSchema as PromptSchema, expectedSchema, schemaMode, promptArgs);

      if (!validation.valid) {
        throw new ClientError(formatValidationError(validation, `prompt "${name}"`));
      }

      // Show warnings in human mode
      if (validation.warnings.length > 0 && options.outputMode === 'human') {
        for (const warning of validation.warnings) {
          console.log(formatWarning(`Schema warning: ${warning}`));
        }
      }
    }

    const result = await client.getPrompt(name, promptArgs);

    console.log(formatOutput(result, options.outputMode));
  });
}
