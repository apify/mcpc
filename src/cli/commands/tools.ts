/**
 * Tools command handlers
 */

import { formatOutput, formatToolDetail, formatSuccess, formatWarning } from '../output.js';
import { ClientError } from '../../lib/errors.js';
import type { CommandOptions } from '../../lib/types.js';
import { withMcpClient } from '../helpers.js';
import { parseCommandArgs, loadArgsFromFile } from '../parser.js';
import {
  loadSchemaFromFile,
  validateToolSchema,
  formatValidationError,
  type ToolSchema,
  type SchemaMode,
} from '../../lib/schema-validator.js';


/**
 * List available tools
 * Automatically fetches all pages if pagination is present
 */
export async function listTools(target: string, options: CommandOptions): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    // Fetch all tools across all pages
    const allTools = [];
    let cursor: string | undefined = undefined;

    do {
      const result = await client.listTools(cursor);
      allTools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);

    console.log(formatOutput(allTools, options.outputMode));
  });
}

/**
 * Get information about a specific tool
 */
export async function getTool(target: string, name: string, options: CommandOptions): Promise<void> {
  // Load expected schema if provided
  let expectedSchema: ToolSchema | undefined;
  if (options.schema) {
    expectedSchema = (await loadSchemaFromFile(options.schema)) as ToolSchema;
  }

  await withMcpClient(target, options, async (client, _context) => {
    // List all tools and find the matching one
    // TODO: It is wasteful to always re-fetch the full list (applies also to prompts),
    //  especially considering that MCP SDK client caches these.
    //  We should use SDK's or our own cache on bridge to make this more efficient
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === name);

    if (!tool) {
      throw new ClientError(`Tool not found: ${name}`);
    }

    // Validate schema if provided
    if (expectedSchema) {
      const schemaMode: SchemaMode = options.schemaMode || 'compatible';
      const validation = validateToolSchema(tool as ToolSchema, expectedSchema, schemaMode);

      if (!validation.valid) {
        throw new ClientError(formatValidationError(validation, `tool "${name}"`));
      }

      // Show warnings in human mode
      if (validation.warnings.length > 0 && options.outputMode === 'human') {
        for (const warning of validation.warnings) {
          console.log(formatWarning(`Schema warning: ${warning}`));
        }
      }
    }

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
  options: CommandOptions & {
    args?: string[];
    argsFile?: string;
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

  // Load expected schema if provided
  let expectedSchema: ToolSchema | undefined;
  if (options.schema) {
    expectedSchema = (await loadSchemaFromFile(options.schema)) as ToolSchema;
  }

  await withMcpClient(target, options, async (client, _context) => {
    // Validate schema if provided (skip entirely in ignore mode)
    const schemaMode: SchemaMode = options.schemaMode || 'compatible';
    if (expectedSchema && schemaMode !== 'ignore') {
      const result = await client.listTools();
      const actualTool = result.tools.find((t) => t.name === name);

      if (!actualTool) {
        throw new ClientError(`Tool not found: ${name}`);
      }

      const validation = validateToolSchema(actualTool as ToolSchema, expectedSchema, schemaMode, parsedArgs);

      if (!validation.valid) {
        throw new ClientError(formatValidationError(validation, `tool "${name}"`));
      }

      // Show warnings in human mode
      if (validation.warnings.length > 0 && options.outputMode === 'human') {
        for (const warning of validation.warnings) {
          console.log(formatWarning(`Schema warning: ${warning}`));
        }
      }
    }

    const result = await client.callTool(name, parsedArgs);

    if (options.outputMode === 'human') {
      console.log(formatSuccess(`Tool ${name} executed successfully`));
      console.log(formatOutput(result, 'human'));
    } else {
      console.log(formatOutput(result, 'json'));
    }
  });
}
