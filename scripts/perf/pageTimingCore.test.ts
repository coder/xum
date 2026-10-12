import { expect, test } from "bun:test";
import {
  hostIsQuiet,
  pairDiffs,
  qualifyHostPage,
  seedRewrites,
  serviceWorkerProofFailures,
  usefulContentShown,
  type Run,
} from "./pageTimingCore";

test("UCS takes the later of Element Timing and visibility, and a static view counts only for UCS (any)", () => {
  const record = {
    elementTiming: [
      { live: false, renderTime: 1500 },
      { live: true, renderTime: 9000 },
    ],
    visible: 1700, // the static copy is painted at 1.5 s but hidden behind a fade until 1.7 s
    visibleLive: 9200, // the live copy is painted at 9 s and shown one frame later
    ir: null,
  };
  expect(usefulContentShown(record)).toEqual({ ucs: 1.7, ucsLive: 9.2 });
  // A run whose target never painted fails instead of falling back to another signal.
  expect(() => usefulContentShown({ ...record, elementTiming: [record.elementTiming[0]] })).toThrow(
    "no Element Timing"
  );
  expect(() => usefulContentShown({ ...record, visibleLive: null })).toThrow(
    "never became visible"
  );
});

test("the service-worker proof names every way a worker could have served the run", () => {
  expect(serviceWorkerProofFailures({ workers: 0, fromWorker: 0, apiAfterRun: false })).toEqual([]);
  expect(serviceWorkerProofFailures({ workers: 1, fromWorker: 3, apiAfterRun: true })).toHaveLength(
    3
  );
});

test("the host rule needs both a low load and low CPU pressure", () => {
  const psi = (avg10: number) =>
    `some avg10=${avg10} avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00`;
  expect(hostIsQuiet(23.9, psi(9.9), 32)).toBe(true);
  expect(hostIsQuiet(24, psi(0), 32)).toBe(false);
  expect(hostIsQuiet(1, psi(10), 32)).toBe(false);
  expect(hostIsQuiet(1, null, 32)).toBe(true); // no PSI (macOS, older kernels)
});

test("paired differences are head - base in pair order, and a missing or doubled arm is refused", () => {
  const run = (pair: number, arm: Run["arm"], ucs: number): Run => ({
    page: "p2",
    pair,
    arm,
    values: { ucs, ucsLive: ucs, ir: 0 },
  });
  // ABBA order: pair 1 runs head first.
  const runs = [run(0, "base", 9), run(0, "head", 8), run(1, "head", 7.5), run(1, "base", 9.5)];
  expect(pairDiffs(runs, "p2", "ucs")).toEqual([-1, -2]);
  expect(pairDiffs(runs, "p1", "ucs")).toEqual([]);
  expect(() => pairDiffs(runs.slice(0, 3), "p2", "ucs")).toThrow("lacks an arm");
  expect(() => pairDiffs([...runs, run(1, "head", 7)], "p2", "ucs")).toThrow("two head runs");
});

test("a page's MDI pools the pairs of every A/A block it ran", () => {
  const quiet = [0.02, -0.03, 0.01, 0, -0.01, 0.04, -0.02, 0.03];
  const noisy = [0.2, 0.25, 0.21, 0.19, 0.22, 0.3, 0.18, 0.2]; // median 0.205 fails qualification
  const one = qualifyHostPage([{ ucs: noisy, ir: quiet }]);
  expect(one.qualification).toBe("needs-confirmation");
  const two = qualifyHostPage([
    { ucs: noisy, ir: quiet },
    { ucs: quiet, ir: quiet },
  ]);
  expect(two.qualification).toBe("qualified");
  // Alone, the quiet block's d(7) is at most 0.04 s (MDI <= 0.08 s). The pooled MDI keeps the noisy pairs.
  expect(one.mdi.ucs).toBeGreaterThanOrEqual(0.36);
  expect(two.mdi.ucs).toBeGreaterThan(0.08);
});

test("a seed check ignores only the token stats cache the app adds to session-usage.json", () => {
  const [usage, cfg] = ["sessions/w/session-usage.json", "config.json"];
  const seed = Buffer.from('{"byModel":{},"version":1}');
  const before = new Map([usage, cfg].map((rel) => [rel, seed]));
  const check = (now: string, changed = [usage], missing: string[] = []) =>
    seedRewrites({ changed, missing }, before, () => Buffer.from(now));
  expect(check('{\n "version": 1, "byModel": {}, "tokenStatsCache": {"at": 1}\n}')).toEqual([]);
  expect(check('{"byModel":{"m":{}},"version":1,"tokenStatsCache":{}}')).toEqual([usage]);
  expect(check("{")).toEqual([usage]);
  expect(check(String(seed), [cfg], [usage])).toEqual([cfg, usage]);
});
