import { describe, expect, test } from "bun:test";
import {
  buildReport,
  parsePlaywrightResults,
  readScenario,
  renderSummary,
  sanitizeInline,
  type PlaywrightResults,
  type ReportInput,
} from "./perfReport";

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

/** Playwright JSON results for one test with the given per-attempt statuses. */
function results(status: string, attempts: number, error?: string): PlaywrightResults {
  return parsePlaywrightResults({
    suites: [
      {
        file: "scenarios/perf.chatTyping.spec.ts",
        specs: [
          {
            title: TITLE,
            tests: [
              {
                status,
                results: Array.from({ length: attempts }, (_, retry) => ({
                  retry,
                  error: error && retry === attempts - 1 ? { message: error } : undefined,
                })),
              },
            ],
          },
        ],
      },
    ],
  });
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

describe("readScenario", () => {
  test("extracts metrics and removes DevTools overhead from task time", () => {
    const read = readScenario(summary(), { sampleCount: 26 });
    expect(read).toMatchObject({ ok: true, testKey: KEY, retry: 0 });
    if (!read.ok) return;
    expect(read.values.scriptMs).toBeCloseTo(400);
    expect(read.values.taskMs).toBeCloseTo(500);
    expect(read.values.heapMb).toBeCloseTo(77);
    expect(read.values.reactRenders).toBe(26);
    expect("hunkStepMedianMs" in read.values).toBe(false);
  });

  test("reads the hunk step median only when the scenario records it", () => {
    const read = readScenario(
      summary({ historyProfile: { iterationSummary: { medianMs: 5.3 } } }),
      undefined
    );
    expect(read.ok && read.values.hunkStepMedianMs).toBe(5.3);
  });

  test("unusable summaries keep their test identity for attribution", () => {
    const noDevTools = summary();
    const chrome = noDevTools.chromeProfile as {
      wallTimeMs: number;
      metrics: Record<string, number>;
    };
    const { DevToolsCommandDuration: _omitted, ...metrics } = chrome.metrics;
    const read = readScenario(summary({ chromeProfile: { ...chrome, metrics } }), undefined);
    expect(read).toMatchObject({ ok: false, testKey: KEY, retry: 0 });
    expect(!read.ok && read.reason).toContain("taskMs");

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
    expect(report.rows[0]).toMatchObject({ label: "chat-typing-large-history" });
  });

  test("a flaky test uses its final attempt, never the earlier one", () => {
    const first = readScenario(
      summary({ chromeProfile: { ...(summary().chromeProfile as object), wallTimeMs: 2618 } }),
      undefined
    );
    const final = readScenario(summary({}, { retry: 1 }), undefined);
    const report = buildReport(input({ results: results("flaky", 2), reads: [final, first] }));
    expect(report.rows[0]?.values?.wallMs).toBe(900);
    expect(report.problems).toEqual([]);
  });

  test("when the final attempt wrote no summary, the row is unavailable instead of using retry 0", () => {
    const first = readScenario(summary(), undefined);
    const failed = buildReport(
      input({ results: results("unexpected", 2, "boom"), reads: [first] })
    );
    expect(failed.rows[0]?.values).toBeUndefined();
    expect(failed.rows[0]?.unavailable).toBe("final attempt wrote no summary");
    expect(keys(failed)).toEqual([`test-failed:${KEY}`]);

    // A passed test whose final attempt wrote nothing is a harness problem of its own.
    const passed = buildReport(input({ results: results("flaky", 2), reads: [first] }));
    expect(passed.rows[0]?.values).toBeUndefined();
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
    expect(report.rows[0]?.values?.wallMs).toBe(900);
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
    const row = markdown.split("\n").find((line) => line.startsWith(`| \`${KEY}`)) ?? "";
    expect(row.match(/\| unavailable /g)).toHaveLength(8);

    const ok = renderSummary({
      runUrl: "https://example.test/run",
      perfResult: "success",
      report: buildReport(input()),
    });
    const okRow = ok.split("\n").find((line) => line.startsWith(`| \`${KEY}`)) ?? "";
    expect(okRow).not.toContain("unavailable");
    expect(okRow.trim().endsWith("| — |")).toBe(true); // no hunk step metric for this scenario
  });

  test("crafted labels and errors cannot inject HTML or break the table", () => {
    const hostile = "</details><img src=x onerror=alert(1)>|`@org/team`\nnext";
    const read = readScenario(summary({ runLabel: hostile }, { title: hostile }), undefined);
    const hostileResults = parsePlaywrightResults({
      suites: [
        {
          file: "perf.chatTyping.spec.ts",
          specs: [
            {
              title: hostile,
              tests: [
                { status: "unexpected", results: [{ retry: 0, error: { message: hostile } }] },
              ],
            },
          ],
        },
      ],
    });
    const report = buildReport(input({ results: hostileResults, reads: [read] }));
    const markdown = renderSummary({
      runUrl: "https://example.test/run",
      perfResult: "failure",
      report,
    });
    expect(markdown).not.toMatch(/[<>]/);
    const rows = markdown.split("\n").filter((line) => line.startsWith("| "));
    expect(new Set(rows.map((row) => row.split("|").length)).size).toBe(1);
    for (const line of markdown.split("\n").filter((l) => l.startsWith("- "))) {
      expect((line.match(/`/g) ?? []).length % 2).toBe(0);
    }
    expect(sanitizeInline("x".repeat(500)).length).toBe(160);
  });
});
