import { describe, expect, test } from "bun:test";
import { armPairMedians, launchPlan, pairedRelativeDelta } from "./desktopColdStartStats";

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

  test("repeats each pair's launch order, so every arm launches `repeats` times per pair", () => {
    const order = launchPlan(2, 0, 3).map((launch) => `${launch.arm[0]}${launch.pair}`);
    expect(order.join(" ")).toBe("b0 h0 b0 h0 b0 h0 h1 b1 h1 b1 h1 b1");
  });
});

describe("armPairMedians", () => {
  test("gives each pair the median of its arm's launches, so one stray launch does not count", () => {
    const launches = [
      ...[180, 100, 102].map((markMs) => ({ arm: "base" as const, pair: 0, markMs })),
      ...[300, 104, 106].map((markMs) => ({ arm: "base" as const, pair: 1, markMs })),
      { arm: "head" as const, pair: 0, markMs: 50 },
      { arm: "base" as const, pair: null, markMs: 999 }, // warm-up
    ];
    expect(armPairMedians(launches, "base", 2)).toEqual([102, 106]);
    expect(() => armPairMedians(launches, "head", 2)).toThrow(); // pair 1 has no head launch
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

  test("20% trim: drops 4 of 20 pairs per side, winsorized sd, t(0.95, df 11) = 1.796", () => {
    // d = -10%, then 18 pairs alternating -1% / +1%, then +60%: the two strays are trimmed away.
    const head = [90, ...[...Array(18).keys()].map((i) => (i % 2 ? 101 : 99)), 160];
    const stats = pairedRelativeDelta(Array(20).fill(100), head, 0.2);
    // Winsorized at the 5th and 16th sorted d: 10 values of -1% and 10 of +1%, sd = 0.01 * sqrt(20 / 19).
    const halfWidth = 1.796 * Math.sqrt((19 * (0.01 ** 2 * 20)) / 19 / (12 * 11));
    expect([stats.n, stats.trim, stats.meanDelta]).toEqual([20, 0.2, near(0)]);
    expect([stats.halfWidth95, stats.upperBound95]).toEqual([near(halfWidth), near(halfWidth)]);
    // Untrimmed, the two strays decide the result.
    expect(pairedRelativeDelta(Array(20).fill(100), head).upperBound95).toBeGreaterThan(0.05);
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
    expect(() => pairedRelativeDelta([100, 100, 100], [100, 100, 100], -0.1)).toThrow();
  });
});
