import { describe, expect, test } from "bun:test";
import { BoundedRing } from "./boundedRing";

describe("BoundedRing", () => {
  test("keeps only the newest entries at capacity", () => {
    const ring = new BoundedRing<number>(3, 10_000);
    for (let i = 1; i <= 5; i++) ring.push(i, i);
    expect(ring.values(5)).toEqual([3, 4, 5]);
  });

  test("forgets entries older than the max age, on push and on read", () => {
    const ring = new BoundedRing<string>(10, 100);
    ring.push("a", 0);
    ring.push("b", 50);
    ring.push("c", 120);
    expect(ring.values(120)).toEqual(["b", "c"]);
    expect(ring.values(151)).toEqual(["c"]);
    expect(ring.values(1_000)).toEqual([]);
  });
});
