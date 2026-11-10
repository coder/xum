import { describe, expect, it } from "bun:test";

import { CALIBRATION_RUNS, expectLinearScan, SLOW_SCAN_MS } from "./linearScan.testHarness";

// Two regex scans of "aaa...": `/a+$/` reads the text once per call (a thousand calls make it
// cost a few milliseconds), and `/a*b/` has no "b" to find, so it restarts from every position
// and reads the rest of the text each time. The regex is compiled once, so its cost per character
// does not fall between the two sizes, as a loop written in this file would.
const build = (scale: number) => "a".repeat(3_000 * scale);
const linearPattern = /a+$/;
const quadraticPattern = /a*b/;
const linear = (text: string) => {
  for (let call = 0; call < 1_000; call++) linearPattern.test(text);
};
const quadratic = (text: string) => quadraticPattern.test(text);

// The scans here cost about half a second of CPU time each, which a busy host stretches to many
// seconds of wall time: the default 5 s limit of a test failed 9 of 10 runs at 7x load.
const REAL_SCAN_TIMEOUT_MS = 60_000;

describe("expectLinearScan", () => {
  it(
    "accepts a scan whose cost grows with the text",
    () => {
      expect(() => expectLinearScan(linear, build, SLOW_SCAN_MS)).not.toThrow();
    },
    REAL_SCAN_TIMEOUT_MS
  );

  it(
    "rejects a scan whose cost grows with the square of the text",
    () => {
      expect(() => expectLinearScan(quadratic, build, SLOW_SCAN_MS)).toThrow();
    },
    REAL_SCAN_TIMEOUT_MS
  );

  it(
    "rejects a linear scan that costs more than its ceiling",
    () => {
      expect(() => expectLinearScan(linear, build, 0.001)).toThrow();
    },
    REAL_SCAN_TIMEOUT_MS
  );

  it(
    "rejects a scan of 40 microseconds whose cost grows with the square of the text",
    () => {
      // 200 characters: a scan costs 0.04 ms, far less than the 1 ms floor of the ratio, and 800
      // characters cost 16 times as much. Only a sample of many scans makes that visible.
      const buildSmall = (scale: number) => "a".repeat(200 * scale);
      expect(() => expectLinearScan(quadratic, buildSmall, SLOW_SCAN_MS)).toThrow();
    },
    REAL_SCAN_TIMEOUT_MS
  );

  // The costs below are scripted, so the scan never runs and these tests cannot flake. An attempt
  // costs CALIBRATION_RUNS calibration scans (`onceMs` each), then the small and the large sample
  // of each run: run i costs `smalls[i]` and `larges[i]`. Calibrating at 3 ms makes 14 runs.
  const attempt = (onceMs: number, smalls: number[], larges: number[]) => [
    ...Array<number>(CALIBRATION_RUNS).fill(onceMs),
    ...smalls.flatMap((small, run) => [small, larges[run]]),
  ];
  const scripted = (...attempts: number[][]) => {
    const costs = attempts.flat();
    return () => {
      const cost = costs.shift();
      if (cost === undefined) throw new Error("the harness measured more runs than were scripted");
      return cost;
    };
  };
  const noScan = () => undefined;
  const expectScripted = (...attempts: number[][]) =>
    expect(() => expectLinearScan(noScan, build, SLOW_SCAN_MS, scripted(...attempts)));

  // Costs of 14 runs at 2.5 ms for the small sample.
  const linearSmalls = [1.1, 2.5, 2.6, 2.4, 2.5, 1.3, 2.5, 2.7, 2.4, 2.5, 2.6, 2.5, 2.5, 2.6];
  const linearLarges = [10, 10, 11, 9.8, 10, 10, 10, 10.5, 9.6, 10, 12, 10, 10, 11];
  const quadraticSmalls = [2.5, 6, 2.4, 3.2, 2.5, 2.7, 2.5, 2.6, 2.4, 2.5, 2.6, 2.5, 2.7, 2.5];
  const quadraticLarges = [40, 40, 39, 46, 40, 43, 40, 38, 38, 40, 41, 40, 43, 40];

  it("accepts a linear scan whose fastest runs are far apart", () => {
    // Every run but two costs 4 times as much at the large size. The fastest small cost (1.1) and
    // the fastest large cost (9.6) make a ratio of 8.7 on their own, and the two runs with a lucky
    // small cost make 9.1 and 7.7. The median of the 14 ratios is 4.
    expectScripted(attempt(3, linearSmalls, linearLarges)).not.toThrow();
  });

  it("rejects a scan that costs 16 times as much, with noise in every run", () => {
    // The run with a small cost of 6 makes a ratio of 6.7. The median of the ratios is 16.
    const costs = attempt(3, quadraticSmalls, quadraticLarges);
    expectScripted(costs, costs).toThrow();
  });

  it("measures again after a stalled attempt, and accepts a linear scan the second time", () => {
    // The first attempt reads 13 times the cost at the large size, as a stalled host made it.
    const stalled = attempt(
      3,
      linearSmalls,
      linearLarges.map((cost) => cost * 3.5)
    );
    expectScripted(stalled, attempt(3, linearSmalls, linearLarges)).not.toThrow();
  });

  it("plans the number of runs from the calibration, so stalled runs cannot shorten it", () => {
    // Calibrating at 3 ms plans 14 runs. Every sample costs 130 ms, as in a stall: the plan must
    // not follow the cost of the runs (2 of them cost 260 ms, more than the budget).
    let calls = 0;
    const stalled = () => (++calls <= CALIBRATION_RUNS ? 3 : 130);
    expectLinearScan(noScan, build, SLOW_SCAN_MS, stalled);
    expect((calls - CALIBRATION_RUNS) / 2).toBeGreaterThan(5);
  });
});
