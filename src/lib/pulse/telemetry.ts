/**
 * Optional MCPfy Pulse telemetry for MCP client transports.
 *
 * Loaded lazily so mcpc pays no cost when MCPFY_API_KEY is unset.
 */

import type { Transport } from '@modelcontextprotocol/client';

/** MCP client identity passed to Pulse batch metadata. */
export interface PulseClientInfo {
  name: string;
  version: string;
}

/**
 * Wrap an MCP client transport with MCPfy Pulse telemetry when configured.
 *
 * No-op when `MCPFY_API_KEY` is unset — the original transport is returned unchanged
 * and `mcpfy-pulse` is not loaded.
 */
export async function wrapTransportWithPulse<T extends Transport>(
  transport: T,
  clientInfo: PulseClientInfo
): Promise<T> {
  const apiKey = process.env.MCPFY_API_KEY;
  if (!apiKey) {
    return transport;
  }

  const { withMcpfyTelemetry } = await import('mcpfy-pulse');
  return withMcpfyTelemetry(transport, {
    apiKey,
    serverName: clientInfo.name,
    serverVersion: clientInfo.version,
    sdkName: '@modelcontextprotocol/sdk',
    sdkVersion: clientInfo.version,
    installMode: 'sdk-wrapper',
  });
}
