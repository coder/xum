import { describe, expect, test } from "bun:test";
import { buildReport, parsePlaywrightResults, readScenario } from "./perfReportCore";
import {
  evaluateTrend,
  formatTrendLogLine,
  nightFromReport,
  selectHistory,
  type Night,
  type RunInfo,
  type TrendMetricId,
  type Values,
} from "./perfTrendCore";

// Far from the wall clock, so an age computed from Date.now() selects differently.
const BASE = Date.parse("2099-03-01T04:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function run(slot: number, overrides: Partial<RunInfo> = {}): RunInfo {
  const createdAt = new Date(BASE - slot * DAY).toISOString();
  const base = { event: "schedule", headBranch: "main", status: "completed", createdAt };
  return { databaseId: 1000 - slot, ...base, ...overrides };
}

/** One night per slot (0 = current); `series[metric][slot]` is scenario `label`'s value. */
function nights(series: Partial<Record<TrendMetricId, Array<number | undefined>>>, label = "s") {
  const length = Math.max(...Object.values(series).map((values) => values?.length ?? 0));
  return Array.from({ length }, (_, slot): Night => {
    const values: Values = {};
    for (const [id, list] of Object.entries(series)) {
      if (list?.[slot] !== undefined) values[id as TrendMetricId] = list[slot];
    }
    return { run: run(slot), scenarios: { [label]: values } };
  });
}

const evaluate = (all: Night[]) => evaluateTrend(all[0], all.slice(1));
const trendOf = (all: Night[], metric: TrendMetricId) =>
  evaluate(all).find((trend) => trend.metric.id === metric);
const statusOf = (all: Night[], metric: TrendMetricId) => trendOf(all, metric)?.status;

const TYPING = { file: "tests/e2e/scenarios/perf.chatTyping.spec.ts", title: "typing" };
const SWITCH = { file: "tests/e2e/scenarios/perf.chatSwitch.spec.ts", title: "switch" };

/** A chat-typing summary whose final metrics give script ms = scriptSeconds * 1000. */
function summary(retry: number, scriptSeconds: number): unknown {
  const metrics = { ScriptDuration: scriptSeconds, TaskDuration: 0.7, DevToolsCommandDuration: 0 };
  return {
    schemaVersion: 1,
    runLabel: "chat-typing",
    test: { ...TYPING, retry },
    chromeProfile: {
      wallTimeMs: 900,
      metrics: { ...metrics, LayoutCount: 13, RecalcStyleCount: 54, JSHeapUsedSize: 1 },
    },
  };
}

type TestFixture = [spec: typeof TYPING, status: string, attempts: number];

/** A night built the way the CLI builds one: Playwright results and summaries via buildReport. */
function reportNight(info: RunInfo, tests: TestFixture[], summaries: unknown[]): Night {
  const results = parsePlaywrightResults({
    suites: tests.map(([spec, status, attempts]) => {
      const attemptResults = Array.from({ length: attempts }, (_, retry) => ({ retry }));
      return {
        file: spec.file,
        specs: [{ title: spec.title, tests: [{ status, results: attemptResults }] }],
      };
    }),
  });
  const reads = summaries.map((entry) => readScenario(entry, { sampleCount: 3 }));
  const report = buildReport({ perfResult: "success", artifactFound: true, results, reads });
  return nightFromReport(info, report);
}

// Median 100. With the streak nights mixed in, the median would rise to 120 and 160 would pass.
const BASELINE = [100, 100, 100, 120, 120];

describe("evaluateTrend", () => {
  test("three high nights regress, one or two only watch, a low tonight is ok", () => {
    expect(trendOf(nights({ scriptMs: [160, 160, 160, ...BASELINE] }), "scriptMs")).toMatchObject({
      status: "regressed",
      baseline: 100,
      above: 3,
    });
    for (const [streak, above] of [
      [[160, 160, 90], 2],
      [[160, 90, 90], 1],
    ] as const) {
      const trend = trendOf(nights({ scriptMs: [...streak, ...BASELINE] }), "scriptMs");
      expect(trend).toMatchObject({ status: "watch", above });
    }
    expect(statusOf(nights({ scriptMs: [90, 160, 160, ...BASELINE] }), "scriptMs")).toBe("ok");
  });

  test("the absolute floor keeps small counts and a zero baseline quiet", () => {
    expect(statusOf(nights({ layouts: [14, 14, 14, 10, 10, 10, 10, 10] }), "layouts")).toBe("ok");
    expect(statusOf(nights({ reactRenders: [4, 4, 4, 0, 0, 0, 0, 0] }), "reactRenders")).toBe("ok");
    const zero = nights({ reactRenders: [6, 6, 6, 0, 0, 0, 0, 0] });
    expect(trendOf(zero, "reactRenders")).toMatchObject({ status: "regressed", baseline: 0 });
  });

  test("a baseline needs five values of that metric, not five nights", () => {
    const all = nights({
      scriptMs: [100, 100, 100, 100, 100, 100, 100, 100],
      layouts: [10, 10, 10, 10, undefined, 10, 10, 10],
    });
    expect(statusOf(all, "scriptMs")).toBe("ok");
    expect(statusOf(all, "layouts")).toBe("no-baseline");
  });

  test("a night whose chat-switch test failed keeps its slot and its other values", () => {
    const all = nights({ scriptMs: [200, 200, undefined, 100, 100, 100, 100, 100] }, "chat-typing");
    const tests: TestFixture[] = [
      [TYPING, "expected", 1],
      [SWITCH, "unexpected", 2],
    ];
    all[2] = reportNight(run(2), tests, [summary(0, 0.2)]);
    expect(all[2]).toMatchObject({
      scenarios: { "chat-typing": { scriptMs: 200 } },
      issue: undefined,
    });
    expect(statusOf(all, "scriptMs")).toBe("regressed");
  });

  test("an empty night is a gap that blocks a streak", () => {
    const all = nights({ scriptMs: [200, undefined, 200, 200, 100, 100, 100, 100, 100] });
    const missing = buildReport({ perfResult: "failure", artifactFound: false, reads: [] });
    all[1] = nightFromReport(run(1), missing);
    expect(all[1]).toMatchObject({ scenarios: {}, issue: "artifact missing or expired" });
    expect(trendOf(all, "scriptMs")).toMatchObject({ status: "watch", above: 2 });
  });

  test("a series with earlier values but none tonight is lost, not dropped", () => {
    const all = nights({ scriptMs: [undefined, 100, 100], layouts: [undefined, 10, 10] });
    expect(evaluate(all).map((trend) => [trend.metric.id, trend.status, trend.lost])).toEqual([
      ["scriptMs", "no-data", true],
      ["layouts", "no-data", true],
    ]);
  });

  test("values come from each test's final attempt only", () => {
    const flaky = reportNight(run(0), [[TYPING, "flaky", 2]], [summary(0, 0.9), summary(1, 0.4)]);
    expect(flaky.scenarios["chat-typing"]?.scriptMs).toBe(400);
    const failed = reportNight(run(0), [[TYPING, "unexpected", 2]], [summary(0, 0.9)]);
    expect(failed).toMatchObject({ scenarios: {}, issue: "no usable summary" });
  });

  test("values from nights before the contract start never count", () => {
    const all = nights({ scriptMs: [200, 200, 200, 100, 100, 100, 100] });
    for (const day of ["29", "28", "27"]) {
      const info = run(0, { databaseId: all.length, createdAt: `2026-09-${day}T04:00:00Z` });
      all.push(reportNight(info, [[TYPING, "expected", 1]], [summary(0, 0.1)]));
    }
    expect(statusOf(all, "scriptMs")).toBe("no-baseline");
  });

  test("report-only metrics get a baseline but never regress or watch", () => {
    const all = nights({
      wallMs: [1800, 1800, 1800, 900, 900, 900, 900, 900],
      heapMb: [200, 200, 200, 100, 100, 100, 100, 100],
      fullyLoadedMs: [2000, 2000, 2000, 1000, 1000, 1000, 1000, 1000],
    });
    const trends = evaluate(all).map((trend) => [trend.status, trend.baseline !== undefined]);
    expect(trends).toEqual([
      ["ok", true],
      ["ok", true],
      ["ok", true],
    ]);
  });
});

describe("selectHistory", () => {
  const ids = (runs: RunInfo[]) => runs.map((entry) => entry.databaseId);

  test("keeps the 16 newest earlier scheduled main runs", () => {
    const valid = Array.from({ length: 20 }, (_, index) => run(index + 1));
    const half = new Date(BASE - DAY / 2).toISOString();
    const others = [
      run(0, { databaseId: 1, event: "workflow_dispatch", createdAt: half }),
      run(0, { databaseId: 2, headBranch: "feature", createdAt: half }),
      run(0, { databaseId: 3, status: "in_progress", createdAt: half }),
      run(0, { databaseId: 4 }),
      run(-1),
    ];
    const selected = selectHistory(run(0), [...others, ...valid].reverse());
    expect(ids(selected)).toEqual(ids(valid.slice(0, 16)));
  });

  test("measures age from the current run and drops runs before the contract start", () => {
    expect(ids(selectHistory(run(0), [run(29), run(31)]))).toEqual([971]);
    const current = run(0, { createdAt: "2026-10-05T04:00:00Z" });
    const runs = ["2026-09-30", "2026-09-28"].map((day, databaseId) =>
      run(0, { databaseId, createdAt: `${day}T04:00:00Z` })
    );
    expect(ids(selectHistory(current, runs))).toEqual([0]);
  });
});

describe("formatTrendLogLine", () => {
  test("holds counts only, never labels or error text", () => {
    const evil = "x\u001b[31m::warning::`|<script>\u2028y";
    const all = nights(
      { scriptMs: [200, 200, 200, 100, 100, 100, 100, 100], layouts: [undefined, 10] },
      evil
    );
    const lines = [
      formatTrendLogLine({ current: all[0], history: all.slice(1) }),
      formatTrendLogLine({ current: all[0], history: [], historyError: evil }),
    ];
    expect(lines[0]).toContain("1 regressed, 0 watch, 1 lost series over 7 nights");
    expect(lines[1]).toContain("history fetch failed");
    for (const line of lines) expect(line).toMatch(/^perf trend: [a-z0-9 ,;]+$/);
  });
});
