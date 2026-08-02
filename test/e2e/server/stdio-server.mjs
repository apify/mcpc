#!/usr/bin/env node
// Minimal stdio MCP server used by e2e tests to create a live stdio session
// without any network access (the official @modelcontextprotocol/sdk is a local
// dependency). It completes the MCP initialize handshake so the bridge reports
// the session as "live", and exposes a single `echo-env` tool that returns the
// value of one of its own environment variables — used by the env-security
// suite to prove that a config entry's `env` still reaches the server process
// even though its values are kept out of sessions.json and the process list.
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
      name: 'echo-env',
      description: 'Return the value of one of the server process environment variables',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Environment variable name' } },
        required: ['name'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'echo-env') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  const name = String(request.params.arguments?.name ?? '');
  return { content: [{ type: 'text', text: process.env[name] ?? '' }] };
});

await server.connect(new StdioServerTransport());
