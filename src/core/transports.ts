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
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLogger } from '../lib/logger.js';
import type { TransportConfig } from '../lib/types.js';
import { ClientError } from '../lib/errors.js';

/**
 * Create a stdio transport for a local MCP server
 */
export function createStdioTransport(config: StdioServerParameters): Transport {
  const logger = createLogger('StdioTransport');
  logger.debug('Creating stdio transport', { command: config.command, args: config.args });

  return new StdioClientTransport(config);
}

/**
 * Create a Streamable HTTP transport for a remote MCP server
 */
export function createStreamableHttpTransport(
  url: string,
  options: Omit<StreamableHTTPClientTransportOptions, 'fetch'> = {}
): Transport {
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

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    reconnectionOptions: defaultReconnectionOptions,
    ...options,
  });

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
}

/**
 * Create a transport from a generic transport configuration
 */
export function createTransportFromConfig(
  config: TransportConfig,
  options: CreateTransportOptions = {}
): Transport {
  switch (config.type) {
    case 'stdio': {
      if (!config.command) {
        throw new ClientError('stdio transport requires a command');
      }

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

    case 'http': {
      if (!config.url) {
        throw new ClientError('http transport requires a URL');
      }

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

      if (config.headers !== undefined) {
        transportOptions.requestInit = {
          headers: config.headers,
        };
      }

      if (config.timeoutMs !== undefined) {
        transportOptions.requestInit = {
          ...transportOptions.requestInit,
          signal: AbortSignal.timeout(config.timeoutMs),
        };
      }

      return createStreamableHttpTransport(config.url, transportOptions);
    }

    default:
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new ClientError(`Unknown transport type: ${config.type}`);
  }
}
