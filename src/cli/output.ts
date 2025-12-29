/**
 * Output formatting for CLI
 * Supports both human-readable and JSON output modes
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import chalk from 'chalk';
import type { OutputMode } from '../lib/index.js';
import type { Tool, Resource, Prompt } from '../lib/types.js';
import { extractSingleTextContent } from './tool-result.js';

// Re-export for external use
export { extractSingleTextContent } from './tool-result.js';

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
 * Format data as JSON with optional syntax highlighting
 * Highlighting only applies when outputting to a TTY (not when piping)
 */
export function formatJson(data: unknown): string {
  const json = JSON.stringify(data, null, 2);

  // Only apply syntax highlighting if outputting to a TTY
  if (!process.stdout.isTTY) {
    return json;
  }

  return highlightJson(json);
}

/**
 * Apply syntax highlighting to JSON string
 */
function highlightJson(json: string): string {
  // Match JSON tokens and apply colors
  return json.replace(
    /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, key: string | undefined, str: string | undefined, bool: string | undefined, num: string | undefined) => {
      if (key) {
        // Object key (includes the quotes and colon)
        return chalk.cyan(key) + ':';
      }
      if (str) {
        // String value
        return chalk.green(str);
      }
      if (bool) {
        // Boolean or null
        return chalk.magenta(bool);
      }
      if (num) {
        // Number
        return chalk.yellow(num);
      }
      return match;
    }
  );
}

/**
 * Format data for human-readable output
 */
export function formatHuman(data: unknown): string {
  if (data === null || data === undefined) {
    return chalk.gray('(no data)');
  }

  // Check if this is a tool call result with a single text content
  // If so, just output the text directly (as Markdown)
  const singleText = extractSingleTextContent(data);
  if (singleText !== undefined) {
    return singleText;
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

  // Primitive types (string, number, boolean, bigint, symbol)
  if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
    return String(data);
  }

  // Fallback for other primitive types
  return JSON.stringify(data);
}

/**
 * Format tool annotations as a compact string
 */
function formatToolAnnotations(annotations: Tool['annotations']): string | null {
  if (!annotations) return null;

  const parts: string[] = [];

  // Add title if different from name (will be shown separately)
  // readOnlyHint and destructiveHint
  if (annotations.readOnlyHint === true) {
    parts.push('read-only');
  } else if (annotations.destructiveHint === true) {
    parts.push(chalk.red('destructive'));
  }

  // idempotentHint
  if (annotations.idempotentHint === true) {
    parts.push('idempotent');
  }

  // openWorldHint
  if (annotations.openWorldHint === true) {
    parts.push('open-world');
  }

  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Format a list of tools as Markdown
 * First shows a quick summary with annotations, then full descriptions
 */
export function formatTools(tools: Tool[]): string {
  const lines: string[] = [];

  lines.push(`Available tools (${tools.length}):`);
  lines.push('');

  // First: quick summary list with annotations
  for (const tool of tools) {
    const annotationsStr = formatToolAnnotations(tool.annotations);
    const suffix = annotationsStr ? ` ${chalk.gray(`[${annotationsStr}]`)}` : '';
    lines.push(`- \`${tool.name}\`${suffix}`);
  }
  lines.push('');

  // Then: full descriptions
  lines.push('Tool details:');
  lines.push('');
  for (const tool of tools) {
    // Use title from annotations if available, otherwise use name
    const title = tool.annotations?.title || tool.name;
    const titleSuffix = title !== tool.name ? ` - ${title}` : '';

    if (tool.description) {
      lines.push(`## \`${tool.name}\`${titleSuffix}: ${tool.description}`);
    } else {
      lines.push(`## \`${tool.name}\`${titleSuffix}: ${chalk.gray('(no description)')}`);
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

  // Use title from annotations if available
  const title = tool.annotations?.title || tool.name;
  lines.push(`# Tool \`${tool.name}\`${title !== tool.name ? ` - ${title}` : ''}`);
  lines.push('');

  // Show annotations
  if (tool.annotations) {
    const annotationLines: string[] = [];
    if (tool.annotations.readOnlyHint === true) {
      annotationLines.push('- Read-only: yes');
    }
    if (tool.annotations.destructiveHint === true) {
      annotationLines.push('- ' + chalk.red('Destructive: yes'));
    }
    if (tool.annotations.idempotentHint === true) {
      annotationLines.push('- Idempotent: yes');
    }
    if (tool.annotations.openWorldHint === true) {
      annotationLines.push('- Open-world: yes (can access external resources)');
    }
    if (annotationLines.length > 0) {
      lines.push('## Annotations');
      lines.push(...annotationLines);
      lines.push('');
    }
  }

  if (tool.description) {
    lines.push('## Description');
    lines.push(tool.description);
    lines.push('');
  }

  lines.push('## Input schema');
  lines.push('```json');
  lines.push(JSON.stringify(tool.inputSchema, null, 2));
  lines.push('```');

  // Add output schema if present
  if ('outputSchema' in tool && tool.outputSchema) {
    lines.push('');
    lines.push('## Output schema');
    lines.push('```json');
    lines.push(JSON.stringify(tool.outputSchema, null, 2));
    lines.push('```');
  }

  return lines.join('\n');
}

/**
 * Format a list of resources as Markdown
 */
export function formatResources(resources: Resource[]): string {
  const lines: string[] = [];

  lines.push(`# Resources`);
  lines.push('');

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

  lines.push(`# Prompts`);
  lines.push('');

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
    let formattedValue: string;
    if (value === null || value === undefined) {
      formattedValue = chalk.gray(String(value));
    } else if (typeof value === 'object') {
      formattedValue = JSON.stringify(value, null, 2);
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      formattedValue = String(value);
    } else {
      // Fallback for other types (bigint, symbol, function)
      formattedValue = JSON.stringify(value);
    }
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
 * @param hide - If true, suppress the output (useful in interactive shell)
 */
export function logTarget(target: string, outputMode: OutputMode, hide = false): void {
  if (outputMode === 'human' && !hide) {
    console.log(chalk.blue(`[Using session: ${target}]`));
  }
}

/**
 * Format JSON error output
 */
export function formatJsonError(error: Error, code: number): string {
  return formatJson({
    error: error.message,
    code,
  });
}
