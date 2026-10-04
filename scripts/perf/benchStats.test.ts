import { describe, expect, test } from "bun:test";
import { compareBenchRounds } from "./benchStats";

describe("compareBenchRounds", () => {
  test("a 2x slowdown is 'slower' with a CI around +100%", () => {
    const result = compareBenchRounds([100, 102, 98, 101, 99, 100], [200, 205, 195, 198, 202, 201]);
    expect(result.verdict).toBe("slower");
    expect(result.deltaPct).toBeCloseTo(100, 0);
    expect(result.ciLowPct).toBeLessThan(100);
    expect(result.ciHighPct).toBeGreaterThan(100);
  });

  test("a 2x speedup is 'faster'", () => {
    const result = compareBenchRounds([200, 205, 195, 198, 202, 201], [100, 102, 98, 101, 99, 100]);
    expect(result.verdict).toBe("faster");
    expect(result.ciHighPct).toBeLessThan(0);
  });

  test("overlapping noisy rounds are '~'", () => {
    const result = compareBenchRounds([100, 110, 95, 105, 100, 98], [102, 97, 108, 99, 104, 101]);
    expect(result.verdict).toBe("~");
    expect(result.ciLowPct).toBeLessThan(0);
    expect(result.ciHighPct).toBeGreaterThan(0);
  });

  test("two widely spread rounds per side stay '~' (small-sample t, not the normal 1.96)", () => {
    // Welch df = 2 here: t = 4.303 gives a +-55% interval around +36%, while 1.96 would call it slower.
    // Hand-computed bounds: (40 +- 4.303 * sqrt(200)) / 110 = [-18.96%, +91.69%]. They pin the
    // df -> t-table lookup, which the verdict alone does not (df = 3's 3.182 is still '~').
    const result = compareBenchRounds([100, 120], [140, 160]);
    expect(result.verdict).toBe("~");
    expect(result.ciLowPct).toBeCloseTo(-18.96, 1);
    expect(result.ciHighPct).toBeCloseTo(91.69, 1);
  });

  test("above df 30 the interval keeps t(30) = 2.042, never the narrower normal 1.96", () => {
    // 20 rounds per side, each alternating +-5 around 105 and 125: Welch df = 38.
    // Hand-computed: SE = sqrt(2 * (500 / 19) / 20) = 1.6222, so (20 +- 2.042 * SE) / 105 gives
    // [+15.89%, +22.20%]; 1.96 would give [+16.02%, +22.08%].
    const base = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 100 : 110));
    const head = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 120 : 130));
    const result = compareBenchRounds(base, head);
    expect(result.verdict).toBe("slower");
    expect(result.ciLowPct).toBeCloseTo(15.89, 2);
    expect(result.ciHighPct).toBeCloseTo(22.2, 2);
  });

  test("rejects too few rounds and non-positive or non-finite values", () => {
    expect(() => compareBenchRounds([100], [100, 101])).toThrow();
    expect(() => compareBenchRounds([100, 101], [0, 101])).toThrow();
    expect(() => compareBenchRounds([100, Number.NaN], [100, 101])).toThrow();
  });
});
