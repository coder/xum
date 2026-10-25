/**
 * Tests for the Map comparator App.tsx passes to useStableReference to keep the
 * sidebar's workspace-by-project Map identity stable.
 */
import { compareMaps } from "./useStableReference";

describe("compareMaps", () => {
  it("returns true for empty maps", () => {
    expect(compareMaps(new Map(), new Map())).toBe(true);
  });

  it("returns true for maps with same entries", () => {
    const prev = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    const next = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    expect(compareMaps(prev, next)).toBe(true);
  });

  it("returns false for maps with different sizes", () => {
    const prev = new Map([["a", 1]]);
    const next = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    expect(compareMaps(prev, next)).toBe(false);
  });

  it("returns false for maps with different keys", () => {
    const prev = new Map([["a", 1]]);
    const next = new Map([["b", 1]]);
    expect(compareMaps(prev, next)).toBe(false);
  });

  it("returns false for maps with different values", () => {
    const prev = new Map([["a", 1]]);
    const next = new Map([["a", 2]]);
    expect(compareMaps(prev, next)).toBe(false);
  });

  it("supports custom value equality function", () => {
    const prev = new Map([["a", { id: 1 }]]);
    const next = new Map([["a", { id: 1 }]]);

    // Default comparison (reference equality) returns false
    expect(compareMaps(prev, next)).toBe(false);

    // Custom comparison (by id) returns true
    expect(compareMaps(prev, next, (a, b) => a.id === b.id)).toBe(true);
  });
});
