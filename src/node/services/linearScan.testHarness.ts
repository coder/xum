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
/** Floor for the smaller sample, so the timer's resolution cannot trip the ratio (see REPS below). */
export const MIN_BASE_MS = 1;
/** Ceiling for a shape that runs in the fast path of the engine (the others cost 6 ms or less). */
export const FAST_SCAN_MS = 50;
/** Ceiling for a shape past such a jump at scale 1 (they cost up to 115 ms today). */
export const SLOW_SCAN_MS = 500;

// A sample is REPS scans of one text, not one scan, so that it costs at least MIN_SAMPLE_MS: a
// scan of 0.06 ms that turned quadratic would cost 1 ms, and the floor above would hide it. The
// scans of the small text that calibrate REPS (the fastest of CALIBRATION_RUNS) also warm up the
// regex engine. Both sizes use the same REPS, so their ratio is the ratio of one scan each. A
// shape of 0.01 ms or less gets MAX_REPS, and the floor applies again.
export const CALIBRATION_RUNS = 3;
const MIN_SAMPLE_MS = 2;
const MAX_REPS = 200;

// One run measures both sizes. A shape that costs a few milliseconds measures within 40% of its
// cost on a busy host (cores shared with other processes slow a sample down, or not, at random),
// and now and then a sample takes 10 to 100 times as long (a scan of 12 ms took 1.2 s of CPU
// time once). The ratio of one run, or of the fastest sample of each size, reached 7.3 to 11
// against a limit of 8 on linear scans. The median of the ratios of many runs stayed under 6.
// The number of runs comes from the calibration, not from the runs themselves: a stall that
// inflates the first runs must not cut the loop short. A cheap shape gets MAX_RUNS runs, one that
// costs 100 ms gets MIN_RUNS.
const MIN_RUNS = 2;
const MAX_RUNS = 15;
const RUN_BUDGET_MS = 200;

// A host can stall a whole measurement, not only a sample: at a load of 140 on 32 cores, the two
// runs of one shape cost 3 and 13 times their usual CPU time, and the ratio read 22. A real
// quadratic scan reads 12 or more every time it is measured, so the check fails only if a second
// measurement fails too.
const ATTEMPTS = 2;

/** CPU time (user + system) that `run` takes: a busy host cannot stretch it. */
export function cpuMs(run: () => void): number {
  const started = process.cpuUsage();
  run();
  const used = process.cpuUsage(started);
  return (used.user + used.system) / 1000;
}

interface Measurement {
  /** The cost of one scan of the small text: its fastest sample divided by REPS. */
  smallScanMs: number;
  /** The median over the runs of the cost of the large sample over the cost of the small one. */
  ratio: number;
}

function measureCosts(
  scan: (text: string) => unknown,
  small: string,
  large: string,
  measure: (run: () => void) => number
): Measurement {
  let onceMs = Number.POSITIVE_INFINITY;
  for (let call = 0; call < CALIBRATION_RUNS; call++) {
    onceMs = Math.min(
      onceMs,
      measure(() => scan(small))
    );
  }
  const scanMs = Math.max(onceMs, MIN_SAMPLE_MS / MAX_REPS);
  const reps = Math.ceil(MIN_SAMPLE_MS / scanMs);
  const runs = Math.min(
    MAX_RUNS,
    Math.max(MIN_RUNS, Math.ceil(RUN_BUDGET_MS / (reps * scanMs * (1 + SIZE_STEP))))
  );
  const scanReps = (text: string) => () => {
    for (let rep = 0; rep < reps; rep++) scan(text);
  };
  let fastestSmallMs = Number.POSITIVE_INFINITY;
  const ratios: number[] = [];
  for (let run = 0; run < runs; run++) {
    const smallRun = measure(scanReps(small));
    const largeRun = measure(scanReps(large));
    fastestSmallMs = Math.min(fastestSmallMs, smallRun);
    ratios.push(largeRun / Math.max(smallRun, MIN_BASE_MS));
  }
  // The lower median: with two runs it is the smaller ratio, as the fastest sample was before.
  ratios.sort((a, b) => a - b);
  return { smallScanMs: fastestSmallMs / reps, ratio: ratios[(ratios.length - 1) >> 1] };
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
  let measurement: Measurement = { smallScanMs: 0, ratio: 0 };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    measurement = measureCosts(scan, small, large, measure);
    if (measurement.smallScanMs < ceilingMs && measurement.ratio < MAX_COST_RATIO) return;
  }
  expect(measurement.smallScanMs).toBeLessThan(ceilingMs);
  expect(measurement.ratio).toBeLessThan(MAX_COST_RATIO);
}
