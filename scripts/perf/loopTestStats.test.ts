import { describe, expect, test } from "bun:test";
import { type LoopTestRun, summarizeFile } from "./loopTestStats";

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
