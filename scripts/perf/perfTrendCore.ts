/**
 * Cross-run perf trends (#4442 phase 2b): pure policy. Slot 0 is the current run,
 * slots 1-16 are earlier scheduled main nights, newest first. A series (one metric of one
 * scenario) regresses when slots 0-2 all exceed the threshold over the median of slots 3-16. A
 * missing artifact, a test without a final-attempt summary or an unusable summary is a gap, never
 * a dropped night, so a streak can never skip a bad night. A failed test whose final attempt wrote
 * a summary keeps its values. Imports only `./perfReportCore` (the job has no `bun install`).
 * Untrusted text reaches the Markdown only through `code()`; the log line holds counts only.
 */
import {
  code,
  formatValue,
  METRICS,
  MILESTONES,
  tableHeader,
  type MetricId,
  type MilestoneId,
  type Report,
} from "./perfReportCore";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`perfTrendCore: ${message}`);
}

/** `gh` prints UTC ISO times. Date.parse alone also accepts strings such as "0". */
function timeOf(createdAt: string): number {
  const time = Date.parse(createdAt);
  const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(createdAt);
  // Bun rolls impossible dates forward (2026-02-30 reads as March 2), so require a round trip.
  const exact = Number.isFinite(time) && new Date(time).toISOString().slice(0, 19);
  assert(iso && exact === createdAt.slice(0, 19), "invalid createdAt");
  return time;
}

export type TrendMetricId = MetricId | MilestoneId;
export type TrendMetric = { id: TrendMetricId; label: string; decimals: number };
export type Values = Partial<Record<TrendMetricId, number>>;
export const TREND_METRICS: readonly TrendMetric[] = [...METRICS, ...MILESTONES];

/** Metrics without a rule (wall, heap, milestones) are report-only: value and delta, no marker. */
export const ALERT_RULES: Partial<Record<TrendMetricId, { rel: number; abs: number }>> = {
  scriptMs: { rel: 0.25, abs: 50 },
  taskMs: { rel: 0.25, abs: 50 },
  layouts: { rel: 0.25, abs: 5 },
  styleRecalcs: { rel: 0.25, abs: 10 },
  reactRenders: { rel: 0.25, abs: 5 },
  hunkStepMedianMs: { rel: 0.5, abs: 3 },
};

/**
 * Values from nights created before their metric's start are gaps. #5210 moved the perf specs to
 * one worker, so earlier nights are not comparable. A PR that changes one metric's meaning bumps
 * that metric's entry; the exhaustive Record makes every new metric declare its start.
 */
export const CONTRACT_START: Record<TrendMetricId, string> = {
  wallMs: "2026-09-29T11:41:33Z",
  scriptMs: "2026-09-29T11:41:33Z",
  taskMs: "2026-09-29T11:41:33Z",
  layouts: "2026-09-29T11:41:33Z",
  styleRecalcs: "2026-09-29T11:41:33Z",
  reactRenders: "2026-09-29T11:41:33Z",
  heapMb: "2026-09-29T11:41:33Z",
  hunkStepMedianMs: "2026-09-29T11:41:33Z",
  firstMessageMs: "2026-09-29T11:41:33Z",
  fullyLoadedMs: "2026-09-29T11:41:33Z",
  longestTaskMs: "2026-09-29T11:41:33Z",
};

const STREAK_NIGHTS = 3;
const BASELINE_NIGHTS = 14;
const HISTORY_NIGHTS = 16;
const MIN_BASELINE_VALUES = 5;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const EARLIEST_START = Math.min(...Object.values(CONTRACT_START).map((start) => Date.parse(start)));

assert(
  STREAK_NIGHTS - 1 + BASELINE_NIGHTS === HISTORY_NIGHTS,
  "history must hold streak + baseline"
);
assert(Number.isFinite(EARLIEST_START), "invalid CONTRACT_START entry");
for (const rule of Object.values(ALERT_RULES)) {
  assert(rule === undefined || (rule.rel > 0 && rule.abs > 0), "rules need rel > 0 and abs > 0");
}

/** One workflow run, with the field names of `gh run list --json`. */
export interface RunInfo {
  databaseId: number;
  event: string;
  headBranch: string;
  status: string;
  createdAt: string;
}

export type NightIssue = "artifact missing or expired" | "no usable summary" | "unusable summary";

export interface Night {
  run: RunInfo;
  /** Scenario label -> metric -> value. Contract-start gaps are already removed. */
  scenarios: Record<string, Values>;
  issue?: NightIssue;
}

/**
 * Earlier scheduled main nights to compare with `current`, newest first. Age counts from the
 * current run, not the wall clock, so any past night can be replayed. Dispatch runs never enter
 * history; a dispatch current run is compared like a nightly (and rendered as a preview).
 */
export function selectHistory<R extends RunInfo>(current: RunInfo, runs: readonly R[]): R[] {
  const now = timeOf(current.createdAt);
  const time = (run: R) => timeOf(run.createdAt);
  // Overlapping listing pages can repeat a run; one run must never fill two slots. Dedupe after
  // filtering and sorting, so the newest eligible copy wins.
  const seen = new Set<number>();
  return runs
    .filter(
      (run) =>
        run.event === "schedule" &&
        run.headBranch === "main" &&
        run.status === "completed" &&
        time(run) < now &&
        now - time(run) <= MAX_AGE_MS &&
        time(run) >= EARLIEST_START
    )
    .sort((a, b) => time(b) - time(a))
    .filter((run) => !seen.has(run.databaseId) && seen.add(run.databaseId))
    .slice(0, HISTORY_NIGHTS);
}

/** Uses only `buildReport` rows, so every value comes from its test's final attempt. */
export function nightFromReport(run: RunInfo, report: Report): Night {
  const created = timeOf(run.createdAt);
  const scenarios: Night["scenarios"] = {};
  // A usable summary from before a metric's contract start is a gap, not "no usable summary".
  let usable = false;
  // Chat-switch rows carry labels only; their per-leg metrics are deferred (#4442).
  for (const row of report.rows.filter((entry) => !entry.chatSwitch)) {
    for (const scenario of row.scenarios) {
      const all: Values = { ...scenario.values, ...scenario.milestones?.values };
      const kept: Values = {};
      usable ||= Object.keys(all).length > 0;
      for (const { id } of TREND_METRICS) {
        if (all[id] !== undefined && created >= Date.parse(CONTRACT_START[id])) kept[id] = all[id];
      }
      scenarios[scenario.label] = kept;
    }
  }
  const keys = report.problems.map((problem) => problem.key);
  const issue: NightIssue | undefined = keys.includes("artifact:missing")
    ? "artifact missing or expired"
    : !usable
      ? "no usable summary"
      : keys.some((key) => key.startsWith("summary-invalid:"))
        ? "unusable summary"
        : undefined;
  return { run, scenarios, issue };
}

export type TrendStatus = "regressed" | "watch" | "ok" | "no-baseline" | "no-data";

export interface SeriesTrend {
  label: string;
  metric: TrendMetric;
  status: TrendStatus;
  value?: number;
  baseline?: number;
  /** Streak nights (slots 0-2) above the threshold. */
  above: number;
  /** No value tonight, but an earlier night has one. */
  lost: boolean;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function evaluateSeries(
  label: string,
  metric: TrendMetric,
  series: Array<number | undefined>
): SeriesTrend {
  const [value] = series;
  const defined = (entry: number | undefined): entry is number => entry !== undefined;
  const values = series.slice(STREAK_NIGHTS, STREAK_NIGHTS + BASELINE_NIGHTS).filter(defined);
  const baseline = values.length >= MIN_BASELINE_VALUES ? median(values) : undefined;
  const rule = ALERT_RULES[metric.id];
  // A zero baseline (React renders) relies on the abs term alone. No rule: report-only.
  const threshold =
    rule && baseline !== undefined
      ? Math.max(baseline * (1 + rule.rel), baseline + rule.abs)
      : Infinity;
  const streak = series.slice(0, STREAK_NIGHTS);
  const above = streak.filter((entry) => defined(entry) && entry > threshold).length;
  let status: TrendStatus = "ok";
  if (value === undefined) status = "no-data";
  else if (baseline === undefined) status = "no-baseline";
  else if (value > threshold) status = above === STREAK_NIGHTS ? "regressed" : "watch";
  const lost = value === undefined && series.slice(1).some(defined);
  return { label, metric, status, value, baseline, above, lost };
}

/** `history` is `selectHistory` order (newest first), one night per selected run. */
export function evaluateTrend(current: Night, history: readonly Night[]): SeriesTrend[] {
  const nights = [current, ...history];
  assert(history.length <= HISTORY_NIGHTS, "too many history nights");
  const ids = new Set(nights.map((night) => night.run.databaseId));
  assert(ids.size === nights.length, "a run fills two slots");
  nights.forEach((night, slot) => {
    assert(Number.isSafeInteger(night.run.databaseId), "invalid run id");
    const newer = slot === 0 ? Infinity : timeOf(nights[slot - 1].run.createdAt);
    assert(timeOf(night.run.createdAt) < newer, "nights must be newest first");
    for (const values of Object.values(night.scenarios)) {
      const valid = (value?: number) =>
        value === undefined || (Number.isFinite(value) && value >= 0);
      assert(Object.values(values).every(valid), "values must be finite and non-negative");
    }
  });
  const labels = [...new Set(nights.flatMap((night) => Object.keys(night.scenarios)))].sort();
  const trends: SeriesTrend[] = [];
  for (const label of labels) {
    for (const metric of TREND_METRICS) {
      const series = nights.map((night) => night.scenarios[label]?.[metric.id]);
      if (series.some((entry) => entry !== undefined))
        trends.push(evaluateSeries(label, metric, series));
    }
  }
  return trends;
}

export interface TrendInput {
  current: Night;
  history: readonly Night[];
  /** Listing or fetching history failed (first line of the error, unsanitized). */
  historyError?: string;
}

function valueText(trend: SeriesTrend): string {
  const value = formatValue(trend.value, trend.metric.decimals);
  if (trend.baseline === undefined) return `${value} (no baseline)`;
  // A zero baseline (React renders) has no meaningful percent.
  if (trend.baseline === 0 || trend.value === undefined) return value;
  const percent = Math.round(((trend.value - trend.baseline) / trend.baseline) * 100);
  return `${value} (${percent >= 0 ? "+" : ""}${percent}%)`;
}

function describe(trend: SeriesTrend): string {
  return `${code(trend.label)} ${trend.metric.label.toLowerCase()} ${valueText(trend)}, ${trend.above} of ${STREAK_NIGHTS} nights above`;
}

function cell(trend: SeriesTrend | undefined): string {
  if (trend === undefined) return "—";
  if (trend.value === undefined) return "no data";
  const marker =
    trend.status === "regressed" ? " **regressed**" : trend.status === "watch" ? " watch" : "";
  return `${valueText(trend)}${marker}`;
}

/** Job summary Markdown. Labels and error text pass through `code()`; numbers are formatted. */
export function renderTrendSummary(input: TrendInput): string {
  const lines = ["## Perf trend", ""];
  const { run } = input.current;
  if (run.event !== "schedule" || run.headBranch !== "main") {
    lines.push("Preview: not a scheduled-main result.", "");
  }
  if (input.historyError !== undefined) {
    // No table: an auth or API error must never look like a cold start.
    const first = input.historyError.split(/[\r\n]/).find((line) => line.trim()) ?? "";
    lines.push("### Problems", "", `- history fetch failed: ${code(first)}`, "");
    return lines.join("\n");
  }
  const { history } = input;
  const trends = evaluateTrend(input.current, history);
  const day = (night: Night) => night.run.createdAt.slice(0, 10);
  lines.push(
    history.length === 0
      ? "No earlier scheduled main nights to compare with."
      : `Compared with ${history.length} scheduled main nights (${day(history[history.length - 1])} to ${day(history[0])}).`,
    ""
  );
  const regressed = trends.filter((trend) => trend.status === "regressed");
  if (regressed.length > 0) {
    lines.push("### Problems", "", ...regressed.map((trend) => `- regressed: ${describe(trend)}`));
    lines.push("");
  }
  const labels = [...new Set(trends.map((trend) => trend.label))];
  if (labels.length > 0) {
    lines.push(...tableHeader(["Scenario", ...TREND_METRICS.map((metric) => metric.label)], 1));
    for (const label of labels) {
      const cells = TREND_METRICS.map((metric) =>
        cell(trends.find((trend) => trend.label === label && trend.metric.id === metric.id))
      );
      lines.push(`| ${code(label)} | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }
  const warnings = trends
    .filter((trend) => trend.status === "watch")
    .map((trend) => `watch: ${describe(trend)}`);
  // Tonight first: a missing current artifact must name its cause, not only lost series.
  for (const night of [input.current, ...history]) {
    if (night.issue !== undefined) warnings.push(`run ${night.run.databaseId}: ${night.issue}`);
  }
  for (const label of labels) {
    const lost = trends.filter((trend) => trend.label === label && trend.lost);
    const metrics = lost.map((trend) => trend.metric.label.toLowerCase()).join(", ");
    if (lost.length > 0)
      warnings.push(`${code(label)} has no value tonight for ${metrics}, but earlier nights do`);
  }
  if (warnings.length > 0)
    lines.push("### Warnings", "", ...warnings.map((text) => `- ${text}`), "");
  return lines.join("\n");
}

/** The only trend line for the job log: counts only, never labels, keys or error text. */
export function formatTrendLogLine(input: TrendInput): string {
  if (input.historyError !== undefined) {
    return "perf trend: history fetch failed; details in the job summary";
  }
  const trends = evaluateTrend(input.current, input.history);
  const count = (status: TrendStatus) => trends.filter((trend) => trend.status === status).length;
  const lost = trends.filter((trend) => trend.lost).length;
  return `perf trend: ${count("regressed")} regressed, ${count("watch")} watch, ${lost} lost series over ${input.history.length} nights; details in the job summary`;
}
