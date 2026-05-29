/**
 * Tests for sessions command helpers
 */

import { formatTimeAgo } from '../../../src/cli/commands/sessions.js';

describe('formatTimeAgo', () => {
  const NOW = new Date('2026-06-01T12:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function isoSecondsAgo(seconds: number): string {
    return new Date(NOW.getTime() - seconds * 1000).toISOString();
  }

  function isoDaysAgo(days: number): string {
    return isoSecondsAgo(days * 24 * 60 * 60);
  }

  it('returns empty string for undefined input', () => {
    expect(formatTimeAgo(undefined)).toBe('');
  });

  it('returns "just now" for under 60 seconds', () => {
    expect(formatTimeAgo(isoSecondsAgo(0))).toBe('just now');
    expect(formatTimeAgo(isoSecondsAgo(30))).toBe('just now');
    expect(formatTimeAgo(isoSecondsAgo(59))).toBe('just now');
  });

  it('returns minutes for under 1 hour', () => {
    expect(formatTimeAgo(isoSecondsAgo(60))).toBe('1m ago');
    expect(formatTimeAgo(isoSecondsAgo(5 * 60))).toBe('5m ago');
    expect(formatTimeAgo(isoSecondsAgo(59 * 60))).toBe('59m ago');
  });

  it('returns hours for under 1 day', () => {
    expect(formatTimeAgo(isoSecondsAgo(60 * 60))).toBe('1h ago');
    expect(formatTimeAgo(isoSecondsAgo(3 * 60 * 60))).toBe('3h ago');
    expect(formatTimeAgo(isoSecondsAgo(23 * 60 * 60))).toBe('23h ago');
  });

  it('returns "yesterday" for exactly 1 day ago', () => {
    expect(formatTimeAgo(isoDaysAgo(1))).toBe('yesterday');
  });

  it('returns days for 2-6 days ago', () => {
    expect(formatTimeAgo(isoDaysAgo(2))).toBe('2 days ago');
    expect(formatTimeAgo(isoDaysAgo(6))).toBe('6 days ago');
  });

  it('uses singular "week" for 1 week (7-13 days)', () => {
    expect(formatTimeAgo(isoDaysAgo(7))).toBe('1 week ago');
    expect(formatTimeAgo(isoDaysAgo(13))).toBe('1 week ago');
  });

  it('uses plural "weeks" for 2+ weeks', () => {
    expect(formatTimeAgo(isoDaysAgo(14))).toBe('2 weeks ago');
    expect(formatTimeAgo(isoDaysAgo(21))).toBe('3 weeks ago');
    expect(formatTimeAgo(isoDaysAgo(29))).toBe('4 weeks ago');
  });

  it('uses singular "month" for 1 month (30-59 days)', () => {
    expect(formatTimeAgo(isoDaysAgo(30))).toBe('1 month ago');
    expect(formatTimeAgo(isoDaysAgo(59))).toBe('1 month ago');
  });

  it('uses plural "months" for 2+ months', () => {
    expect(formatTimeAgo(isoDaysAgo(60))).toBe('2 months ago');
    expect(formatTimeAgo(isoDaysAgo(90))).toBe('3 months ago');
    expect(formatTimeAgo(isoDaysAgo(365))).toBe('12 months ago');
  });
});
