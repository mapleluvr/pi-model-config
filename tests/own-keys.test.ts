import assert from "node:assert/strict";
import test from "node:test";

import {
  cloneOwnJsonData,
  OwnJsonDataError,
  stringifyOwnJsonData,
} from "../own-keys.ts";

test("own JSON materialization ignores inherited and global serialization hooks", () => {
  let hookCalls = 0;
  const source = Object.assign(Object.create({
    inherited: "ignored",
    toJSON() {
      hookCalls += 1;
      return { authorized: true };
    },
  }), {
    nested: { keep: true },
  });
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  try {
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value() {
        hookCalls += 1;
        return { authorized: true };
      },
    });
    const clone = cloneOwnJsonData(source);
    assert.equal(Object.getPrototypeOf(clone), null);
    assert.equal(Object.getPrototypeOf(clone.nested), null);
    assert.equal(Object.hasOwn(clone, "inherited"), false);
    assert.deepEqual(Object.keys(clone), ["nested"]);
    assert.equal(stringifyOwnJsonData(source), '{"nested":{"keep":true}}');
    assert.equal(hookCalls, 0);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, "toJSON", previous);
    else delete (Object.prototype as Record<string, unknown>).toJSON;
  }
});

test("own JSON materialization never reads accessors and rejects non-JSON structures", () => {
  let getterCalls = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "secret", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "not-read";
    },
  });
  assert.throws(() => cloneOwnJsonData(accessor), OwnJsonDataError);
  assert.equal(getterCalls, 0);

  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse = new Array(2);
  sparse[1] = "present";
  for (const value of [
    cycle,
    { invalid: undefined },
    { invalid: () => true },
    { invalid: 1n },
    { invalid: Number.NaN },
    { invalid: Number.POSITIVE_INFINITY },
    sparse,
  ]) {
    assert.throws(() => cloneOwnJsonData(value), OwnJsonDataError);
  }
});

test("own JSON serialization preserves arbitrary own keys without prototype assignment", () => {
  const source = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(source, "__proto__", {
    value: { constructor: "kept" },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const clone = cloneOwnJsonData(source);
  assert.equal(Object.hasOwn(clone, "__proto__"), true);
  assert.equal((clone.__proto__ as Record<string, unknown>).constructor, "kept");
  assert.equal(stringifyOwnJsonData(source), '{"__proto__":{"constructor":"kept"}}');
});
