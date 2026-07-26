/**
 * Unit tests for MCP protocol version constants and the --mcp-version pin mapping
 */

import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/client';
import {
  MODERN_MCP_VERSIONS,
  LEGACY_MCP_VERSIONS,
  SUPPORTED_MCP_VERSIONS,
  isModernMcpVersion,
  isSupportedMcpVersion,
} from '../../../src/core/protocol.js';
import { resolveVersionOptions } from '../../../src/core/mcp-client.js';
import { ClientError } from '../../../src/lib/errors.js';

describe('protocol version constants', () => {
  it('legacy list stays in sync with the SDK (drift guard)', () => {
    // protocol.ts hardcodes the list so the CLI never loads the SDK at startup;
    // this test catches drift when the SDK is upgraded.
    expect(LEGACY_MCP_VERSIONS).toEqual(SUPPORTED_PROTOCOL_VERSIONS);
  });

  it('supported list is modern versions followed by legacy versions', () => {
    expect(SUPPORTED_MCP_VERSIONS).toEqual([...MODERN_MCP_VERSIONS, ...LEGACY_MCP_VERSIONS]);
  });

  it('classifies modern and legacy versions', () => {
    expect(isModernMcpVersion('2026-07-28')).toBe(true);
    expect(isModernMcpVersion('2025-11-25')).toBe(false);
    expect(isSupportedMcpVersion('2026-07-28')).toBe(true);
    expect(isSupportedMcpVersion('2025-11-25')).toBe(true);
    expect(isSupportedMcpVersion('2024-10-07')).toBe(true);
    expect(isSupportedMcpVersion('1999-01-01')).toBe(false);
    expect(isSupportedMcpVersion('')).toBe(false);
  });
});

describe('resolveVersionOptions', () => {
  it('defaults to auto negotiation without a pin', () => {
    expect(resolveVersionOptions(undefined, undefined)).toEqual({
      versionNegotiation: { mode: 'auto' },
    });
  });

  it('caps the probe timeout on stdio without a pin', () => {
    const options = resolveVersionOptions(undefined, true);
    expect(options.versionNegotiation?.mode).toBe('auto');
    expect(options.versionNegotiation?.probe?.timeoutMs).toBeGreaterThan(0);
  });

  it('maps a modern pin to the SDK pin mode', () => {
    expect(resolveVersionOptions('2026-07-28', undefined)).toEqual({
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    });
  });

  it('maps a legacy pin to legacy mode with a single supported version', () => {
    expect(resolveVersionOptions('2025-11-25', undefined)).toEqual({
      versionNegotiation: { mode: 'legacy' },
      supportedProtocolVersions: ['2025-11-25'],
    });
    expect(resolveVersionOptions('2024-10-07', true)).toEqual({
      versionNegotiation: { mode: 'legacy' },
      supportedProtocolVersions: ['2024-10-07'],
    });
  });

  it('rejects unsupported versions with the supported list', () => {
    expect(() => resolveVersionOptions('1999-01-01', undefined)).toThrow(ClientError);
    expect(() => resolveVersionOptions('1999-01-01', undefined)).toThrow(
      /Supported versions: 2026-07-28, 2025-11-25/
    );
  });
});
