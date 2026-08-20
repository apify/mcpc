/**
 * Unit tests for session-resumption planning.
 *
 * Resuming skips version negotiation, so the plan is what keeps a 2026-07-28 connection
 * honest: without the era verdict rebuilt here, the SDK sends requests with no `_meta`
 * envelope while the transport stamps the modern protocol-version header, and the server
 * rejects every one of them (#374).
 */

import { describe, it, expect } from 'vitest';
import { planResumption } from '../../../src/bridge/resume.js';

const MODERN_SESSION = {
  capabilities: { tools: { listChanged: true } },
  supportedVersions: ['2026-07-28', '2025-11-25'],
  instructions: 'Be nice',
  _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'srv', version: '1.0.0' } },
};

describe('planResumption', () => {
  it('does not resume without a stored session id', () => {
    expect(planResumption({ protocolVersion: '2026-07-28', session: MODERN_SESSION })).toEqual({});
  });

  it('resumes a 2025-era session with just the session id and version', () => {
    // The transport replays the version in a header; no request envelope is expected.
    expect(
      planResumption({ mcpSessionId: 'sess-1', protocolVersion: '2025-11-25', session: {} })
    ).toEqual({ resumption: { mcpSessionId: 'sess-1', protocolVersion: '2025-11-25' } });
  });

  it('resumes a session whose version was never recorded', () => {
    expect(planResumption({ mcpSessionId: 'sess-1', session: {} })).toEqual({
      resumption: { mcpSessionId: 'sess-1' },
    });
  });

  it('abandons a session id left over from a stateless connection', () => {
    // How the bug reached users: a stateful 2025-era connect stored an id, the server
    // upgraded to stateless 2026-07-28, and the leftover id kept suppressing negotiation.
    const plan = planResumption({
      mcpSessionId: 'sess-1',
      protocolVersion: '2026-07-28',
      session: { ...MODERN_SESSION, connectionMode: 'stateless' },
    });

    expect(plan.resumption).toBeUndefined();
    expect(plan.abandonedReason).toContain('stateless');
  });

  it('rebuilds the discover result as the era verdict for a modern session', () => {
    const plan = planResumption({
      mcpSessionId: 'sess-1',
      protocolVersion: '2026-07-28',
      session: MODERN_SESSION,
    });

    expect(plan.abandonedReason).toBeUndefined();
    expect(plan.resumption).toEqual({
      mcpSessionId: 'sess-1',
      protocolVersion: '2026-07-28',
      prior: {
        kind: 'modern',
        discover: {
          supportedVersions: ['2026-07-28', '2025-11-25'],
          capabilities: { tools: { listChanged: true } },
          instructions: 'Be nice',
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'srv', version: '1.0.0' } },
        },
      },
    });
  });

  it('abandons a modern resume when no discover result was persisted', () => {
    // Sessions stored by older mcpc versions, or a truncated sessions.json.
    const plan = planResumption({
      mcpSessionId: 'sess-1',
      protocolVersion: '2026-07-28',
      session: { capabilities: { tools: {} } },
    });

    expect(plan.resumption).toBeUndefined();
    expect(plan.abandonedReason).toContain('no stored server/discover result');
  });

  it('abandons a modern resume when the advertised versions no longer overlap', () => {
    const plan = planResumption({
      mcpSessionId: 'sess-1',
      protocolVersion: '2026-07-28',
      session: { capabilities: {}, supportedVersions: ['2027-01-01'] },
    });

    expect(plan.resumption).toBeUndefined();
    expect(plan.abandonedReason).toContain('no longer overlap');
  });

  it('does not report an abandoned resume when there was nothing to resume', () => {
    expect(planResumption({}).abandonedReason).toBeUndefined();
  });
});
