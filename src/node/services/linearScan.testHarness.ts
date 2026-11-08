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

// Each run costs both sizes. There are up to MAX_RUNS of them, and none after the first once
// RUN_BUDGET_MS of CPU time is spent: a cheap shape gets many runs, because the first ones pay for
// engine warm-up and the GC and a few milliseconds are within their noise, and a slow shape gets
// one, because those costs are small beside its own.
const MAX_RUNS = 5;
const RUN_BUDGET_MS = 40;

/** CPU time (user + system) that `run` takes: a busy host cannot stretch it. */
export function cpuMs(run: () => void): number {
  const started = process.cpuUsage();
  run();
  const used = process.cpuUsage(started);
  return (used.user + used.system) / 1000;
}

export function expectLinearScan(
  scan: (text: string) => unknown,
  build: (scale: number) => string,
  ceilingMs: number = FAST_SCAN_MS
): void {
  const small = build(1);
  const large = build(SIZE_STEP);
  let smallMs = Number.POSITIVE_INFINITY;
  let largeMs = Number.POSITIVE_INFINITY;
  let spentMs = 0;
  for (let run = 0; run < MAX_RUNS && (run === 0 || spentMs < RUN_BUDGET_MS); run++) {
    const smallRun = cpuMs(() => scan(small));
    const largeRun = cpuMs(() => scan(large));
    smallMs = Math.min(smallMs, smallRun);
    largeMs = Math.min(largeMs, largeRun);
    spentMs += smallRun + largeRun;
  }
  expect(smallMs).toBeLessThan(ceilingMs);
  expect(largeMs).toBeLessThan(MAX_COST_RATIO * Math.max(smallMs, MIN_BASE_MS));
}
