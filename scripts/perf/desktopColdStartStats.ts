/** Pure helpers for scripts/perf/desktopColdStart.ts (T3 #5971, desktop protocol D2). */
import assert from "node:assert/strict";

export type Arm = "base" | "head";
export interface PlannedLaunch {
  arm: Arm;
  pair: number | null; // null = warm-up
}

// One-sided 95% (= two-sided 90%) Student t critical values for df 1..30 (index = df - 1).
// benchStats.ts holds the two-sided 95% table, which is the wrong quantile for an upper bound.
const T_ONE_SIDED_95 = [
  6.314, 2.92, 2.353, 2.132, 2.015, 1.943, 1.895, 1.86, 1.833, 1.812, 1.796, 1.782, 1.771, 1.761,
  1.753, 1.746, 1.74, 1.734, 1.729, 1.725, 1.721, 1.717, 1.714, 1.711, 1.708, 1.706, 1.703, 1.701,
  1.699, 1.697,
];

/**
 * Warm-ups alternate base, head; pairs then run ABBA (base-head, head-base, base-head, ...), and
 * each pair runs its order `repeats` times (base-head-base-head-... for an even pair).
 */
export function launchPlan(pairs: number, warmupsPerArm = 2, repeats = 1): PlannedLaunch[] {
  assert(Number.isInteger(pairs) && pairs >= 2, `pairs must be an integer >= 2, got ${pairs}`);
  assert(Number.isInteger(warmupsPerArm) && warmupsPerArm >= 0, `bad warm-ups ${warmupsPerArm}`);
  assert(Number.isInteger(repeats) && repeats >= 1, `bad repeats ${repeats}`);
  const plan: PlannedLaunch[] = [];
  for (let i = 0; i < warmupsPerArm; i++) {
    plan.push({ arm: "base", pair: null }, { arm: "head", pair: null });
  }
  for (let pair = 0; pair < pairs; pair++) {
    const order: Arm[] = pair % 2 === 0 ? ["base", "head"] : ["head", "base"];
    for (let r = 0; r < repeats; r++) for (const arm of order) plan.push({ arm, pair });
  }
  return plan;
}

export function median(values: number[]): number {
  assert(values.length > 0, "median of no values");
  const s = [...values].sort((a, b) => a - b);
  return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2; // odd length: the same index twice
}

/** One value per pair for `arm`: the median of its measured launches in that pair. */
export function armPairMedians(
  launches: Array<{ arm: Arm; pair: number | null; markMs: number }>,
  arm: Arm,
  pairs: number
): number[] {
  return [...Array(pairs).keys()].map((pair) =>
    median(launches.filter((l) => l.arm === arm && l.pair === pair).map((l) => l.markMs))
  );
}

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/**
 * Per pair d = (head - base) / base. Fractions: 0.012 = 1.2%. With `trim` > 0, meanDelta is the
 * trimmed mean of d: g = floor(trim * n) values are dropped from each end. Its interval is Yuen's
 * (Tukey-McLaughlin): sdDelta is the sd of d winsorized at the same g, se = sqrt((n - 1) sd^2 /
 * (h (h - 1))) with h = n - 2g kept values, and df = h - 1. trim 0 is the paired t interval.
 */
export function pairedRelativeDelta(base: number[], head: number[], trim = 0) {
  assert(base.length === head.length, `arm sizes differ: ${base.length} vs ${head.length}`);
  assert(trim >= 0 && trim < 0.5, `trim must be in [0, 0.5), got ${trim}`);
  const n = base.length;
  const g = Math.floor(trim * n);
  const h = n - 2 * g;
  assert(h >= 2, `need at least 2 pairs after trimming, got ${n} pairs`);
  const bad = [...base, ...head].find((value) => !(Number.isFinite(value) && value > 0));
  assert(bad === undefined, `invalid value ${bad}`);
  const sorted = base.map((b, i) => (head[i] - b) / b).sort((a, b) => a - b);
  const meanDelta = mean(sorted.slice(g, n - g));
  const winsorized = sorted.map((d) => Math.min(Math.max(d, sorted[g]), sorted[n - g - 1]));
  const wMean = mean(winsorized);
  const sdDelta = Math.sqrt(winsorized.reduce((sum, d) => sum + (d - wMean) ** 2, 0) / (n - 1));
  // Above df 30 keep t(30): slightly wide, never too narrow (same convention as benchStats.ts).
  const t = T_ONE_SIDED_95[Math.min(h - 1, T_ONE_SIDED_95.length) - 1];
  const halfWidth95 = t * Math.sqrt(((n - 1) * sdDelta ** 2) / (h * (h - 1)));
  return { n, trim, meanDelta, sdDelta, halfWidth95, upperBound95: meanDelta + halfWidth95 };
}
