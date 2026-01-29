/**
 * MCP Transport implementations
 * Re-exports and wraps transports from @modelcontextprotocol/sdk
 */

// Re-export transport types and classes from SDK
export type {
  Transport,
  TransportSendOptions,
  FetchLike,
} from '@modelcontextprotocol/sdk/shared/transport.js';

export {
  StdioClientTransport,
  type StdioServerParameters,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

export {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
  type StreamableHTTPReconnectionOptions,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Re-export auth-related types if needed
export type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLogger, getVerbose } from '../lib/logger.js';
import type { ServerConfig } from '../lib/types.js';
import { ClientError } from '../lib/errors.js';

/**
 * Create a proxy-aware fetch function if HTTPS_PROXY or https_proxy is set.
 * This allows mcpc to work in environments where network access is routed through
 * a proxy (e.g., Claude Code's sandbox, corporate proxies).
 *
 * Node.js native fetch (undici) does not respect proxy environment variables,
 * so we need to explicitly configure a ProxyAgent dispatcher.
 */
async function createProxyAwareFetch(): Promise<FetchLike | undefined> {
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
  if (!proxyUrl) {
    return undefined;
  }

  const logger = createLogger('ProxyFetch');
  logger.debug(`Configuring proxy-aware fetch with proxy: ${proxyUrl}`);

  try {
    // Dynamically import undici to create a ProxyAgent
    // undici is the HTTP client that powers Node.js native fetch
    const { ProxyAgent, fetch: undiciFetch } = await import('undici');
    const proxyAgent = new ProxyAgent(proxyUrl);

    // Return a fetch function that uses the proxy dispatcher
    const proxyFetch: FetchLike = (input, init) => {
      return undiciFetch(input, {
        ...init,
        dispatcher: proxyAgent,
      }) as Promise<Response>;
    };

    logger.debug('Proxy-aware fetch configured successfully');
    return proxyFetch;
  } catch (error) {
    logger.debug(`Failed to configure proxy-aware fetch: ${error}`);
    return undefined;
  }
}

/**
 * Create a stdio transport for a local MCP server
 */
export function createStdioTransport(config: StdioServerParameters): Transport {
  const logger = createLogger('StdioTransport');
  logger.debug('Creating stdio transport', { command: config.command, args: config.args });

  // Suppress server stderr unless in verbose mode
  // Server stderr typically contains startup messages that clutter output
  const params: StdioServerParameters = {
    ...config,
    stderr: getVerbose() ? 'inherit' : 'ignore',
  };

  return new StdioClientTransport(params);
}

/**
 * Create a Streamable HTTP transport for a remote MCP server
 */
export async function createStreamableHttpTransport(
  url: string,
  options: Omit<StreamableHTTPClientTransportOptions, 'fetch'> = {}
): Promise<Transport> {
  const logger = createLogger('StreamableHttpTransport');
  logger.debug('Creating Streamable HTTP transport', { url });
  logger.debug('Transport options:', {
    hasAuthProvider: !!options.authProvider,
    hasRequestInit: !!options.requestInit,
  });

  // Default reconnection options matching CLAUDE.md specs
  const defaultReconnectionOptions = {
    initialReconnectionDelay: 1000, // 1s
    maxReconnectionDelay: 30000, // 30s
    reconnectionDelayGrowFactor: 2, // Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s
    maxRetries: 10, // Max 10 reconnection attempts
  };

  // Create proxy-aware fetch if proxy environment variables are set
  const proxyFetch = await createProxyAwareFetch();

  const transportOptions: StreamableHTTPClientTransportOptions = {
    reconnectionOptions: defaultReconnectionOptions,
    ...options,
  };

  // Use proxy-aware fetch if available
  if (proxyFetch) {
    transportOptions.fetch = proxyFetch;
    logger.debug('Using proxy-aware fetch for HTTP transport');
  }

  const transport = new StreamableHTTPClientTransport(new URL(url), transportOptions);

  // Verify authProvider is correctly attached
  // @ts-expect-error accessing private property for debugging
  const hasAuthProvider = !!transport._authProvider;
  logger.debug('Transport created, authProvider attached:', hasAuthProvider);

  // Verification: Test that tokens() is actually callable
  // Note: This is a non-blocking test - the actual tokens() call during requests
  // is what matters. This just verifies the authProvider is correctly attached.
  if (hasAuthProvider) {
    // @ts-expect-error accessing private property for debugging
    const authProvider = transport._authProvider as OAuthClientProvider;
    if (typeof authProvider.tokens === 'function') {
      logger.debug('authProvider.tokens() is a function - verification passed');
    } else {
      logger.error('authProvider.tokens() is NOT a function - this is a bug!');
    }
  }

  return transport as Transport;
}

/**
 * Options for creating a transport from config
 */
export interface CreateTransportOptions {
  /**
   * OAuth provider for automatic token refresh (HTTP transport only)
   */
  authProvider?: OAuthClientProvider;

  /**
   * MCP session ID for resuming a previous session (HTTP transport only)
   * If provided, the transport will include this in the MCP-Session-Id header
   */
  mcpSessionId?: string;
}

/**
 * Create a transport from a generic transport configuration
 */
export async function createTransportFromConfig(
  config: ServerConfig,
  options: CreateTransportOptions = {}
): Promise<Transport> {
  // Stdio transport
  if (config.command) {
    const stdioConfig: StdioServerParameters = {
      command: config.command,
    };

    if (config.args !== undefined) {
      stdioConfig.args = config.args;
    }
    if (config.env !== undefined) {
      stdioConfig.env = config.env;
    }

    return createStdioTransport(stdioConfig);
  }

  // HTTP transport
  if (config.url) {
    const logger = createLogger('TransportFactory');
    const transportOptions: StreamableHTTPClientTransportOptions = {};

    // Set auth provider for automatic token refresh (takes priority over static headers)
    if (options.authProvider) {
      transportOptions.authProvider = options.authProvider;
      logger.debug('Setting authProvider on transport options');
      logger.debug(`  authProvider type: ${options.authProvider.constructor.name}`);
      logger.debug(`  authProvider has tokens method: ${typeof options.authProvider.tokens === 'function'}`);
    } else {
      logger.debug('No authProvider provided for HTTP transport');
    }

    // Set session ID for resuming a previous MCP session
    if (options.mcpSessionId) {
      transportOptions.sessionId = options.mcpSessionId;
      logger.debug(`Setting mcpSessionId for session resumption: ${options.mcpSessionId}`);
    }

    if (config.headers !== undefined) {
      transportOptions.requestInit = {
        headers: config.headers,
      };
    }

    if (config.timeout !== undefined) {
      transportOptions.requestInit = {
        ...transportOptions.requestInit,
        signal: AbortSignal.timeout(config.timeout * 1000),
      };
    }

    return await createStreamableHttpTransport(config.url, transportOptions);
  }

  throw new ClientError('Invalid ServerConfig: must have either url or command');
}
