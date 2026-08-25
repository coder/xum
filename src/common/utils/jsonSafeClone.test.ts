import { describe, it, expect } from "bun:test";
import { jsonSafeClone } from "./jsonSafeClone";

describe("jsonSafeClone", () => {
  it("passes JSON-safe values through structurally unchanged", () => {
    const value = { a: 1, b: "x", c: [true, null, { d: 2 }] };
    expect(jsonSafeClone(value)).toEqual(value);
  });

  it("normalizes undefined like JSON serialization does", () => {
    expect(jsonSafeClone({ a: undefined, b: 1 })).toEqual({ b: 1 });
    expect(jsonSafeClone([undefined, 1, undefined])).toEqual([null, 1, null]);
    expect(jsonSafeClone(undefined)).toBeUndefined();
  });

  it("normalizes functions and non-finite numbers like JSON serialization does", () => {
    expect(jsonSafeClone({ fn: () => 1, n: NaN, i: Infinity, ok: 2 })).toEqual({
      n: null,
      i: null,
      ok: 2,
    });
    expect(jsonSafeClone([() => 1])).toEqual([null]);
  });

  it("honors toJSON", () => {
    const date = new Date("2026-01-02T03:04:05.000Z");
    expect(jsonSafeClone({ date })).toEqual({ date: "2026-01-02T03:04:05.000Z" });
  });

  it("converts BigInt to a decimal string instead of throwing", () => {
    expect(jsonSafeClone({ big: 123n, keep: [1n] })).toEqual({ big: "123", keep: ["1"] });
  });

  it("replaces circular references instead of throwing", () => {
    const cyclic: { self?: unknown; ok: number } = { ok: 1 };
    cyclic.self = cyclic;
    expect(jsonSafeClone(cyclic)).toEqual({ ok: 1, self: "[Circular]" });
  });

  it("preserves shared non-cyclic references in the fallback path", () => {
    const shared = { v: 1 };
    // BigInt forces the manual scrub; the DAG must not be treated as a cycle.
    const value = { a: shared, b: shared, big: 1n };
    expect(jsonSafeClone(value)).toEqual({ a: { v: 1 }, b: { v: 1 }, big: "1" });
  });

  it("drops properties whose getters throw, keeping the rest", () => {
    const value: Record<string, unknown> = { ok: 1 };
    Object.defineProperty(value, "bad", {
      enumerable: true,
      get() {
        throw new Error("getter boom");
      },
    });
    expect(jsonSafeClone(value)).toEqual({ ok: 1 });
  });

  it("produces output that is stable under a JSON round-trip", () => {
    const messy = {
      arr: [undefined, NaN, { nested: undefined, big: 7n }],
      fn: () => 1,
    };
    const cloned = jsonSafeClone(messy);
    expect(JSON.parse(JSON.stringify(cloned))).toEqual(cloned);
  });
});
