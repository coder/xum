/**
 * Nightly perf report for `.github/workflows/perf-profiles.yml` (job `perf-report`).
 *
 * Reports the current run only: per-test outcomes and each scenario's metrics. It does not compare
 * with earlier runs yet; history and regression detection need their own design.
 *
 * Attribution rule: a scenario's numbers come from its test's final attempt only. When the final
 * attempt wrote no usable summary, the row shows "unavailable". An earlier attempt's numbers are
 * never used instead, because the final attempt is the one that decided the run.
 *
 * Pure logic only; `scripts/perf/perfReport.ts` does the file I/O. This lives under `src/` because
 * CI lints, typechecks and unit-tests only `src/**`, and it has no imports, so the CLI runs with
 * plain Bun and no `bun install` (no project dependency code runs in the report job).
 */

export type MetricId =
  | "wallMs"
  | "scriptMs"
  | "taskMs"
  | "layouts"
  | "styleRecalcs"
  | "reactRenders"
  | "heapMb"
  | "hunkStepMedianMs";

export interface MetricSpec {
  id: MetricId;
  label: string;
  decimals: number;
  /** Every summary must provide it; otherwise the summary is unusable. */
  required: boolean;
}

export const METRICS: readonly MetricSpec[] = [
  // Includes Playwright round trips and expect polling.
  { id: "wallMs", label: "Wall ms", decimals: 0, required: true },
  { id: "scriptMs", label: "Script ms", decimals: 0, required: true },
  // TaskDuration minus DevToolsCommandDuration: the raw value includes profiler setup overhead.
  { id: "taskMs", label: "Task ms", decimals: 0, required: true },
  { id: "layouts", label: "Layouts", decimals: 0, required: true },
  { id: "styleRecalcs", label: "Style recalcs", decimals: 0, required: true },
  { id: "reactRenders", label: "React renders", decimals: 0, required: false },
  { id: "heapMb", label: "Heap MB", decimals: 0, required: true },
  // Only the immersive-review hunk iteration scenario records it.
  { id: "hunkStepMedianMs", label: "Hunk step ms", decimals: 1, required: false },
];

// ---------------------------------------------------------------------------
// Sanitizing: every string taken from an artifact is untrusted.
// ---------------------------------------------------------------------------

const ANSI_ESCAPE = new RegExp(String.raw`\u001b\[[0-9;?]*[ -/]*[@-~]`, "g");
const CONTROL_CHARS = new RegExp(String.raw`[\u0000-\u001f\u007f]`, "g");

/**
 * Make untrusted text safe for a Markdown inline code span inside a table: no ANSI or control
 * characters, no backticks (cannot close the span), no `<`/`>` (no raw HTML), no `|` (no broken
 * table cells). Truncated so one error cannot flood the summary.
 */
export function sanitizeInline(text: string, maxLength = 160): string {
  const cleaned = text
    .replace(ANSI_ESCAPE, "")
    .replace(CONTROL_CHARS, " ")
    .replace(/[`<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return "(empty)";
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

/** Scenario labels become table cells, so restrict them to a safe alphabet. */
export function sanitizeLabel(label: string): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : "invalid-label";
}

function code(text: string): string {
  return `\`${sanitizeInline(text)}\``;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** Test identity shared by perf summaries and Playwright results: `<spec basename> › <title>`. */
export function testKey(file: string, title: string): string {
  return `${basename(file)} › ${title}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// perf-summary.json / react-profile.json (tests/e2e/utils/perfProfile.ts, schemaVersion 1)
// ---------------------------------------------------------------------------

export interface ScenarioIdentity {
  /** Sanitized `runLabel`. */
  label: string;
  /** undefined when the summary does not say which test wrote it. */
  testKey?: string;
  /** undefined when the summary does not say which attempt wrote it. */
  retry?: number;
}

export type ScenarioRead =
  | ({ ok: true; values: Partial<Record<MetricId, number>> } & ScenarioIdentity & {
        testKey: string;
        retry: number;
      })
  | ({ ok: false; reason: string } & ScenarioIdentity);

/**
 * Validate one scenario's artifacts and extract its metrics. Bad data never throws: it comes back
 * as `{ ok: false }` (with whatever identity could be read) so it can be reported.
 */
export function readScenario(summary: unknown, reactProfile: unknown): ScenarioRead {
  if (!isRecord(summary))
    return { ok: false, label: "unknown", reason: "summary is not an object" };
  const label = typeof summary.runLabel === "string" ? sanitizeLabel(summary.runLabel) : "unknown";
  const testInfo = isRecord(summary.test) ? summary.test : {};
  const key =
    typeof testInfo.title === "string" && typeof testInfo.file === "string"
      ? testKey(testInfo.file, testInfo.title)
      : undefined;
  const rawRetry = testInfo.retry;
  const retry =
    typeof rawRetry === "number" && Number.isInteger(rawRetry) && rawRetry >= 0
      ? rawRetry
      : undefined;
  const identity: ScenarioIdentity = { label, testKey: key, retry };

  if (summary.schemaVersion !== 1) {
    return {
      ok: false,
      ...identity,
      reason: `unsupported schemaVersion ${String(summary.schemaVersion)}`,
    };
  }
  if (key === undefined || retry === undefined) {
    return { ok: false, ...identity, reason: "missing test title, file or retry" };
  }
  const chrome = isRecord(summary.chromeProfile) ? summary.chromeProfile : undefined;
  if (!chrome) return { ok: false, ...identity, reason: "missing chromeProfile" };
  const metrics = isRecord(chrome.metrics) ? chrome.metrics : {};

  const scriptSeconds = finiteNonNegative(metrics.ScriptDuration);
  const taskSeconds = finiteNonNegative(metrics.TaskDuration);
  // Required, not defaulted: without it task time would silently include profiler overhead.
  const devToolsSeconds = finiteNonNegative(metrics.DevToolsCommandDuration);
  const heapBytes = finiteNonNegative(metrics.JSHeapUsedSize);
  const history = isRecord(summary.historyProfile) ? summary.historyProfile : undefined;
  const iteration =
    history && isRecord(history.iterationSummary) ? history.iterationSummary : undefined;

  const candidates: Partial<Record<MetricId, number | undefined>> = {
    wallMs: finiteNonNegative(chrome.wallTimeMs),
    scriptMs: scriptSeconds === undefined ? undefined : scriptSeconds * 1000,
    taskMs:
      taskSeconds === undefined || devToolsSeconds === undefined
        ? undefined
        : Math.max(0, taskSeconds - devToolsSeconds) * 1000,
    layouts: finiteNonNegative(metrics.LayoutCount),
    styleRecalcs: finiteNonNegative(metrics.RecalcStyleCount),
    heapMb: heapBytes === undefined ? undefined : heapBytes / (1024 * 1024),
    reactRenders: isRecord(reactProfile) ? finiteNonNegative(reactProfile.sampleCount) : undefined,
    hunkStepMedianMs: iteration ? finiteNonNegative(iteration.medianMs) : undefined,
  };
  const missing = METRICS.filter((spec) => spec.required && candidates[spec.id] === undefined);
  if (missing.length > 0) {
    return {
      ok: false,
      ...identity,
      reason: `missing or invalid metrics: ${missing.map((spec) => spec.id).join(", ")}`,
    };
  }
  const values: Partial<Record<MetricId, number>> = {};
  for (const spec of METRICS) {
    const value = candidates[spec.id];
    if (value !== undefined) values[spec.id] = value;
  }
  return { ok: true, label, testKey: key, retry, values };
}

// ---------------------------------------------------------------------------
// Playwright JSON results (artifacts/perf/playwright-results.json)
// ---------------------------------------------------------------------------

export type TestStatus = "expected" | "unexpected" | "flaky" | "skipped";

export interface TestOutcome {
  key: string;
  title: string;
  status: TestStatus;
  attempts: number;
  /** Retry index of the attempt that decided the outcome; undefined when nothing ran. */
  finalRetry?: number;
  /** First line of the final attempt's error, unsanitized. */
  error?: string;
}

export type PlaywrightResults =
  | { ok: true; tests: TestOutcome[]; globalErrors: string[] }
  | { ok: false; error: string };

const TEST_STATUSES: ReadonlySet<string> = new Set(["expected", "unexpected", "flaky", "skipped"]);

function firstLine(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.message !== "string") return undefined;
  const line = value.message
    .replace(ANSI_ESCAPE, "")
    .split("\n")
    .find((part) => part.trim());
  return line?.trim();
}

export function parsePlaywrightResults(json: unknown): PlaywrightResults {
  if (!isRecord(json) || !Array.isArray(json.suites)) {
    return { ok: false, error: "results JSON has no suites array" };
  }
  const tests: TestOutcome[] = [];
  const visit = (suite: unknown, inheritedFile: string): void => {
    if (!isRecord(suite)) return;
    const file = typeof suite.file === "string" ? suite.file : inheritedFile;
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      if (!isRecord(spec)) continue;
      const title = typeof spec.title === "string" ? spec.title : "";
      const specFile = typeof spec.file === "string" ? spec.file : file;
      for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
        if (!isRecord(test)) continue;
        const status = typeof test.status === "string" ? test.status : "";
        if (!TEST_STATUSES.has(status)) continue;
        const results = Array.isArray(test.results) ? test.results : [];
        const last: unknown = results[results.length - 1];
        const lastRetry = isRecord(last) ? last.retry : undefined;
        const finalRetry =
          results.length === 0
            ? undefined
            : typeof lastRetry === "number" && Number.isInteger(lastRetry) && lastRetry >= 0
              ? lastRetry
              : results.length - 1;
        tests.push({
          key: testKey(specFile, title),
          title,
          status: status as TestStatus,
          attempts: results.length,
          finalRetry,
          error: isRecord(last) ? firstLine(last.error) : undefined,
        });
      }
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) visit(child, file);
  };
  for (const suite of json.suites) visit(suite, "");
  const globalErrors = (Array.isArray(json.errors) ? json.errors : [])
    .map((error) => firstLine(error))
    .filter((line): line is string => line !== undefined);
  return { ok: true, tests, globalErrors };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface Problem {
  /** Stable identity, for future consumers that track problems across runs. */
  key: string;
  /** Markdown; untrusted text inside is already sanitized. */
  text: string;
}

export interface ReportRow {
  test: TestOutcome;
  /** Present when the final attempt wrote a usable summary. */
  label?: string;
  values?: Partial<Record<MetricId, number>>;
  /** Why there is no data, when `values` is absent. */
  unavailable?: string;
}

export interface Report {
  rows: ReportRow[];
  problems: Problem[];
  warnings: string[];
}

export interface ReportInput {
  /** `needs.perf-profiles.result`: success | failure | cancelled | skipped. */
  perfResult: string;
  artifactFound: boolean;
  /** undefined = the results file was not found. */
  results?: PlaywrightResults;
  reads: readonly ScenarioRead[];
}

/**
 * The expected scenarios are exactly the tests this run selected (from the Playwright results), so
 * a filtered manual run expects only what it ran. Summaries are attributed to a test's final
 * attempt only.
 */
export function buildReport(input: ReportInput): Report {
  const problems: Problem[] = [];
  const warnings: string[] = [];
  const rows: ReportRow[] = [];

  if (input.perfResult !== "success") {
    problems.push({
      key: `job:${sanitizeLabel(input.perfResult)}`,
      text: `The perf job finished with result ${code(input.perfResult)}.`,
    });
  }
  if (!input.artifactFound) {
    problems.push({
      key: "artifact:missing",
      text: "The perf job uploaded no artifact, so there is nothing to report.",
    });
    return { rows, problems, warnings };
  }
  if (!input.results?.ok) {
    problems.push(
      input.results === undefined
        ? {
            key: "results:missing",
            text: "`perf/playwright-results.json` is missing, so results cannot be attributed to tests.",
          }
        : {
            key: "results:malformed",
            text: `\`perf/playwright-results.json\` is malformed: ${code(input.results.error)}.`,
          }
    );
    return { rows, problems, warnings };
  }

  const results = input.results;
  if (results.tests.length === 0) {
    problems.push({ key: "tests:none", text: "The run selected no perf tests." });
  }
  for (const error of results.globalErrors) {
    problems.push({
      key: `playwright-error:${sanitizeInline(error, 80)}`,
      text: `Playwright error: ${code(error)}`,
    });
  }

  const knownTests = new Set(results.tests.map((test) => test.key));
  for (const test of results.tests) {
    if (test.status === "unexpected") {
      problems.push({
        key: `test-failed:${test.key}`,
        text: `Test ${code(test.key)} failed after ${test.attempts} attempt(s)${
          test.error ? `: ${code(test.error)}` : "."
        }`,
      });
    } else if (test.status === "flaky") {
      warnings.push(`Test ${code(test.key)} passed only on retry (${test.attempts} attempts).`);
    } else if (test.status === "skipped") {
      warnings.push(`Test ${code(test.key)} was skipped.`);
      rows.push({ test, unavailable: "test skipped" });
      continue;
    }

    const final = input.reads.filter(
      (read) => read.testKey === test.key && read.retry === test.finalRetry
    );
    const usable = final.filter((read) => read.ok);
    if (usable.length > 1) {
      warnings.push(
        `Test ${code(test.key)} wrote ${usable.length} summaries in its final attempt; showing the first.`
      );
    }
    const [read] = usable;
    if (read?.ok) {
      rows.push({ test, label: read.label, values: read.values });
      continue;
    }
    const invalid = final.find((entry) => !entry.ok);
    if (invalid?.ok === false) {
      rows.push({ test, unavailable: "final attempt wrote an unusable summary" });
      problems.push({
        key: `summary-invalid:${test.key}`,
        text: `Test ${code(test.key)} wrote an unusable summary: ${code(invalid.reason)}.`,
      });
      continue;
    }
    rows.push({ test, unavailable: "final attempt wrote no summary" });
    if (test.status !== "unexpected") {
      problems.push({
        key: `summary-missing:${test.key}`,
        text: `Test ${code(test.key)} passed but its final attempt wrote no perf summary.`,
      });
    }
  }

  for (const read of input.reads) {
    if (read.testKey === undefined || !knownTests.has(read.testKey)) {
      warnings.push(
        `A summary for ${code(read.label)} does not belong to any test in this run${
          read.ok ? "" : ` and is unusable: ${code(read.reason)}`
        }.`
      );
    }
  }
  return { rows, problems, warnings };
}

// ---------------------------------------------------------------------------
// Step summary
// ---------------------------------------------------------------------------

function outcome(test: TestOutcome): string {
  switch (test.status) {
    case "expected":
      return "passed";
    case "flaky":
      return `passed on retry (${test.attempts} attempts)`;
    case "unexpected":
      return `**failed** (${test.attempts} attempt${test.attempts === 1 ? "" : "s"})`;
    case "skipped":
      return "skipped";
  }
}

export function renderSummary(input: {
  runUrl: string;
  perfResult: string;
  report: Report;
}): string {
  const { rows, problems, warnings } = input.report;
  const count = (status: TestStatus) => rows.filter((row) => row.test.status === status).length;
  const lines: string[] = ["## Nightly perf report", ""];
  const tests =
    rows.length > 0
      ? `${rows.length} tests (${count("expected")} passed, ${count("flaky")} flaky, ${count(
          "unexpected"
        )} failed, ${count("skipped")} skipped)`
      : "no test results";
  lines.push(
    `**${problems.length > 0 ? `Problems: ${problems.length}` : "Healthy"}** · perf job ${code(
      input.perfResult
    )} · ${tests} · [run](${input.runUrl})`,
    ""
  );
  if (problems.length > 0) {
    lines.push("### Problems", "", ...problems.map((problem) => `- ${problem.text}`), "");
  }
  if (rows.length > 0) {
    lines.push(
      "### Tests",
      "",
      `| Test | Result | Scenario | ${METRICS.map((spec) => spec.label).join(" | ")} |`,
      `|---|---|---|${METRICS.map(() => "---:").join("|")}|`
    );
    for (const row of rows) {
      const cells = METRICS.map((spec) => {
        if (!row.values) return "unavailable";
        const value = row.values[spec.id];
        return value === undefined ? "—" : value.toFixed(spec.decimals);
      });
      const scenario = row.label
        ? code(row.label)
        : `unavailable: ${sanitizeInline(row.unavailable ?? "no data")}`;
      lines.push(
        `| ${code(row.test.key)} | ${outcome(row.test)} | ${scenario} | ${cells.join(" | ")} |`
      );
    }
    lines.push(
      "",
      "Values come from each test's final attempt only. — means the scenario does not record that metric.",
      ""
    );
  }
  if (warnings.length > 0) {
    lines.push("### Warnings", "", ...warnings.map((warning) => `- ${warning}`), "");
  }
  return lines.join("\n");
}
