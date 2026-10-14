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

  test("pairs rounds: load drift shared by both runs of a round does not hide a +10% change", () => {
    // Each round's load scales both sides alike (base 100..1000); head is 10% slower in every round.
    // Unpaired, the between-round spread would swamp the change.
    const base = Array.from({ length: 10 }, (_, i) => 100 * (i + 1));
    const head = base.map((value) => value * 1.1);
    const result = compareBenchRounds(base, head);
    expect(result.verdict).toBe("slower");
    expect(result.deltaPct).toBeCloseTo(10, 6);
  });

  test("two rounds use the small-sample t (df 1), not the normal 1.96", () => {
    // Ratios 1.5 and 1.3. Hand-computed with t(1) = 12.706 on the log ratios:
    // exp(mean +- 12.706 * sd / sqrt(2)) - 1 = [-43.74%, +246.61%].
    const result = compareBenchRounds([100, 200], [150, 260]);
    expect(result.verdict).toBe("~");
    expect(result.ciLowPct).toBeCloseTo(-43.74, 1);
    expect(result.ciHighPct).toBeCloseTo(246.61, 1);
  });

  test("above df 30 the interval keeps t(30) = 2.042, never the narrower normal 1.96", () => {
    // 40 rounds, head/base alternating 1.1 and 1.2. Hand-computed lower bound with t(30) = 2.042:
    // +13.268%; 1.96 would give +13.333%.
    const base = Array.from({ length: 40 }, () => 100);
    const head = base.map((_, i) => (i % 2 === 0 ? 110 : 120));
    const result = compareBenchRounds(base, head);
    expect(result.verdict).toBe("slower");
    expect(result.ciLowPct).toBeCloseTo(13.268, 2);
    expect(result.ciHighPct).toBeCloseTo(16.537, 2);
  });

  test("rejects too few or unpaired rounds and non-positive or non-finite values", () => {
    expect(() => compareBenchRounds([100], [100, 101])).toThrow();
    expect(() => compareBenchRounds([100, 101, 102], [100, 101])).toThrow();
    expect(() => compareBenchRounds([100, 101], [0, 101])).toThrow();
    expect(() => compareBenchRounds([100, Number.NaN], [100, 101])).toThrow();
  });
});
