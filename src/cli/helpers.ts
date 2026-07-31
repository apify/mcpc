/**
 * Helper functions for CLI command handlers
 * Provides target resolution and MCP client management
 */

import type { OutputMode, ServerConfig } from '../lib/types.js';
// Type-only import — the runtime module is still loaded lazily inside withMcpClient
import type { SessionClient } from '../lib/session-client.js';
import { ClientError } from '../lib/errors.js';
import { normalizeServerUrl, isValidSessionName, getServerHost } from '../lib/utils.js';
import { setVerbose, createLogger } from '../lib/logger.js';
import { loadConfig, getServerConfig, validateServerConfig } from '../lib/config.js';
import { getAuthProfile } from '../lib/auth/profiles.js';
import { formatSessionLine } from './output.js';
import { DEFAULT_AUTH_PROFILE } from '../lib/auth/oauth-utils.js';
import { parseHeaderFlags } from './parser.js';

const logger = createLogger('cli');

/**
 * Resolve which auth profile to use for an HTTP server
 * Returns the profile name to use, or undefined if no profile is available
 *
 * @param serverUrl - The server URL
 * @param target - Original target string (for error messages)
 * @param specifiedProfile - Profile name from --profile flag (optional)
 * @param context - Additional context for error messages (e.g., session name)
 * @returns The profile name to use, or undefined for unauthenticated connection
 * @throws ClientError only when --profile is specified but profile doesn't exist,
 *         or when profiles exist for server but no default (user likely forgot --profile)
 */
export async function resolveAuthProfile(
  serverUrl: string,
  target: string,
  specifiedProfile?: string,
  _context?: { sessionName?: string }
): Promise<string | undefined> {
  const host = getServerHost(serverUrl);

  if (specifiedProfile) {
    // Profile specified - verify it exists
    const profile = await getAuthProfile(serverUrl, specifiedProfile);
    if (!profile) {
      throw new ClientError(
        `Authentication profile "${specifiedProfile}" not found for ${host}.\n\n` +
          `To create this profile, run:\n` +
          `  mcpc login ${target} --profile ${specifiedProfile}`
      );
    }
    return specifiedProfile;
  }

  // No profile specified - only use "default" profile if it exists
  // Non-default profiles require explicit --profile flag
  const defaultProfile = await getAuthProfile(serverUrl, DEFAULT_AUTH_PROFILE);
  if (defaultProfile) {
    logger.debug(`Using default auth profile for ${host}`);
    return DEFAULT_AUTH_PROFILE;
  }

  // No default profile - allow unauthenticated connection attempt
  // If server requires auth, the connection error will provide guidance
  logger.debug(`No default auth profile for ${host}, attempting unauthenticated connection`);
  return undefined;
}

/**
 * Resolve a target string to server configuration
 *
 * Target types:
 * - @<name> - Named session (looks up in sessions.json)
 * - <url> - Remote HTTP server (defaults to https:// if no scheme provided)
 * - <config-entry> - Entry from config file (when --config is used)
 */
export async function resolveTarget(
  target: string,
  options: {
    config?: string;
    headers?: string[];
    timeoutSecs?: number;
    verbose?: boolean;
    profile?: string;
    protocolVersion?: string;
  } = {}
): Promise<ServerConfig> {
  if (options.verbose) {
    setVerbose(true);
  }

  // Named session (@name) is handled in withMcpClient, should not reach here
  if (isValidSessionName(target)) {
    throw new ClientError(`Session target should be handled by withMcpClient: ${target}`);
  }

  // Config file entry - check this first to avoid treating config names as URLs
  if (options.config) {
    logger.debug(`Loading config file: ${options.config}`);
    const mcpConfig = loadConfig(options.config);
    const serverConfig = getServerConfig(mcpConfig, target);
    validateServerConfig(serverConfig);

    // Merge CLI options with config file (CLI takes precedence)
    const cliHeaders = parseHeaderFlags(options.headers);
    const mergedHeaders = { ...serverConfig.headers, ...cliHeaders };

    return {
      ...serverConfig,
      ...(Object.keys(mergedHeaders).length > 0 && { headers: mergedHeaders }),
      ...(options.timeoutSecs && { timeout: options.timeoutSecs }),
      ...(options.protocolVersion && { protocolVersion: options.protocolVersion }),
    };
  }

  // Try to parse as URL (will default to https:// if no scheme provided)
  let url;
  try {
    url = normalizeServerUrl(target);
  } catch (error) {
    throw new ClientError(
      // TODO: or config file?
      `Failed to resolve target: ${target}\n` +
        `Target must be a server URL (e.g., mcp.apify.com or https://mcp.apify.com)\n\n` +
        `Error: ${(error as Error).message}`
    );
  }

  // Build server config from URL and CLI options
  const headers = parseHeaderFlags(options.headers);

  return {
    url,
    ...(Object.keys(headers).length > 0 && { headers }),
    ...(options.timeoutSecs && { timeout: options.timeoutSecs }),
    ...(options.protocolVersion && { protocolVersion: options.protocolVersion }),
  };
}

/**
 * Context passed to the withMcpClient callback
 */
export interface McpClientContext {
  sessionName?: string | undefined;
  profileName?: string | undefined;
  serverConfig?: ServerConfig | undefined;
  /**
   * Protocol version negotiated by the session's bridge, as persisted in sessions.json.
   * Lets a command adapt its output to the protocol era without an extra IPC round-trip;
   * commands that must be authoritative should call `getServerDetails()` instead.
   */
  protocolVersion?: string | undefined;
}

/**
 * Execute an operation with an MCP client via a named session
 * The target must be a valid session name (starts with @)
 *
 * The callback receives the concrete SessionClient (which implements IMcpClient),
 * so session-only operations like resource subscriptions are available too.
 *
 * @param target - Session name (e.g. @apify)
 * @param options - CLI options (verbose, outputMode, etc.)
 * @param callback - Async function that receives the connected client and context
 */
export async function withMcpClient<T>(
  target: string,
  options: {
    outputMode?: OutputMode;
    verbose?: boolean;
    hideTarget?: boolean;
    timeoutSecs?: number;
  },
  callback: (client: SessionClient, context: McpClientContext) => Promise<T>
): Promise<T> {
  if (!isValidSessionName(target)) {
    throw new ClientError(
      `Invalid session name: ${target}\n` +
        `Session names must start with @ (e.g. @apify).\n\n` +
        `To create a session, run:\n` +
        `  mcpc connect <server> @my-session`
    );
  }

  const { withSessionClient } = await import('../lib/session-client.js');
  const { getSession } = await import('../lib/sessions.js');

  logger.debug('Using session:', target);

  // Get session data to include in context
  const session = await getSession(target);
  const context: McpClientContext = {
    sessionName: session?.name,
    profileName: session?.profileName,
    serverConfig: session?.server,
    protocolVersion: session?.protocolVersion,
  };

  // Log target prefix (unless hidden)
  if (options.outputMode === 'human' && !options.hideTarget && session) {
    console.log(`[${formatSessionLine(session)}]\n`);
  }

  // Use session client (SessionClient implements IMcpClient interface)
  const sessionOpts =
    options.timeoutSecs !== undefined ? { timeoutSecs: options.timeoutSecs } : undefined;
  return await withSessionClient(target, (client) => callback(client, context), sessionOpts);
}
