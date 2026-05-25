/**
 * Unit tests for the on-read migration that converts the legacy `x402: boolean`
 * shape (mcpc ≤ v0.3.0) into the current `x402?: 'auto'|'upto'|'exact'` shape.
 *
 * Must be idempotent on already-migrated records and defensive against bogus
 * values hand-edited into `sessions.json`.
 */
import { describe, expect, it } from 'vitest';

import { normaliseLegacyX402 } from '../../../src/lib/sessions.js';
import type { SessionData, X402SchemePreference } from '../../../src/lib/types.js';

function baseSession(): SessionData {
  return {
    name: '@test',
    server: { url: 'https://example.test' },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('normaliseLegacyX402()', () => {
  it('migrates legacy `x402: true` to `x402: "auto"`', () => {
    const session = { ...baseSession(), x402: true as unknown as X402SchemePreference };
    normaliseLegacyX402(session);
    expect(session.x402).toBe('auto');
  });

  it('clears legacy `x402: false`', () => {
    const session = { ...baseSession(), x402: false as unknown as X402SchemePreference };
    normaliseLegacyX402(session);
    expect(session.x402).toBeUndefined();
  });

  it('is idempotent on already-migrated `x402: "upto"`', () => {
    const session = { ...baseSession(), x402: 'upto' as const };
    normaliseLegacyX402(session);
    expect(session.x402).toBe('upto');
  });

  it('drops invalid string values defensively (hand-edited sessions.json)', () => {
    const session = { ...baseSession(), x402: 'bogus' as unknown as X402SchemePreference };
    normaliseLegacyX402(session);
    expect(session.x402).toBeUndefined();
  });

  it('leaves sessions without x402 untouched', () => {
    const session = baseSession();
    normaliseLegacyX402(session);
    expect(session.x402).toBeUndefined();
  });
});
