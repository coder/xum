import { describe, expect, test } from "bun:test";
import { type LoopTestRecord, type LoopTestRun, summarizeFile, trips } from "./loopTestStats";

const run = (wallMs: number, exitCode: number, fsMs?: number, timerMs = 0): LoopTestRun => ({
  wallMs,
  exitCode,
  preload: fsMs === undefined ? null : { fsMs, timerMs, usesTempDir: fsMs > 0 },
});

describe("summarizeFile", () => {
  test("keeps every round and counts failed runs, a crash with no preload output included", () => {
    const record = summarizeFile(
      "a.test.ts",
      [run(1000, 0, 100), run(2000, 1), run(4000, 0, 0)],
      true
    );
    expect(record.wallMs).toEqual([1000, 2000, 4000]);
    expect(record.failedRuns).toBe(1);
    expect(record.patchesGlobalTime).toBe(true);
  });

  test("shares are medians over the rounds with preload output", () => {
    const record = summarizeFile(
      "a.test.ts",
      [run(1000, 0, 500, 100), run(2000, 0, 200, 200), run(3000, 0, 300, 2400), run(500, 1)],
      false
    );
    expect(record.fsShare).toBe(0.1); // 0.5, 0.1, 0.1
    expect(record.timerShare).toBe(0.1); // 0.1, 0.1, 0.8
    expect(record.usesTempDir).toBe(true);
  });

  test("shares are null and usesTempDir false when no round wrote preload output", () => {
    const record = summarizeFile("a.test.ts", [run(800, 1), run(900, 1)], false);
    expect(record).toMatchObject({ fsShare: null, timerShare: null, usesTempDir: false });
    expect(record.failedRuns).toBe(2);
  });
});

describe("trips", () => {
  const record = (files: Array<[string, number[], number]>): LoopTestRecord => ({
    commit: "c",
    dirty: false,
    bun: "1.4.3",
    loadavg: [1],
    rounds: 3,
    files: files.map(([file, wallMs, failedRuns]) => ({
      file,
      wallMs,
      failedRuns,
      usesTempDir: true,
      patchesGlobalTime: false,
      fsShare: 0.1,
      timerShare: 0,
    })),
  });

  test("no trip on equal rounds or for a new file", () => {
    const base = record([["a", [1000, 1010, 990], 0]]);
    const head = record([
      ["a", [1000, 1010, 990], 0],
      ["new", [9000, 9000, 9000], 3],
    ]);
    expect(trips(base, head)).toEqual([]);
  });

  test("a slowdown far above the noise trips as slower", () => {
    const base = record([["a", [1000, 1010, 990], 0]]);
    const head = record([["a", [2000, 2030, 1990], 0]]);
    expect(trips(base, head)).toMatchObject([{ file: "a", slower: true, failsMore: false }]);
  });

  test("a large share that adds 250 ms or less does not trip", () => {
    const base = record([["a", [100, 101, 99], 0]]);
    const head = record([["a", [340, 342, 338], 0]]);
    expect(trips(base, head)).toEqual([]);
  });

  test("two more failed runs trip as fails more, one more does not", () => {
    const base = record([
      ["a", [1000, 1000, 1000], 0],
      ["b", [1000, 1000, 1000], 1],
    ]);
    const head = record([
      ["a", [1000, 1000, 1000], 2],
      ["b", [1000, 1000, 1000], 2],
    ]);
    expect(trips(base, head)).toMatchObject([{ file: "a", slower: false, failsMore: true }]);
  });
});
