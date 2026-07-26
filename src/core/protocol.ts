/**
 * MCP protocol version constants and helpers.
 *
 * Deliberately dependency-free: the CLI imports this module on every invocation
 * (for `--mcp-version` validation and help text), so it must not pull in the MCP
 * SDK. The legacy list mirrors the SDK's `SUPPORTED_PROTOCOL_VERSIONS` (the
 * versions its `initialize` handshake can offer/accept) and the modern list
 * mirrors its internal `SUPPORTED_MODERN_PROTOCOL_VERSIONS`; a unit test guards
 * against drift on SDK upgrades.
 */

/** Modern-era protocol revisions (2026-07-28 and later), newest first. */
export const MODERN_MCP_VERSIONS: readonly string[] = ['2026-07-28'];

/** Legacy-era protocol revisions negotiated via the `initialize` handshake, newest first. */
export const LEGACY_MCP_VERSIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];

/** All protocol revisions mcpc can pin via `--mcp-version`, newest first. */
export const SUPPORTED_MCP_VERSIONS: readonly string[] = [
  ...MODERN_MCP_VERSIONS,
  ...LEGACY_MCP_VERSIONS,
];

/** Whether a protocol revision belongs to the modern (2026-07-28+) era. */
export function isModernMcpVersion(version: string): boolean {
  return MODERN_MCP_VERSIONS.includes(version);
}

/** Whether a protocol revision can be pinned via `--mcp-version`. */
export function isSupportedMcpVersion(version: string): boolean {
  return SUPPORTED_MCP_VERSIONS.includes(version);
}
