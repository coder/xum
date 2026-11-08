import { describe, expect, it } from "bun:test";
import { rememberLogKey } from "./logDedupe";

describe("rememberLogKey", () => {
  it("is true once per key and keeps only the newest keys past its cap", () => {
    const seen = new Set<string>();
    expect(rememberLogKey(seen, "a", 2)).toBe(true);
    expect(rememberLogKey(seen, "a", 2)).toBe(false);
    for (const key of ["b", "c", "d"]) expect(rememberLogKey(seen, key, 2)).toBe(true);
    expect([...seen]).toEqual(["c", "d"]);
    expect(rememberLogKey(seen, "d", 2)).toBe(false);
    expect(rememberLogKey(seen, "a", 2)).toBe(true);
  });
});
