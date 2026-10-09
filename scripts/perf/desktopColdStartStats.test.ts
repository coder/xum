import { describe, expect, test } from "bun:test";
import { launchPlan, pairedRelativeDelta } from "./desktopColdStartStats";

describe("launchPlan", () => {
  test("alternates warm-ups, then runs pairs in ABBA order", () => {
    expect(launchPlan(3)).toEqual([
      { arm: "base", pair: null },
      { arm: "head", pair: null },
      { arm: "base", pair: null },
      { arm: "head", pair: null },
      { arm: "base", pair: 0 },
      { arm: "head", pair: 0 },
      { arm: "head", pair: 1 },
      { arm: "base", pair: 1 },
      { arm: "base", pair: 2 },
      { arm: "head", pair: 2 },
    ]);
  });

  test("measures every pair once per arm and honors the warm-up count", () => {
    const plan = launchPlan(20, 0);
    expect(plan).toHaveLength(40);
    for (const arm of ["base", "head"] as const) {
      const pairs = plan.filter((launch) => launch.arm === arm).map((launch) => launch.pair);
      expect(pairs).toEqual(Array.from({ length: 20 }, (_, i) => i));
    }
    expect(launchPlan(20).filter((launch) => launch.pair === null)).toHaveLength(4);
  });

  test("rejects invalid counts", () => {
    expect(() => launchPlan(1)).toThrow();
    expect(() => launchPlan(2.5)).toThrow();
    expect(() => launchPlan(4, -1)).toThrow();
  });
});

describe("pairedRelativeDelta", () => {
  test("hand-computed example: mean 0, sd 0.1, one-sided t(0.95, 2) = 2.920", () => {
    const stats = pairedRelativeDelta([100, 100, 100], [110, 100, 90]);
    expect(stats.n).toBe(3);
    expect(stats.meanDelta).toBeCloseTo(0, 12);
    expect(stats.sdDelta).toBeCloseTo(0.1, 12);
    expect(stats.halfWidth95).toBeCloseTo((2.92 * 0.1) / Math.sqrt(3), 12);
    expect(stats.upperBound95).toBeCloseTo(stats.halfWidth95, 12);
  });

  test("a consistent +10% head has mean 0.1 and zero spread", () => {
    const stats = pairedRelativeDelta([100, 200, 400], [110, 220, 440]);
    expect(stats.meanDelta).toBeCloseTo(0.1, 12);
    expect(stats.sdDelta).toBeCloseTo(0, 12);
    expect(stats.upperBound95).toBeCloseTo(0.1, 12);
  });

  test("identical arms give zero delta and zero half-width", () => {
    const stats = pairedRelativeDelta([500, 520, 480], [500, 520, 480]);
    expect(stats.meanDelta).toBe(0);
    expect(stats.halfWidth95).toBe(0);
  });

  test("uses t = 1.729 at 20 pairs (df 19) and keeps 1.697 above df 30", () => {
    for (const [n, t] of [
      [20, 1.729],
      [40, 1.697],
    ] as const) {
      const base = Array.from({ length: n }, () => 100);
      const head = base.map((_, i) => (i % 2 === 0 ? 101 : 99));
      const sd = 0.01 * Math.sqrt(n / (n - 1));
      const stats = pairedRelativeDelta(base, head);
      expect(stats.sdDelta).toBeCloseTo(sd, 12);
      expect(stats.halfWidth95).toBeCloseTo((t * sd) / Math.sqrt(n), 12);
    }
  });

  test("rejects mismatched, short, or non-positive input", () => {
    expect(() => pairedRelativeDelta([100, 100], [100])).toThrow();
    expect(() => pairedRelativeDelta([100], [100])).toThrow();
    expect(() => pairedRelativeDelta([100, 0], [100, 100])).toThrow();
    expect(() => pairedRelativeDelta([100, 100], [100, Number.NaN])).toThrow();
  });
});
