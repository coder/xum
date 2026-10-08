import { describe, expect, test } from "bun:test";
import { buildReport, parsePlaywrightResults, readScenario } from "./perfReportCore";
import {
  evaluateTrend,
  formatTrendLogLine,
  nightFromReport,
  renderTrendSummary,
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
const render = (all: Night[], historyError?: string) =>
  renderTrendSummary({ current: all[0], history: all.slice(1), historyError });

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
      expect(render(nights({ scriptMs: [...streak, ...BASELINE] }))).toContain(
        `### Warnings\n\n- watch: \`s\` script ms 160 (+60%), ${above} of 3 nights above\n`
      );
    }
    expect(statusOf(nights({ scriptMs: [90, 160, 160, ...BASELINE] }), "scriptMs")).toBe("ok");
  });

  test("the absolute floor keeps small counts and a zero baseline quiet", () => {
    expect(statusOf(nights({ layouts: [14, 14, 14, 10, 10, 10, 10, 10] }), "layouts")).toBe("ok");
    expect(statusOf(nights({ reactRenders: [4, 4, 4, 0, 0, 0, 0, 0] }), "reactRenders")).toBe("ok");
    const zero = nights({ reactRenders: [6, 6, 6, 0, 0, 0, 0, 0] });
    expect(trendOf(zero, "reactRenders")).toMatchObject({ status: "regressed", baseline: 0 });
    expect(render(zero)).toContain("| 6 **regressed** |");
    expect(render(zero)).not.toContain("%");
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
    expect(all[1]).toEqual({ run: run(1), scenarios: {}, issue: "artifact missing or expired" });
    expect(trendOf(all, "scriptMs")).toMatchObject({ status: "watch", above: 2 });
    expect(render(all)).toContain(`- run ${all[1].run.databaseId}: artifact missing or expired`);
  });

  test("a series with earlier values but none tonight is lost, not dropped", () => {
    const all = nights({ scriptMs: [undefined, 100, 100], layouts: [undefined, 10, 10] });
    expect(evaluate(all).map((trend) => [trend.metric.id, trend.status, trend.lost])).toEqual([
      ["scriptMs", "no-data", true],
      ["layouts", "no-data", true],
    ]);
    expect(render(all).match(/^- .*/gm)).toEqual([
      "- `s` has no value tonight for script ms, layouts, but earlier nights do",
    ]);
  });

  test("values come from each test's final attempt only", () => {
    const flaky = reportNight(run(0), [[TYPING, "flaky", 2]], [summary(0, 0.9), summary(1, 0.4)]);
    expect(flaky.scenarios["chat-typing"]?.scriptMs).toBe(400);
    const failed = reportNight(run(0), [[TYPING, "unexpected", 2]], [summary(0, 0.9)]);
    expect(failed).toEqual({ run: run(0), scenarios: {}, issue: "no usable summary" });
  });

  test("a night merges page milestones and skips chat-switch rows", () => {
    const test = { key: "k", spec: "s", title: "t", status: "expected", attempts: 1 } as const;
    const milestones = { values: { firstMessageMs: 3 }, gaps: [] };
    const open = { label: "open", values: { wallMs: 9 }, milestones };
    const rows = [
      { test, chatSwitch: false, scenarios: [open] },
      { test, chatSwitch: true, scenarios: [{ label: "switch", values: { scriptMs: 1 } }] },
    ];
    const night = nightFromReport(run(0), { rows, problems: [], warnings: [] });
    expect(night.scenarios).toEqual({ open: { wallMs: 9, firstMessageMs: 3 } });
  });

  test("values from nights before the contract start never count", () => {
    const all = nights({ scriptMs: [200, 200, 200, 100, 100, 100, 100] });
    for (const day of ["29", "28", "27"]) {
      const info = run(0, { databaseId: all.length, createdAt: `2026-09-${day}T04:00:00Z` });
      all.push(reportNight(info, [[TYPING, "expected", 1]], [summary(0, 0.1)]));
    }
    expect(statusOf(all, "scriptMs")).toBe("no-baseline");
    // Their summaries were usable: the values are contract gaps, not a broken night.
    expect(all.at(-1)?.issue).toBeUndefined();
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
    const markdown = render(all);
    expect(markdown.match(/\(\+100%\)/g)).toHaveLength(3);
    expect(markdown).not.toMatch(/regressed|watch/);
  });

  test("malformed nights fail loudly instead of reading as ok or empty", () => {
    for (const bad of [NaN, -5]) {
      expect(() => evaluate(nights({ scriptMs: [bad, 100, 100, 100, 100, 100, 100] }))).toThrow(
        "values must be finite and non-negative"
      );
    }
    const report = buildReport({ perfResult: "success", artifactFound: true, reads: [] });
    for (const createdAt of ["bad", "0", "2099-13-01T04:00:00Z", "2026-02-30T04:00:00Z"]) {
      expect(() => nightFromReport(run(0, { createdAt }), report)).toThrow("invalid createdAt");
    }
    for (const repeated of [1, 0]) {
      const all = nights({ scriptMs: [100, 100, 100] });
      all[2].run.databaseId = all[repeated].run.databaseId;
      expect(() => evaluate(all)).toThrow("a run fills two slots");
    }
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
      // Copies of slot 1's run: ineligible, older, and repeated. Only the newest eligible counts.
      run(1, { status: "in_progress" }),
      run(1, { createdAt: new Date(BASE - 25 * DAY).toISOString() }),
      run(1),
    ];
    const selected = selectHistory(run(0), [...others, ...[...valid].reverse()]);
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

describe("renderTrendSummary", () => {
  test("a history error is one problem, never an empty-history table", () => {
    const markdown = render(nights({ scriptMs: [100, 100] }), "\nHTTP 401: Bad credentials\nmore");
    expect(markdown).toContain(
      "### Problems\n\n- history fetch failed: `HTTP 401: Bad credentials`\n"
    );
    expect(markdown).not.toMatch(/^\||no baseline|No earlier|more/m);
  });

  test("a dispatch run is labeled as a preview", () => {
    const all = nights({ scriptMs: [100, 100] });
    expect(render(all)).not.toContain("Preview");
    all[0] = { ...all[0], run: run(0, { event: "workflow_dispatch" }) };
    expect(render(all)).toContain("## Perf trend\n\nPreview: not a scheduled-main result.\n");
  });

  test("untrusted labels and errors cannot break the Markdown", () => {
    const evil = "x\u001b[31m`|<script>alert(1)</script>\u2028y\u001b]8;;https://e.test\u0007|z";
    const all = nights(
      { scriptMs: [200, 200, 200, 100, 100, 100, 100, 100], layouts: [undefined, 10] },
      evil
    );
    for (const historyError of [undefined, evil]) {
      const lines = render(all, historyError).split("\n");
      expect(lines.join("")).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/);
      const table = lines.filter((line) => line.startsWith("|"));
      expect(table.length).toBe(historyError === undefined ? 3 : 0);
      for (const line of table) expect(line.split("|").length).toBe(table[0].split("|").length);
      for (const line of lines) expect((line.match(/`/g)?.length ?? 0) % 2).toBe(0);
    }
    expect(render(all)).toMatch(
      /^\| `x[^`|]*` \| — \| 200 \(\+100%\) \*\*regressed\*\* \| — \| no data \|/m
    );
  });
});
