#!/usr/bin/env bun
/**
 * Nightly perf report for `.github/workflows/perf-profiles.yml` (job `perf-report`).
 *
 * Reads this run's perf artifact and writes per-test outcomes and scenario metrics to
 * $GITHUB_STEP_SUMMARY (stdout when unset). The logic lives in perfReportCore.ts next to this file,
 * where perfReport.test.ts tests it; keep this file to I/O. It makes no GitHub API calls and uses
 * only Bun/Node built-ins, so it needs no token and no `bun install`.
 *
 * Local replay of a past run:
 *   gh run download <id> -R coder/xum -n perf-artifacts-<id> -D /tmp/perf-<id>
 *   bun scripts/perf/perfReport.ts --current /tmp/perf-<id> --perf-result success
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { Glob } from "bun";
import {
  buildReport,
  formatLogLine,
  parsePlaywrightResults,
  readScenario,
  renderSummary,
  sanitizeForLog,
  type PlaywrightResults,
  type ScenarioRead,
} from "./perfReportCore";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Works for both layouts: actions/download-artifact and `gh run download -n`. */
function readRunDir(dir: string): {
  artifactFound: boolean;
  reads: ScenarioRead[];
  results?: PlaywrightResults;
} {
  if (!existsSync(dir) || readdirSync(dir).length === 0) return { artifactFound: false, reads: [] };
  const reads: ScenarioRead[] = [];
  for (const rel of new Glob("**/perf/electron/*/perf-summary.json").scanSync({ cwd: dir })) {
    const summaryPath = join(dir, rel);
    const reactPath = join(dirname(summaryPath), "react-profile.json");
    // The React profile is optional: an unreadable one only loses the React renders metric.
    let react: unknown;
    try {
      react = existsSync(reactPath) ? readJson(reactPath) : undefined;
    } catch {
      react = undefined;
    }
    try {
      reads.push(readScenario(readJson(summaryPath), react));
    } catch (error) {
      // Unparseable JSON: no identity is known, so it is reported as an unattributed summary.
      reads.push({ ok: false, label: basename(dirname(summaryPath)), reason: errorMessage(error) });
    }
  }
  let results: PlaywrightResults | undefined;
  const [resultsRel] = [...new Glob("**/perf/playwright-results.json").scanSync({ cwd: dir })];
  if (resultsRel !== undefined) {
    try {
      results = parsePlaywrightResults(readJson(join(dir, resultsRel)));
    } catch (error) {
      results = { ok: false, error: errorMessage(error) };
    }
  }
  return { artifactFound: true, reads, results };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      current: { type: "string" },
      "perf-result": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !values.current || !values["perf-result"]) {
    console.log(
      "Usage: bun scripts/perf/perfReport.ts --current <artifact dir> --perf-result <success|failure|cancelled|skipped>\n" +
        "Env (optional): GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID for the run link; GITHUB_STEP_SUMMARY."
    );
    process.exit(values.help ? 0 : 2);
  }
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const repo = process.env.GITHUB_REPOSITORY ?? "coder/xum";
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const runUrl = runId ? `${server}/${repo}/actions/runs/${runId}` : `${server}/${repo}/actions`;

  const dir = readRunDir(values.current);
  const report = buildReport({
    perfResult: values["perf-result"],
    artifactFound: dir.artifactFound,
    results: dir.results,
    reads: dir.reads,
  });
  const markdown = renderSummary({ runUrl, perfResult: values["perf-result"], report });
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, markdown);
  // In GitHub Actions stdout is the job log, which parses workflow commands, so the Markdown (it
  // holds artifact text) goes only to the step summary. Local runs print it.
  else if (process.env.GITHUB_ACTIONS !== "true") console.log(markdown);
  // One counts-only log line so the job log shows the verdict without opening the summary. The
  // step still exits 0: the perf job's own result already marks a failed run red.
  console.error(formatLogLine(report));
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    // The message may quote artifact text (a path, a parse error), so it is sanitized for the log.
    console.error(`perf report: crashed: ${sanitizeForLog(errorMessage(error))}`);
    process.exit(1);
  }
}
