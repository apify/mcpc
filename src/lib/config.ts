/**
 * MCP configuration file loader
 * Loads and parses MCP server configuration files (Claude Desktop format)
 */

import { readFileSync, statSync } from 'fs';
import { homedir, platform } from 'os';
import { join, resolve } from 'path';
import type { McpConfig, ServerConfig } from './types.js';
import { ClientError } from './errors.js';
import { createLogger } from './logger.js';
import { normalizeServerUrl } from './utils.js';

const logger = createLogger('config');

/**
 * Load and parse a standard MCP configuration file (see https://gofastmcp.com/integrations/mcp-json-configuration)
 *
 * @param configPath - Path to the config file
 * @returns Parsed configuration
 * @throws ClientError if file cannot be read or parsed
 */
export function loadConfig(configPath: string): McpConfig {
  const absolutePath = resolve(configPath);

  try {
    logger.debug(`Loading config from: ${absolutePath}`);
    const content = readFileSync(absolutePath, 'utf-8');

    // Parse JSON
    const raw = JSON.parse(content) as Record<string, unknown>;

    // Normalize VS Code format: "servers" → "mcpServers"
    if (
      !raw.mcpServers &&
      raw.servers &&
      typeof raw.servers === 'object' &&
      !Array.isArray(raw.servers)
    ) {
      raw.mcpServers = raw.servers;
    }

    const config = raw as unknown as McpConfig;

    // Validate structure
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      throw new ClientError(
        `Invalid config file format: missing or invalid "mcpServers" (or "servers") field.\n` +
          `Expected: { "mcpServers": { "server-name": {...} } }`
      );
    }

    logger.debug(`Loaded ${Object.keys(config.mcpServers).length} server(s) from config`);

    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ClientError(`Config file not found: ${absolutePath}`);
    }

    if (error instanceof SyntaxError) {
      throw new ClientError(`Invalid JSON in config file: ${absolutePath}\n${error.message}`);
    }

    if (error instanceof ClientError) {
      throw error;
    }

    throw new ClientError(
      `Failed to load config file: ${absolutePath}\n${(error as Error).message}`
    );
  }
}

/**
 * Get a specific server configuration by name
 *
 * @param config - Parsed MCP configuration
 * @param serverName - Name of the server
 * @returns Server configuration with environment variables substituted
 * @throws ClientError if server name not found
 */
export function getServerConfig(config: McpConfig, serverName: string): ServerConfig {
  const serverConfig = config.mcpServers[serverName];

  if (!serverConfig) {
    const availableServers = Object.keys(config.mcpServers);
    throw new ClientError(
      `Server "${serverName}" not found in config file.\n` +
        `Available servers: ${availableServers.join(', ')}`
    );
  }

  // Substitute environment variables
  const substituted = substituteEnvVars(serverConfig);

  logger.debug(`Retrieved config for server: ${serverName}`, substituted);

  return substituted;
}

/**
 * Substitute environment variables in a server configuration
 * Supports ${VAR_NAME} syntax
 *
 * All fields are copied through and only the ones that can contain `${VAR_NAME}` (or need
 * normalizing) are rewritten. Keep it that way rather than reverting to a per-field allowlist,
 * which silently dropped every field it forgot — that is how a config entry's `protocolVersion`
 * came to be ignored, and the next new `ServerConfig` field would meet the same fate.
 *
 * @param config - Server configuration
 * @returns Configuration with environment variables substituted
 */
function substituteEnvVars(config: ServerConfig): ServerConfig {
  const result: ServerConfig = { ...config };

  if (config.url !== undefined) {
    // Substitute environment variables and normalize URL
    const substituted = substituteString(config.url);
    try {
      result.url = normalizeServerUrl(substituted);
    } catch (error) {
      throw new ClientError(
        `Invalid URL in server config: ${substituted}\n${(error as Error).message}`
      );
    }
  }

  if (config.command !== undefined) {
    result.command = substituteString(config.command);
  }

  if (config.args !== undefined) {
    result.args = config.args.map(substituteString);
  }

  if (config.env !== undefined) {
    result.env = substituteEnvObject(config.env);
  }

  if (config.headers !== undefined) {
    result.headers = substituteEnvObject(config.headers);
  }

  return result;
}

/**
 * Track which environment variables have already been warned about
 * to avoid noisy repeated warnings (e.g., during bulk connect from config file).
 */
const warnedEnvVars = new Set<string>();

/**
 * Substitute environment variables in a string
 * Replaces ${VAR_NAME} with process.env.VAR_NAME
 *
 * @param str - String to process
 * @returns String with substituted variables
 */
function substituteString(str: string): string {
  return str.replace(/\$\{([^}]+)}/g, (_match, varName: string) => {
    const value = process.env[varName];
    if (value === undefined) {
      if (!warnedEnvVars.has(varName)) {
        warnedEnvVars.add(varName);
        logger.warn(`Environment variable not found: ${varName}, using empty string`);
      }
      return '';
    }
    return value;
  });
}

/**
 * Substitute environment variables in an object's values
 *
 * @param obj - Object with string values
 * @returns Object with substituted values
 */
function substituteEnvObject(obj: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(obj)) {
    result[key] = substituteString(value);
  }

  return result;
}

/**
 * List all server names in a configuration
 *
 * @param config - Parsed MCP configuration
 * @returns Array of server names
 */
export function listServers(config: McpConfig): string[] {
  return Object.keys(config.mcpServers);
}

/**
 * Validate that a server configuration is properly formatted
 *
 * @param config - Server configuration to validate
 * @returns True if valid
 * @throws ClientError if invalid
 */
export function validateServerConfig(config: ServerConfig): boolean {
  // Must have either url (HTTP) or command (stdio)
  const hasUrl = config.url !== undefined;
  const hasCommand = config.command !== undefined;

  if (!hasUrl && !hasCommand) {
    throw new ClientError(
      'Invalid server config: must specify either "url" (for HTTP) or "command" (for stdio)'
    );
  }

  // Cannot have both
  if (hasUrl && hasCommand) {
    throw new ClientError('Invalid server config: cannot specify both "url" and "command"');
  }

  // HTTP-specific validation
  if (config.url !== undefined) {
    if (typeof config.url !== 'string' || config.url.trim() === '') {
      throw new ClientError('Invalid server config: "url" must be a non-empty string');
    }
    if (!config.url.startsWith('http://') && !config.url.startsWith('https://')) {
      throw new ClientError(
        `Invalid server config: "url" must start with http:// or https://, got: ${config.url}`
      );
    }
  }

  // Stdio-specific validation
  if (config.command !== undefined) {
    if (typeof config.command !== 'string' || config.command.trim() === '') {
      throw new ClientError('Invalid server config: "command" must be a non-empty string');
    }
  }

  return true;
}

/**
 * Check whether a named entry in an MCP config uses the stdio transport
 * (i.e. has a `command` field rather than a `url`).
 */
export function isStdioEntry(config: McpConfig, entryName: string): boolean {
  return config.mcpServers[entryName]?.command !== undefined;
}

// ----------------------------------------------------------------------------
// Standard MCP config discovery
// ----------------------------------------------------------------------------

/**
 * A well-known config file location.
 */
export interface ConfigCandidate {
  /** Absolute path to the config file. */
  path: string;
  /** Scope: 'project' (CWD-relative) or 'global' (home-relative). */
  scope: 'project' | 'global';
}

/**
 * A discovered config file — candidate metadata plus the parsed content.
 */
export interface DiscoveredConfig extends ConfigCandidate {
  /** Parsed MCP configuration. */
  config: McpConfig;
  /** Number of servers defined in the config. */
  serverCount: number;
}

/**
 * Return the list of standard MCP config file paths to search.
 *
 * Paths are returned in priority order: project-level first (CWD), then global (home).
 * This determines which entry wins in case of session-name collisions across configs.
 *
 * Supported locations (inspired by https://www.withone.ai/docs/cli#mcp-server-installation):
 *  - Claude Code (global):     ~/.claude.json
 *  - Claude Code (project):    .mcp.json
 *  - Claude Desktop:           platform-specific app-support directory
 *  - Cursor:                   ~/.cursor/mcp.json, .cursor/mcp.json
 *  - VS Code:                  ~/.vscode/mcp.json, .vscode/mcp.json
 *  - Windsurf:                 ~/.codeium/windsurf/mcp_config.json
 *  - Kiro:                     ~/.kiro/settings/mcp.json, .kiro/settings/mcp.json
 *
 * TOML-based configs (e.g. Codex's `~/.codex/config.toml`) are not supported.
 *
 * @param options - Optional overrides for home dir, cwd, and platform (useful for testing)
 */
export function getStandardMcpConfigPaths(options?: {
  homeDir?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  appData?: string;
}): ConfigCandidate[] {
  const home = options?.homeDir ?? homedir();
  const cwd = options?.cwd ?? process.cwd();
  const os = options?.platform ?? platform();
  const appData = options?.appData ?? process.env.APPDATA;

  const candidates: ConfigCandidate[] = [];

  // Project-level configs (CWD) — highest priority, most specific
  candidates.push(
    { path: join(cwd, '.mcp.json'), scope: 'project' },
    { path: join(cwd, 'mcp.json'), scope: 'project' },
    { path: join(cwd, 'mcp_config.json'), scope: 'project' },
    { path: join(cwd, '.cursor/mcp.json'), scope: 'project' },
    { path: join(cwd, '.vscode/mcp.json'), scope: 'project' },
    { path: join(cwd, '.kiro/settings/mcp.json'), scope: 'project' }
  );

  // Global / user-level configs
  candidates.push(
    { path: join(home, '.cursor/mcp.json'), scope: 'global' },
    { path: join(home, '.vscode/mcp.json'), scope: 'global' },
    { path: join(home, '.codeium/windsurf/mcp_config.json'), scope: 'global' },
    { path: join(home, '.kiro/settings/mcp.json'), scope: 'global' },
    { path: join(home, '.claude.json'), scope: 'global' }
  );

  // VS Code app config and Claude Desktop — platform-specific paths
  if (os === 'darwin') {
    candidates.push(
      { path: join(home, 'Library/Application Support/Code/User/mcp.json'), scope: 'global' },
      {
        path: join(home, 'Library/Application Support/Claude/claude_desktop_config.json'),
        scope: 'global',
      }
    );
  } else if (os === 'win32') {
    if (appData) {
      candidates.push(
        { path: join(appData, 'Code/User/mcp.json'), scope: 'global' },
        { path: join(appData, 'Claude/claude_desktop_config.json'), scope: 'global' }
      );
    }
  } else {
    // Linux / other — XDG-style
    candidates.push(
      { path: join(home, '.config/Code/User/mcp.json'), scope: 'global' },
      { path: join(home, '.config/Claude/claude_desktop_config.json'), scope: 'global' }
    );
  }

  // Dedup by resolved absolute path (preserve order — first occurrence wins)
  const seen = new Set<string>();
  const deduped: ConfigCandidate[] = [];
  for (const candidate of candidates) {
    const absolute = resolve(candidate.path);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    deduped.push({ ...candidate, path: absolute });
  }

  return deduped;
}

/**
 * Recognize a parsed value as an MCP config: the standard `{ mcpServers }` shape or the
 * VS Code `{ servers }` variant (normalized to `mcpServers`). Returns `null` for anything
 * else, including a valid-JSON file that simply isn't an MCP config. The servers object may
 * be empty.
 */
function asMcpConfig(parsed: unknown): McpConfig | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    return parsed as McpConfig;
  }
  if (obj.servers && typeof obj.servers === 'object' && !Array.isArray(obj.servers)) {
    return { mcpServers: obj.servers as Record<string, ServerConfig> };
  }
  return null;
}

/**
 * Reduce a `JSON.parse` error to a safe one-liner. V8 embeds a snippet of the file content
 * (`Unexpected token X, "<snippet>"... is not valid JSON`) that spans newlines and echoes
 * untrusted input; drop the snippet and keep just the diagnosis.
 */
function sanitizeJsonError(message: string): string {
  return message.replace(/, "[\s\S]*"\.{0,3} is not valid JSON$/, '. Not a valid JSON file.');
}

/**
 * A config file that exists at a standard location but couldn't be used — invalid JSON,
 * unreadable (e.g. permissions), or (for project-level files) missing a servers object.
 */
export interface ConfigError extends ConfigCandidate {
  /** Human-readable reason the file couldn't be used. */
  error: string;
}

/**
 * The result of scanning all standard config locations.
 */
export interface McpConfigScan {
  /** Files that exist and define at least one server (priority order: project, then global). */
  discovered: DiscoveredConfig[];
  /**
   * Files that exist with a recognizable but empty servers object (e.g. `{ "mcpServers": {} }`).
   * Surfaced so callers can tell "you have a config file, just add a server" apart from
   * "no config file exists at all".
   */
  empty: ConfigCandidate[];
  /** Files that exist but couldn't be used, each with a reason (see `ConfigError`). */
  errors: ConfigError[];
}

/**
 * Scan all standard MCP config locations, partitioning the files that exist into those that
 * define servers (`discovered`), those with an empty servers object (`empty`), and those that
 * couldn't be used (`errors`: invalid JSON, unreadable, or — for project-level files — missing
 * a servers object). Missing files are skipped silently; so are global files without a servers
 * object (e.g. `~/.claude.json` app state, which legitimately omits MCP servers). Never throws.
 *
 * Results are returned in priority order (project-level first, then global),
 * so callers can deterministically resolve collisions by taking the first occurrence.
 *
 * @param options - Optional overrides for home dir, cwd, and platform (useful for testing)
 */
export function scanMcpConfigFiles(options?: {
  homeDir?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  appData?: string;
}): McpConfigScan {
  const candidates = getStandardMcpConfigPaths(options);
  const discovered: DiscoveredConfig[] = [];
  const empty: ConfigCandidate[] = [];
  const errors: ConfigError[] = [];

  for (const candidate of candidates) {
    let content: string;
    try {
      if (!statSync(candidate.path).isFile()) continue; // missing or not a regular file
      content = readFileSync(candidate.path, 'utf-8');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') continue; // doesn't exist — skip silently
      errors.push({ ...candidate, error: err.message }); // exists but unreadable (e.g. EACCES)
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      errors.push({ ...candidate, error: sanitizeJsonError((error as Error).message) });
      continue;
    }

    const config = asMcpConfig(parsed);
    if (!config) {
      // Valid JSON without a servers object. For project files (dedicated MCP configs the user
      // authored) this is a mistake worth flagging; global files are usually app state that
      // simply has no MCP servers (e.g. ~/.claude.json), so skip them silently.
      if (candidate.scope === 'project') {
        errors.push({ ...candidate, error: 'No "mcpServers" or "servers" property.' });
      }
      continue;
    }

    const serverCount = Object.keys(config.mcpServers).length;
    if (serverCount === 0) empty.push(candidate);
    else discovered.push({ ...candidate, config, serverCount });
  }

  return { discovered, empty, errors };
}

/**
 * Discover MCP config files from standard locations.
 * Only returns files that exist and contain at least one server.
 * Files that can't be used are skipped (see `scanMcpConfigFiles().errors`) — discovery does not fail.
 *
 * Results are returned in priority order (project-level first, then global),
 * so callers can deterministically resolve collisions by taking the first occurrence.
 *
 * @param options - Optional overrides for home dir, cwd, and platform (useful for testing)
 */
export function discoverMcpConfigFiles(options?: {
  homeDir?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  appData?: string;
}): DiscoveredConfig[] {
  return scanMcpConfigFiles(options).discovered;
}
