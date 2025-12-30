#!/usr/bin/env npx ts-node
/**
 * Configurable MCP test server for E2E testing
 *
 * Environment variables:
 *   PORT - HTTP port (default: 13456)
 *   PAGINATION_SIZE - items per page, 0 = no pagination (default: 0)
 *   LATENCY_MS - artificial latency in ms (default: 0)
 *   REQUIRE_AUTH - require Authorization header (default: false)
 *
 * Control endpoints (for test manipulation):
 *   GET  /health - health check
 *   POST /control/fail-next?count=N - fail next N MCP requests
 *   POST /control/expire-session - expire current session
 *   POST /control/reset - reset all control state
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourceTemplatesRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import http from 'http';

// Configuration from environment
const PORT = parseInt(process.env.PORT || '13456', 10);
const PAGINATION_SIZE = parseInt(process.env.PAGINATION_SIZE || '0', 10);
const LATENCY_MS = parseInt(process.env.LATENCY_MS || '0', 10);
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';

// Control state (manipulated via /control/* endpoints)
let failNextCount = 0;
let sessionExpired = false;

// Test data
const TOOLS = [
  {
    name: 'echo',
    description: 'Returns the input message',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Message to echo' },
      },
      required: ['message'],
    },
    annotations: {
      title: 'Echo Tool',
      readOnlyHint: true,
    },
  },
  {
    name: 'add',
    description: 'Adds two numbers',
    inputSchema: {
      type: 'object' as const,
      properties: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' },
      },
      required: ['a', 'b'],
    },
    annotations: {
      title: 'Add Numbers',
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  {
    name: 'fail',
    description: 'Always fails with an error',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Error message' },
      },
    },
  },
  {
    name: 'slow',
    description: 'Waits for specified milliseconds then returns',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ms: { type: 'number', description: 'Milliseconds to wait', default: 1000 },
      },
    },
  },
  {
    name: 'write-file',
    description: 'Simulates writing to a file (destructive)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['path', 'content'],
    },
    annotations: {
      title: 'Write File',
      destructiveHint: true,
    },
  },
];

const RESOURCES = [
  {
    uri: 'test://static/hello',
    name: 'Hello Resource',
    description: 'A static test resource',
    mimeType: 'text/plain',
  },
  {
    uri: 'test://static/json',
    name: 'JSON Resource',
    description: 'A JSON test resource',
    mimeType: 'application/json',
  },
  {
    uri: 'test://dynamic/time',
    name: 'Current Time',
    description: 'Returns current timestamp',
    mimeType: 'text/plain',
  },
];

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'test://file/{path}',
    name: 'File Template',
    description: 'Access files by path',
    mimeType: 'application/octet-stream',
  },
];

const PROMPTS = [
  {
    name: 'greeting',
    description: 'Generate a greeting message',
    arguments: [
      { name: 'name', description: 'Name to greet', required: true },
      { name: 'style', description: 'Greeting style (formal/casual)', required: false },
    ],
  },
  {
    name: 'summarize',
    description: 'Summarize text',
    arguments: [
      { name: 'text', description: 'Text to summarize', required: true },
      { name: 'maxLength', description: 'Maximum length', required: false },
    ],
  },
];

// Helper for pagination
function paginate<T>(items: T[], cursor?: string): { items: T[]; nextCursor?: string } {
  if (PAGINATION_SIZE <= 0) {
    return { items };
  }

  const startIndex = cursor ? parseInt(cursor, 10) : 0;
  const endIndex = startIndex + PAGINATION_SIZE;
  const pageItems = items.slice(startIndex, endIndex);

  // Only include nextCursor when there are more items (exactOptionalPropertyTypes compatibility)
  if (endIndex < items.length) {
    return { items: pageItems, nextCursor: String(endIndex) };
  }
  return { items: pageItems };
}

// Helper for artificial latency
async function maybeDelay(): Promise<void> {
  if (LATENCY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
  }
}

// Helper to check if we should fail
function shouldFail(): boolean {
  if (failNextCount > 0) {
    failNextCount--;
    return true;
  }
  return false;
}

// Create the MCP server
function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'e2e-test-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        logging: {},
      },
    }
  );

  // Tools
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    await maybeDelay();
    if (shouldFail()) {
      throw new Error('Simulated failure');
    }

    const { items, nextCursor } = paginate(TOOLS, request.params?.cursor);
    return { tools: items, nextCursor };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    await maybeDelay();
    if (shouldFail()) {
      throw new Error('Simulated failure');
    }

    const { name, arguments: args } = request.params;

    switch (name) {
      case 'echo':
        return {
          content: [{ type: 'text', text: String(args?.message || '') }],
        };

      case 'add': {
        const a = Number(args?.a || 0);
        const b = Number(args?.b || 0);
        return {
          content: [{ type: 'text', text: String(a + b) }],
        };
      }

      case 'fail':
        throw new Error(String(args?.message || 'Tool intentionally failed'));

      case 'slow': {
        const ms = Number(args?.ms || 1000);
        await new Promise((resolve) => setTimeout(resolve, ms));
        return {
          content: [{ type: 'text', text: `Waited ${ms}ms` }],
        };
      }

      case 'write-file':
        // Simulate write (don't actually write)
        return {
          content: [{ type: 'text', text: `Would write to ${args?.path}` }],
        };

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  // Resources
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    await maybeDelay();
    if (shouldFail()) {
      throw new Error('Simulated failure');
    }

    const { items, nextCursor } = paginate(RESOURCES, request.params?.cursor);
    return { resources: items, nextCursor };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    await maybeDelay();
    if (shouldFail()) {
      throw new Error('Simulated failure');
    }

    const { items, nextCursor } = paginate(RESOURCE_TEMPLATES, request.params?.cursor);
    return { resourceTemplates: items, nextCursor };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    await maybeDelay();
    if (shouldFail()) {
      throw new Error('Simulated failure');
    }

    const { uri } = request.params;

    if (uri === 'test://static/hello') {
      return {
        contents: [{ uri, mimeType: 'text/plain', text: 'Hello, World!' }],
      };
    }

    if (uri === 'test://static/json') {
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({ test: true, value: 42 }),
          },
        ],
      };
    }

    if (uri === 'test://dynamic/time') {
      return {
        contents: [{ uri, mimeType: 'text/plain', text: new Date().toISOString() }],
      };
    }

    throw new Error(`Resource not found: ${uri}`);
  });

  // Prompts
  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    await maybeDelay();
    if (shouldFail()) {
      throw new Error('Simulated failure');
    }

    const { items, nextCursor } = paginate(PROMPTS, request.params?.cursor);
    return { prompts: items, nextCursor };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    await maybeDelay();
    if (shouldFail()) {
      throw new Error('Simulated failure');
    }

    const { name, arguments: args } = request.params;

    if (name === 'greeting') {
      const userName = args?.name || 'World';
      const style = args?.style || 'casual';
      const greeting = style === 'formal' ? `Good day, ${userName}.` : `Hey ${userName}!`;

      return {
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: greeting },
          },
        ],
      };
    }

    if (name === 'summarize') {
      const text = args?.text || '';
      const maxLength = args?.maxLength ? parseInt(args.maxLength, 10) : 100;

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please summarize the following text in ${maxLength} characters or less:\n\n${text}`,
            },
          },
        ],
      };
    }

    throw new Error(`Prompt not found: ${name}`);
  });

  return server;
}

// Create HTTP server with MCP transport and control endpoints
async function main() {
  const mcpServer = createMcpServer();
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    // Health check
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Control endpoints
    if (url.pathname.startsWith('/control/')) {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      const action = url.pathname.slice('/control/'.length);

      switch (action) {
        case 'fail-next': {
          const count = parseInt(url.searchParams.get('count') || '1', 10);
          failNextCount = count;
          res.writeHead(200);
          res.end(`Will fail next ${count} requests`);
          return;
        }

        case 'expire-session':
          sessionExpired = true;
          res.writeHead(200);
          res.end('Session marked as expired');
          return;

        case 'reset':
          failNextCount = 0;
          sessionExpired = false;
          res.writeHead(200);
          res.end('State reset');
          return;

        default:
          res.writeHead(404);
          res.end('Unknown control action');
          return;
      }
    }

    // Auth check
    if (REQUIRE_AUTH) {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    // Session expiration check
    if (sessionExpired) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session expired' }));
      return;
    }

    // MCP endpoint
    if (url.pathname === '/' || url.pathname === '/mcp') {
      // Handle MCP requests via StreamableHTTPServerTransport
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else if (req.method === 'POST' && !sessionId) {
        // New session - create transport
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => `e2e-session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          onsessioninitialized: (newSessionId) => {
            transports.set(newSessionId, transport);
          },
        });

        // Connect to MCP server
        // Type assertion needed due to exactOptionalPropertyTypes incompatibility with MCP SDK
        await mcpServer.connect(transport as Parameters<typeof mcpServer.connect>[0]);
      } else if (req.method === 'DELETE') {
        // Session termination
        if (sessionId && transports.has(sessionId)) {
          const oldTransport = transports.get(sessionId)!;
          await oldTransport.close();
          transports.delete(sessionId);
        }
        res.writeHead(200);
        res.end();
        return;
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
        return;
      }

      // Let transport handle the request
      await transport.handleRequest(req, res);
      return;
    }

    // 404 for unknown paths
    res.writeHead(404);
    res.end('Not found');
  });

  httpServer.listen(PORT, () => {
    console.log(`E2E test server running on http://localhost:${PORT}`);
    console.log(`  Pagination: ${PAGINATION_SIZE > 0 ? `${PAGINATION_SIZE} items/page` : 'disabled'}`);
    console.log(`  Latency: ${LATENCY_MS}ms`);
    console.log(`  Auth required: ${REQUIRE_AUTH}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('Shutting down...');
    httpServer.close();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('Shutting down...');
    httpServer.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
