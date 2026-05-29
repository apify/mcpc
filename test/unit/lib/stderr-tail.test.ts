/**
 * Unit tests for StderrTail
 */

import { StderrTail } from '../../../src/lib/stderr-tail';

describe('StderrTail', () => {
  it('starts empty', () => {
    const tail = new StderrTail();
    expect(tail.count).toBe(0);
    expect(tail.format()).toBe('');
  });

  it('stores and counts non-empty lines', () => {
    const tail = new StderrTail();
    expect(tail.add('hello')).toBe('hello');
    expect(tail.add('world')).toBe('world');
    expect(tail.count).toBe(2);
    expect(tail.format()).toBe('  hello\n  world');
  });

  it('drops empty lines and reports null', () => {
    const tail = new StderrTail();
    expect(tail.add('')).toBeNull();
    expect(tail.count).toBe(0);
    tail.add('keep');
    expect(tail.add('')).toBeNull();
    expect(tail.count).toBe(1);
  });

  it('truncates a single huge line and returns the stored form', () => {
    const tail = new StderrTail();
    const huge = 'x'.repeat(20_000);
    const stored = tail.add(huge);
    expect(stored).not.toBeNull();
    expect(stored!.length).toBeLessThanOrEqual(8_001); // 8000 + ellipsis
    expect(stored!.endsWith('…')).toBe(true);
    expect(tail.count).toBe(1);
  });

  it('caps the buffer at 50 lines (evicts the oldest)', () => {
    const tail = new StderrTail();
    for (let i = 0; i < 60; i++) tail.add(`line-${i}`);
    expect(tail.count).toBe(50);
    const lines = tail.format().split('\n');
    expect(lines[0]).toBe('  line-10');
    expect(lines[lines.length - 1]).toBe('  line-59');
  });

  it('evicts to stay near the 8000-char cap when lines are large', () => {
    const tail = new StderrTail();
    const big = 'x'.repeat(2_000);
    for (let i = 0; i < 10; i++) tail.add(big);
    // 10 * 2001 (line + newline) = 20010 chars; eviction keeps things bounded
    expect(tail.count).toBeLessThan(10);
    expect(tail.count).toBeGreaterThanOrEqual(1);
  });

  it('keeps at least one line even when it exceeds the char cap', () => {
    // The cap shouldn't drop the only line — that would defeat the purpose of
    // surfacing a single useful (truncated) error message.
    const tail = new StderrTail();
    tail.add('x'.repeat(20_000));
    expect(tail.count).toBe(1);
  });
});
