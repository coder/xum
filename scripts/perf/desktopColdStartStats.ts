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

/** Warm-ups alternate base, head; pairs then run ABBA (base-head, head-base, base-head, ...). */
export function launchPlan(pairs: number, warmupsPerArm = 2): PlannedLaunch[] {
  assert(Number.isInteger(pairs) && pairs >= 2, `pairs must be an integer >= 2, got ${pairs}`);
  assert(Number.isInteger(warmupsPerArm) && warmupsPerArm >= 0, `bad warm-ups ${warmupsPerArm}`);
  const plan: PlannedLaunch[] = [];
  for (let i = 0; i < warmupsPerArm; i++) {
    plan.push({ arm: "base", pair: null }, { arm: "head", pair: null });
  }
  for (let pair = 0; pair < pairs; pair++) {
    const order: Arm[] = pair % 2 === 0 ? ["base", "head"] : ["head", "base"];
    for (const arm of order) plan.push({ arm, pair });
  }
  return plan;
}

/** Per pair d = (head - base) / base. Fractions: 0.012 = 1.2%. */
export function pairedRelativeDelta(base: number[], head: number[]) {
  assert(base.length === head.length, `arm sizes differ: ${base.length} vs ${head.length}`);
  assert(base.length >= 2, `need at least 2 pairs, got ${base.length}`);
  const bad = [...base, ...head].find((value) => !(Number.isFinite(value) && value > 0));
  assert(bad === undefined, `invalid value ${bad}`);
  const n = base.length;
  const deltas = base.map((b, i) => (head[i] - b) / b);
  const meanDelta = deltas.reduce((sum, d) => sum + d, 0) / n;
  const sdDelta = Math.sqrt(deltas.reduce((sum, d) => sum + (d - meanDelta) ** 2, 0) / (n - 1));
  // Above df 30 keep t(30): slightly wide, never too narrow (same convention as benchStats.ts).
  const t = T_ONE_SIDED_95[Math.min(n - 1, T_ONE_SIDED_95.length) - 1];
  const halfWidth95 = (t * sdDelta) / Math.sqrt(n);
  return { n, meanDelta, sdDelta, halfWidth95, upperBound95: meanDelta + halfWidth95 };
}
