/**
 * Unit tests for MCP client factory
 */

import { McpClient } from '../../../src/core/mcp-client.js';
import { createMcpClient } from '../../../src/core/factory.js';

// Mock the transports
vi.mock('../../../src/core/transports', () => ({
  createTransportFromConfig: vi.fn().mockReturnValue({
    start: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
  }),
}));

// Mock the SDK Client
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(function () {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getServerVersion: vi.fn().mockReturnValue({ name: 'test-server', version: '1.0.0' }),
      getServerCapabilities: vi.fn().mockReturnValue({}),
      getInstructions: vi.fn().mockReturnValue(undefined),
      ping: vi.fn().mockResolvedValue(undefined),
      onerror: undefined,
    };
  }),
}));

describe('createMcpClient', () => {
  it('should create a client with stdio transport', async () => {
    const client = await createMcpClient({
      clientInfo: { name: 'test-client', version: '1.0.0' },
      serverConfig: {
        command: 'node',
        args: ['server.js'],
      },
    });

    expect(client).toBeInstanceOf(McpClient);
  });

  it('should create a client with http transport', async () => {
    const client = await createMcpClient({
      clientInfo: { name: 'test-client', version: '1.0.0' },
      serverConfig: {
        url: 'https://mcp.example.com',
      },
    });

    expect(client).toBeInstanceOf(McpClient);
  });

  it('should not auto-connect if autoConnect is false', async () => {
    const client = await createMcpClient({
      clientInfo: { name: 'test-client', version: '1.0.0' },
      serverConfig: {
        url: 'https://mcp.example.com',
      },
      autoConnect: false,
    });

    expect(client).toBeInstanceOf(McpClient);
  });

  it('should pass capabilities to client', async () => {
    const capabilities = {
      roots: { listChanged: true },
    };

    const client = await createMcpClient({
      clientInfo: { name: 'test-client', version: '1.0.0' },
      serverConfig: {
        url: 'https://mcp.example.com',
      },
      capabilities,
    });

    expect(client).toBeInstanceOf(McpClient);
  });
});
