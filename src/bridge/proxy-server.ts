/**
 * Proxy MCP Server for bridge process
 * Creates an HTTP MCP server that forwards requests to the upstream MCP client
 * without exposing original authentication tokens - useful for AI sandboxing
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion */

import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'http';
import { randomUUID } from 'crypto';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  SetLevelRequestSchema,
  PingRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpClient } from '../core/mcp-client.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('proxy-server');

/** Host names that always resolve to the local machine. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface ProxyServerOptions {
  host: string;
  port: number;
  client: McpClient;
  sessionName: string;
  /** mcpc version reported to proxy clients in the server implementation info */
  version: string;
  bearerToken?: string;
  instructions?: string; // Instructions from upstream server to pass to proxy clients
}

/**
 * Proxy MCP Server class
 * Wraps an upstream MCP client and exposes it as an HTTP MCP server
 */
export class ProxyServer {
  private httpServer: HttpServer | null = null;
  private options: ProxyServerOptions;
  /** Active proxy sessions keyed by MCP session ID (one transport per client session) */
  private transports = new Map<string, StreamableHTTPServerTransport>();

  constructor(options: ProxyServerOptions) {
    this.options = options;
  }

  /**
   * Start the proxy server
   */
  async start(): Promise<void> {
    const { host, port, sessionName, bearerToken } = this.options;

    logger.info(`Starting proxy server on ${host}:${port} for session ${sessionName}`);

    // Create HTTP server
    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res, bearerToken).catch((error) => {
        logger.error('Error handling request:', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
    });

    // Start listening
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(port, host, () => {
        logger.info(`Proxy server listening on http://${host}:${port}`);
        resolve();
      });

      this.httpServer!.on('error', (error) => {
        logger.error('HTTP server error:', error);
        reject(error);
      });
    });
  }

  /**
   * Validate Host and Origin headers to prevent DNS-rebinding attacks.
   *
   * A malicious web page can point a hostname it controls at 127.0.0.1 and issue
   * requests to the proxy from the user's browser — riding on the bridge's
   * authenticated upstream session. Such requests arrive with the attacker's
   * hostname in `Host` and/or a non-local `Origin`, so both are rejected here.
   *
   * When the proxy is deliberately bound to a non-loopback address, the operator
   * has opted into network exposure and legitimate Host values are unknowable —
   * only the Origin check applies there (browsers always send Origin on
   * cross-origin requests; non-browser MCP clients typically send none).
   */
  private validateHostAndOrigin(req: IncomingMessage, res: ServerResponse): boolean {
    const bindHost = this.options.host;
    const isLoopbackBind = LOOPBACK_HOSTS.has(bindHost);

    if (isLoopbackBind) {
      // Strip port and brackets from the Host header (e.g. "127.0.0.1:3000", "[::1]:3000")
      const rawHost = req.headers.host ?? '';
      const hostName = rawHost
        .replace(/:\d+$/, '')
        .replace(/^\[|\]$/g, '')
        .toLowerCase();
      if (!LOOPBACK_HOSTS.has(hostName) && hostName !== bindHost.toLowerCase()) {
        logger.warn(`Rejected proxy request with unexpected Host header: ${rawHost}`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: invalid Host header' }));
        return false;
      }
    }

    const origin = req.headers.origin;
    if (origin) {
      let originHost: string;
      try {
        originHost = new URL(origin).hostname.toLowerCase();
      } catch {
        originHost = '';
      }
      if (!LOOPBACK_HOSTS.has(originHost)) {
        logger.warn(`Rejected proxy request with non-local Origin: ${origin}`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: invalid Origin header' }));
        return false;
      }
    }

    return true;
  }

  /**
   * Handle incoming HTTP requests
   */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    bearerToken?: string
  ): Promise<void> {
    const { method, url } = req;

    logger.debug(`Proxy request: ${method} ${url}`);

    if (!this.validateHostAndOrigin(req, res)) {
      return;
    }

    // Health check endpoint
    if (url === '/health' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Validate bearer token if configured
    if (bearerToken) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        logger.debug('Missing or invalid Authorization header');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Bearer token required' }));
        return;
      }

      const providedToken = authHeader.slice(7); // Remove 'Bearer ' prefix
      if (providedToken !== bearerToken) {
        logger.debug('Invalid bearer token');
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: Invalid bearer token' }));
        return;
      }
    }

    // POST/GET/DELETE all delegate to the per-session transport. DELETE is
    // handled by the transport itself (real session termination), so multiple
    // clients can initialize, terminate, and re-initialize sessions freely.
    if (method === 'POST' || method === 'GET' || method === 'DELETE') {
      await this.handleMcpRequest(req, res);
      return;
    }

    // Unknown method
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  /**
   * Route an MCP request to its session transport, creating a new session
   * (transport + MCP server instance) for an initialize request.
   */
  private async handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId) {
      const transport = this.transports.get(sessionId);
      if (!transport) {
        // Unknown/expired session — per spec the client must re-initialize
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing MCP-Session-Id header' }));
      return;
    }

    // No session ID on a POST: treat as a new initialize request
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        logger.debug(`Proxy session initialized: ${sid}`);
        this.transports.set(sid, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        logger.debug(`Proxy session closed: ${transport.sessionId}`);
        this.transports.delete(transport.sessionId);
      }
    };

    const mcpServer = this.createMcpServer();
    await mcpServer.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res);

    // Non-initialize POST without a session ID: the transport rejects it and
    // never assigns a session — release the orphaned instances.
    if (!transport.sessionId) {
      await transport.close().catch(() => {});
      await mcpServer.close().catch(() => {});
    }
  }

  /**
   * Create an MCP server instance (one per proxy session) whose handlers
   * forward to the upstream client.
   */
  private createMcpServer(): MCPServer {
    const { client, sessionName, version, instructions } = this.options;

    const mcpServer = new MCPServer(
      {
        name: `mcpc-proxy${sessionName}`,
        version,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
          logging: {},
        },
        // Pass upstream server's instructions to proxy clients (if available)
        ...(instructions && { instructions }),
      }
    );

    this.registerHandlers(mcpServer, client);
    return mcpServer;
  }

  /**
   * Register MCP request handlers that forward to upstream client
   */
  private registerHandlers(mcpServer: MCPServer, client: McpClient): void {
    // Ping
    mcpServer.setRequestHandler(PingRequestSchema, async () => {
      await client.ping();
      return {};
    });

    // Tools
    mcpServer.setRequestHandler(ListToolsRequestSchema, async (request) => {
      return await client.listTools(request.params?.cursor);
    });

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      return await client.callTool(request.params.name, request.params.arguments);
    });

    // Resources
    mcpServer.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      return await client.listResources(request.params?.cursor);
    });

    mcpServer.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
      return await client.listResourceTemplates(request.params?.cursor);
    });

    mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return await client.readResource(request.params.uri);
    });

    // Prompts
    mcpServer.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      return await client.listPrompts(request.params?.cursor);
    });

    mcpServer.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return await client.getPrompt(request.params.name, request.params.arguments);
    });

    // Logging
    mcpServer.setRequestHandler(SetLevelRequestSchema, async (request) => {
      await client.setLoggingLevel(request.params.level);
      return {};
    });
  }

  /**
   * Stop the proxy server
   */
  async stop(): Promise<void> {
    logger.info('Stopping proxy server...');

    // Close all session transports (closing a transport also closes its MCP server)
    for (const [sid, transport] of this.transports) {
      try {
        await transport.close();
      } catch (error) {
        logger.warn(`Error closing proxy session ${sid}:`, error);
      }
    }
    this.transports.clear();

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => {
          logger.debug('HTTP server closed');
          resolve();
        });
      });
      this.httpServer = null;
    }

    logger.info('Proxy server stopped');
  }

  /**
   * Get the proxy server address
   */
  getAddress(): string {
    return `http://${this.options.host}:${this.options.port}`;
  }
}
