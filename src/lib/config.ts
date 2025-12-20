/**
 * MCP configuration file loader
 * Loads and parses MCP server configuration files (Claude Desktop format)
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { McpConfig, McpServerConfig } from './types.js';
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
    const config = JSON.parse(content) as McpConfig;

    // Validate structure
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      throw new ClientError(
        `Invalid config file format: missing or invalid "mcpServers" field.\n` +
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
      throw new ClientError(
        `Invalid JSON in config file: ${absolutePath}\n${error.message}`
      );
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
export function getServerConfig(config: McpConfig, serverName: string): McpServerConfig {
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
 * @param config - Server configuration
 * @returns Configuration with environment variables substituted
 */
function substituteEnvVars(config: McpServerConfig): McpServerConfig {
  const result: McpServerConfig = {};

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

  if (config.timeout !== undefined) {
    result.timeout = config.timeout;
  }

  return result;
}

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
      logger.warn(`Environment variable not found: ${varName}, using empty string`);
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
export function validateServerConfig(config: McpServerConfig): boolean {
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
    throw new ClientError(
      'Invalid server config: cannot specify both "url" and "command"'
    );
  }

  // HTTP-specific validation
  if (config.url !== undefined) {
    if (typeof config.url !== 'string' || config.url.trim() === '') {
      throw new ClientError(
        'Invalid server config: "url" must be a non-empty string'
      );
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
      throw new ClientError(
        'Invalid server config: "command" must be a non-empty string'
      );
    }
  }

  return true;
}
