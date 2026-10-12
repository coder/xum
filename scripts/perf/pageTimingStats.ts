/**
 * Pure statistics for the page-timing harness (T3 #5971, plan section 2.6): useful content shown (UCS) and
 * interaction ready (IR) on paired base/head runs. Values are seconds, and d = head - base per pair.
 */
import assert from "node:assert/strict";

export { launchPlan } from "./desktopColdStartStats"; // ABBA pair order, shared with the D2 harness

export type Signal = "ucs" | "ir";
/** "needs-confirmation": the first A/A block failed, so one confirmatory block runs before any gate. */
export type Qualification = "qualified" | "needs-confirmation" | "inconclusive";

export const BLOCK_PAIRS = 8;
export const NO_REGRESSION_LIMIT: Record<Signal, number> = { ucs: 0.25, ir: 0.3 };
// Some runs wait one or two extra throttled round trips (0.56-1.16 s), so every rule tolerates outlier pairs:
// medians, and for UCS at most 3 of 8 pairs beyond 0.25 s. IR moves in round-trip steps: a wider median.
const QUALIFY_MEDIAN_LIMIT: Record<Signal, number> = { ucs: 0.1, ir: 0.3 };

function assertBlock(d: number[]) {
  assert(
    d.length === BLOCK_PAIRS && d.every(Number.isFinite),
    `need ${BLOCK_PAIRS} finite pairs: ${d}`
  );
}

export function median(values: number[]): number {
  assert(values.length > 0, "median of nothing");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** k-th largest value, 1-based: kthLargest(d, 2) of an 8-pair block is d(7). */
export function kthLargest(values: number[], k: number): number {
  assert(Number.isInteger(k) && k >= 1 && k <= values.length, `k=${k} for ${values.length} values`);
  return [...values].sort((a, b) => b - a)[k - 1];
}

/** One signal of one A/A block. An A/A has no expected sign, so the checks use |d|. */
export function signalQualifies(signal: Signal, d: number[]): boolean {
  assertBlock(d);
  if (Math.abs(median(d)) > QUALIFY_MEDIAN_LIMIT[signal]) return false;
  return signal === "ir" || kthLargest(d.map(Math.abs), 4) <= 0.25;
}

/** A page's A/A blocks in run order: the first block, then one confirmatory block if the first failed. */
export function qualifyPage(blocks: Array<Record<Signal, number[]>>): Qualification {
  assert(blocks.length === 1 || blocks.length === 2, `1 or 2 A/A blocks, got ${blocks.length}`);
  const ok = blocks.map((b) => signalQualifies("ucs", b.ucs) && signalQualifies("ir", b.ir));
  assert(
    !(ok[0] && blocks.length === 2),
    "a confirmatory block runs only after a failed first block"
  );
  if (ok[0]) return "qualified";
  if (blocks.length === 1) return "needs-confirmation";
  return ok[1] ? "qualified" : "inconclusive";
}

/** `count` blocks of BLOCK_PAIRS differences drawn with replacement, from a seeded generator (mulberry32). */
export function bootstrapBlocks(aa: number[], count: number, seed: number): number[][] {
  assert(
    aa.length >= BLOCK_PAIRS && aa.every(Number.isFinite),
    `need >= ${BLOCK_PAIRS} finite A/A pairs`
  );
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, () =>
    Array.from({ length: BLOCK_PAIRS }, () => aa[Math.floor(random() * aa.length)])
  );
}

/** Minimum detectable improvement (MDI): 2 x the 95th percentile of d(7) across bootstrap A/A blocks. */
export function minimumDetectableImprovement(aa: number[], count = 20_000, seed = 1): number {
  const d7 = bootstrapBlocks(aa, count, seed).map((b) => kthLargest(b, 2));
  d7.sort((a, b) => a - b);
  return Math.max(0, 2 * d7[Math.floor(0.95 * (count - 1))]);
}

/**
 * Gate one signal of one page. A predicted saving (seconds, > 0) at or above the host's MDI gets the
 * improvement rule: d(7) <= -saving / 2, a one-sided 96.5% bound on the median (sign test, 1 - 9/256).
 * A smaller or no prediction gates on no-regression only, and the PR reports the measured change.
 */
export function gate(input: {
  qualification: Qualification;
  signal: Signal;
  d: number[];
  mdi: number;
  predictedSaving?: number | null;
}) {
  assert(input.qualification !== "needs-confirmation", "run the confirmatory A/A block first");
  if (input.qualification === "inconclusive")
    return { verdict: "inconclusive", rule: null } as const;
  assertBlock(input.d);
  const saving = input.predictedSaving;
  assert(
    input.mdi >= 0 && (saving == null || saving > 0),
    `bad MDI ${input.mdi} or saving ${saving}`
  );
  if (saving != null && saving >= input.mdi) {
    const d7 = kthLargest(input.d, 2);
    return {
      verdict: d7 <= -saving / 2 ? "pass" : "fail",
      rule: "improvement",
      statistic: d7,
    } as const;
  }
  const m = median(input.d);
  const verdict = m <= NO_REGRESSION_LIMIT[input.signal] ? "pass" : "fail";
  return { verdict, rule: "no-regression", statistic: m } as const;
}
