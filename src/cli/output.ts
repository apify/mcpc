/**
 * Output formatting for CLI
 * Supports both human-readable and JSON output modes
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import chalk from 'chalk';
import type {
  GetPromptResult,
  PromptMessage,
  ContentBlock,
} from '@modelcontextprotocol/sdk/types.js';
import type { OutputMode } from '../lib/index.js';
import type {
  Tool,
  Resource,
  ResourceTemplate,
  Prompt,
  SessionData,
  ServerDetails,
  Task,
  CallToolResult,
} from '../lib/types.js';
import { extractAllTextContent } from './tool-result.js';
import { join } from 'node:path';
import { getLogsDir } from '../lib/utils.js';
import { getSession } from '../lib/sessions.js';

// Re-export for external use
export { extractAllTextContent } from './tool-result.js';

/**
 * Convert HSL to RGB hex color
 */
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// SF rainbow palette: softened like a prism seen through coastal haze.
// Hues run from Golden Gate Bridge vermillion (12°) to soft violet (282°),
// with lower saturation (45%) and higher lightness (62%) for a pastel feel.
const RAINBOW_HUE_START = 12;
const RAINBOW_HUE_SPAN = 270;
const RAINBOW_SATURATION = 45;
const RAINBOW_LIGHTNESS = 62;

const themeHex = (hue: number): string => hslToHex(hue, RAINBOW_SATURATION, RAINBOW_LIGHTNESS);

/**
 * Themed colors sampled from the same gradient as `rainbow()` so all CLI
 * output shares the soft, fog-filtered palette shown in `mcpc --help`.
 */
export const theme = {
  red: chalk.hex(themeHex(12)), // vermillion (rainbow start)
  yellow: chalk.hex(themeHex(60)),
  // Green is bumped past the rainbow's pastel S/L so "● live" actually feels alive.
  green: chalk.hex(hslToHex(135, 65, 52)),
  cyan: chalk.hex(themeHex(190)),
  blue: chalk.hex(themeHex(230)),
  magenta: chalk.hex(themeHex(282)), // violet (rainbow end)
};

/**
 * Apply the soft rainbow gradient across each character of a string.
 */
export function rainbow(text: string): string {
  const len = text.length;
  if (len === 0) return text;

  return text
    .split('')
    .map((char, i) => {
      const hue = RAINBOW_HUE_START + (i / (len - 1)) * RAINBOW_HUE_SPAN;
      return chalk.hex(themeHex(hue))(char);
    })
    .join('');
}

/**
 * Options for formatting output
 */
export interface FormatOptions {
  /** Show full details (for tools-list, shows complete input schema) */
  full?: boolean;
  /** Session name for contextual hints (e.g. @apify) */
  sessionName?: string;
  /** Truncate human-mode output to this many characters */
  maxChars?: number;
}

/**
 * Format output based on the specified mode
 * Human mode output always ends with a newline for visual separation
 */
export function formatOutput(
  data: unknown,
  mode: OutputMode = 'human',
  options?: FormatOptions
): string {
  if (mode === 'json') {
    return formatJson(data);
  }
  let output = formatHuman(data, options);
  // Ensure trailing newline for visual separation in shell (unless ends with code block)
  if (!output.endsWith('````') && !output.endsWith('\n')) {
    output += '\n';
  }
  if (options?.maxChars) {
    output = truncateOutput(output, options.maxChars);
  }
  return output;
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
    (
      match,
      key: string | undefined,
      str: string | undefined,
      bool: string | undefined,
      num: string | undefined
    ) => {
      if (key) {
        // Object key (includes the quotes and colon)
        return theme.cyan(key) + ':';
      }
      if (str) {
        // String value
        return theme.green(str);
      }
      if (bool) {
        // Boolean or null
        return theme.magenta(bool);
      }
      if (num) {
        // Number
        return theme.yellow(num);
      }
      return match;
    }
  );
}

/**
 * Format data for human-readable output
 */
export function formatHuman(data: unknown, options?: FormatOptions): string {
  if (data === null || data === undefined) {
    return chalk.gray('(no data)');
  }

  // Check if this is a tool call result whose `content` is an array of only
  // `type: "text"` items. If so, render just the texts wrapped in quadruple
  // backticks so the content is unambiguously quoted (and skip any
  // `structuredContent` — the texts are the canonical view).
  const textContent = extractAllTextContent(data);
  if (textContent !== undefined) {
    return `${chalk.gray('````')}\n${textContent}\n${chalk.gray('````')}`;
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
        return formatTools(data as Tool[], options);
      }
      if ('uriTemplate' in first) {
        return formatResourceTemplates(data as ResourceTemplate[]);
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
    // Check if this is a GetPromptResult (has messages array with role/content)
    if (isPromptResult(data)) {
      return formatPromptResult(data);
    }
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
export function formatToolAnnotations(annotations: Tool['annotations']): string | null {
  if (!annotations) return null;

  const parts: string[] = [];

  // Add title if different from name (will be shown separately)
  // readOnlyHint and destructiveHint
  if (annotations.readOnlyHint === true) {
    parts.push('read-only');
  } else if (annotations.destructiveHint === true) {
    parts.push(theme.red('destructive'));
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
 * Get the task support mode for a tool ('required', 'optional', or undefined)
 */
export function getToolTaskSupport(tool: Tool): string | undefined {
  const toolAny = tool as Record<string, unknown>;
  const execution = toolAny.execution as Record<string, unknown> | undefined;
  return execution?.taskSupport as string | undefined;
}

/**
 * Format tool hints: annotations + task support mode.
 * Returns a string like "destructive, open-world, task:required" or null if empty.
 */
export function formatToolHints(tool: Tool): string | null {
  const parts: string[] = [];

  const annotationsStr = formatToolAnnotations(tool.annotations);
  if (annotationsStr) parts.push(annotationsStr);

  const taskSupport = getToolTaskSupport(tool);
  if (taskSupport && taskSupport !== 'forbidden') parts.push(`task:${taskSupport}`);

  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Convert a JSON Schema type definition to a simplified type string
 * e.g., { type: 'string' } -> 'string'
 *       { type: 'array', items: { type: 'number' } } -> 'array<number>'
 *       { type: ['string', 'null'] } -> 'string | null'
 */
export function formatSchemaType(schema: Record<string, unknown>): string {
  if (!schema || typeof schema !== 'object') {
    return 'any';
  }

  const schemaType = schema.type;

  // Handle union types (e.g., ['string', 'null'])
  if (Array.isArray(schemaType)) {
    return schemaType.join(' | ');
  }

  // Handle array type with items
  if (schemaType === 'array' && schema.items) {
    const items = schema.items as Record<string, unknown>;
    const itemType = formatSchemaType(items);
    return `array<${itemType}>`;
  }

  // Handle object type with properties (nested object)
  if (schemaType === 'object' && schema.properties) {
    return 'object';
  }

  // Handle enum
  if (schema.enum && Array.isArray(schema.enum)) {
    const enumValues = schema.enum as unknown[];
    if (enumValues.length <= 5) {
      return enumValues.map((v) => JSON.stringify(v)).join(' | ');
    }
    return `enum(${enumValues.length} values)`;
  }

  // Handle oneOf/anyOf
  if (schema.oneOf && Array.isArray(schema.oneOf)) {
    const types = (schema.oneOf as Record<string, unknown>[]).map(formatSchemaType);
    return types.join(' | ');
  }
  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    const types = (schema.anyOf as Record<string, unknown>[]).map(formatSchemaType);
    return types.join(' | ');
  }

  // Simple type
  if (typeof schemaType === 'string') {
    return schemaType;
  }

  return 'any';
}

/**
 * Format backticks in gray color for subtle Markdown-like display
 */
export function grayBacktick(): string {
  return chalk.gray('`');
}

/**
 * Wrap text in gray backticks with cyan coloring for code-like terms
 * Used for tool names, argument names, and other identifiers
 */
export function inBackticks(text: string): string {
  return `${grayBacktick()}${theme.cyan(text)}${grayBacktick()}`;
}

/**
 * Format a JSON Schema as simplified human-readable args
 * Returns lines like:
 *   * `path`: string [required] - description
 *   * `tail`: number - If provided, returns only the last N lines
 */
export function formatSimplifiedArgs(
  schema: Record<string, unknown>,
  indent: string = ''
): string[] {
  const lines: string[] = [];

  const bullet = chalk.dim('*');

  if (!schema || typeof schema !== 'object') {
    lines.push(`${indent}${bullet} ${chalk.gray('(none)')}`);
    return lines;
  }

  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = (schema.required as string[]) || [];

  if (!properties || Object.keys(properties).length === 0) {
    lines.push(`${indent}${bullet} ${chalk.gray('(none)')}`);
    return lines;
  }

  for (const [name, propSchema] of Object.entries(properties)) {
    const typeStr = formatSchemaType(propSchema);
    const isRequired = required.includes(name);
    const description = propSchema.description as string | undefined;
    const defaultValue = propSchema.default;

    // Build the line: * `name`: type [required] (default: value) - description
    let line = `${indent}${bullet} ${inBackticks(name)}: ${theme.yellow(typeStr)}`;

    if (isRequired) {
      line += ` ${theme.red('[required]')}`;
    }

    if (defaultValue !== undefined) {
      line += chalk.dim(` (default: ${JSON.stringify(defaultValue)})`);
    }

    if (description) {
      line += ` ${chalk.dim('-')} ${description}`;
    }

    lines.push(line);
  }

  return lines;
}

/**
 * Format a list of tools
 * Default: compact format for quick scanning
 * With full option: detailed format with complete input schema
 */
export function formatTools(tools: Tool[], options?: FormatOptions): string {
  if (options?.full) {
    return formatToolsFull(tools);
  }
  return formatToolsCompact(tools, options);
}

/**
 * Convert a full JSON Schema type to a short abbreviation for inline display.
 * e.g., 'string' -> 'str', 'object' -> 'obj', 'array<string>' -> '[str]'
 */
export function shortType(schema: Record<string, unknown>): string {
  if (!schema || typeof schema !== 'object') return 'any';

  const schemaType = schema.type;

  // Handle array type with items → [itemType]
  if (schemaType === 'array' && schema.items) {
    const itemShort = shortType(schema.items as Record<string, unknown>);
    return `[${itemShort}]`;
  }
  // Handle array without items
  if (schemaType === 'array') return '[any]';

  // Handle union types (e.g., ['string', 'null'])
  if (Array.isArray(schemaType)) {
    const filtered = schemaType.filter((t) => t !== 'null');
    if (filtered.length === 1) return shortTypeName(filtered[0] as string);
    return filtered.map((t) => shortTypeName(t as string)).join(' | ');
  }

  // Handle enum
  if (schema.enum && Array.isArray(schema.enum)) return 'enum';

  // Simple type
  if (typeof schemaType === 'string') return shortTypeName(schemaType);

  return 'any';
}

const SHORT_TYPE_MAP: Record<string, string> = {
  string: 'str',
  number: 'num',
  integer: 'int',
  boolean: 'bool',
  object: 'obj',
  array: '[any]',
};

function shortTypeName(type: string): string {
  return SHORT_TYPE_MAP[type] || type;
}

/**
 * Format inline parameter signature for tool summary.
 * Shows at most 3 params (required first, then optional in declaration order).
 * Uses short type names (str, num, obj, bool, [str]).
 */
export function formatToolParamsInline(schema: Record<string, unknown>): string {
  const properties = schema?.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties || Object.keys(properties).length === 0) return '()';

  const requiredNames = (schema.required as string[]) || [];
  const allNames = Object.keys(properties);

  // Build ordered list: required params first (in declaration order), then optional (in declaration order)
  const ordered: { name: string; required: boolean }[] = [];
  const requiredInOrder = allNames.filter((n) => requiredNames.includes(n));
  const optionalInOrder = allNames.filter((n) => !requiredNames.includes(n));
  for (const name of requiredInOrder) ordered.push({ name, required: true });
  for (const name of optionalInOrder) ordered.push({ name, required: false });

  const MAX_SHOWN = 3;
  const shown = ordered.slice(0, MAX_SHOWN);
  const hidden = ordered.length - shown.length;

  const paramStrings: string[] = shown.map(({ name, required }) => {
    const typeStr = shortType(properties[name] ?? {});
    return required ? `${name}:${typeStr}` : `${name}?:${typeStr}`;
  });

  if (hidden > 0) {
    paramStrings.push('\u2026');
  }

  return `(${paramStrings.join(', ')})`;
}

/**
 * Format tools summary list (shared by compact and full modes)
 * Format: * `tool_name(params)` [annotations]
 */
/**
 * Format a single tool as a compact bullet line: * `tool_name (params)` [annotations]
 */
export function formatToolLine(tool: Tool): string {
  const bullet = chalk.dim('*');
  const params = formatToolParamsInline(tool.inputSchema as Record<string, unknown>);
  const hintsStr = formatToolHints(tool);
  const suffix = hintsStr ? ` ${chalk.gray(`[${hintsStr}]`)}` : '';
  return `${bullet} ${grayBacktick()}${theme.cyan(tool.name)} ${params}${grayBacktick()}${suffix}`;
}

function formatToolsSummary(tools: Tool[]): string[] {
  const lines: string[] = [];

  // Header with tool count
  lines.push(chalk.bold(`Tools (${tools.length}):`));

  // Summary list of tools
  for (const tool of tools) {
    lines.push(formatToolLine(tool));
  }

  return lines;
}

/**
 * Format tools in compact form (just the summary list)
 */
function formatToolsCompact(tools: Tool[], options?: FormatOptions): string {
  const lines = formatToolsSummary(tools);

  // Footer hint
  const session = options?.sessionName ? `${options.sessionName} ` : '';
  lines.push('');
  lines.push(
    `For full tool details and schema, run \`mcpc ${session}tools-list --full\` or \`mcpc ${session}tools-get <name>\``
  );

  return lines.join('\n');
}

/**
 * Format tools with full details (summary + detailed view for each tool)
 */
function formatToolsFull(tools: Tool[]): string {
  const lines = formatToolsSummary(tools);

  // Detailed view for each tool with separators
  for (const tool of tools) {
    lines.push('');
    lines.push(chalk.dim('---'));
    lines.push(formatToolDetail(tool));
  }

  return lines.join('\n');
}

/**
 * Format a single tool with details (Markdown-like display)
 */
export function formatToolDetail(tool: Tool): string {
  const lines: string[] = [];

  // Title from annotations (if present) - shown as heading above tool name
  const title = tool.annotations?.title;
  if (title) {
    lines.push(chalk.bold(`# ${title}`));
  }

  // Tool header: Tool: `name` [hints]
  const hintsStr = formatToolHints(tool);
  const hintsSuffix = hintsStr ? ` ${chalk.gray(`[${hintsStr}]`)}` : '';
  lines.push(`${chalk.bold('Tool:')} ${inBackticks(tool.name)}${hintsSuffix}`);

  // Input args
  lines.push('');
  lines.push(chalk.bold('Input:'));
  const inputArgs = formatSimplifiedArgs(tool.inputSchema as Record<string, unknown>, '');
  lines.push(...inputArgs);

  // Output schema (if present)
  if ('outputSchema' in tool && tool.outputSchema) {
    lines.push('');
    lines.push(chalk.bold('Output:'));
    const outputArgs = formatSimplifiedArgs(tool.outputSchema as Record<string, unknown>, '');
    lines.push(...outputArgs);
  }

  // Description in code block
  const description = (tool.description || '').trim();
  if (description) {
    lines.push('');
    lines.push(chalk.bold('Description:'));
    lines.push(chalk.gray('````'));
    lines.push(description);
    lines.push(chalk.gray('````'));
  }

  return lines.join('\n');
}

/**
 * Generate an example placeholder value for a JSON Schema property.
 * Uses the default value if available, otherwise a reasonable placeholder.
 */
function exampleValue(propSchema: Record<string, unknown>): string {
  // Use default value if available
  if (propSchema.default !== undefined) {
    return JSON.stringify(propSchema.default);
  }

  // Use first enum value if available
  if (propSchema.enum && Array.isArray(propSchema.enum) && propSchema.enum.length > 0) {
    return JSON.stringify(propSchema.enum[0]);
  }

  const schemaType = propSchema.type;

  if (schemaType === 'string') return '"something"';
  if (schemaType === 'number') return '1';
  if (schemaType === 'integer') {
    // Respect minimum if set
    const min = propSchema.minimum as number | undefined;
    return String(min ?? 1);
  }
  if (schemaType === 'boolean') return 'true';

  // Union types like ['string', 'null']
  if (Array.isArray(schemaType)) {
    const nonNull = schemaType.filter((t) => t !== 'null');
    if (nonNull.includes('string')) return '"something"';
    if (nonNull.includes('number') || nonNull.includes('integer')) return '1';
    if (nonNull.includes('boolean')) return 'true';
  }

  return '"something"';
}

/**
 * Wrap a JSON-stringified example value in single quotes if it contains
 * characters that would be mangled by a POSIX shell (double quotes, brackets,
 * braces, spaces, etc.). This ensures the "Call example" line can be
 * copy-pasted into a shell verbatim and still round-trip through the parser.
 *
 * Without this, values like `["markdown"]` lose their inner quotes to shell
 * word-splitting and reach mcpc as `[markdown]`, which is not valid JSON.
 */
function shellSafeExampleValue(jsonValue: string): string {
  // Numbers, booleans, null, and simple identifier-like tokens are safe as-is.
  if (/^[a-zA-Z0-9_.+-]+$/.test(jsonValue)) {
    return jsonValue;
  }
  // Single-quote the value, escaping any embedded single quotes using the
  // POSIX-portable `'\''` trick.
  return `'${jsonValue.replace(/'/g, `'\\''`)}'`;
}

/**
 * Format a tools-call usage example for a tool, showing how to invoke it.
 * Shows required params first, then fills with optional params up to 3 total.
 */
export function formatToolCallExample(tool: Tool, sessionName?: string): string | null {
  const schema = tool.inputSchema as Record<string, unknown> | undefined;
  const properties = schema?.properties as Record<string, Record<string, unknown>> | undefined;
  const session = sessionName || '<@session>';

  // Build --task flag based on task support
  const taskSupport = getToolTaskSupport(tool);
  const taskFlag =
    taskSupport === 'required' ? ' --task' : taskSupport === 'optional' ? ' [--task]' : '';

  const bullet = chalk.dim('*');

  if (!properties || Object.keys(properties).length === 0) {
    // Tool takes no arguments — still show the simple call
    const cmd = `mcpc ${session} tools-call ${tool.name}${taskFlag}`;
    return `${chalk.bold('Call example:')}\n${bullet} ${grayBacktick()}${theme.cyan(cmd)}${grayBacktick()}`;
  }

  const requiredNames = (schema?.required as string[]) || [];
  const allNames = Object.keys(properties);
  const requiredInOrder = allNames.filter((n) => requiredNames.includes(n));
  const optionalInOrder = allNames.filter((n) => !requiredNames.includes(n));

  // Pick params: all required, then fill optional up to 3 total
  const MAX_EXAMPLE_PARAMS = 3;
  const params: string[] = [...requiredInOrder];
  if (params.length < MAX_EXAMPLE_PARAMS) {
    const remaining = MAX_EXAMPLE_PARAMS - params.length;
    params.push(...optionalInOrder.slice(0, remaining));
  }

  const argParts = params.map((name) => {
    const val = shellSafeExampleValue(exampleValue(properties[name] ?? {}));
    return `${name}:=${val}`;
  });

  const cmd = `mcpc ${session} tools-call ${tool.name} ${argParts.join(' ')}${taskFlag}`;
  return `${chalk.bold('Call example:')}\n${bullet} ${grayBacktick()}${theme.cyan(cmd)}${grayBacktick()}`;
}

/**
 * Format a list of resources with Markdown-like display
 */
export function formatResources(resources: Resource[]): string {
  const lines: string[] = [];

  // Header with resource count
  lines.push(chalk.bold(`Resources (${resources.length}):`));

  // Summary list of resources
  const bullet = chalk.dim('*');
  for (const resource of resources) {
    lines.push(`${bullet} ${inBackticks(resource.uri)}`);
  }

  // Detailed view for each resource with separators
  for (const resource of resources) {
    lines.push('');
    lines.push(chalk.dim('---'));
    lines.push(formatResourceDetail(resource));
  }

  return lines.join('\n');
}

/**
 * Format a single resource with details (Markdown-like display)
 */
export function formatResourceDetail(resource: Resource): string {
  const lines: string[] = [];

  // Resource header: Resource: `uri`
  lines.push(`${chalk.bold('Resource:')} ${inBackticks(resource.uri)}`);

  // Name (if different from URI)
  if (resource.name) {
    lines.push(`${chalk.bold('Name:')} ${resource.name}`);
  }

  // MIME type
  if (resource.mimeType) {
    lines.push(`${chalk.bold('MIME type:')} ${theme.yellow(resource.mimeType)}`);
  }

  // Description in code block
  const description = (resource.description || '').trim();
  if (description) {
    lines.push('');
    lines.push(chalk.bold('Description:'));
    lines.push(chalk.gray('````'));
    lines.push(description);
    lines.push(chalk.gray('````'));
  }

  return lines.join('\n');
}

/**
 * Format a list of resource templates with Markdown-like display
 */
export function formatResourceTemplates(templates: ResourceTemplate[]): string {
  const lines: string[] = [];

  // Header with template count
  lines.push(chalk.bold(`Resource templates (${templates.length}):`));

  // Summary list of templates
  const bullet = chalk.dim('*');
  for (const template of templates) {
    lines.push(`${bullet} ${inBackticks(template.uriTemplate)}`);
  }

  // Detailed view for each template with separators
  for (const template of templates) {
    lines.push('');
    lines.push(chalk.dim('---'));
    lines.push(formatResourceTemplateDetail(template));
  }

  return lines.join('\n');
}

/**
 * Format a single resource template with details (Markdown-like display)
 */
export function formatResourceTemplateDetail(template: ResourceTemplate): string {
  const lines: string[] = [];

  // Template header: Template: `uriTemplate`
  lines.push(`${chalk.bold('Template:')} ${inBackticks(template.uriTemplate)}`);

  // Name (if present)
  if (template.name) {
    lines.push(`${chalk.bold('Name:')} ${template.name}`);
  }

  // MIME type
  if (template.mimeType) {
    lines.push(`${chalk.bold('MIME type:')} ${theme.yellow(template.mimeType)}`);
  }

  // Description in code block
  const description = (template.description || '').trim();
  if (description) {
    lines.push('');
    lines.push(chalk.bold('Description:'));
    lines.push(chalk.gray('````'));
    lines.push(description);
    lines.push(chalk.gray('````'));
  }

  return lines.join('\n');
}

/**
 * Format a list of prompts with Markdown-like display
 */
export function formatPrompts(prompts: Prompt[]): string {
  const lines: string[] = [];

  // Header with prompt count
  lines.push(chalk.bold(`Prompts (${prompts.length}):`));

  // Summary list of prompts
  const bullet = chalk.dim('*');
  for (const prompt of prompts) {
    lines.push(`${bullet} ${inBackticks(prompt.name)}`);
  }

  // Detailed view for each prompt with separators
  for (const prompt of prompts) {
    lines.push('');
    lines.push(chalk.dim('---'));
    lines.push(formatPromptDetail(prompt));
  }

  return lines.join('\n');
}

/**
 * Format a single prompt with details (Markdown-like display)
 */
export function formatPromptDetail(prompt: Prompt): string {
  const lines: string[] = [];

  // Prompt header: Prompt: `name`
  lines.push(`${chalk.bold('Prompt:')} ${inBackticks(prompt.name)}`);

  // Arguments
  lines.push('');
  lines.push(chalk.bold('Arguments:'));
  if (prompt.arguments && prompt.arguments.length > 0) {
    for (const arg of prompt.arguments) {
      const typePart = theme.yellow('string'); // Prompt arguments are always strings
      const requiredPart = arg.required ? ` ${theme.red('[required]')}` : '';
      const description = arg.description ? ` ${chalk.dim('-')} ${arg.description}` : '';
      lines.push(`  ${inBackticks(arg.name)}: ${typePart}${requiredPart}${description}`);
    }
  } else {
    lines.push(chalk.gray('  (no arguments)'));
  }

  // Description in code block
  const description = (prompt.description || '').trim();
  if (description) {
    lines.push('');
    lines.push(chalk.bold('Description:'));
    lines.push(chalk.gray('````'));
    lines.push(description);
    lines.push(chalk.gray('````'));
  }

  return lines.join('\n');
}

/**
 * Check if data is a GetPromptResult (has messages array with role/content)
 */
function isPromptResult(data: unknown): data is GetPromptResult {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  if (!('messages' in obj) || !Array.isArray(obj.messages)) return false;
  if (obj.messages.length === 0) return false;
  const first = obj.messages[0] as Record<string, unknown>;
  return 'role' in first && 'content' in first;
}

/**
 * Format GetPromptResult messages with nice display
 */
function formatPromptResult(result: GetPromptResult): string {
  const lines: string[] = [];

  // Description first if present
  const description = (result.description || '').trim();
  if (description) {
    lines.push(chalk.bold('Description:'));
    lines.push(chalk.gray('````'));
    lines.push(description);
    lines.push(chalk.gray('````'));
    lines.push('');
  }

  // Messages header
  lines.push(chalk.bold(`Messages (${result.messages.length}):`));

  // Format each message
  for (const message of result.messages) {
    lines.push('');
    lines.push(`${chalk.bold('Role:')} ${theme.cyan(message.role)}`);
    lines.push(formatPromptContent(message.content));
  }

  return lines.join('\n');
}

/**
 * Format a single content block from a prompt message
 */
function formatPromptContent(content: PromptMessage['content']): string {
  const lines: string[] = [];

  // ContentBlock is a union type, use type narrowing
  const block = content as ContentBlock;

  switch (block.type) {
    case 'text':
      lines.push(chalk.gray('````'));
      lines.push(block.text || '');
      lines.push(chalk.gray('````'));
      break;

    case 'image':
      lines.push(chalk.gray('````'));
      lines.push(`[Image: ${block.mimeType || 'unknown type'}]`);
      if (block.data) {
        lines.push(`${block.data.substring(0, 50)}...`);
      }
      lines.push(chalk.gray('````'));
      break;

    case 'audio':
      lines.push(chalk.gray('````'));
      lines.push(`[Audio: ${block.mimeType || 'unknown type'}]`);
      lines.push(chalk.gray('````'));
      break;

    case 'resource_link':
      lines.push(chalk.gray('````'));
      lines.push(`[Resource link: ${block.uri || 'unknown'}]`);
      lines.push(chalk.gray('````'));
      break;

    case 'resource':
      lines.push(chalk.gray('````'));
      if (block.resource) {
        lines.push(`[Embedded resource: ${block.resource.uri}]`);
        if ('text' in block.resource && block.resource.text) {
          lines.push(block.resource.text);
        }
      } else {
        lines.push('[Embedded resource]');
      }
      lines.push(chalk.gray('````'));
      break;

    default:
      // Fallback for unknown content types
      lines.push(chalk.gray('````'));
      lines.push(JSON.stringify(content, null, 2));
      lines.push(chalk.gray('````'));
  }

  return lines.join('\n');
}

/**
 * Get a colored status indicator for a task status
 */
function taskStatusLabel(status: string): string {
  const label = (icon: string): string => `${icon} ${status}`;
  switch (status) {
    case 'working':
      return theme.cyan(label('⟳'));
    case 'input_required':
      return theme.yellow(label('?'));
    case 'completed':
      return theme.green(label('✔'));
    case 'failed':
      return theme.red(label('✖'));
    case 'cancelled':
      return chalk.gray(label('⊘'));
    default:
      return chalk.gray(label('·'));
  }
}

/**
 * Format a single task with details
 */
export function formatTask(task: Task): string {
  const lines: string[] = [];

  lines.push(`${chalk.bold('Task ID:')} ${inBackticks(task.taskId)}`);
  lines.push(`${chalk.bold('Status:')} ${taskStatusLabel(task.status)}`);

  if (task.statusMessage) {
    lines.push(`${chalk.bold('Message:')} ${task.statusMessage}`);
  }

  if (task.createdAt) {
    lines.push(`${chalk.bold('Created:')} ${task.createdAt}`);
  }
  if (task.lastUpdatedAt) {
    lines.push(`${chalk.bold('Updated:')} ${task.lastUpdatedAt}`);
  }

  return lines.join('\n');
}

/**
 * Format a list of tasks as a summary table
 */
export function formatTasks(taskList: Task[]): string {
  const lines: string[] = [];

  lines.push(chalk.bold(`Tasks (${taskList.length}):`));

  const bullet = chalk.dim('*');
  for (const task of taskList) {
    const statusStr = taskStatusLabel(task.status);
    const msgStr = task.statusMessage ? chalk.dim(` - ${task.statusMessage}`) : '';
    lines.push(`${bullet} ${inBackticks(task.taskId)}  ${statusStr}${msgStr}`);
  }

  return lines.join('\n');
}

/**
 * Format a single MCP content block for human display.
 * Used by `formatCallToolResultHuman` to render each block in the Content section.
 */
function formatContentBlock(block: ContentBlock, lines: string[]): void {
  const bullet = chalk.dim('*');

  switch (block.type) {
    case 'text':
      lines.push(chalk.gray('````'));
      lines.push(block.text);
      lines.push(chalk.gray('````'));
      break;

    case 'resource_link':
      lines.push(chalk.bold('Resource link'));
      lines.push(`${bullet} URI: ${block.uri}`);
      if (block.name) lines.push(`${bullet} Name: ${block.name}`);
      if (block.description) {
        lines.push(
          `${bullet} Description: ${chalk.gray('````')}${block.description}${chalk.gray('````')}`
        );
      }
      if (block.mimeType) lines.push(`${bullet} MIME type: ${block.mimeType}`);
      break;

    case 'image':
      lines.push(
        `[Image: ${block.mimeType || 'unknown type'}${block.data ? `, ${block.data.length} chars base64` : ''}]`
      );
      break;

    case 'audio':
      lines.push(
        `[Audio: ${block.mimeType || 'unknown type'}${block.data ? `, ${block.data.length} chars base64` : ''}]`
      );
      break;

    case 'resource':
      lines.push(chalk.bold('Embedded resource'));
      if (block.resource) {
        lines.push(`${bullet} URI: ${block.resource.uri}`);
        if (block.resource.mimeType) lines.push(`${bullet} MIME type: ${block.resource.mimeType}`);
        if ('text' in block.resource && block.resource.text) {
          lines.push(chalk.gray('````'));
          lines.push(block.resource.text);
          lines.push(chalk.gray('````'));
        }
      }
      break;

    default:
      lines.push(JSON.stringify(block, null, 2));
  }
}

/**
 * Return the indices of text content blocks that are JSON serializations of
 * `structuredContent`.  Per the MCP spec, servers SHOULD include such a block
 * for backwards compatibility — we skip those blocks from the Content section
 * so the better-formatted Structured content section is the canonical view.
 */
function findDuplicateTextBlocks(
  content: CallToolResult['content'],
  structuredContent: Record<string, unknown>
): Set<number> {
  const dupes = new Set<number>();
  const canonical = JSON.stringify(structuredContent);
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block || block.type !== 'text') continue;
    try {
      const parsed: unknown = JSON.parse((block as { text: string }).text.trim());
      if (JSON.stringify(parsed) === canonical) dupes.add(i);
    } catch {
      // not valid JSON — keep the block
    }
  }
  return dupes;
}

/**
 * Format a `CallToolResult` for human-readable display.
 *
 * Sections (each printed only when present):
 * 1. **Content:** — each content block rendered per its type (text blocks
 *    that duplicate `structuredContent` are omitted)
 * 2. **Structured content:** — `structuredContent` as syntax-highlighted JSON,
 *    shown only when there is no visible Content (otherwise it duplicates
 *    information already present and adds noise for LLM consumers; use
 *    `--json` to always get the full payload)
 * 3. **Metadata:** — `_meta` as syntax-highlighted JSON
 */
export function formatCallToolResultHuman(result: CallToolResult): string {
  const lines: string[] = [];

  // Identify text blocks that are just a JSON dump of structuredContent
  const sc = result.structuredContent;
  const hasStructuredContent = !!sc && Object.keys(sc).length > 0;
  const content = result.content;
  let skipIndices = new Set<number>();
  if (hasStructuredContent && content && sc) {
    skipIndices = findDuplicateTextBlocks(content, sc);
  }

  const visibleContent = content?.filter((_, i) => !skipIndices.has(i)) ?? [];

  // Content section — skip duplicate text blocks
  if (visibleContent.length > 0) {
    lines.push(chalk.bold('Content:'));
    for (let i = 0; i < visibleContent.length; i++) {
      if (i > 0) lines.push('');
      formatContentBlock(visibleContent[i] as ContentBlock, lines);
    }
  }

  // Structured content section — only when Content is empty, to avoid
  // redundant verbose output for LLMs. Available via `--json` if needed.
  if (hasStructuredContent && visibleContent.length === 0) {
    if (lines.length > 0) lines.push('');
    lines.push(chalk.bold('Structured content:'));
    const scJson = JSON.stringify(sc, null, 2);
    lines.push(process.stdout.isTTY ? highlightJson(scJson) : scJson);
  }

  // Metadata section — syntax-highlighted JSON, shown last
  const meta = result._meta;
  if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(chalk.bold('Metadata:'));
    const metaJson = JSON.stringify(meta, null, 2);
    lines.push(process.stdout.isTTY ? highlightJson(metaJson) : metaJson);
  }

  if (lines.length === 0) {
    return chalk.gray('(no content)');
  }

  return lines.join('\n');
}

/**
 * Format a generic object as key-value pairs
 */
export function formatObject(obj: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const formattedKey = theme.cyan(`${key}:`);
    let formattedValue: string;
    if (value === null || value === undefined) {
      formattedValue = chalk.gray(String(value));
    } else if (typeof value === 'object') {
      formattedValue = JSON.stringify(value, null, 2);
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
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
  return theme.green(`✓ ${message}`);
}

/**
 * Format an error message
 */
export function formatError(message: string): string {
  return theme.red(`✗ ${message}`);
}

/**
 * Format a warning message
 */
export function formatWarning(message: string): string {
  return theme.yellow(`⚠ ${message}`);
}

/**
 * Format an info message
 */
export function formatInfo(message: string): string {
  return theme.cyan(`ℹ ${message}`);
}

export function formatTaskCommandsHint(
  target: string,
  taskId?: string,
  status?: Task['status']
): string {
  const id = taskId ?? '<taskId>';
  const lines = [
    '\nAvailable commands:',
    `  mcpc ${target} tasks-get ${id}`,
    `  mcpc ${target} tasks-result ${id}`,
  ];
  // Only suggest cancel while the task is still active (or when status is unknown,
  // e.g. the generic list hint where individual task statuses vary).
  if (status === undefined || status === 'working' || status === 'input_required') {
    lines.push(`  mcpc ${target} tasks-cancel ${id}`);
  }
  return lines.join('\n');
}

/**
 * Truncate formatted output string to maxChars, appending a notice about truncation.
 * Returns the original string if within limit.
 */
export function truncateOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  const truncated = output.substring(0, maxChars);
  const totalSize =
    output.length >= 1024 ? `${(output.length / 1024).toFixed(1)}KB` : `${output.length} chars`;
  return `${truncated}\n\n... output truncated (${totalSize} total, showing first ${maxChars} chars). Use --max-chars to adjust.`;
}

/**
 * Truncate string with ellipsis if significantly longer than maxLen
 * Allows +3 chars slack to avoid weird cutoffs
 */
function truncateWithEllipsis(str: string, maxLen: number): string {
  if (str.length <= maxLen + 3) return str;
  return str.substring(0, maxLen - 1) + '…';
}

/**
 * Format a session line for display (without status)
 * Returns: "@name → target (OAuth: profile)" with colors applied
 */
export function formatSessionLine(session: SessionData): string {
  // Format session name (cyan)
  const nameStr = theme.cyan(session.name);

  // Format target
  let target: string;
  if (session.server.url) {
    // For http: show full URL as there might be different MCP servers on different paths
    target = session.server.url;
  } else {
    // For stdio: show command + args
    target = session.server.command || 'unknown';
    if (session.server.args && session.server.args.length > 0) {
      target += ' ' + session.server.args.join(' ');
    }
  }
  const targetStr = truncateWithEllipsis(target, 80);

  // Format auth info. OAuth and x402 are mutually exclusive auth mechanisms;
  // x402 takes precedence when both happen to be present on the session record.
  let infoStr = '';
  if (session.x402) {
    infoStr = theme.yellow('[x402]');
  } else if (!session.server.command && session.profileName) {
    infoStr = chalk.dim('(OAuth: ') + theme.magenta(session.profileName) + chalk.dim(')');
  }

  // Add proxy info separately (not dimmed, for visibility)
  let proxyStr = '';
  if (session.proxy) {
    proxyStr =
      ' ' +
      theme.green('[proxy: ') +
      chalk.greenBright(`${session.proxy.host}:${session.proxy.port}`) +
      theme.green(']');
  }

  const suffix = [infoStr, proxyStr].filter(Boolean).join(' ');
  return `${nameStr} → ${targetStr}${suffix ? ' ' + suffix : ''}`;
}

/**
 * Options for logTarget
 */
export interface LogTargetOptions {
  outputMode: OutputMode;
  hide?: boolean | undefined;
}

/**
 * Log session info prefix (only in human mode)
 * Shows: [@name → server (auth)]
 */
export async function logTarget(target: string, options: LogTargetOptions): Promise<void> {
  if (options.outputMode !== 'human' || options.hide) {
    return;
  }

  const session = await getSession(target);
  if (session) {
    console.log(`[${formatSessionLine(session)}]\n`);
  }
  // Session not found - don't print anything, let the error handler show the message
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

/**
 * Format server details for human-readable output
 */
export function formatServerDetails(
  details: ServerDetails,
  target: string,
  tools?: Tool[]
): string {
  const lines: string[] = [];
  const bullet = chalk.dim('*');
  const bt = chalk.gray('`'); // backtick

  const { serverInfo, capabilities, instructions } = details;

  // Server info
  if (serverInfo) {
    lines.push(
      chalk.bold('Server:') + ` ${serverInfo.name} (version: ${serverInfo.version || 'N/A'})`
    );
    lines.push('');
  }

  // Capabilities - only show what the server actually exposes
  lines.push(chalk.bold('Capabilities:'));

  const capabilityList: string[] = [];

  if (capabilities?.tools) {
    capabilityList.push(
      `${bullet} tools ${capabilities.tools.listChanged ? '(dynamic)' : '(static)'}`
    );
  }

  if (capabilities?.resources) {
    const features: string[] = [];
    if (capabilities.resources.subscribe) features.push('subscribe');
    if (capabilities.resources.listChanged) features.push('dynamic list');
    const featureStr = features.length > 0 ? ` (supports ${features.join(', ')})` : '';
    capabilityList.push(`${bullet} resources${featureStr}`);
  }

  if (capabilities?.prompts) {
    const featureStr = capabilities.prompts.listChanged ? ' (dynamic list)' : '';
    capabilityList.push(`${bullet} prompts${featureStr}`);
  }

  if (capabilities?.logging) {
    capabilityList.push(`${bullet} logging`);
  }

  if (capabilities?.completions) {
    capabilityList.push(`${bullet} completions`);
  }

  if (capabilities?.tasks) {
    const features: string[] = [];
    if (capabilities.tasks.requests?.tools?.call) features.push('tools');
    const featureStr = features.length > 0 ? ` (${features.join(', ')})` : '';
    capabilityList.push(`${bullet} tasks${featureStr}`);
  }

  if (capabilityList.length > 0) {
    lines.push(capabilityList.join('\n'));
  } else {
    lines.push(`${bullet} (none)`);
  }
  lines.push('');

  // Instructions in code block
  const trimmed = instructions ? instructions.trim() : '';
  if (trimmed) {
    lines.push(chalk.bold('Instructions:'));
    lines.push(chalk.gray('````'));
    lines.push(trimmed);
    lines.push(chalk.gray('````'));
    lines.push('');
  }

  // Tools list (from bridge cache, no extra server call)
  if (tools && tools.length > 0) {
    lines.push(formatToolsCompact(tools, { sessionName: target }));
    lines.push('');
  }

  // Commands
  const commands: string[] = [];

  if (capabilities?.tools) {
    commands.push(`${bullet} ${bt}mcpc ${target} tools-list [--full]${bt}`);
    commands.push(`${bullet} ${bt}mcpc ${target} tools-get <name>${bt}`);
    commands.push(
      `${bullet} ${bt}mcpc ${target} tools-call <name> [arg1:=val1 ... | <args-json> | <stdin]${bt}`
    );
  }

  if (capabilities?.resources) {
    commands.push(`${bullet} ${bt}mcpc ${target} resources-list${bt}`);
    commands.push(`${bullet} ${bt}mcpc ${target} resources-read <uri>${bt}`);
  }

  if (capabilities?.prompts) {
    commands.push(`${bullet} ${bt}mcpc ${target} prompts-list${bt}`);
    commands.push(
      `${bullet} ${bt}mcpc ${target} prompts-get <name> [arg1:=val1 ... | <args-json> | <stdin]${bt}`
    );
  }

  if (capabilities?.tasks) {
    commands.push(`${bullet} ${bt}mcpc ${target} tasks-list${bt}`);
    commands.push(`${bullet} ${bt}mcpc ${target} tasks-get <taskId>${bt}`);
    commands.push(`${bullet} ${bt}mcpc ${target} tasks-result <taskId>${bt}`);
    commands.push(`${bullet} ${bt}mcpc ${target} tasks-cancel <taskId>${bt}`);
  }

  if (capabilities?.logging) {
    commands.push(`${bullet} ${bt}mcpc ${target} logging-set-level <lvl>${bt}`);
  }

  if (commands.length > 0) {
    lines.push(chalk.bold('Available commands:'));
    lines.push(commands.join('\n'));
    lines.push('');
  }

  // Debugging hint: bridge log file path (only shown for sessions, i.e. @name targets)
  if (target.startsWith('@')) {
    const logPath = join(getLogsDir(), `bridge-${target}.log`);
    lines.push(chalk.dim(`Session log for debugging: ${logPath}`));
    lines.push('');
  }

  return lines.join('\n');
}
