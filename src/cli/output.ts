/**
 * Output formatting for CLI
 * Supports both human-readable and JSON output modes
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import chalk from 'chalk';
import type { OutputMode } from '../lib/types.js';
import type { Tool, Resource, Prompt } from '../lib/types.js';

/**
 * Format output based on the specified mode
 */
export function formatOutput(data: unknown, mode: OutputMode = 'human'): string {
  if (mode === 'json') {
    return formatJson(data);
  }
  return formatHuman(data);
}

/**
 * Format data as JSON
 */
export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Format data for human-readable output
 */
export function formatHuman(data: unknown): string {
  if (data === null || data === undefined) {
    return chalk.gray('(no data)');
  }

  // Handle different data types
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return chalk.gray('(empty list)');
    }

    // Try to detect what kind of array this is
    const first = data[0];
    if (first && typeof first === 'object') {
      if ('name' in first && 'inputSchema' in first) {
        return formatTools(data as Tool[]);
      }
      if ('uri' in first) {
        return formatResources(data as Resource[]);
      }
      if ('name' in first && 'arguments' in first) {
        return formatPrompts(data as Prompt[]);
      }
    }

    // Generic array formatting
    return data.map((item) => formatHuman(item)).join('\n');
  }

  if (typeof data === 'object') {
    return formatObject(data as Record<string, unknown>);
  }

  // Primitive types
  return String(data);
}

/**
 * Format a list of tools as Markdown
 */
export function formatTools(tools: Tool[]): string {
  const lines: string[] = [];

  for (const tool of tools) {
    lines.push(`## \`${tool.name}\``);
    if (tool.description) {
      lines.push(tool.description);
    } else {
      lines.push(chalk.gray('(no description)'));
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format a single tool with details
 */
export function formatToolDetail(tool: Tool): string {
  const lines: string[] = [];

  lines.push(`# ${tool.name}`);
  lines.push('');

  if (tool.description) {
    lines.push('## Description');
    lines.push(tool.description);
    lines.push('');
  }

  lines.push('## Input schema');
  lines.push('```json');
  lines.push(JSON.stringify(tool.inputSchema, null, 2));
  lines.push('```');

  return lines.join('\n');
}

/**
 * Format a list of resources as Markdown
 */
export function formatResources(resources: Resource[]): string {
  const lines: string[] = [];

  for (const resource of resources) {
    lines.push(`## \`${resource.uri}\``);

    const details: string[] = [];
    if (resource.name) {
      details.push(`**Name:** ${resource.name}`);
    }
    if (resource.description) {
      details.push(`**Description:** ${resource.description}`);
    }
    if (resource.mimeType) {
      details.push(`**MIME Type:** ${resource.mimeType}`);
    }

    if (details.length > 0) {
      lines.push(details.join('  \n'));
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format a list of prompts as Markdown
 */
export function formatPrompts(prompts: Prompt[]): string {
  const lines: string[] = [];

  for (const prompt of prompts) {
    lines.push(`## \`${prompt.name}\``);

    if (prompt.description) {
      lines.push(prompt.description);
    }

    if (prompt.arguments && prompt.arguments.length > 0) {
      lines.push('');
      lines.push('**Arguments:**');
      for (const arg of prompt.arguments) {
        const required = arg.required ? ' (required)' : '';
        const description = arg.description ? ` - ${arg.description}` : '';
        lines.push(`- \`${arg.name}\`${required}${description}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format a generic object as key-value pairs
 */
export function formatObject(obj: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const formattedKey = chalk.cyan(`${key}:`);
    const formattedValue = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
    lines.push(`${formattedKey} ${formattedValue}`);
  }

  return lines.join('\n');
}

/**
 * Format a success message
 */
export function formatSuccess(message: string): string {
  return chalk.green(`✓ ${message}`);
}

/**
 * Format an error message
 */
export function formatError(message: string): string {
  return chalk.red(`✗ ${message}`);
}

/**
 * Format a warning message
 */
export function formatWarning(message: string): string {
  return chalk.yellow(`⚠ ${message}`);
}

/**
 * Format an info message
 */
export function formatInfo(message: string): string {
  return chalk.blue(`ℹ ${message}`);
}

/**
 * Log target prefix (only in human mode)
 */
export function logTarget(target: string, outputMode: OutputMode): void {
  if (outputMode === 'human') {
    console.log(`[Using session: ${target}]`);
  }
}

/**
 * Format JSON error output
 */
export function formatJsonError(error: Error, code: number): string {
  return JSON.stringify(
    {
      error: error.message,
      code,
    },
    null,
    2
  );
}
