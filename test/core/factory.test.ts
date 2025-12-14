/**
 * Unit tests for MCP client factory
 */

import { McpClient } from '../../src/core/client';
import { createClient, createStdioClient, createHttpClient } from '../../src/core/factory';

// Mock the transports
jest.mock('../../src/core/transports', () => ({
  createTransportFromConfig: jest.fn().mockReturnValue({
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

describe('createClient', () => {
  it('should create a client with stdio transport', async () => {
    const client = await createClient({
      clientInfo: { name: 'test-client', version: '1.0.0' },
      transport: {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
      },
    });

    expect(client).toBeInstanceOf(McpClient);
  });

  it('should create a client with http transport', async () => {
    const client = await createClient({
      clientInfo: { name: 'test-client', version: '1.0.0' },
      transport: {
        type: 'http',
        url: 'https://mcp.example.com',
      },
    });

    expect(client).toBeInstanceOf(McpClient);
  });

  it('should not auto-connect if autoConnect is false', async () => {
    const client = await createClient({
      clientInfo: { name: 'test-client', version: '1.0.0' },
      transport: {
        type: 'http',
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

    const client = await createClient({
      clientInfo: { name: 'test-client', version: '1.0.0' },
      transport: {
        type: 'http',
        url: 'https://mcp.example.com',
      },
      capabilities,
    });

    expect(client).toBeInstanceOf(McpClient);
  });
});

describe('createStdioClient', () => {
  it('should create a stdio client with command and args', async () => {
    const client = await createStdioClient(
      { name: 'mcpc', version: '0.0.1' },
      'node',
      ['server.js']
    );

    expect(client).toBeInstanceOf(McpClient);
  });

  it('should create a stdio client with environment variables', async () => {
    const client = await createStdioClient(
      { name: 'mcpc', version: '0.1.0' },
      'node',
      ['server.js'],
      { DEBUG: '1' }
    );

    expect(client).toBeInstanceOf(McpClient);
  });
});

describe('createHttpClient', () => {
  it('should create an http client with URL', async () => {
    const client = await createHttpClient(
      { name: 'mcpc', version: '0.1.0' },
      'https://mcp.example.com'
    );

    expect(client).toBeInstanceOf(McpClient);
  });

  it('should create an http client with headers', async () => {
    const client = await createHttpClient(
      { name: 'mcpc', version: '0.1.0' },
      'https://mcp.example.com',
      { Authorization: 'Bearer token' }
    );

    expect(client).toBeInstanceOf(McpClient);
  });

  it('should create an http client with timeout', async () => {
    const client = await createHttpClient(
      { name: 'mcpc', version: '0.1.0' },
      'https://mcp.example.com',
      undefined,
      30000
    );

    expect(client).toBeInstanceOf(McpClient);
  });
});
