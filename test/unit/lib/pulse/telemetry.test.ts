/**
 * Unit tests for MCPfy Pulse transport wrapping
 */

import type { Transport } from '@modelcontextprotocol/client';
import { wrapTransportWithPulse } from '../../../../src/lib/pulse/telemetry.js';

const withMcpfyTelemetry = vi.hoisted(() =>
  vi.fn((transport: Transport) => ({ ...transport, pulseWrapped: true }))
);

vi.mock('mcpfy-pulse', () => ({
  withMcpfyTelemetry,
}));

function mockTransport(): Transport {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

describe('wrapTransportWithPulse', () => {
  const clientInfo = { name: 'mcpc', version: '0.7.0' };

  afterEach(() => {
    delete process.env.MCPFY_API_KEY;
    vi.clearAllMocks();
  });

  it('returns the original transport when MCPFY_API_KEY is unset', async () => {
    const transport = mockTransport();
    const result = await wrapTransportWithPulse(transport, clientInfo);

    expect(result).toBe(transport);
    expect(withMcpfyTelemetry).not.toHaveBeenCalled();
  });

  it('wraps the transport when MCPFY_API_KEY is set', async () => {
    process.env.MCPFY_API_KEY = 'mk_test';
    const transport = mockTransport();
    const wrapped = { ...transport, pulseWrapped: true };
    withMcpfyTelemetry.mockReturnValue(wrapped);

    const result = await wrapTransportWithPulse(transport, clientInfo);

    expect(withMcpfyTelemetry).toHaveBeenCalledOnce();
    expect(withMcpfyTelemetry).toHaveBeenCalledWith(transport, {
      apiKey: 'mk_test',
      serverName: clientInfo.name,
      serverVersion: clientInfo.version,
      sdkName: '@modelcontextprotocol/sdk',
      sdkVersion: clientInfo.version,
      installMode: 'sdk-wrapper',
    });
    expect(result).toBe(wrapped);
  });
});
