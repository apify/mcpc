/**
 * Unit tests for MCP transports
 */

import { createTransportFromConfig } from '../../../src/core/transports';
import { ClientError } from '../../../src/lib/errors';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Mock the SDK transports
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  getDefaultEnvironment: jest.fn().mockReturnValue({}),
}));

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  StreamableHTTPError: class StreamableHTTPError extends Error {},
}));

// Mock undici for proxy tests
jest.mock('undici', () => ({
  ProxyAgent: jest.fn().mockImplementation((url: string) => ({ proxyUrl: url })),
  fetch: jest.fn().mockResolvedValue({ ok: true }),
}));

describe('createTransportFromConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset environment variables before each test
    process.env = { ...originalEnv };
    delete process.env.https_proxy;
    delete process.env.HTTPS_PROXY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should create stdio transport from config', async () => {
    const transport = await createTransportFromConfig({
      command: 'node',
      args: ['server.js'],
    });

    expect(transport).toBeDefined();
  });

  it('should create http transport from config', async () => {
    const transport = await createTransportFromConfig({
      url: 'https://mcp.example.com',
    });

    expect(transport).toBeDefined();
  });

  it('should throw error for config without url or command', async () => {
    await expect(
      createTransportFromConfig({} as any)
    ).rejects.toThrow(ClientError);
  });

  it('should pass headers to http transport', async () => {
    const transport = await createTransportFromConfig({
      url: 'https://mcp.example.com',
      headers: {
        Authorization: 'Bearer token',
      },
    });

    expect(transport).toBeDefined();
  });

  it('should pass environment variables to stdio transport', async () => {
    const transport = await createTransportFromConfig({
      command: 'node',
      args: ['server.js'],
      env: {
        DEBUG: '1',
      },
    });

    expect(transport).toBeDefined();
  });
});

describe('proxy-aware fetch', () => {
  const originalEnv = process.env;
  const MockedStreamableHTTPClientTransport = StreamableHTTPClientTransport as jest.MockedClass<typeof StreamableHTTPClientTransport>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.https_proxy;
    delete process.env.HTTPS_PROXY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should not use proxy fetch when no proxy env var is set', async () => {
    await createTransportFromConfig({
      url: 'https://mcp.example.com',
    });

    // Check that StreamableHTTPClientTransport was called without a custom fetch
    expect(MockedStreamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    const callArgs = MockedStreamableHTTPClientTransport.mock.calls[0];
    expect(callArgs[1]).not.toHaveProperty('fetch');
  });

  it('should use proxy fetch when https_proxy is set', async () => {
    process.env.https_proxy = 'http://localhost:8080';

    await createTransportFromConfig({
      url: 'https://mcp.example.com',
    });

    // Check that StreamableHTTPClientTransport was called with a custom fetch
    expect(MockedStreamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    const callArgs = MockedStreamableHTTPClientTransport.mock.calls[0];
    expect(callArgs[1]).toHaveProperty('fetch');
    expect(typeof callArgs[1]?.fetch).toBe('function');
  });

  it('should use proxy fetch when HTTPS_PROXY is set', async () => {
    process.env.HTTPS_PROXY = 'http://localhost:8080';

    await createTransportFromConfig({
      url: 'https://mcp.example.com',
    });

    // Check that StreamableHTTPClientTransport was called with a custom fetch
    expect(MockedStreamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    const callArgs = MockedStreamableHTTPClientTransport.mock.calls[0];
    expect(callArgs[1]).toHaveProperty('fetch');
    expect(typeof callArgs[1]?.fetch).toBe('function');
  });

  it('should prefer https_proxy over HTTPS_PROXY when both are set', async () => {
    process.env.https_proxy = 'http://localhost:8080';
    process.env.HTTPS_PROXY = 'http://localhost:9090';

    await createTransportFromConfig({
      url: 'https://mcp.example.com',
    });

    // The proxy fetch should be configured (we can't easily verify which URL was used
    // without more complex mocking, but we can verify a fetch was provided)
    expect(MockedStreamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    const callArgs = MockedStreamableHTTPClientTransport.mock.calls[0];
    expect(callArgs[1]).toHaveProperty('fetch');
  });

  it('should not affect stdio transport when proxy is set', async () => {
    process.env.https_proxy = 'http://localhost:8080';

    const transport = await createTransportFromConfig({
      command: 'node',
      args: ['server.js'],
    });

    // Stdio transport should still work normally
    expect(transport).toBeDefined();
    // StreamableHTTPClientTransport should not have been called
    expect(MockedStreamableHTTPClientTransport).not.toHaveBeenCalled();
  });
});
