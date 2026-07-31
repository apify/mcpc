/**
 * Unit tests for MCP protocol version constants and the --protocol-version pin mapping
 */

import {
  SUPPORTED_PROTOCOL_VERSIONS as SDK_SUPPORTED_PROTOCOL_VERSIONS,
  SERVER_INFO_META_KEY as SDK_SERVER_INFO_META_KEY,
} from '@modelcontextprotocol/client';
import {
  MODERN_PROTOCOL_VERSIONS,
  LEGACY_PROTOCOL_VERSIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  SERVER_INFO_META_KEY,
  isModernProtocolVersion,
  isSupportedProtocolVersion,
  discoverUnavailableMessage,
  tasksUnavailableMessage,
  tasksUnsupportedByServerMessage,
} from '../../../src/core/protocol.js';
import { resolveVersionOptions } from '../../../src/core/mcp-client.js';
import { ClientError } from '../../../src/lib/errors.js';

describe('protocol version constants', () => {
  it('legacy list stays in sync with the SDK (drift guard)', () => {
    // protocol.ts hardcodes the list so the CLI never loads the SDK at startup;
    // this test catches drift when the SDK is upgraded.
    expect(LEGACY_PROTOCOL_VERSIONS).toEqual(SDK_SUPPORTED_PROTOCOL_VERSIONS);
  });

  it('server-info meta key stays in sync with the SDK (drift guard)', () => {
    // Spelled out in protocol.ts so the CLI can read it without loading the SDK.
    expect(SERVER_INFO_META_KEY).toEqual(SDK_SERVER_INFO_META_KEY);
  });

  it('supported list is modern versions followed by legacy versions', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual([
      ...MODERN_PROTOCOL_VERSIONS,
      ...LEGACY_PROTOCOL_VERSIONS,
    ]);
  });

  it('classifies modern and legacy versions', () => {
    expect(isModernProtocolVersion('2026-07-28')).toBe(true);
    expect(isModernProtocolVersion('2025-11-25')).toBe(false);
    expect(isSupportedProtocolVersion('2026-07-28')).toBe(true);
    expect(isSupportedProtocolVersion('2025-11-25')).toBe(true);
    expect(isSupportedProtocolVersion('2024-10-07')).toBe(true);
    expect(isSupportedProtocolVersion('1999-01-01')).toBe(false);
    expect(isSupportedProtocolVersion('')).toBe(false);
  });
});

describe('tasksUnavailableMessage', () => {
  // Shared by the CLI (which gates tools-call --task/--detach) and McpClient (which
  // gates the tasks/* requests), so both report the identical reason.
  it('names the negotiated version and the extension', () => {
    const message = tasksUnavailableMessage('2026-07-28');
    expect(message).toContain('2026-07-28');
    expect(message).toContain('io.modelcontextprotocol/tasks extension');
    expect(message).toContain('2025-11-25');
  });

  it('has no trailing period, so the bridge\'s ". For details, run: ..." never doubles up', () => {
    expect(tasksUnavailableMessage('2026-07-28')).not.toMatch(/\.$/);
    expect(tasksUnavailableMessage(undefined)).not.toMatch(/\.$/);
  });

  it('falls back to the latest modern version when none is known', () => {
    expect(tasksUnavailableMessage(undefined)).toContain(MODERN_PROTOCOL_VERSIONS[0]!);
  });
});

describe('tasksUnsupportedByServerMessage', () => {
  it('names the missing capability and how to proceed', () => {
    const message = tasksUnsupportedByServerMessage();
    expect(message).toContain('tasks.requests.tools.call');
    expect(message).toContain('--task/--detach');
    // The flags are refused, so the message must say what to run instead.
    expect(message).toMatch(/without them/);
  });

  it('has no trailing period, so the bridge\'s ". For details, run: ..." never doubles up', () => {
    expect(tasksUnsupportedByServerMessage()).not.toMatch(/\.$/);
  });

  it('is distinct from the protocol-era reason', () => {
    expect(tasksUnsupportedByServerMessage()).not.toEqual(tasksUnavailableMessage('2026-07-28'));
  });
});

describe('discoverUnavailableMessage', () => {
  // Shared by the CLI (which gates `server-discover` before sending anything) and
  // McpClient (the backstop), so both report the identical reason.
  it('names both eras and where the same information lives', () => {
    const message = discoverUnavailableMessage('2025-11-25', '@test');
    expect(message).toContain('server/discover');
    expect(message).toContain('2026-07-28');
    expect(message).toContain('2025-11-25');
    expect(message).toContain('initialize handshake');
  });

  it('points at the given session, or a placeholder when the bridge reports it', () => {
    expect(discoverUnavailableMessage('2025-11-25', '@test')).toContain('mcpc @test');
    expect(discoverUnavailableMessage('2025-11-25')).toContain('mcpc @session');
  });

  it('has no trailing period, so the bridge\'s ". For details, run: ..." never doubles up', () => {
    expect(discoverUnavailableMessage('2025-11-25', '@test')).not.toMatch(/\.$/);
    expect(discoverUnavailableMessage(undefined)).not.toMatch(/\.$/);
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
