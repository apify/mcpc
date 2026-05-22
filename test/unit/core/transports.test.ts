/**
 * Unit tests for MCP transports
 */

import type { Mock } from 'vitest';
import { createTransportFromConfig } from '../../../src/core/transports.js';
import { StreamableHTTPClientTransport } from '../../../src/core/transports.js';
import { ClientError } from '../../../src/lib/errors.js';
import { proxyFetch } from '../../../src/lib/proxy.js';

// Mock the SDK transports
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(function () {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
  getDefaultEnvironment: vi.fn().mockReturnValue({}),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(function () {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
  StreamableHTTPError: class StreamableHTTPError extends Error {},
}));

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

  it('should inject proxyFetch into HTTP transport when no custom fetch is provided', () => {
    const mock = StreamableHTTPClientTransport as Mock;
    mock.mockClear();
    createTransportFromConfig({
      url: 'https://mcp.example.com',
    });

    expect(mock).toHaveBeenCalledTimes(1);
    const [, options] = mock.mock.calls[0];
    expect(options.fetch).toBe(proxyFetch);
  });

  it('should preserve custom fetch when provided (e.g. x402 middleware)', () => {
    const mock = StreamableHTTPClientTransport as Mock;
    mock.mockClear();
    const customFetch = vi.fn();
    createTransportFromConfig(
      { url: 'https://mcp.example.com' },
      { customFetch: customFetch as any }
    );

    expect(mock).toHaveBeenCalledTimes(1);
    const [, options] = mock.mock.calls[0];
    expect(options.fetch).toBe(customFetch);
  });
});
