/**
 * Unit tests for MCP transports
 */

import type { Mock } from 'vitest';
import { createTransportFromConfig } from '../../../src/core/transports.js';
import { StreamableHTTPClientTransport } from '../../../src/core/transports.js';
import { ClientError } from '../../../src/lib/errors.js';
import { proxyFetch } from '../../../src/lib/proxy.js';

// Mock the proxy-aware fetch so calling through the transport's fetch never hits the network
vi.mock('../../../src/lib/proxy.js', () => ({
  proxyFetch: vi.fn().mockResolvedValue(new Response('{}')),
}));

// Mock the SDK transports
vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: vi.fn(function () {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
  getDefaultEnvironment: vi.fn().mockReturnValue({}),
}));

vi.mock('@modelcontextprotocol/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/client')>();
  return {
    ...actual,
    StreamableHTTPClientTransport: vi.fn(function () {
      return {
        start: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

describe('createTransportFromConfig', () => {
  it('should create stdio transport from config', () => {
    const transport = createTransportFromConfig({
      command: 'node',
      args: ['server.js'],
    });

    expect(transport).toBeDefined();
  });

  it('should create http transport from config', () => {
    const transport = createTransportFromConfig({
      url: 'https://mcp.example.com',
    });

    expect(transport).toBeDefined();
  });

  it('should throw error for config without url or command', () => {
    expect(() => createTransportFromConfig({} as any)).toThrow(ClientError);
  });

  it('should pass headers to http transport', () => {
    const transport = createTransportFromConfig({
      url: 'https://mcp.example.com',
      headers: {
        Authorization: 'Bearer token',
      },
    });

    expect(transport).toBeDefined();
  });

  it('should pass environment variables to stdio transport', () => {
    const transport = createTransportFromConfig({
      command: 'node',
      args: ['server.js'],
      env: {
        DEBUG: '1',
      },
    });

    expect(transport).toBeDefined();
  });

  // The transport's fetch is wrapped by the tasks-extension routing-header shim, so the
  // underlying function is observed by calling through it rather than by identity.
  it('should inject proxyFetch into HTTP transport when no custom fetch is provided', async () => {
    const mock = StreamableHTTPClientTransport as Mock;
    mock.mockClear();
    createTransportFromConfig({
      url: 'https://mcp.example.com',
    });

    expect(mock).toHaveBeenCalledTimes(1);
    const [, options] = mock.mock.calls[0];
    expect(typeof options.fetch).toBe('function');
    (proxyFetch as unknown as Mock).mockClear();
    await options.fetch('https://mcp.example.com', { method: 'GET' });
    expect(proxyFetch).toHaveBeenCalledWith('https://mcp.example.com', { method: 'GET' });
  });

  it('should preserve custom fetch when provided (e.g. x402 middleware)', async () => {
    const mock = StreamableHTTPClientTransport as Mock;
    mock.mockClear();
    const customFetch = vi.fn().mockResolvedValue(new Response('{}'));
    createTransportFromConfig(
      { url: 'https://mcp.example.com' },
      { customFetch: customFetch as any }
    );

    expect(mock).toHaveBeenCalledTimes(1);
    const [, options] = mock.mock.calls[0];
    await options.fetch('https://mcp.example.com', { method: 'GET' });
    expect(customFetch).toHaveBeenCalledWith('https://mcp.example.com', { method: 'GET' });
    expect(proxyFetch).not.toHaveBeenCalled();
  });
});
