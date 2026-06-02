#!/usr/bin/env node
// Minimal stdio MCP server used by e2e tests to create a live stdio session
// without any network access (the official @modelcontextprotocol/sdk is a local
// dependency). It only needs to complete the MCP initialize handshake so the
// bridge reports the session as "live".
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'e2e-stdio', version: '1.0.0' });
await server.connect(new StdioServerTransport());
