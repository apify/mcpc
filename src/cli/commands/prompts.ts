/**
 * Prompts command handlers
 */

import type { OutputMode } from '../../lib/types.js';
import { formatOutput, logTarget } from '../output.js';
import { ClientError } from '../../lib/errors.js';

/**
 * List available prompts
 */
export async function listPrompts(
  target: string,
  options: {
    cursor?: string;
    outputMode: OutputMode;
  }
): Promise<void> {
  // TODO: Connect to MCP client using target and list prompts

  const mockPrompts = [
    {
      name: 'summarize',
      description: 'Summarize a document',
      arguments: [{ name: 'document', description: 'Document to summarize', required: true }],
    },
    {
      name: 'translate',
      description: 'Translate text to another language',
      arguments: [
        { name: 'text', description: 'Text to translate', required: true },
        { name: 'language', description: 'Target language', required: true },
      ],
    },
  ];

  logTarget(target, options.outputMode);
  console.log(formatOutput(mockPrompts, options.outputMode));
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
  }
): Promise<void> {
  // TODO: Connect to MCP client using target and get prompt

  // Parse args from key=value or key:=json pairs
  let parsedArgs: Record<string, unknown> = {};
  if (options.args) {
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
        throw new ClientError(`Invalid argument format: ${pair}. Use key=value or key:=json`);
      }
    }
  }

  const mockPrompt = {
    description: `Prompt: ${name}`,
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Prompt ${name} with args: ${JSON.stringify(parsedArgs)}`,
        },
      },
    ],
  };

  logTarget(target, options.outputMode);
  console.log(formatOutput(mockPrompt, options.outputMode));
}
