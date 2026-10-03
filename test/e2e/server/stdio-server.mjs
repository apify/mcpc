#!/usr/bin/env node
// Minimal stdio MCP server used by e2e tests to create a live stdio session
// without any network access (the official @modelcontextprotocol/sdk is a local
// dependency). It completes the MCP initialize handshake so the bridge reports
// the session as "live", and exposes one tool, `env`, that returns the value of
// an environment variable of this process — so a test can prove that the `env`
// of a config entry reaches the server, and only the server (see
// suites/stdio/env-security.test.sh). Uses the low-level Server API so it needs
// no zod import (zod is not a direct dependency of this repo).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'e2e-stdio', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'env',
      description: 'Return the value of an environment variable of the server process',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Variable name' } },
        required: ['name'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name !== 'env') {
    throw new Error(`Unknown tool: ${name}`);
  }
  return { content: [{ type: 'text', text: process.env[String(args?.name)] ?? '' }] };
});

await server.connect(new StdioServerTransport());
