/**
 * Unit tests for MCP client factory
 */

import { McpClient } from '../../../src/core/mcp-client.js';
import { createMcpClient } from '../../../src/core/factory.js';
import { createTransportFromConfig } from '../../../src/core/transports.js';
import { wrapTransportWithPulse } from '../../../src/lib/pulse/telemetry.js';

const mockTransport = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  onclose: undefined,
  onerror: undefined,
  onmessage: undefined,
}));

// Mock the transports
vi.mock('../../../src/core/transports', () => ({
  createTransportFromConfig: vi.fn().mockReturnValue(mockTransport),
}));

vi.mock('../../../src/lib/pulse/telemetry.js', () => ({
  wrapTransportWithPulse: vi.fn(async (transport: typeof mockTransport) => transport),
}));

const sdkConnect = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// Mock the SDK Client
vi.mock('@modelcontextprotocol/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/client')>();
  return {
    ...actual,
    Client: vi.fn(function () {
      return {
        connect: sdkConnect,
        close: vi.fn().mockResolvedValue(undefined),
        getServerVersion: vi.fn().mockReturnValue({ name: 'test-server', version: '1.0.0' }),
        getServerCapabilities: vi.fn().mockReturnValue({}),
        getInstructions: vi.fn().mockReturnValue(undefined),
        getNegotiatedProtocolVersion: vi.fn().mockReturnValue('2025-11-25'),
        getProtocolEra: vi.fn().mockReturnValue('legacy'),
        ping: vi.fn().mockResolvedValue(undefined),
        onerror: undefined,
      };
    }),
  };
});

describe('createMcpClient', () => {
  afterEach(() => {
    delete process.env.MCPFY_API_KEY;
    vi.clearAllMocks();
  });

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

  it('does not wrap the transport when MCPFY_API_KEY is unset', async () => {
    await createMcpClient({
      clientInfo: { name: 'test-client', version: '1.0.0' },
      serverConfig: { url: 'https://mcp.example.com' },
    });

    expect(wrapTransportWithPulse).toHaveBeenCalledWith(mockTransport, {
      name: 'test-client',
      version: '1.0.0',
    });
    expect(sdkConnect).toHaveBeenCalledWith(mockTransport);
  });

  it('wraps the transport before connect when MCPFY_API_KEY is set', async () => {
    process.env.MCPFY_API_KEY = 'mk_test';
    const wrappedTransport = { ...mockTransport, pulseWrapped: true };
    const callOrder: string[] = [];
    vi.mocked(wrapTransportWithPulse).mockImplementationOnce(async (transport, clientInfo) => {
      callOrder.push('wrap');
      expect(transport).toBe(mockTransport);
      expect(clientInfo).toEqual({ name: 'test-client', version: '1.0.0' });
      return wrappedTransport;
    });
    sdkConnect.mockImplementationOnce(async () => {
      callOrder.push('connect');
    });

    await createMcpClient({
      clientInfo: { name: 'test-client', version: '1.0.0' },
      serverConfig: { url: 'https://mcp.example.com' },
    });

    expect(createTransportFromConfig).toHaveBeenCalledOnce();
    expect(wrapTransportWithPulse).toHaveBeenCalledOnce();
    expect(callOrder).toEqual(['wrap', 'connect']);
    expect(sdkConnect).toHaveBeenCalledWith(wrappedTransport);
  });
});
