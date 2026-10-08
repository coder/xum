#!/usr/bin/env bun
/**
 * Nightly perf trend (`.github/workflows/perf-profiles.yml`, job `perf-trend`, #4442 phase 2b).
 * Compares this run's perf artifact with up to 16 earlier scheduled main nights fetched with `gh`
 * (GH_TOKEN needs `actions: read`) and writes perfTrendCore's Markdown to $GITHUB_STEP_SUMMARY
 * (stdout outside Actions). Any failure while fetching or checking history becomes one "history
 * fetch failed" problem and exit 0; only a crash exits 1, with one sanitized log line. Replay a
 * past night (the 30-day window counts from that run) with GITHUB_RUN_ID=<id> and its artifact.
 */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readRunDir } from "./perfReport";
import { buildReport, sanitizeForLog, type Report } from "./perfReportCore";
import * as trend from "./perfTrendCore";

/** One artifact is about 43 MB. */
const PARALLEL_DOWNLOADS = 4;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const EARLIEST_START = Math.min(...Object.values(trend.CONTRACT_START).map((s) => Date.parse(s)));

type Run = trend.RunInfo & { conclusion: string };

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Output is piped, never inherited; a non-zero exit throws with the first stderr line. */
async function gh(args: string[]): Promise<string> {
  const child = Bun.spawn(["gh", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode === 0) return out;
  throw new Error(err.split("\n").find((line) => line.trim()) ?? `gh exited with ${exitCode}`);
}

async function api(path: string, fields: string[] = []): Promise<Record<string, unknown>> {
  const json: unknown = JSON.parse(await gh(["api", "-X", "GET", path, ...fields]));
  if (typeof json !== "object" || json === null) throw new Error(`unexpected response for ${path}`);
  return json as Record<string, unknown>;
}

/** REST run -> RunInfo. Ids become API paths and directory names, so only positive integers pass. */
function toRun(raw: unknown): Run {
  const run = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (!Number.isSafeInteger(run.id) || Number(run.id) <= 0) throw new Error("invalid run id");
  const keys = ["event", "head_branch", "status", "created_at", "conclusion"];
  const [event, headBranch, status, createdAt, conclusion] = keys.map((key) =>
    typeof run[key] === "string" ? run[key] : ""
  );
  return { databaseId: Number(run.id), event, headBranch, status, createdAt, conclusion };
}

/** A missing or expired artifact is an empty night (a gap with a warning), never a dropped one. */
async function fetchNight(repo: string, run: Run, tmp: string): Promise<trend.Night> {
  const name = `perf-artifacts-${run.databaseId}`;
  const path = `repos/${repo}/actions/runs/${run.databaseId}/artifacts`;
  const { artifacts } = await api(path, ["-f", `name=${name}`]);
  if (!Array.isArray(artifacts)) throw new Error("malformed artifact listing");
  const live = (artifacts as Array<{ name?: unknown; expired?: unknown }>).some(
    (entry) => entry.name === name && entry.expired === false
  );
  const dir = join(tmp, String(run.databaseId));
  try {
    if (live)
      await gh(["run", "download", String(run.databaseId), "-R", repo, "-n", name, "-D", dir]);
    const read = live ? readRunDir(dir) : { artifactFound: false, reads: [] };
    return trend.nightFromReport(run, buildReport({ perfResult: run.conclusion, ...read }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function fetchTrendInput(repo: string, runId: string, report: Report, tmp: string) {
  const current = toRun(await api(`repos/${repo}/actions/runs/${runId}`));
  const currentNight = trend.nightFromReport(current, report);
  // Bounded by the current run, so newer runs never fill the page during an old-run replay.
  const from = new Date(Math.max(Date.parse(current.createdAt) - MAX_AGE_MS, EARLIEST_START));
  const filters = ["branch=main", "event=schedule", "status=completed", "per_page=100"];
  const created = `created=${from.toISOString()}..${current.createdAt}`;
  const fields = [...filters, created].flatMap((field) => ["-f", field]);
  const listing = await api(`repos/${repo}/actions/workflows/perf-profiles.yml/runs`, fields);
  const { total_count: total, workflow_runs: runs } = listing;
  if (!Array.isArray(runs) || typeof total !== "number") throw new Error("malformed run listing");
  if (total > runs.length) throw new Error(`run listing truncated (${total} runs)`);
  const selected = trend.selectHistory(current, runs.map(toRun));
  const history: trend.Night[] = [];
  for (let start = 0; start < selected.length; start += PARALLEL_DOWNLOADS) {
    const batch = selected.slice(start, start + PARALLEL_DOWNLOADS);
    // Every started download settles before the caller removes the temp root.
    const settled = await Promise.allSettled(batch.map((run) => fetchNight(repo, run, tmp)));
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
      history.push(result.value);
    }
  }
  return { current: currentNight, history } satisfies trend.TrendInput;
}

async function main(): Promise<void> {
  const options = { current: { type: "string" }, "perf-result": { type: "string" } } as const;
  const { values } = parseArgs({ options });
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId } = process.env;
  if (!values.current || !values["perf-result"] || !repo || !runId) {
    console.log("Usage: bun scripts/perf/perfTrend.ts --current <dir> --perf-result <result>");
    console.log("Env: GITHUB_REPOSITORY, GITHUB_RUN_ID, GH_TOKEN; optional GITHUB_STEP_SUMMARY.");
    process.exit(2);
  }
  const report = buildReport({ perfResult: values["perf-result"], ...readRunDir(values.current) });
  const tmp = mkdtempSync(join(tmpdir(), "perf-trend-"));
  let input: trend.TrendInput;
  let markdown: string;
  try {
    input = await fetchTrendInput(repo, runId, report, tmp);
    // Rendering evaluates the trend, which rejects malformed history (such as two nights with one
    // createdAt), so it stays inside the try and becomes a history error too.
    markdown = trend.renderTrendSummary(input);
  } catch (error) {
    // The current-run fetch may have failed, so the preview header falls back to the Actions env.
    const { GITHUB_EVENT_NAME: event = "", GITHUB_REF_NAME: headBranch = "" } = process.env;
    const run = { databaseId: 0, event, headBranch, status: "", createdAt: "" };
    input = { current: { run, scenarios: {} }, history: [], historyError: errorMessage(error) };
    markdown = trend.renderTrendSummary(input);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, markdown);
  // In Actions stdout is the job log, which parses workflow commands; the Markdown holds API and
  // artifact text, so it goes only to the step summary there.
  else if (process.env.GITHUB_ACTIONS !== "true") console.log(markdown);
  console.error(trend.formatTrendLogLine(input));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    // The message may quote API or artifact text (a path, a parse error), so it is sanitized.
    console.error(`perf trend: crashed: ${sanitizeForLog(errorMessage(error))}`);
    process.exit(1);
  });
}
