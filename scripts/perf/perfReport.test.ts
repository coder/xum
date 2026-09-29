import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReport,
  formatLogLine,
  METRICS,
  parsePlaywrightResults,
  readScenario,
  renderSummary,
  sanitizeForLog,
  type MetricId,
  type PlaywrightResults,
  type Report,
  type ReportInput,
  type ScenarioRead,
} from "./perfReportCore";

const SPEC = "/home/runner/work/xum/xum/tests/e2e/scenarios/perf.chatTyping.spec.ts";
const TITLE = "perf: type in composer with large chat history";
const KEY = `perf.chatTyping.spec.ts › ${TITLE}`;

function summary(
  overrides: Record<string, unknown> = {},
  testOverrides = {}
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runLabel: "chat-typing-large-history",
    test: { title: TITLE, file: SPEC, retry: 0, ...testOverrides },
    historyProfile: null,
    chromeProfile: {
      wallTimeMs: 900,
      metrics: {
        ScriptDuration: 0.4,
        TaskDuration: 0.7,
        DevToolsCommandDuration: 0.2,
        LayoutCount: 13,
        RecalcStyleCount: 54,
        JSHeapUsedSize: 77 * 1024 * 1024,
      },
    },
    ...overrides,
  };
}

interface SpecFixture {
  file: string;
  title: string;
  status?: string;
  attempts?: number;
  error?: string;
}

/** Playwright JSON results; each spec has one test with `attempts` results (retry 0..n-1). */
function playwright(specs: SpecFixture[]): PlaywrightResults {
  return parsePlaywrightResults({
    suites: specs.map((spec) => {
      const attempts = spec.attempts ?? 1;
      return {
        file: spec.file,
        specs: [
          {
            title: spec.title,
            tests: [
              {
                status: spec.status ?? "expected",
                results: Array.from({ length: attempts }, (_, retry) => ({
                  retry,
                  error: spec.error && retry === attempts - 1 ? { message: spec.error } : undefined,
                })),
              },
            ],
          },
        ],
      };
    }),
  });
}

/** Playwright JSON results for the chat-typing test with the given outcome. */
function results(status: string, attempts: number, error?: string): PlaywrightResults {
  return playwright([
    { file: "scenarios/perf.chatTyping.spec.ts", title: TITLE, status, attempts, error },
  ]);
}

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    perfResult: "success",
    artifactFound: true,
    results: results("expected", 1),
    reads: [readScenario(summary(), { sampleCount: 26 })],
    ...overrides,
  };
}

function keys(report: ReturnType<typeof buildReport>): string[] {
  return report.problems.map((problem) => problem.key);
}

function metricValues(read: ScenarioRead): Partial<Record<MetricId, number>> {
  if (!read.ok || !read.metrics.ok) throw new Error("expected usable metrics");
  return read.metrics.values;
}

function metricColumn(id: MetricId): number {
  return METRICS.findIndex((spec) => spec.id === id);
}

function render(report: Report): string {
  return renderSummary({ runUrl: "https://example.test/run", perfResult: "success", report });
}

/** Body rows (cells, trimmed) of the table under `### <heading>`; [] when the section is absent. */
function tableRows(markdown: string, heading: string): string[][] {
  const lines = markdown.split("\n");
  const start = lines.indexOf(`### ${heading}`);
  if (start === -1) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("### ")) break;
    if (line.startsWith("|"))
      rows.push(
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim())
      );
  }
  return rows.slice(2); // header and separator
}

describe("readScenario", () => {
  test("extracts metrics and removes DevTools overhead from task time", () => {
    const read = readScenario(summary(), { sampleCount: 26 });
    expect(read).toMatchObject({ ok: true, testKey: KEY, retry: 0 });
    const values = metricValues(read);
    expect(values.scriptMs).toBeCloseTo(400);
    expect(values.taskMs).toBeCloseTo(500);
    expect(values.heapMb).toBeCloseTo(77);
    expect(values.reactRenders).toBe(26);
    expect("hunkStepMedianMs" in values).toBe(false);
  });

  test("reads the hunk step median only when the scenario records it", () => {
    const read = readScenario(
      summary({ historyProfile: { iterationSummary: { medianMs: 5.3 } } }),
      undefined
    );
    expect(metricValues(read).hunkStepMedianMs).toBe(5.3);
  });

  test("unusable summaries keep their test identity for attribution", () => {
    const noDevTools = summary();
    const chrome = noDevTools.chromeProfile as {
      wallTimeMs: number;
      metrics: Record<string, number>;
    };
    const { DevToolsCommandDuration: _omitted, ...metrics } = chrome.metrics;
    // Readable and attributable; whether its metrics are required depends on its siblings.
    const read = readScenario(summary({ chromeProfile: { ...chrome, metrics } }), undefined);
    expect(read).toMatchObject({ ok: true, testKey: KEY, retry: 0, metrics: { ok: false } });
    expect(read.ok && !read.metrics.ok && read.metrics.reason).toContain("taskMs");

    expect(readScenario(summary({ schemaVersion: 2 }), undefined)).toMatchObject({
      ok: false,
      testKey: KEY,
    });
    expect(readScenario(summary({}, { retry: "0" }), undefined)).toMatchObject({ ok: false });
    expect(readScenario("not json", undefined)).toMatchObject({ ok: false });
  });
});

describe("parsePlaywrightResults", () => {
  test("classifies outcomes across nested suites with the final attempt and first error line", () => {
    const parsed = parsePlaywrightResults({
      suites: [
        {
          file: "scenarios/perf.chatTyping.spec.ts",
          specs: [
            {
              title: "fails",
              tests: [
                {
                  status: "unexpected",
                  results: [
                    { retry: 0, error: { message: "first" } },
                    {
                      retry: 1,
                      error: { message: "\u001b[31mTimeout 15000ms exceeded\u001b[39m\n  at foo" },
                    },
                  ],
                },
              ],
            },
          ],
          suites: [
            {
              specs: [
                {
                  title: "flaky",
                  tests: [{ status: "flaky", results: [{ retry: 0 }, { retry: 1 }] }],
                },
                { title: "skipped", tests: [{ status: "skipped", results: [] }] },
              ],
            },
          ],
        },
      ],
      errors: [{ message: "Error: worker crashed\nstack" }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tests.map((t) => [t.key, t.status, t.attempts, t.finalRetry])).toEqual([
      ["perf.chatTyping.spec.ts › fails", "unexpected", 2, 1],
      ["perf.chatTyping.spec.ts › flaky", "flaky", 2, 1],
      ["perf.chatTyping.spec.ts › skipped", "skipped", 0, undefined],
    ]);
    expect(parsed.tests[0]?.error).toBe("Timeout 15000ms exceeded");
    expect(parsed.globalErrors).toEqual(["Error: worker crashed"]);
  });

  test("malformed input is reported, not thrown", () => {
    expect(parsePlaywrightResults({ nope: true })).toMatchObject({ ok: false });
    expect(parsePlaywrightResults(null)).toMatchObject({ ok: false });
  });
});

describe("buildReport attribution", () => {
  test("a clean run reports the test with its scenario metrics", () => {
    const report = buildReport(input());
    expect(report.problems).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.scenarios.map((scenario) => scenario.label)).toEqual([
      "chat-typing-large-history",
    ]);
  });

  test("a flaky test uses its final attempt, never the earlier one", () => {
    const first = readScenario(
      summary({ chromeProfile: { ...(summary().chromeProfile as object), wallTimeMs: 2618 } }),
      undefined
    );
    const final = readScenario(summary({}, { retry: 1 }), { sampleCount: 26 });
    const report = buildReport(input({ results: results("flaky", 2), reads: [final, first] }));
    expect(report.rows[0]?.scenarios[0]?.values?.wallMs).toBe(900);
    expect(report.problems).toEqual([]);
  });

  test("a missing or malformed React profile is a problem; the other metrics stay and the cell says unavailable", () => {
    for (const react of [undefined, { sampleCount: "26" }]) {
      const report = buildReport(input({ reads: [readScenario(summary(), react)] }));
      expect(keys(report)).toEqual([`react-profile-unreadable:${KEY}/chat-typing-large-history`]);
      const scenario = report.rows[0]?.scenarios[0];
      expect(scenario?.values?.wallMs).toBe(900);
      const markdown = renderSummary({
        runUrl: "https://example.test/run",
        perfResult: "success",
        report,
      });
      const row =
        markdown
          .split("\n")
          .find((line) => line.includes("| `chat-typing-large-history` | 900 |")) ?? "";
      const reactColumn = METRICS.findIndex((spec) => spec.id === "reactRenders");
      expect(row.split("|").map((cell) => cell.trim())[3 + reactColumn]).toBe("unavailable");
    }
    // A readable profile raises nothing.
    expect(
      keys(buildReport(input({ reads: [readScenario(summary(), { sampleCount: 26 })] })))
    ).toEqual([]);
  });

  test("when the final attempt wrote no summary, the row is unavailable instead of using retry 0", () => {
    const first = readScenario(summary(), undefined);
    const failed = buildReport(
      input({ results: results("unexpected", 2, "boom"), reads: [first] })
    );
    expect(failed.rows[0]?.scenarios).toEqual([]);
    expect(failed.rows[0]?.unavailable).toBe("final attempt wrote no summary");
    expect(keys(failed)).toEqual([`test-failed:${KEY}`]);

    // A passed test whose final attempt wrote nothing is a harness problem of its own.
    const passed = buildReport(input({ results: results("flaky", 2), reads: [first] }));
    expect(passed.rows[0]?.scenarios).toEqual([]);
    expect(keys(passed)).toEqual([`summary-missing:${KEY}`]);
  });

  test("an unusable final-attempt summary is a problem and the row is unavailable", () => {
    const broken = readScenario(
      summary({ chromeProfile: { wallTimeMs: 900, metrics: {} } }),
      undefined
    );
    const report = buildReport(input({ reads: [broken] }));
    expect(report.rows[0]?.unavailable).toBe("final attempt wrote an unusable summary");
    expect(keys(report)).toEqual([`summary-invalid:${KEY}`]);
  });

  test("a failed test still shows the numbers its final attempt wrote", () => {
    // Threshold asserts run after the summary is written, so the final attempt's data is real.
    const report = buildReport(input({ results: results("unexpected", 1, "expected < 2500") }));
    expect(report.rows[0]?.scenarios[0]?.values?.wallMs).toBe(900);
    expect(keys(report)).toEqual([`test-failed:${KEY}`]);
  });

  test("expected scenarios are the tests this run selected, so filtered runs raise nothing", () => {
    // A filtered dispatch selects one test; nothing else is expected, so no warnings appear.
    const report = buildReport(input());
    expect(report.warnings).toEqual([]);
    // A summary from a test that is not in this run's results is flagged, not attributed.
    const stray = readScenario(summary({ runLabel: "stray" }, { title: "other test" }), undefined);
    const withStray = buildReport(input({ reads: [readScenario(summary(), undefined), stray] }));
    expect(withStray.rows).toHaveLength(1);
    expect(withStray.warnings).toHaveLength(1);
  });

  test("skipped tests warn and are unavailable; flaky tests warn", () => {
    const skipped = buildReport(input({ results: results("skipped", 0), reads: [] }));
    expect(skipped.problems).toEqual([]);
    expect(skipped.rows[0]?.unavailable).toBe("test skipped");
    expect(skipped.warnings).toHaveLength(1);
    const flaky = buildReport(
      input({
        results: results("flaky", 2),
        reads: [readScenario(summary({}, { retry: 1 }), undefined)],
      })
    );
    expect(flaky.warnings).toHaveLength(1);
  });
});

describe("buildReport run-level problems", () => {
  test("a failed or cancelled perf job is a problem even when every test passed", () => {
    expect(keys(buildReport(input({ perfResult: "failure" })))).toEqual(["job:failure"]);
    expect(keys(buildReport(input({ perfResult: "cancelled" })))).toEqual(["job:cancelled"]);
  });

  test("a missing artifact is reported without follow-on noise", () => {
    const report = buildReport(
      input({ perfResult: "failure", artifactFound: false, results: undefined, reads: [] })
    );
    expect(keys(report)).toEqual(["job:failure", "artifact:missing"]);
    expect(report.rows).toEqual([]);
  });

  test("missing or malformed results mean nothing can be attributed", () => {
    const missing = buildReport(input({ results: undefined }));
    expect(keys(missing)).toEqual(["results:missing"]);
    expect(missing.rows).toEqual([]);
    expect(keys(buildReport(input({ results: { ok: false, error: "bad" } })))).toEqual([
      "results:malformed",
    ]);
  });

  test("zero selected tests and Playwright global errors are problems", () => {
    expect(
      keys(buildReport(input({ results: parsePlaywrightResults({ suites: [] }), reads: [] })))
    ).toEqual(["tests:none"]);
    const crashed = parsePlaywrightResults({ suites: [], errors: [{ message: "worker crashed" }] });
    expect(keys(buildReport(input({ results: crashed, reads: [] })))).toEqual([
      "tests:none",
      "playwright-error:worker crashed",
    ]);
  });
});

describe("renderSummary", () => {
  test("unavailable rows say so in every metric cell; inapplicable metrics show a dash", () => {
    const first = readScenario(summary(), undefined);
    const report = buildReport(input({ results: results("unexpected", 2), reads: [first] }));
    const markdown = renderSummary({
      runUrl: "https://example.test/run",
      perfResult: "failure",
      report,
    });
    const [row] = tableRows(markdown, "Scenario metrics");
    expect(row?.slice(2)).toEqual(METRICS.map(() => "unavailable"));

    const ok = renderSummary({
      runUrl: "https://example.test/run",
      perfResult: "success",
      report: buildReport(input()),
    });
    const [okRow] = tableRows(ok, "Scenario metrics");
    expect(okRow).not.toContain("unavailable");
    expect(okRow?.[2 + metricColumn("hunkStepMedianMs")]).toBe("—"); // not recorded by this scenario
  });
});

const CHAT_SWITCH_SPEC = "/home/runner/work/xum/xum/tests/e2e/scenarios/perf.chatSwitch.spec.ts";
const CHAT_SWITCH_TITLE = "perf: switch back to chats left mid-stream";
const CHAT_SWITCH_KEY = `perf.chatSwitch.spec.ts › ${CHAT_SWITCH_TITLE}`;

function legMedians(firstRowFromClickMs: number | null): Record<string, number | null> {
  return {
    count: 3,
    "dom.firstRowFromClickMs": firstRowFromClickMs,
    "renderer.firstRowMs": 91.5,
    "renderer.caughtUpMs": 47.4,
    "dom.longestTaskMs": 0,
    "server.totalMs": 19.4,
    "server.sentRowCount": 24,
  };
}

/** The chat-switch primary summary: a `chatSwitch` object plus full Chrome metrics. */
function chatSwitchSummary(chatSwitch: unknown, retry = 0): Record<string, unknown> {
  return summary(
    { runLabel: "chat-switch-mid-stream", chatSwitch },
    { title: CHAT_SWITCH_TITLE, file: CHAT_SWITCH_SPEC, retry }
  );
}

/** The server-window companion: same test and attempt, profile only, no Chrome `metrics` key. */
function companionSummary(retry = 0): Record<string, unknown> {
  return summary(
    { runLabel: "chat-switch-mid-stream-server-window", chromeProfile: { wallTimeMs: 68580 } },
    { title: CHAT_SWITCH_TITLE, file: CHAT_SWITCH_SPEC, retry }
  );
}

function chatSwitchReport(chatSwitch: unknown, extra: ScenarioRead[] = []): Report {
  return buildReport(
    input({
      results: playwright([
        { file: "scenarios/perf.chatSwitch.spec.ts", title: CHAT_SWITCH_TITLE },
      ]),
      reads: [readScenario(chatSwitchSummary(chatSwitch), undefined), ...extra],
    })
  );
}

describe("chat-switch scenarios", () => {
  test("a primary and a metrics-less companion are one test with two scenarios, outside the metrics table", () => {
    const report = chatSwitchReport({ medians: { "cold-open-small": legMedians(105.4) } }, [
      readScenario(companionSummary(), undefined),
    ]);
    expect(report.problems).toEqual([]);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.scenarios.map((scenario) => scenario.label)).toEqual([
      "chat-switch-mid-stream",
      "chat-switch-mid-stream-server-window",
    ]);
    const markdown = render(report);
    expect(tableRows(markdown, "Tests")).toHaveLength(1);
    expect(tableRows(markdown, "Scenario metrics")).toEqual([]);
    // Per-leg medians are deferred (#4442): no Chat switch section is rendered.
    expect(markdown).not.toContain("### Chat switch");
  });

  test("an earlier attempt's chat-switch summaries are never used", () => {
    const report = buildReport(
      input({
        results: playwright([
          {
            file: "perf.chatSwitch.spec.ts",
            title: CHAT_SWITCH_TITLE,
            status: "flaky",
            attempts: 2,
          },
        ]),
        reads: [
          readScenario(
            chatSwitchSummary({ medians: { "cold-open-small": legMedians(1) } }),
            undefined
          ),
          readScenario(companionSummary(), undefined),
        ],
      })
    );
    expect(keys(report)).toEqual([`summary-missing:${CHAT_SWITCH_KEY}`]);
    expect(report.rows[0]?.scenarios).toEqual([]);
    expect(tableRows(render(report), "Chat switch")).toEqual([]);
  });
});

describe("sink safety", () => {
  // Workflow commands, their %-encoded newline form, terminal escapes and line breaks.
  const CRAFTED = [
    "::warning::x",
    "::add-mask::secret",
    "::stop-commands::tok",
    "%0A::error::y",
    ":::group:::z",
    "\u001b[31mred\u001b[0m",
    "\u001b]0;title\u0007",
    "\u001bcreset",
    "\u009b2Jclear",
    "cr\rlf\ntab\tnel\u0085ls\u2028ps\u2029end",
  ];
  const HOSTILE = `${CRAFTED.join(" ")} </details><img src=x onerror=alert(1)>|\`@org/team\``;
  const LONG_TITLE = `${HOSTILE} ${"x".repeat(5000)}`;
  const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

  function hostileReport(): Report {
    const file = "perf.hostile.spec.ts";
    return buildReport(
      input({
        perfResult: "failure",
        results: parsePlaywrightResults({
          suites: [
            {
              file,
              specs: [
                {
                  title: LONG_TITLE,
                  tests: [
                    { status: "unexpected", results: [{ retry: 0, error: { message: HOSTILE } }] },
                  ],
                },
                { title: HOSTILE, tests: [{ status: "expected", results: [{ retry: 0 }] }] },
                {
                  title: `${HOSTILE} flaky`,
                  tests: [{ status: "flaky", results: [{ retry: 0 }, { retry: 1 }] }],
                },
              ],
            },
          ],
          errors: [{ message: HOSTILE }],
        }),
        reads: [
          readScenario(summary({ runLabel: HOSTILE }, { title: LONG_TITLE, file }), undefined),
          readScenario(
            summary(
              {
                runLabel: HOSTILE,
                chatSwitch: {
                  medians: {},
                  mediansByTransport: { [HOSTILE]: { [HOSTILE]: legMedians(1) } },
                },
              },
              { title: HOSTILE, file }
            ),
            undefined
          ),
          readScenario(
            summary(
              { runLabel: HOSTILE, schemaVersion: 2 },
              { title: `${HOSTILE} flaky`, file, retry: 1 }
            ),
            undefined
          ),
          readScenario(
            summary({ runLabel: HOSTILE }, { title: `stray ${HOSTILE}`, file }),
            undefined
          ),
        ],
      })
    );
  }

  test("the job log line carries counts only, never artifact text", () => {
    const report = hostileReport();
    expect(report.problems.length).toBeGreaterThan(0);
    expect(report.warnings.length).toBeGreaterThan(0);
    const line = formatLogLine(report);
    expect(line).not.toContain("::");
    expect(line).not.toMatch(CONTROL);
    for (const token of [
      "warning::",
      "add-mask",
      "secret",
      "stop-commands",
      "tok",
      "%0A",
      "error",
      "red",
      "title",
      "img",
      "x".repeat(20),
    ]) {
      expect(line).not.toContain(token);
    }
  });

  test.each([...CRAFTED, HOSTILE, LONG_TITLE])("sanitizeForLog neutralizes %#", (text) => {
    const cleaned = sanitizeForLog(text);
    expect(cleaned).not.toMatch(CONTROL);
    expect(cleaned).not.toContain("::");
    expect(cleaned.length).toBeLessThanOrEqual(200);
  });

  test("the summary has no escapes, HTML or broken tables, and long titles are truncated in their cell", () => {
    const markdown = render(hostileReport());
    expect(markdown).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(markdown).not.toMatch(/[<>]/);
    for (const line of markdown.split("\n").filter((l) => l.startsWith("- "))) {
      expect((line.match(/`/g) ?? []).length % 2).toBe(0);
    }
    for (const heading of ["Tests", "Scenario metrics"]) {
      const rows = tableRows(markdown, heading);
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.length)).size).toBe(1);
      for (const cell of rows.flat()) expect(cell.length).toBeLessThanOrEqual(200);
    }
    expect(markdown).not.toContain("x".repeat(200));
  });

  // The CLI owns the job-log sink, so these run it the way the workflow does. The environment is
  // explicit: in CI the test process itself has GITHUB_STEP_SUMMARY set.
  function runCli(current: string, env: Record<string, string>) {
    const proc = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "perfReport.ts"),
        "--current",
        current,
        "--perf-result",
        "failure",
      ],
      { env: { PATH: process.env.PATH ?? "", GITHUB_ACTIONS: "true", ...env } }
    );
    return { exitCode: proc.exitCode, log: `${proc.stdout.toString()}${proc.stderr.toString()}` };
  }

  test("in GitHub Actions the CLI writes artifact text only to the step summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-report-cli-"));
    try {
      const file = "perf.hostile.spec.ts";
      mkdirSync(join(dir, "perf", "electron", "hostile-1"), { recursive: true });
      writeFileSync(
        join(dir, "perf", "electron", "hostile-1", "perf-summary.json"),
        JSON.stringify(summary({ runLabel: HOSTILE }, { title: HOSTILE, file }))
      );
      writeFileSync(
        join(dir, "perf", "playwright-results.json"),
        JSON.stringify({
          suites: [
            {
              file,
              specs: [
                {
                  title: HOSTILE,
                  tests: [
                    { status: "unexpected", results: [{ retry: 0, error: { message: HOSTILE } }] },
                  ],
                },
              ],
            },
          ],
          errors: [{ message: HOSTILE }],
        })
      );
      const summaryPath = join(dir, "summary.md");
      const withSummary = runCli(dir, { GITHUB_STEP_SUMMARY: summaryPath });
      const withoutSummary = runCli(dir, {});
      for (const run of [withSummary, withoutSummary]) {
        expect(run.exitCode).toBe(0);
        // Rendered Markdown keeps `::` inside code spans, so any Markdown in the log fails here.
        expect(run.log).not.toContain("::");
        expect(run.log).not.toContain("secret");
        expect(run.log.trimEnd()).not.toMatch(CONTROL);
      }
      // The report itself still reached the summary.
      expect(readFileSync(summaryPath, "utf8")).toContain(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a crash prints one sanitized line and exits 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-report-cli-"));
    try {
      // A file where the artifact directory should be: reading it throws with the path inside.
      const current = join(dir, CRAFTED.join(" "));
      writeFileSync(current, "");
      const run = runCli(current, {});
      expect(run.exitCode).toBe(1);
      expect(run.log).not.toContain("::");
      expect(run.log.trimEnd()).not.toMatch(CONTROL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
