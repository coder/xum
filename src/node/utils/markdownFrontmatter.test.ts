import { describe, expect, test } from "bun:test";

import { cutToCap } from "./markdownFrontmatter";

describe("cutToCap", () => {
  test("keeps text up to the cap and cuts what is over it", () => {
    expect(cutToCap("a".repeat(9), 10)).toBe("a".repeat(9));
    expect(cutToCap("a".repeat(10), 10)).toBe("a".repeat(10));
    expect(cutToCap("a".repeat(11), 10)).toBe("a".repeat(10));
  });

  test("returns text that is within the cap as it is, even when it ends on a lone first half", () => {
    const text = `${"a".repeat(9)}\uD83D`;
    expect(cutToCap(text, 10)).toBe(text);
  });

  test("drops the first half of a surrogate pair that the cut would end on", () => {
    // The emoji is two UTF-16 units, so a cap of 10 falls between them.
    expect(cutToCap(`${"a".repeat(9)}😀`, 10)).toBe("a".repeat(9));
  });

  test("keeps a surrogate pair that ends at the cap", () => {
    expect(cutToCap(`${"a".repeat(8)}😀b`, 10)).toBe(`${"a".repeat(8)}😀`);
  });
});
