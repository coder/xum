import { expect } from "bun:test";

/**
 * Checks that a text scan takes linear time on hostile input, without a wall-clock bound: one
 * input costs 0.1 ms in one shape and 100 ms in another, so no single bound is both loose enough
 * for the slow shape and tight enough for the fast one, and a bound on wall-clock time also fails
 * on a busy host (the old 100 ms bounds failed at 125 and 154 ms).
 *
 * A shape is a function of a `scale`: it builds the hostile text with every repeat count
 * multiplied by it. The scan runs at scale 1 and at scale SIZE_STEP, and the larger cost must stay
 * within MAX_COST_RATIO times the smaller one. A linear scan costs SIZE_STEP times as much (up to
 * 6 times in measurements: a larger string also costs more per character), and a quadratic scan
 * costs its square (16 times). The cost is CPU time: a busy host does not stretch it, but it
 * stretches a wall-clock sample that spans several scheduler slices more than a short one.
 *
 * The ratio cannot see a scan that is linear but slow, so the cost at scale 1 also has a ceiling.
 * It sits well above what a shape costs today and well below what a hostile 100 KB text is worth:
 * a name suffix that was widened from 48 to 5000 characters took 365 ms on one shape that costs
 * 6 ms.
 *
 * Choose the repeat counts so that scale SIZE_STEP stays clear of a jump in cost per character:
 * the regex engine's cost for some shapes grows by 3 to 100 times at some size, and is linear on
 * each side. A shape that crosses its jump between the two sizes fails the ratio, on every run.
 */
export const SIZE_STEP = 4;
export const MAX_COST_RATIO = 8;
/** Floor for the smaller cost, so the timer's resolution on a near-free scan cannot trip the ratio. */
export const MIN_BASE_MS = 1;
/** Ceiling for a shape that runs in the fast path of the engine (the others cost 6 ms or less). */
export const FAST_SCAN_MS = 50;
/** Ceiling for a shape past such a jump at scale 1 (they cost up to 115 ms today). */
export const SLOW_SCAN_MS = 500;

// One run measures both sizes. A shape that costs a few milliseconds measures within 40% of its
// cost on a busy host (cores shared with other processes slow a sample down, or not, at random),
// and now and then a sample takes 10 to 100 times as long (a scan of 12 ms took 1.2 s of CPU
// time once). The ratio of one run, or of the fastest sample of each size, reached 7.3 to 11
// against a limit of 8 on linear scans. The median of the ratios of many runs stayed under 6.
// The number of runs follows the fastest run so far, not the time spent, so a stalled sample does
// not end the loop early: a cheap shape gets MAX_RUNS runs, one that costs 100 ms gets MIN_RUNS.
const MIN_RUNS = 2;
const MAX_RUNS = 15;
const RUN_BUDGET_MS = 200;

/** CPU time (user + system) that `run` takes: a busy host cannot stretch it. */
export function cpuMs(run: () => void): number {
  const started = process.cpuUsage();
  run();
  const used = process.cpuUsage(started);
  return (used.user + used.system) / 1000;
}

/** `measure` is a seam for the tests of this file: they feed it costs, and the scan never runs. */
export function expectLinearScan(
  scan: (text: string) => unknown,
  build: (scale: number) => string,
  ceilingMs: number = FAST_SCAN_MS,
  measure: (run: () => void) => number = cpuMs
): void {
  const small = build(1);
  const large = build(SIZE_STEP);
  let fastestSmallMs = Number.POSITIVE_INFINITY;
  let fastestLargeMs = Number.POSITIVE_INFINITY;
  const ratios: number[] = [];
  for (let run = 0; run < MAX_RUNS; run++) {
    if (run >= MIN_RUNS && run * (fastestSmallMs + fastestLargeMs) >= RUN_BUDGET_MS) break;
    const smallRun = measure(() => scan(small));
    const largeRun = measure(() => scan(large));
    fastestSmallMs = Math.min(fastestSmallMs, smallRun);
    fastestLargeMs = Math.min(fastestLargeMs, largeRun);
    ratios.push(largeRun / Math.max(smallRun, MIN_BASE_MS));
  }
  expect(fastestSmallMs).toBeLessThan(ceilingMs);
  // The lower median: with two runs it is the smaller ratio, as the fastest sample was before.
  ratios.sort((a, b) => a - b);
  expect(ratios[(ratios.length - 1) >> 1]).toBeLessThan(MAX_COST_RATIO);
}
