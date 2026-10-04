/**
 * Base-vs-head statistics for scripts/perf/benchCompare.ts (a small benchstat equivalent).
 *
 * Each input value is one process run's mean (mitata `avg`) for one benchmark. Comparing
 * per-process values, not the samples inside one process, keeps JIT luck and host-load swings
 * inside the noise estimate.
 */
import assert from "node:assert/strict";

export type BenchVerdict = "faster" | "slower" | "~";

export interface BenchComparison {
  baseMedian: number;
  headMedian: number;
  /** headMedian / baseMedian - 1, in percent. */
  deltaPct: number;
  /** 95% Welch t-interval of mean(head) - mean(base), in percent of mean(base). */
  ciLowPct: number;
  ciHighPct: number;
  verdict: BenchVerdict;
}

// Two-sided 95% Student t critical values for df 1..30 (index = df - 1).
const T_CRITICAL_95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
  2.045, 2.042,
];

function tCritical95(df: number): number {
  assert(Number.isFinite(df) && df > 0, `invalid degrees of freedom: ${df}`);
  // Above df 30 keep t(30) = 2.042 instead of the normal 1.96: slightly wide, never too narrow.
  // Welch df is >= min(n) - 1 >= 1 in exact arithmetic; clamp rounding error below 1.
  const clamped = Math.min(Math.max(df, 1), T_CRITICAL_95.length);
  const lower = Math.floor(clamped);
  const upper = Math.min(lower + 1, T_CRITICAL_95.length);
  const lowerValue = T_CRITICAL_95[lower - 1];
  const upperValue = T_CRITICAL_95[upper - 1];
  return lowerValue + (upperValue - lowerValue) * (clamped - lower);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values: readonly number[]): number {
  const m = mean(values);
  return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function assertRounds(label: string, values: readonly number[]): void {
  assert(values.length >= 2, `${label}: need at least 2 rounds, got ${values.length}`);
  for (const value of values) {
    assert(Number.isFinite(value) && value > 0, `${label}: invalid value ${value}`);
  }
}

export function compareBenchRounds(
  base: readonly number[],
  head: readonly number[]
): BenchComparison {
  assertRounds("base", base);
  assertRounds("head", head);

  const baseMean = mean(base);
  const diff = mean(head) - baseMean;
  const baseTerm = sampleVariance(base) / base.length;
  const headTerm = sampleVariance(head) / head.length;
  const standardError = Math.sqrt(baseTerm + headTerm);

  let halfWidth = 0;
  if (standardError > 0) {
    // Welch-Satterthwaite degrees of freedom.
    const df =
      (baseTerm + headTerm) ** 2 /
      (baseTerm ** 2 / (base.length - 1) + headTerm ** 2 / (head.length - 1));
    halfWidth = tCritical95(df) * standardError;
  }

  const ciLowPct = ((diff - halfWidth) / baseMean) * 100;
  const ciHighPct = ((diff + halfWidth) / baseMean) * 100;
  const baseMedian = median(base);
  const headMedian = median(head);
  const verdict: BenchVerdict = ciLowPct > 0 ? "slower" : ciHighPct < 0 ? "faster" : "~";
  return {
    baseMedian,
    headMedian,
    deltaPct: (headMedian / baseMedian - 1) * 100,
    ciLowPct,
    ciHighPct,
    verdict,
  };
}
