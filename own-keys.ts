/** Own-property helpers safe for arbitrary JSON keys including __proto__/constructor/prototype. */

export function hasOwnKey(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function getOwnValue<T>(object: Record<string, T> | object, key: string): T | undefined {
  if (!hasOwnKey(object, key)) return undefined;
  return (object as Record<string, T>)[key];
}

export function setOwnValue<T>(object: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(object, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

export function deleteOwnKey(object: object, key: string): boolean {
  if (!hasOwnKey(object, key)) return false;
  return delete (object as Record<string, unknown>)[key];
}

/** Plain object bag; all writes must use setOwnValue for prototype-key safety. */
export function emptyOwnMap<T>(): Record<string, T> {
  return {} as Record<string, T>;
}

export function ownKeys(object: object): string[] {
  return Object.keys(object);
}

export function cloneOwnMap<T>(source: Record<string, T>): Record<string, T> {
  const next = emptyOwnMap<T>();
  for (const key of ownKeys(source)) {
    if (!hasOwnKey(source, key)) continue;
    setOwnValue(next, key, source[key]!);
  }
  return next;
}
