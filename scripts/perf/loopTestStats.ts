/**
 * Records of the loop test baseline (agent loop refactor, phase 1).
 *
 * The runner (scripts/perf/loopTestBaseline.ts) runs each loop test file in fresh `bun test`
 * processes, one per round, and folds the rounds of a file into one LoopTestFileRecord. The record
 * keeps every round's wall time, so a later compare can pair base and head rounds. The master plan
 * named the fields medianMs and realWaitShare; this record keeps wallMs[] and timerShare instead.
 */
import assert from "node:assert/strict";
import { type BenchComparison, compareBenchRounds } from "./benchStats";

/** What scripts/perf/loopTests.preload.ts writes for one process. */
export interface PreloadOutput {
  fsMs: number;
  timerMs: number;
  usesTempDir: boolean;
}

/** One `bun test` process of one file. */
export interface LoopTestRun {
  /** The runner times the process from spawn to exit. */
  wallMs: number;
  exitCode: number;
  /** Null when the process wrote no preload output (for example a crash at import). */
  preload: PreloadOutput | null;
}

export interface LoopTestFileRecord {
  /** Repo-relative test path. */
  file: string;
  wallMs: number[];
  /** Rounds whose exit code is not 0, a crash at import included. */
  failedRuns: number;
  usesTempDir: boolean;
  patchesGlobalTime: boolean;
  /** Median of fsMs / wallMs over the rounds with preload output; null if none has it. */
  fsShare: number | null;
  /** Median of timerMs / wallMs over the rounds with preload output; null if none has it. */
  timerShare: number | null;
}

export interface LoopTestRecord {
  commit: string;
  /** True for a working tree with uncommitted edits. */
  dirty: boolean;
  bun: string;
  /** The 1-minute load average, sampled once a minute during the run. */
  loadavg: number[];
  rounds: number;
  files: LoopTestFileRecord[];
}

export function median(values: readonly number[]): number {
  assert(values.length > 0, "median of no values");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Folds the rounds of one test file into its record. */
export function summarizeFile(
  file: string,
  runs: readonly LoopTestRun[],
  patchesGlobalTime: boolean
): LoopTestFileRecord {
  assert(runs.length > 0, `${file}: no runs`);
  for (const run of runs) {
    assert(Number.isFinite(run.wallMs) && run.wallMs > 0, `${file}: bad wallMs ${run.wallMs}`);
  }
  const measured = runs.flatMap((run) =>
    run.preload === null ? [] : [{ wallMs: run.wallMs, preload: run.preload }]
  );
  const share = (pick: (preload: PreloadOutput) => number): number | null =>
    measured.length === 0 ? null : median(measured.map((run) => pick(run.preload) / run.wallMs));
  return {
    file,
    wallMs: runs.map((run) => run.wallMs),
    failedRuns: runs.filter((run) => run.exitCode !== 0).length,
    usesTempDir: measured.some((run) => run.preload.usesTempDir),
    patchesGlobalTime,
    fsShare: share((preload) => preload.fsMs),
    timerShare: share((preload) => preload.timerMs),
  };
}

/**
 * The trip margins. They are fixed in the phase 1 plan before work starts: no worker changes them
 * to clear a trip. A paired same-code (A/A) spike of 5 rounds gave a highest lower bound of +2.7%,
 * and tools/bash_output.test.ts failed 1 of 2 runs with no change, so one more failed run is noise.
 */
export const SLOWER_LOW_BOUND_PCT = 10;
export const SLOWER_MIN_DELTA_MS = 250;
export const MORE_FAILED_RUNS = 2;

export interface Trip {
  file: string;
  slower: boolean;
  failsMore: boolean;
  comparison: BenchComparison;
}

export interface LoopTestCompare {
  base: LoopTestRecord;
  head: LoopTestRecord;
  /** Files left out of this run (backgroundProcessManager.test.ts at RUNS below 5). */
  skipped: string[];
  trips: Trip[];
  /** Head test files with no base: listed, never a trip. */
  newFiles: string[];
}

/**
 * A head file trips when its paired 95% lower bound is above +SLOWER_LOW_BOUND_PCT and its median
 * grew by more than SLOWER_MIN_DELTA_MS, or when it failed MORE_FAILED_RUNS more runs than base.
 * A trip pauses the PR for review; it never fails the PR by itself.
 */
export function trips(base: LoopTestRecord, head: LoopTestRecord): Trip[] {
  return head.files.flatMap((h) => {
    const b = base.files.find((f) => f.file === h.file);
    if (b === undefined) return [];
    const comparison = compareBenchRounds(b.wallMs, h.wallMs);
    const slower =
      comparison.ciLowPct > SLOWER_LOW_BOUND_PCT &&
      comparison.headMedian - comparison.baseMedian > SLOWER_MIN_DELTA_MS;
    const failsMore = h.failedRuns >= b.failedRuns + MORE_FAILED_RUNS;
    return slower || failsMore ? [{ file: h.file, slower, failsMore, comparison }] : [];
  });
}
