/**
 * MCP Transport implementations
 * Re-exports and wraps transports from the @modelcontextprotocol/client SDK (v2)
 */

// Re-export transport types and classes from SDK
export type { Transport, TransportSendOptions, FetchLike } from '@modelcontextprotocol/client';

export {
  StdioClientTransport,
  type StdioServerParameters,
  getDefaultEnvironment,
} from '@modelcontextprotocol/client/stdio';

export {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
  type StreamableHTTPReconnectionOptions,
  SdkHttpError,
} from '@modelcontextprotocol/client';

// Re-export auth-related types if needed
export type { OAuthClientProvider } from '@modelcontextprotocol/client';

import type { Transport, FetchLike, OAuthClientProvider } from '@modelcontextprotocol/client';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/client/stdio';
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/client';
import { createLogger, getVerbose } from '../lib/logger.js';
import type { ServerConfig } from '../lib/types.js';
import { ClientError } from '../lib/errors.js';
import { proxyFetch } from '../lib/proxy.js';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

/**
 * Options for createStdioTransport
 */
export interface CreateStdioTransportOptions {
  /**
   * Callback invoked for each newline-delimited line written by the child
   * server to stderr. When provided, stderr is piped and consumed; when not,
   * it is inherited in verbose mode and discarded otherwise.
   */
  onStderrLine?: (line: string) => void;
}

/**
 * Create a stdio transport for a local MCP server
 */
export function createStdioTransport(
  config: StdioServerParameters,
  options: CreateStdioTransportOptions = {}
): Transport {
  const logger = createLogger('StdioTransport');
  logger.debug('Creating stdio transport', { command: config.command, args: config.args });

  // Pipe stderr when a handler is provided so the caller (bridge) can log it
  // to the session log and surface it on connect failures. Otherwise fall back
  // to inheriting in verbose mode or dropping it — stdio servers often print
  // noisy startup banners that would clutter normal CLI output.
  const shouldPipe = !!options.onStderrLine;
  const params: StdioServerParameters = {
    ...config,
    stderr: shouldPipe ? 'pipe' : getVerbose() ? 'inherit' : 'ignore',
  };

  const transport = new StdioClientTransport(params);

  if (options.onStderrLine) {
    const handler = options.onStderrLine;
    // With stderr: 'pipe', the SDK exposes a PassThrough stream on
    // `transport.stderr` from construction time onwards, so we can attach the
    // reader before `start()` is called without losing any output.
    // SDK types stderr as the abstract Stream class; the runtime value is
    // always a PassThrough (Readable) when stderr === 'pipe'.
    const stream = transport.stderr as Readable | null;
    if (stream) {
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (line.length === 0) return;
        try {
          handler(line);
        } catch (err) {
          logger.debug('onStderrLine handler threw:', err);
        }
      });
    }
  }

  return transport;
}

/**
 * Create a Streamable HTTP transport for a remote MCP server
 */
export function createStreamableHttpTransport(
  url: string,
  options: StreamableHTTPClientTransportOptions = {}
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

  // Explicitly pass proxy-aware fetch so the MCP SDK transport respects
  // HTTP_PROXY/HTTPS_PROXY env vars (its internal fetch ignores the global dispatcher).
  // Custom fetch (e.g. x402 middleware) takes priority if provided.
  const fetchFn = options.fetch ?? proxyFetch;

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    reconnectionOptions: defaultReconnectionOptions,
    ...options,
    fetch: fetchFn,
  });

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

  /**
   * Protocol version negotiated by the session being resumed (HTTP transport only).
   * The SDK skips the initialize handshake when mcpSessionId is provided, so the
   * transport must be seeded with the original version to keep sending the
   * required MCP-Protocol-Version header on all requests.
   */
  protocolVersion?: string;

  /**
   * Custom fetch function (HTTP transport only)
   * Used by x402 middleware to intercept and modify requests
   */
  customFetch?: FetchLike;

  /**
   * Callback for lines written to stderr by the child (stdio transport only).
   * Ignored for HTTP transports.
   */
  onStderrLine?: (line: string) => void;
}

/**
 * Create a transport from a generic transport configuration
 */
export function createTransportFromConfig(
  config: ServerConfig,
  options: CreateTransportOptions = {}
): Transport {
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

    return createStdioTransport(stdioConfig, {
      ...(options.onStderrLine && { onStderrLine: options.onStderrLine }),
    });
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
      logger.debug(
        `  authProvider has tokens method: ${typeof options.authProvider.tokens === 'function'}`
      );
    } else {
      logger.debug('No authProvider provided for HTTP transport');
    }

    // Set session ID for resuming a previous MCP session, restoring the protocol
    // version negotiated by the original handshake (the SDK skips the handshake on
    // resumption, so the version cannot be re-negotiated)
    if (options.mcpSessionId) {
      transportOptions.sessionId = options.mcpSessionId;
      logger.debug(`Setting mcpSessionId for session resumption: ${options.mcpSessionId}`);
      if (options.protocolVersion) {
        transportOptions.protocolVersion = options.protocolVersion;
        logger.debug(`Restoring negotiated protocol version: ${options.protocolVersion}`);
      }
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

    // Set custom fetch function (e.g., x402 payment middleware)
    if (options.customFetch) {
      transportOptions.fetch = options.customFetch;
      logger.debug('Setting custom fetch function on transport');
    }

    return createStreamableHttpTransport(config.url, transportOptions);
  }

  throw new ClientError('Invalid ServerConfig: must have either url or command');
}
