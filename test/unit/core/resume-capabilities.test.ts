/**
 * McpClient.restoreServerCapabilities against the real SDK client (#484).
 *
 * A connection whose transport already carries an MCP session ID skips the handshake,
 * so the SDK client learns no server capabilities. restoreServerCapabilities fills in
 * the SDK client state that the handshake would have set. Those are SDK internals, so
 * this suite drives the real SDK client (unlike mcp-client.test.ts, which stubs it) and
 * fails if a later SDK version renames or drops them.
 */

import { vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { McpClient } from '../../../src/core/mcp-client.js';

const CAPABILITIES = { tools: { listChanged: true }, prompts: {} };

const ECHO_TOOL = {
  name: 'echo',
  inputSchema: { type: 'object' as const, properties: {} },
  outputSchema: {
    type: 'object' as const,
    properties: { message: { type: 'string' } },
    required: ['message'],
  },
};

/** A legacy-era server, and an McpClient connected to it as if resuming a session. */
async function resumedConnection(onToolsChanged = vi.fn()): Promise<{
  server: Server;
  client: McpClient;
}> {
  const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: CAPABILITIES });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [ECHO_TOOL] }));
  server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [{ name: 'greeting' }] }));
  // Breaks the tool's own output schema, which a validating client must reject.
  server.setRequestHandler(CallToolRequestSchema, () => ({
    content: [],
    structuredContent: { message: 42 },
  }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  // A transport that carries a session ID makes the SDK skip the handshake.
  (clientTransport as { sessionId?: string }).sessionId = 'resumed-session';

  const client = new McpClient(
    { name: 'test', version: '0.0.0' },
    {
      protocolVersion: '2025-11-25',
      listChanged: { tools: { autoRefresh: false, onChanged: onToolsChanged } },
    }
  );
  await client.connect(clientTransport);
  return { server, client };
}

describe('resumed session capabilities (real SDK client)', () => {
  it('lists nothing before the capabilities are restored (the bug)', async () => {
    const { client } = await resumedConnection();
    await expect(client.listTools()).resolves.toEqual({ tools: [] });
    await client.close();
  });

  it('lists the server items once the capabilities are restored', async () => {
    const { client } = await resumedConnection();
    client.restoreServerCapabilities(CAPABILITIES);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['echo']);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual(['greeting']);
    await expect(client.getServerDetails()).resolves.toMatchObject({ capabilities: CAPABILITIES });
    await client.close();
  });

  it('handles list-changed notifications once the capabilities are restored', async () => {
    const onToolsChanged = vi.fn();
    const { server, client } = await resumedConnection(onToolsChanged);
    client.restoreServerCapabilities(CAPABILITIES);

    await server.sendToolListChanged();
    await vi.waitFor(() => expect(onToolsChanged).toHaveBeenCalled());
    await client.close();
  });

  it('checks tool results against the output schema again', async () => {
    const { client } = await resumedConnection();
    client.restoreServerCapabilities(CAPABILITIES);

    await client.listTools();
    await expect(client.callTool('echo', {})).rejects.toThrow(/output schema/i);
    await client.close();
  });

  it('does not replace capabilities the SDK client already has', async () => {
    const { client } = await resumedConnection();
    client.restoreServerCapabilities(CAPABILITIES);
    client.restoreServerCapabilities({ resources: {} });

    await expect(client.getServerDetails()).resolves.toMatchObject({ capabilities: CAPABILITIES });
    await client.close();
  });
});
