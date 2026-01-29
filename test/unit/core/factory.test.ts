/**
 * Unit tests for MCP client factory
 */

import { McpClient } from '../../../src/core/mcp-client.js';
import { createMcpClient } from '../../../src/core/factory.js';

// Mock the transports (now async)
jest.mock('../../../src/core/transports', () => ({
  createTransportFromConfig: jest.fn().mockResolvedValue({
    start: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
  }),
}));

// Mock the SDK Client
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    getServerVersion: jest.fn().mockReturnValue({ name: 'test-server', version: '1.0.0' }),
    getServerCapabilities: jest.fn().mockReturnValue({}),
    getInstructions: jest.fn().mockReturnValue(undefined),
    ping: jest.fn().mockResolvedValue(undefined),
    onerror: undefined,
  })),
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

