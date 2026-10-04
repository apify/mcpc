/**
 * Unit tests for the task type helpers in src/lib/types.ts.
 */

import { isExtensionTask } from '../../../src/lib/types.js';

describe('isExtensionTask', () => {
  const base = { taskId: 't', status: 'working' as const, createdAt: 'x', lastUpdatedAt: 'x' };

  it('recognizes the 2026-07-28 shape by ttlMs, whatever else the server attached', () => {
    expect(isExtensionTask({ ...base, ttlMs: null })).toBe(true);
    expect(isExtensionTask({ ...base, ttlMs: 1000, pollIntervalMs: 50 })).toBe(true);
    // Unknown fields pass through the extension validator, so a stray `ttl` must not
    // flip a modern task back to the legacy shape
    expect(isExtensionTask({ ...base, ttlMs: 1000, ttl: 5 })).toBe(true);
  });

  it('recognizes the 2025-11-25 core shape', () => {
    expect(isExtensionTask({ ...base, ttl: null })).toBe(false);
    expect(isExtensionTask({ ...base, ttl: 60_000, pollInterval: 500 })).toBe(false);
  });
});
