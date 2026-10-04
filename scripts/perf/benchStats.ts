/**
 * Base-vs-head statistics for scripts/perf/benchCompare.ts (a small benchstat equivalent).
 *
 * Each input value is one process run's mean (mitata `avg`) for one benchmark, and index i of base
 * and head comes from the same interleaved round. Comparing per-process values, not the samples
 * inside one process, keeps JIT luck inside the noise estimate. Pairing the two runs of a round
 * (a paired t-interval on log(head / base)) cancels host-load drift that hits both runs alike;
 * treating the sides as independent would let that drift hide a consistent change.
 */
import assert from "node:assert/strict";

export type BenchVerdict = "faster" | "slower" | "~";

export interface BenchComparison {
  baseMedian: number;
  headMedian: number;
  /** Geometric mean of the per-round head / base ratios, minus 1, in percent. */
  deltaPct: number;
  /** 95% paired t-interval of that ratio, minus 1, in percent. */
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
  assert(Number.isInteger(df) && df >= 1, `invalid degrees of freedom: ${df}`);
  // Above df 30 keep t(30) = 2.042 instead of the normal 1.96: slightly wide, never too narrow.
  return T_CRITICAL_95[Math.min(df, T_CRITICAL_95.length) - 1];
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

const toPct = (logRatio: number): number => (Math.exp(logRatio) - 1) * 100;

export function compareBenchRounds(
  base: readonly number[],
  head: readonly number[]
): BenchComparison {
  assertRounds("base", base);
  assertRounds("head", head);
  assert(base.length === head.length, `paired rounds differ: ${base.length} vs ${head.length}`);

  const logRatios = base.map((baseValue, i) => Math.log(head[i] / baseValue));
  const center = mean(logRatios);
  const halfWidth =
    tCritical95(logRatios.length - 1) * Math.sqrt(sampleVariance(logRatios) / logRatios.length);
  const ciLowPct = toPct(center - halfWidth);
  const ciHighPct = toPct(center + halfWidth);
  const verdict: BenchVerdict = ciLowPct > 0 ? "slower" : ciHighPct < 0 ? "faster" : "~";
  return {
    baseMedian: median(base),
    headMedian: median(head),
    deltaPct: toPct(center),
    ciLowPct,
    ciHighPct,
    verdict,
  };
}
