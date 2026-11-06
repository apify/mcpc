/**
 * Tests for own-property helpers used on objects keyed by external data
 */

import { getOwnProperty, setOwnProperty } from '../../../src/lib/own-property.js';

describe('setOwnProperty', () => {
  it('creates an own, enumerable "__proto__" field instead of replacing the prototype', () => {
    const target: Record<string, unknown> = {};
    setOwnProperty(target, '__proto__', { name: 'evil' });
    expect(Object.keys(target)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(target.name).toBeUndefined();
    expect(JSON.stringify(target)).toBe('{"__proto__":{"name":"evil"}}');
  });

  it('overwrites an existing field', () => {
    const target: Record<string, number> = { a: 1 };
    setOwnProperty(target, 'a', 2);
    expect(target).toEqual({ a: 2 });
  });
});

describe('getOwnProperty', () => {
  it('returns own fields, including "__proto__"', () => {
    const source = JSON.parse('{"__proto__":1,"a":2}') as Record<string, number>;
    expect(getOwnProperty(source, '__proto__')).toBe(1);
    expect(getOwnProperty(source, 'a')).toBe(2);
  });

  it('ignores names inherited from Object.prototype', () => {
    const source: Record<string, unknown> = {};
    expect(getOwnProperty(source, 'constructor')).toBeUndefined();
    expect(getOwnProperty(source, 'toString')).toBeUndefined();
    expect(getOwnProperty(source, '__proto__')).toBeUndefined();
    expect(getOwnProperty(undefined, 'a')).toBeUndefined();
  });
});
