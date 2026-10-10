import { describe, expect, test } from "bun:test";
import { launchPlan, pairedRelativeDelta } from "./desktopColdStartStats";

const near = (value: number) => expect.closeTo(value, 12);

describe("launchPlan", () => {
  test("alternates warm-ups, runs pairs ABBA, and measures every pair once per arm", () => {
    const order = launchPlan(3).map((launch) => `${launch.arm}:${launch.pair}`);
    expect(order.join(" ")).toBe(
      "base:null head:null base:null head:null base:0 head:0 head:1 base:1 base:2 head:2"
    );
    // With no warm-ups, each arm visits pairs 0..19 once, in order.
    for (const arm of ["base", "head"] as const) {
      const pairs = launchPlan(20, 0).filter((launch) => launch.arm === arm);
      expect(pairs.map((launch) => launch.pair)).toEqual([...Array(20).keys()]);
    }
  });
});

describe("pairedRelativeDelta", () => {
  test("hand-computed example: mean 0, sd 0.1, one-sided t(0.95, 2) = 2.920", () => {
    const stats = pairedRelativeDelta([100, 100, 100], [110, 100, 90]);
    const halfWidth = (2.92 * 0.1) / Math.sqrt(3);
    expect([stats.n, stats.meanDelta, stats.sdDelta]).toEqual([3, near(0), near(0.1)]);
    expect([stats.halfWidth95, stats.upperBound95]).toEqual([near(halfWidth), near(halfWidth)]);
  });

  test("a slower head is positive; identical arms give zero delta and half-width", () => {
    const slower = pairedRelativeDelta([100, 200, 400], [110, 220, 440]);
    expect([slower.meanDelta, slower.upperBound95]).toEqual([near(0.1), near(0.1)]);
    const same = pairedRelativeDelta([500, 520, 480], [500, 520, 480]);
    expect([same.meanDelta, same.halfWidth95]).toEqual([0, 0]);
  });

  test("uses t = 1.729 at 20 pairs (df 19) and keeps 1.697 above df 30", () => {
    const alternating = (n: number) =>
      pairedRelativeDelta(
        Array(n).fill(100),
        [...Array(n).keys()].map((i) => (i % 2 ? 99 : 101))
      );
    // d alternates +1% / -1%, so halfWidth = t * sd / sqrt(n) = t * 0.01 / sqrt(n - 1).
    expect(alternating(20).halfWidth95).toBeCloseTo((1.729 * 0.01) / Math.sqrt(19), 12);
    expect(alternating(40).halfWidth95).toBeCloseTo((1.697 * 0.01) / Math.sqrt(39), 12);
  });

  test("rejects mismatched, short, or non-positive input", () => {
    expect(() => pairedRelativeDelta([100, 100], [100])).toThrow();
    expect(() => pairedRelativeDelta([100], [100])).toThrow();
    expect(() => pairedRelativeDelta([100, 0], [100, 100])).toThrow();
    expect(() => pairedRelativeDelta([100, 100], [100, Number.NaN])).toThrow();
  });
});
