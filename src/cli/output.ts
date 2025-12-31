/**
 * Output formatting for CLI
 * Supports both human-readable and JSON output modes
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import chalk from 'chalk';
import type { OutputMode, ServerConfig } from '../lib/index.js';
import type { Tool, Resource, ResourceTemplate, Prompt, SessionData, ServerDetails } from '../lib/types.js';
import { extractSingleTextContent } from './tool-result.js';
import { isValidSessionName } from '../lib/utils.js';
import { getSession } from '../lib/sessions.js';

// Re-export for external use
export { extractSingleTextContent } from './tool-result.js';

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
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Apply subtle rainbow gradient to a string (red to magenta)
 */
export function rainbow(text: string): string {
  const len = text.length;
  if (len === 0) return text;

  // Interpolate hue from 0 (red) to 300 (magenta)
  // Use moderate saturation (70%) and lightness (55%) for subtlety
  return text
    .split('')
    .map((char, i) => {
      const hue = (i / (len - 1)) * 300; // 0 to 300
      const hex = hslToHex(hue, 70, 55);
      return chalk.hex(hex)(char);
    })
    .join('');
}

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
function grayBacktick(): string {
  return chalk.gray('`');
}

/**
 * Wrap text in gray backticks with cyan coloring for code-like terms
 * Used for tool names, argument names, and other identifiers
 */
function inBackticks(text: string): string {
  return `${grayBacktick()}${chalk.cyan(text)}${grayBacktick()}`;
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
    let line = `${indent}${bullet} ${inBackticks(name)}: ${chalk.yellow(typeStr)}`;

    if (isRequired) {
      line += ` ${chalk.red('[required]')}`;
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
 * Format a list of tools with Markdown-like display
 */
export function formatTools(tools: Tool[]): string {
  const lines: string[] = [];

  // Header with tool count
  lines.push(chalk.bold(`Available tools (${tools.length}):`));

  // Summary list of tools
  const bullet = chalk.dim('*');
  for (const tool of tools) {
    const annotationsStr = formatToolAnnotations(tool.annotations);
    const annotationsSuffix = annotationsStr ? ` ${chalk.gray(`[${annotationsStr}]`)}` : '';
    lines.push(`${bullet} ${inBackticks(tool.name)}${annotationsSuffix}`);
  }

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

  // Tool header: Tool: `name` [annotations]
  const annotationsStr = formatToolAnnotations(tool.annotations);
  const annotationsSuffix = annotationsStr ? ` ${chalk.gray(`[${annotationsStr}]`)}` : '';
  lines.push(`${chalk.bold('Tool:')} ${inBackticks(tool.name)}${annotationsSuffix}`);

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
  lines.push('');
  lines.push(chalk.bold('Description:'));
  if (tool.description) {
    lines.push(chalk.gray('````'));
    lines.push(tool.description);
    lines.push(chalk.gray('````'));
  } else {
    lines.push(chalk.gray('````'));
    lines.push(chalk.gray('(no description)'));
    lines.push(chalk.gray('````'));
  }

  return lines.join('\n');
}

/**
 * Format a list of resources with Markdown-like display
 */
export function formatResources(resources: Resource[]): string {
  const lines: string[] = [];

  // Header with resource count
  lines.push(chalk.bold(`Available resources (${resources.length}):`));

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
    lines.push(`${chalk.bold('MIME type:')} ${chalk.yellow(resource.mimeType)}`);
  }

  // Description in code block
  lines.push('');
  lines.push(chalk.bold('Description:'));
  if (resource.description) {
    lines.push(chalk.gray('````'));
    lines.push(resource.description);
    lines.push(chalk.gray('````'));
  } else {
    lines.push(chalk.gray('````'));
    lines.push(chalk.gray('(no description)'));
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
  lines.push(chalk.bold(`Available resource templates (${templates.length}):`));

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
    lines.push(`${chalk.bold('MIME type:')} ${chalk.yellow(template.mimeType)}`);
  }

  // Description in code block
  lines.push('');
  lines.push(chalk.bold('Description:'));
  if (template.description) {
    lines.push(chalk.gray('````'));
    lines.push(template.description);
    lines.push(chalk.gray('````'));
  } else {
    lines.push(chalk.gray('````'));
    lines.push(chalk.gray('(no description)'));
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
  lines.push(chalk.bold(`Available prompts (${prompts.length}):`));

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
      const typePart = chalk.yellow('string'); // Prompt arguments are always strings
      const requiredPart = arg.required ? ` ${chalk.red('[required]')}` : '';
      const description = arg.description ? ` ${chalk.dim('-')} ${arg.description}` : '';
      lines.push(`  ${inBackticks(arg.name)}: ${typePart}${requiredPart}${description}`);
    }
  } else {
    lines.push(chalk.gray('  (no arguments)'));
  }

  // Description in code block
  lines.push('');
  lines.push(chalk.bold('Description:'));
  if (prompt.description) {
    lines.push(chalk.gray('````'));
    lines.push(prompt.description);
    lines.push(chalk.gray('````'));
  } else {
    lines.push(chalk.gray('````'));
    lines.push(chalk.gray('(no description)'));
    lines.push(chalk.gray('````'));
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
 * Truncate string with ellipsis if significantly longer than maxLen
 * Allows +3 chars slack to avoid weird cutoffs
 */
function truncateWithEllipsis(str: string, maxLen: number): string {
  if (str.length <= maxLen + 3) return str;
  return str.substring(0, maxLen - 1) + '…';
}

/**
 * Format a session line for display (without status)
 * Returns: "@name → target (transport)" with colors applied
 */
export function formatSessionLine(session: SessionData): string {
  // Format session name (cyan)
  const nameStr = chalk.cyan(session.name);

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

  // Format transport/auth info
  let authStr: string;
  if (session.server.command) {
    authStr = chalk.dim('(stdio)');
  } else if (session.profileName) {
    authStr = chalk.dim('(http, oauth: ') + chalk.magenta(session.profileName) + chalk.dim(')');
  } else {
    authStr = chalk.dim('(http)');
  }

  return `${nameStr} → ${targetStr} ${authStr}`;
}

/**
 * Options for logTarget
 */
export interface LogTargetOptions {
  outputMode: OutputMode;
  hide?: boolean | undefined;
  profileName?: string | undefined; // Auth profile being used (for http targets)
  serverConfig?: ServerConfig | undefined; // Resolved transport config (for non-session targets)
}

/**
 * Log target prefix (only in human mode)
 * For sessions: [@name → server (transport, auth)]
 * For direct connections: [target (transport, auth)]
 */
export async function logTarget(target: string, options: LogTargetOptions): Promise<void> {
  if (options.outputMode !== 'human' || options.hide) {
    return;
  }

  // For session targets, show rich info
  if (isValidSessionName(target)) {
    const session = await getSession(target);
    if (session) {
      console.log(`[${formatSessionLine(session)}]\n`);
      return;
    }
  }

  // For direct connections, use transportConfig if available
  const tc = options.serverConfig;
  if (tc?.command) {
    // Stdio transport: show command + args
    let targetStr = tc.command;
    if (tc.args && tc.args.length > 0) {
      targetStr += ' ' + tc.args.join(' ');
    }
    targetStr = truncateWithEllipsis(targetStr, 80);
    console.log(`[→ ${targetStr} ${chalk.dim('(stdio)')}]\n`);
    return;
  }

  // HTTP transport: show server URL with auth info
  const serverStr = tc?.url || target; // tc?.url ? getServerHost(tc.url) : getServerHost(target);
  let authStr: string;
  if (options.profileName) {
    authStr = chalk.dim('(http, oauth: ') + chalk.magenta(options.profileName) + chalk.dim(')');
  } else {
    authStr = chalk.dim('(http)');
  }
  console.log(`[→ ${serverStr} ${authStr}]\n`);
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
export function formatServerDetails(details: ServerDetails, target: string): string {
  const lines: string[] = [];
  const bullet = chalk.dim('*');
  const bt = chalk.gray('`'); // backtick

  const { serverInfo, capabilities, instructions, protocolVersion } = details;

  // Server info
  if (serverInfo) {
    const versionInfo = protocolVersion ? ` (MCP version: ${protocolVersion})` : '';
    lines.push(chalk.bold('Server:') + ` ${serverInfo.name} v${serverInfo.version}${versionInfo}`);
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

  if (capabilityList.length > 0) {
    lines.push(capabilityList.join('\n'));
  } else {
    lines.push(`${bullet} (none)`);
  }
  lines.push('');

  // Commands
  lines.push(chalk.bold('Available commands:'));
  const commands: string[] = [];

  if (capabilities?.tools) {
    commands.push(`${bullet} ${bt}mcpc ${target} tools-list${bt}`);
    commands.push(`${bullet} ${bt}mcpc ${target} tools-get <name>${bt}`);
    commands.push(`${bullet} ${bt}mcpc ${target} tools-call <name> [--args key=val ...] [--args-file <file>]${bt}`);
  }

  if (capabilities?.resources) {
    commands.push(`${bullet} ${bt}mcpc ${target} resources-list${bt}`);
    commands.push(`${bullet} ${bt}mcpc ${target} resources-read <uri>${bt}`);
  }

  if (capabilities?.prompts) {
    commands.push(`${bullet} ${bt}mcpc ${target} prompts-list${bt}`);
    commands.push(`${bullet} ${bt}mcpc ${target} prompts-get <name>${bt}`);
  }

  if (capabilities?.logging) {
    commands.push(`${bullet} ${bt}mcpc ${target} logging-set-level <lvl>${bt}`);
  }

  commands.push(`${bullet} ${bt}mcpc ${target} shell${bt}`);

  lines.push(commands.join('\n'));
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

  return lines.join('\n');
}
