/**
 * Own-property access for objects keyed by external data (server responses, config
 * files, CLI input).
 *
 * A plain `obj[key] = value` with the key `__proto__` replaces the object's prototype
 * instead of creating a field, so the entry vanishes from `Object.keys` while its
 * contents stay readable through the prototype. A plain `obj[key]` read with a key like
 * `constructor` or `toString` returns what `Object.prototype` inherits. Both make the
 * object say something other than what the data said; these helpers never consult the
 * prototype chain.
 *
 * Dependency-free on purpose, so any module can use it.
 */

/**
 * Set an own, enumerable property, even for the key `__proto__`
 */
export function setOwnProperty<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Read an own property, ignoring anything inherited from the prototype chain
 */
export function getOwnProperty<T>(
  source: Record<string, T> | undefined,
  key: string
): T | undefined {
  return source !== undefined && Object.hasOwn(source, key) ? source[key] : undefined;
}
