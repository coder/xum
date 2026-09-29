/**
 * Nightly perf report for `.github/workflows/perf-profiles.yml` (job `perf-report`).
 *
 * Reports the current run only: per-test outcomes and each scenario's metrics. It does not compare
 * with earlier runs yet; history and regression detection need their own design.
 *
 * Attribution rule: a scenario's numbers come from its test's final attempt only. When the final
 * attempt wrote no usable summary, the row shows "unavailable". An earlier attempt's numbers are
 * never used instead, because the final attempt is the one that decided the run. One test may
 * write several summaries in its final attempt (the chat-switch test writes a server-window
 * companion); each becomes its own scenario. Chat-switch scenarios are listed but their Chrome
 * totals are not reported; per-leg medians are deferred (#4442). Workspace-open scenarios add
 * page milestones.
 *
 * Coverage rule (#4442): every value shown either has a check that turns lost data into
 * "unavailable" plus a problem or warning, or it is not shown. Missing data is never silent.
 *
 * Artifact text is untrusted: it only goes into the Markdown summary, sanitized inside code spans.
 * The job log gets a counts-only line (`formatLogLine`) or a sanitized crash message
 * (`sanitizeForLog`), so a crafted test title cannot inject workflow commands.
 *
 * Pure logic only; the CLI next to it (`perfReport.ts`) does the file I/O. CI runs every test file
 * under `scripts/` as a tooling test and typechecks it (with this module) via
 * `tsconfig.tooling.json`. Keep it free of imports (type-only ones aside): the report job runs the
 * CLI with plain Bun and no `bun install`, so no project dependency code runs there.
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
  /** Every non-chat-switch summary must provide it; otherwise the summary is unusable. */
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

/** Page milestones (`milestones` in perf-summary.json, tests/e2e/utils/pageMilestones.ts). */
export type MilestoneId = "firstMessageMs" | "fullyLoadedMs" | "longestTaskMs";

export const MILESTONES: ReadonlyArray<{ id: MilestoneId; label: string; decimals: number }> = [
  // A transcript that never renders still passes the spec (it asserts only fullyLoadedMs), so a
  // missing first message must be visible here.
  { id: "firstMessageMs", label: "First message ms", decimals: 0 },
  { id: "fullyLoadedMs", label: "Fully loaded ms", decimals: 0 },
  { id: "longestTaskMs", label: "Longest task ms", decimals: 0 },
];

/** Tests identified by spec file (the basename in the Playwright results), not by label. */
const WORKSPACE_OPEN_SPEC = "perf.workspaceOpen.spec.ts";
const CHAT_SWITCH_SPEC = "perf.chatSwitch.spec.ts";

// ---------------------------------------------------------------------------
// Sanitizing: every string taken from an artifact is untrusted.
// ---------------------------------------------------------------------------

// OSC sequences (ESC ] ... BEL or ESC \), then CSI (ESC [ or C1 CSI) and two-character ESC
// sequences. Anything left over is removed as a control character below.
const ANSI_ESCAPE = new RegExp(
  String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[\u001b\u009b]\[?[0-9;?]*[ -/]*[@-~]`,
  "g"
);
// C0, DEL, C1 (incl. U+0085 NEL) and the Unicode line/paragraph separators.
const CONTROL_CHARS = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f\u2028\u2029]`, "g");

function truncate(text: string, maxLength: number): string {
  if (text.length === 0) return "(empty)";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

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
  return truncate(cleaned, maxLength);
}

/**
 * Make untrusted text safe for one job-log line. The runner parses stdout/stderr lines for
 * workflow commands (`::warning::`, `::add-mask::`, `::stop-commands::`), so every `::` gets a
 * space between its colons, after control characters and escape sequences are gone (removing them
 * could otherwise join two colons). Single line, at most `maxLength` characters.
 */
export function sanitizeForLog(text: string, maxLength = 200): string {
  const cleaned = text
    .replace(ANSI_ESCAPE, "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/:(?=:)/g, ": ");
  return truncate(cleaned, maxLength);
}

/** Scenario labels, legs and transports become table cells, so restrict them to a safe alphabet. */
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

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Why a value the report shows is absent: not written, written as null, or not a valid number. */
export type ValueGap = "missing" | "null" | "invalid";

function valueGap(value: unknown): ValueGap | undefined {
  if (finiteNonNegative(value) !== undefined) return undefined;
  if (value === undefined) return "missing";
  return value === null ? "null" : "invalid";
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

export type MetricsRead =
  | {
      ok: true;
      values: Partial<Record<MetricId, number>>;
      /**
       * Metrics the scenario should have but whose source could not be read. Today only React
       * renders: every non-chat-switch scenario writes react-profile.json, so a missing or
       * malformed file is lost coverage, not an inapplicable metric.
       */
      unavailable: MetricId[];
    }
  | { ok: false; reason: string };

/** A value that is present and valid, or why it is not. */
export interface ValuesRead<K extends string> {
  values: Partial<Record<K, number>>;
  gaps: Array<{ key: K; gap: ValueGap }>;
}

function readValues<K extends string>(
  record: Record<string, unknown>,
  keys: readonly K[]
): ValuesRead<K> {
  const result: ValuesRead<K> = { values: {}, gaps: [] };
  for (const key of keys) {
    const gap = valueGap(record[key]);
    if (gap === undefined) result.values[key] = record[key] as number;
    else result.gaps.push({ key, gap });
  }
  return result;
}

/** Additive in schemaVersion 1; judged only for workspace-open tests, which always write it. */
function readMilestones(value: unknown): ValuesRead<MilestoneId> {
  const ids = MILESTONES.map((milestone) => milestone.id);
  if (!isRecord(value)) {
    const gap = valueGap(value) ?? "invalid";
    return { values: {}, gaps: ids.map((key) => ({ key, gap })) };
  }
  return readValues(value, ids);
}

/**
 * `ok: true` means the summary is readable and attributable to a test attempt. Whether its Chrome
 * metrics are required depends on its siblings (chat-switch tests skip them), so a metrics
 * failure is carried in `metrics` and judged by `buildReport`.
 */
export type ScenarioRead =
  | ({
      ok: true;
      metrics: MetricsRead;
      milestones: ValuesRead<MilestoneId>;
      /** The summary has a `chatSwitch` key (the chat-switch test's primary summary). */
      chatSwitch: boolean;
    } & ScenarioIdentity & { testKey: string; retry: number })
  | ({ ok: false; reason: string } & ScenarioIdentity);

function readMetrics(summary: Record<string, unknown>, reactProfile: unknown): MetricsRead {
  const chrome = isRecord(summary.chromeProfile) ? summary.chromeProfile : undefined;
  if (!chrome) return { ok: false, reason: "missing chromeProfile" };
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
      reason: `missing or invalid metrics: ${missing.map((spec) => spec.id).join(", ")}`,
    };
  }
  const values: Partial<Record<MetricId, number>> = {};
  for (const spec of METRICS) {
    const value = candidates[spec.id];
    if (value !== undefined) values[spec.id] = value;
  }
  return {
    ok: true,
    values,
    unavailable: values.reactRenders === undefined ? ["reactRenders"] : [],
  };
}

/**
 * Validate one scenario's artifacts and extract its data. Bad data never throws: it comes back as
 * `{ ok: false }` (with whatever identity could be read) so it can be reported.
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
  const retry = nonNegativeInteger(testInfo.retry);
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
  return {
    ok: true,
    label,
    testKey: key,
    retry,
    metrics: readMetrics(summary, reactProfile),
    milestones: readMilestones(summary.milestones),
    chatSwitch: "chatSwitch" in summary,
  };
}

// ---------------------------------------------------------------------------
// Playwright JSON results (artifacts/perf/playwright-results.json)
// ---------------------------------------------------------------------------

export type TestStatus = "expected" | "unexpected" | "flaky" | "skipped";

export interface TestOutcome {
  key: string;
  /** Spec file basename, e.g. `perf.workspaceOpen.spec.ts`. */
  spec: string;
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
        const lastRetry = isRecord(last) ? nonNegativeInteger(last.retry) : undefined;
        const finalRetry = results.length === 0 ? undefined : (lastRetry ?? results.length - 1);
        tests.push({
          key: testKey(specFile, title),
          spec: basename(specFile),
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
  /** Stable identity, for future consumers that track problems across runs. Never printed. */
  key: string;
  /** Markdown; untrusted text inside is already sanitized. */
  text: string;
}

export interface ReportScenario {
  label: string;
  /** Scenario metrics; absent for chat-switch scenarios, whose Chrome totals are not reported. */
  values?: Partial<Record<MetricId, number>>;
  /** Metrics that should exist but could not be read; shown as "unavailable". */
  unavailable?: MetricId[];
  /** Page milestones; only workspace-open scenarios have them (others show "—"). */
  milestones?: ValuesRead<MilestoneId>;
}

export interface ReportRow {
  test: TestOutcome;
  /**
   * The chat-switch test (by spec file, or any test whose final attempt wrote a `chatSwitch`
   * summary). All of that attempt's scenarios (including
   * profile-only companions) are chat-switch scenarios: their whole-scenario Chrome totals changed
   * scope when server-window switches were added, so they are neither required nor reported.
   */
  chatSwitch: boolean;
  /** Every usable summary of the final attempt, one scenario each, sorted by label. */
  scenarios: ReportScenario[];
  /** Why there is no data, when `scenarios` is empty. */
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

function gapList<K extends string>(
  gaps: ReadonlyArray<{ key: K; gap: ValueGap }>,
  label: (key: K) => string
): string {
  return gaps.map((entry) => `${label(entry.key)} (${entry.gap})`).join(", ");
}

const MILESTONE_LABEL = (id: MilestoneId) =>
  MILESTONES.find((milestone) => milestone.id === id)?.label ?? id;
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
      rows.push({
        test,
        chatSwitch: test.spec === CHAT_SWITCH_SPEC,
        scenarios: [],
        unavailable: "test skipped",
      });
      continue;
    }

    const final = input.reads.filter(
      (read) => read.testKey === test.key && read.retry === test.finalRetry
    );
    // The chat-switch spec is classified by file, so a summary that lost its `chatSwitch` key never
    // publishes its scope-dependent Chrome totals as an ordinary scenario.
    const chatSwitch =
      test.spec === CHAT_SWITCH_SPEC || final.some((read) => read.ok && read.chatSwitch);
    const workspaceOpen = test.spec === WORKSPACE_OPEN_SPEC;
    const scenarios: ReportScenario[] = [];
    const invalid: string[] = [];
    for (const read of final) {
      if (!read.ok) {
        invalid.push(read.reason);
      } else if (!chatSwitch) {
        if (read.metrics.ok) {
          const { values, unavailable } = read.metrics;
          const milestones = workspaceOpen ? read.milestones : undefined;
          scenarios.push({ label: read.label, values, unavailable, milestones });
          if (unavailable.includes("reactRenders")) {
            problems.push({
              key: `react-profile-unreadable:${test.key}/${read.label}`,
              text: `Scenario ${code(read.label)} has no readable React profile (\`react-profile.json\` is missing or malformed), so React renders are unavailable.`,
            });
          }
          if (milestones && milestones.gaps.length > 0) {
            problems.push({
              key: `milestones-unavailable:${test.key}/${read.label}`,
              text: `Scenario ${code(read.label)} has no usable page milestones for ${gapList(
                milestones.gaps,
                MILESTONE_LABEL
              )}, so those cells are unavailable.`,
            });
          }
        } else {
          invalid.push(read.metrics.reason);
        }
      } else {
        scenarios.push({ label: read.label });
      }
    }
    scenarios.sort((a, b) => a.label.localeCompare(b.label));

    if (invalid[0] !== undefined) {
      const more = invalid.length > 1 ? ` (and ${invalid.length - 1} more)` : "";
      problems.push({
        key: `summary-invalid:${test.key}`,
        text: `Test ${code(test.key)} wrote an unusable summary: ${code(invalid[0])}${more}.`,
      });
    }
    if (scenarios.length > 0) {
      rows.push({ test, chatSwitch, scenarios });
    } else if (invalid.length > 0) {
      rows.push({
        test,
        chatSwitch,
        scenarios,
        unavailable: "final attempt wrote an unusable summary",
      });
    } else {
      rows.push({ test, chatSwitch, scenarios, unavailable: "final attempt wrote no summary" });
      if (test.status !== "unexpected") {
        problems.push({
          key: `summary-missing:${test.key}`,
          text: `Test ${code(test.key)} passed but its final attempt wrote no perf summary.`,
        });
      }
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
// Step summary and job log
// ---------------------------------------------------------------------------

/**
 * The only report line written to the job log. It holds counts only: artifact text (test titles,
 * labels, errors) never reaches stdout/stderr, where the runner would parse workflow commands.
 */
export function formatLogLine(report: Report): string {
  return `perf report: ${report.problems.length} problem(s), ${report.warnings.length} warning(s); details in the job summary`;
}

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

function formatValue(value: number | undefined, decimals: number): string {
  return value === undefined ? "—" : value.toFixed(decimals);
}

function unavailable(row: ReportRow): string {
  return `unavailable: ${sanitizeInline(row.unavailable ?? "no data")}`;
}

function tableHeader(columns: readonly string[], leftColumns: number): string[] {
  return [
    `| ${columns.join(" | ")} |`,
    `|${columns.map((_, index) => (index < leftColumns ? "---" : "---:")).join("|")}|`,
  ];
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
    lines.push("### Tests", "", ...tableHeader(["Test", "Result", "Scenarios"], 3));
    for (const row of rows) {
      const scenarios =
        row.scenarios.length > 0
          ? row.scenarios.map((scenario) => code(scenario.label)).join(", ")
          : unavailable(row);
      lines.push(`| ${code(row.test.key)} | ${outcome(row.test)} | ${scenarios} |`);
    }
    lines.push("", "Every value below comes from each test's final attempt only.", "");
  }

  // Scenario metrics: every non-chat-switch scenario, plus an unavailable row for each such test
  // that has none.
  const metricRows: string[] = [];
  for (const row of rows.filter((entry) => !entry.chatSwitch)) {
    if (row.scenarios.length === 0) {
      const cells = [...METRICS, ...MILESTONES].map(() => "unavailable");
      metricRows.push(`| ${code(row.test.key)} | ${unavailable(row)} | ${cells.join(" | ")} |`);
    }
    for (const scenario of row.scenarios) {
      const cells = METRICS.map((spec) =>
        scenario.unavailable?.includes(spec.id)
          ? "unavailable"
          : formatValue(scenario.values?.[spec.id], spec.decimals)
      );
      const { milestones } = scenario;
      for (const spec of MILESTONES) {
        cells.push(
          milestones === undefined
            ? "—"
            : milestones.values[spec.id] === undefined
              ? "unavailable"
              : formatValue(milestones.values[spec.id], spec.decimals)
        );
      }
      metricRows.push(`| ${code(row.test.key)} | ${code(scenario.label)} | ${cells.join(" | ")} |`);
    }
  }
  const chatSwitchLabels = rows
    .filter((row) => row.chatSwitch)
    .flatMap((row) => row.scenarios.map((scenario) => code(scenario.label)));
  if (metricRows.length > 0 || chatSwitchLabels.length > 0) {
    lines.push("### Scenario metrics", "");
    if (metricRows.length > 0) {
      lines.push(
        ...tableHeader(
          [
            "Test",
            "Scenario",
            ...METRICS.map((spec) => spec.label),
            ...MILESTONES.map((spec) => spec.label),
          ],
          2
        ),
        ...metricRows,
        ""
      );
    }
    lines.push(
      "— means the scenario does not record that metric. Page milestones (the last three columns) are recorded by workspace-open scenarios only."
    );
    if (chatSwitchLabels.length > 0) {
      lines.push(
        "",
        `Chat-switch scenarios (${chatSwitchLabels.join(", ")}) are not listed: their whole-scenario Chrome totals changed scope when server-window switches were added, so they are not comparable over time. Per-leg chat-switch medians are not reported yet (#4442).`
      );
    }
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push("### Warnings", "", ...warnings.map((warning) => `- ${warning}`), "");
  }
  return lines.join("\n");
}
