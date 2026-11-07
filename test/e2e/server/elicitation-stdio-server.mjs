#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'e2e-elicitation-stdio', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true }, resources: { subscribe: true } } }
);

let changed = false;
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'request_input',
      description: 'Request a form response from the MCP client',
      inputSchema: { type: 'object', properties: {} },
    },
    ...(changed ? [{ name: 'new_tool', inputSchema: { type: 'object', properties: {} } }] : []),
  ],
}));
server.setRequestHandler(SubscribeRequestSchema, async () => {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return {};
});
server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => ({
  contents: [{ uri: params.uri, text: changed ? 'updated' : 'initial' }],
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name !== 'request_input') throw new Error(`Unknown tool: ${params.name}`);

  const request = {
    mode: 'form',
    message: 'Provide your display name',
    requestedSchema: {
      type: 'object',
      properties: { name: { type: 'string', title: 'Name' } },
      required: ['name'],
    },
  };
  if (params.arguments?.timeoutSecond) {
    const first = await server.elicitInput(request);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = await server.elicitInput(request);
    return { content: [{ type: 'text', text: JSON.stringify([first, second]) }] };
  }
  if (params.arguments?.overlap) {
    const results = await Promise.all([server.elicitInput(request), server.elicitInput(request)]);
    return { content: [{ type: 'text', text: JSON.stringify(results) }] };
  }
  if (params.arguments?.notify) {
    changed = true;
    await server.notification({ method: 'notifications/tools/list_changed' });
    await server.notification({
      method: 'notifications/resources/updated',
      params: { uri: 'test://resource' },
    });
  }
  const result = await server.elicitInput(request);

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
});

await server.connect(new StdioServerTransport());
