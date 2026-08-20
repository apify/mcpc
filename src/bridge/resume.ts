/**
 * Planning for session resumption.
 *
 * Resuming means reconnecting with the `MCP-Session-Id` the server assigned earlier, which
 * makes the SDK skip version negotiation: there is no handshake to redo on a session the
 * server still holds. That is harmless in the 2025 era, but not on 2026-07-28 — there every
 * request must carry the `_meta` envelope (protocol version, client info, client
 * capabilities), and a client that never negotiated emits none while the transport still
 * stamps the restored `MCP-Protocol-Version` header. Servers reject that combination
 * ("missing the required per-request envelope key(s): _meta"), so every reconnect of a
 * modern session failed and the session stayed stuck reconnecting.
 *
 * The SDK's answer is `connect({ prior })`: hand it the `server/discover` result the
 * original connect saw and it adopts the modern era with no round trip. mcpc persists that
 * result field by field in `sessions.json`, so this module rebuilds it — and when the stored
 * state cannot support a resume (an id left behind by a server that has since gone
 * stateless, a session stored before those fields existed, or a server whose advertised
 * versions no longer overlap with ours), it abandons resumption instead of reconnecting
 * into the same rejection.
 */

import type { DiscoverResult, PriorDiscovery } from '@modelcontextprotocol/client';
import { MODERN_PROTOCOL_VERSIONS, isModernProtocolVersion } from '../core/protocol.js';
import type { SessionData } from '../lib/types.js';

/** How to reconnect to a server-side session that is still expected to be alive. */
export interface SessionResumption {
  /** The `MCP-Session-Id` to reconnect with. */
  mcpSessionId: string;
  /** Protocol version the original connect negotiated, replayed as a header on every request. */
  protocolVersion?: string;
  /** Era verdict for the SDK, so a resumed modern connection still emits the `_meta` envelope. */
  prior?: PriorDiscovery;
}

/** The outcome of {@link planResumption}. */
export interface ResumePlan {
  /** Absent when the bridge should connect from scratch and negotiate the version again. */
  resumption?: SessionResumption;
  /** Why a stored session id was not used; set only when there was one to use. */
  abandonedReason?: string;
}

/** The persisted fields the plan is derived from. */
export type ResumeSessionState = Pick<
  SessionData,
  'capabilities' | 'connectionMode' | 'instructions' | 'supportedVersions' | '_meta'
>;

/**
 * Decide how a bridge start should treat the session state persisted in `sessions.json`.
 *
 * @param options.mcpSessionId - Session id the bridge was started with, if any
 * @param options.protocolVersion - Version the resumed session negotiated, if recorded
 * @param options.session - The persisted session, source of the modern era verdict
 */
export function planResumption(options: {
  mcpSessionId?: string;
  protocolVersion?: string;
  session?: ResumeSessionState | undefined;
}): ResumePlan {
  const { mcpSessionId, protocolVersion, session } = options;

  // Nothing to resume: a fresh session, or a stateless connection that never got an id.
  if (!mcpSessionId) return {};

  // A stored id the last connection did not use — a stateless server (the 2026-07-28
  // model) with an id left over from an earlier stateful connect. Replaying it would send
  // a session header the server never issued, and worse, suppress version negotiation.
  if (session?.connectionMode === 'stateless') {
    return {
      abandonedReason: `the last connection to this server was stateless, so the stored session id is stale`,
    };
  }

  // 2025-era resume: the transport replays the negotiated version in the
  // MCP-Protocol-Version header, and no per-request envelope is expected.
  if (!protocolVersion || !isModernProtocolVersion(protocolVersion)) {
    return { resumption: { mcpSessionId, ...(protocolVersion && { protocolVersion }) } };
  }

  const capabilities = session?.capabilities;
  const supportedVersions = session?.supportedVersions;
  if (!capabilities || !supportedVersions?.length) {
    return {
      abandonedReason:
        `no stored server/discover result (capabilities + supportedVersions) to resume ` +
        `protocol ${protocolVersion} with`,
    };
  }
  if (!MODERN_PROTOCOL_VERSIONS.some((version) => supportedVersions.includes(version))) {
    return {
      abandonedReason:
        `the versions the server advertised (${supportedVersions.join(', ')}) no longer ` +
        `overlap with the modern revisions mcpc speaks (${MODERN_PROTOCOL_VERSIONS.join(', ')})`,
    };
  }

  const discover: DiscoverResult = {
    supportedVersions,
    capabilities,
    ...(session.instructions && { instructions: session.instructions }),
    ...(session._meta && { _meta: session._meta }),
  };
  return {
    resumption: { mcpSessionId, protocolVersion, prior: { kind: 'modern', discover } },
  };
}
