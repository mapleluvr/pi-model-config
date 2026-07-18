/** Own-property helpers safe for arbitrary JSON keys including __proto__/constructor/prototype. */

export class OwnJsonDataError extends Error {
  constructor() {
    super("value must contain only own JSON data properties");
    this.name = "OwnJsonDataError";
  }
}

export interface CloneOwnJsonOptions {
  /** Null-prototype objects are the default for trust-boundary materialization. */
  objectPrototype?: "null" | "ordinary";
  /** Validation-only: preserve non-finite numbers so exact issue paths can be reported. */
  allowNonFiniteNumbers?: boolean;
}

function cloneOwnJsonValue(
  value: unknown,
  active: Set<object>,
  objectPrototype: "null" | "ordinary",
  allowNonFiniteNumbers: boolean,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) && !allowNonFiniteNumbers) throw new OwnJsonDataError();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new OwnJsonDataError();
  if (active.has(value)) throw new OwnJsonDataError();
  active.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as keyof typeof descriptors]!;
      if (!descriptor.enumerable) continue;
      if (typeof key === "symbol" || !("value" in descriptor)) throw new OwnJsonDataError();
    }

    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !("value" in descriptor)) throw new OwnJsonDataError();
        out.push(cloneOwnJsonValue(descriptor.value, active, objectPrototype, allowNonFiniteNumbers));
      }
      for (const key of Object.keys(descriptors)) {
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable) continue;
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || String(index) !== key || index >= value.length) {
          throw new OwnJsonDataError();
        }
      }
      return out;
    }

    const out: Record<string, unknown> = objectPrototype === "null" ? Object.create(null) : {};
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) throw new OwnJsonDataError();
      setOwnValue(out, key, cloneOwnJsonValue(descriptor.value, active, objectPrototype, allowNonFiniteNumbers));
    }
    return out;
  } finally {
    active.delete(value);
  }
}

/**
 * Clone JSON data without property reads or serialization hooks.
 * Inherited properties are ignored; enumerable accessors, cycles, sparse arrays,
 * symbols, undefined, functions, bigint, and non-finite numbers are rejected.
 */
export function cloneOwnJsonData<T>(value: T, options: CloneOwnJsonOptions = {}): T {
  return cloneOwnJsonValue(
    value,
    new Set(),
    options.objectPrototype ?? "null",
    options.allowNonFiniteNumbers ?? false,
  ) as T;
}

function renderOwnJson(value: unknown, indent: string, depth: number): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const rendered = value.map((entry) => renderOwnJson(entry, indent, depth + 1));
    if (!indent) return `[${rendered.join(",")}]`;
    const childIndent = indent.repeat(depth + 1);
    return `[\n${childIndent}${rendered.join(`,\n${childIndent}`)}\n${indent.repeat(depth)}]`;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length === 0) return "{}";
  const rendered = keys.map((key) => `${JSON.stringify(key)}:${indent ? " " : ""}${renderOwnJson(object[key], indent, depth + 1)}`);
  if (!indent) return `{${rendered.join(",")}}`;
  const childIndent = indent.repeat(depth + 1);
  return `{\n${childIndent}${rendered.join(`,\n${childIndent}`)}\n${indent.repeat(depth)}}`;
}

/** Hook-free JSON serialization for untrusted or prototype-pollutable values. */
export function stringifyOwnJsonData(value: unknown, space = 0): string {
  const normalized = cloneOwnJsonData(value);
  const indent = space > 0 ? " ".repeat(Math.min(10, Math.floor(space))) : "";
  return renderOwnJson(normalized, indent, 0);
}

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

/** Own-key-safe object bag; all writes must use setOwnValue for prototype-key safety. */
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
