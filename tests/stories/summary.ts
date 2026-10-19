/**
 * The story lane's CI helper (.github/workflows/stories.yml), after one `make test-stories`.
 *
 * - `bun tests/stories/summary.ts` prints one Markdown table for the job summary: a row per
 *   selected test of every story job (`tests/stories/.e2e/stories-*`) and agent-repros job
 *   (`tests/bugbash/.e2e/agent-repros-*`), then one line per job with its spend from
 *   `<job>.spend.json` (launch.ts). A missing or broken report gives a row that says so: the
 *   summary runs after a failed run too, and must show what is there.
 * - `--next-seed <dir>` replaces `<dir>` with the replay cache (`<job>/cache/*.json`) of the
 *   newest story job that recorded one, so the next run replays it. That cache already holds
 *   the seed the job started with (seedCacheDir copies it in), so nothing else is merged. Only
 *   names that checkSeed accepts are copied: the newest by `createdAt`, at most MAX_SEED_ENTRIES and
 *   MAX_SEED_BYTES in all, so the next launch never refuses the seed. Without such a job, `<dir>` stays as it is.
 *
 * No import beyond node and the repo: CI runs it with plain bun.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkSeed,
  isSeedEntry,
  MAX_SEED_BYTES,
  MAX_SEED_ENTRIES,
} from "../bugbash/sandbox/cacheSeed";

/** Where make test-stories puts each job's output folder; the first kind records the cache. */
const JOB_KINDS = [
  { dir: "tests/stories/.e2e", prefix: "stories-" },
  { dir: "tests/bugbash/.e2e", prefix: "agent-repros-" },
] as const;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  v != null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * The job output folders of one kind, oldest first. The names carry the UTC start time
 * (Makefile), so name order is start order. The preflight's name is not a job.
 */
function jobFolders(root: string, kind: (typeof JOB_KINDS)[number]): string[] {
  const base = path.join(root, kind.dir);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(kind.prefix))
    .filter((e) => !e.name.endsWith("-preflight"))
    .map((e) => path.join(base, e.name))
    .sort();
}

/** The parsed JSON file, or why there is none. */
function readJson(file: string): { value: unknown } | { problem: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { problem: "missing" };
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { problem: "not valid JSON (cut off?)" };
  }
}

/** A table cell: one line, with no `|` that would split it. */
const cell = (text: string) => text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

const CACHE_MODES = ["self-finalized", "agent-concluded", "missed"] as const;

/** One table row (without the job cell) for a result of report-1 (e2e report/build.d.ts). */
function resultRow(result: Json): string[] {
  const title = list(result.titlePath).filter((t) => typeof t === "string");
  const attempts = list(result.attempts)
    .map(obj)
    .filter((a) => a != null);
  const durationMs = attempts.reduce((sum, a) => sum + (num(a.durationMs) ?? 0), 0);
  // Model calls are per step (`step.model.calls`, e2e run/steps.d.ts StepModelInfo).
  const calls: number[] = [];
  const cache: Record<string, number> = { "self-finalized": 0, "agent-concluded": 0, missed: 0 };
  for (const attempt of attempts)
    for (const step of list(attempt.steps)) {
      const mode = obj(obj(step)?.cache)?.mode;
      if (typeof mode === "string" && mode in cache) cache[mode] += 1;
      const stepCalls = num(obj(obj(step)?.model)?.calls);
      if (stepCalls != null) calls.push(stepCalls);
    }
  const status = typeof result.status === "string" ? result.status : "unknown";
  return [
    title.length > 0 ? title.join(" › ") : "(no title)",
    attempts.length > 1 ? `${status} (${attempts.length} attempts)` : status,
    `${(durationMs / 1000).toFixed(1)} s`,
    CACHE_MODES.map((m) => cache[m]).join(" / "),
    calls.length > 0 ? String(calls.reduce((a, b) => a + b, 0)) : "-",
  ];
}

/** The rows of one job's report.json: one per selected test, or one that says what is wrong. */
function jobRows(folder: string): string[][] {
  const read = readJson(path.join(folder, "report.json"));
  if ("problem" in read) return [[`(report.json ${read.problem})`, "-", "-", "-", "-"]];
  const results = obj(obj(read.value)?.run)?.results;
  if (!Array.isArray(results)) return [["(report.json has no run.results)", "-", "-", "-", "-"]];
  // A test the selection left out (a tag filter) is in the report as skipped, for the record.
  const selected = results.map(obj).filter((r) => r != null && r.selected !== false) as Json[];
  if (selected.length === 0) return [["(no test selected)", "-", "-", "-", "-"]];
  return selected.map(resultRow);
}

/** The job's line under the table: the e2e run status and the spend from `<job>.spend.json`. */
function jobLine(folder: string): string {
  const report = readJson(path.join(folder, "report.json"));
  const run = "value" in report ? obj(obj(report.value)?.run) : undefined;
  const status = typeof run?.status === "string" ? `e2e ${run.status}` : "no e2e status";
  const read = readJson(`${folder}.spend.json`);
  const spend = "value" in read ? obj(read.value) : undefined;
  let money = `spend.json ${"problem" in read ? read.problem : "is not an object"}`;
  if (spend != null) {
    const usd = (v: unknown) => `$${(num(v) ?? 0).toFixed(2)}`;
    money =
      `${usd(spend.spentUsd)} spent of the ${usd(spend.capUsd)} cap, ` +
      `${num(spend.settled) ?? 0} calls settled, ${num(spend.refused) ?? 0} refused`;
    if ((num(spend.refused) ?? 0) > 0) money += ` ${JSON.stringify(spend.refusedBy ?? {})}`;
  }
  return `- \`${path.basename(folder)}\`: ${status}. ${money}.`;
}

/** The Markdown summary of every job output under `root` (a checkout). */
export function summarize(root: string): string {
  const folders = JOB_KINDS.flatMap((kind) => jobFolders(root, kind));
  const lines = ["### Story tests", ""];
  if (folders.length === 0) {
    lines.push("No job left output: `make test-stories` stopped before its first job.");
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    "| Job | Test | Status | Duration | Cache: self-finalized / agent-concluded / missed | Model calls |",
    "| --- | --- | --- | --- | --- | --- |"
  );
  for (const folder of folders)
    for (const row of jobRows(folder))
      lines.push(`| ${[`\`${path.basename(folder)}\``, ...row].map(cell).join(" | ")} |`);
  lines.push("", ...folders.map(jobLine));
  return `${lines.join("\n")}\n`;
}

/** When e2e recorded the entry (its `createdAt`, e2e cache/store.js), or null if unreadable. */
function recordedAt(file: string): number | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const createdAt = obj(parsed)?.createdAt;
    const ms = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * Replaces the seed folder `seed` with the newest story job's cache entries (header). Returns
 * the number of entries, or null when no job recorded one and `seed` was left alone.
 */
export function nextSeed(root: string, seed: string): number | null {
  for (const folder of jobFolders(root, JOB_KINDS[0]).reverse()) {
    const cache = path.join(folder, "cache");
    if (!fs.existsSync(cache)) continue;
    const entries = fs
      .readdirSync(cache)
      .map((name) => path.join(cache, name))
      .filter(isSeedEntry)
      .map((file) => {
        const st = fs.statSync(file);
        return { file, recordedMs: recordedAt(file) ?? st.mtimeMs, size: st.size };
      })
      // Newest recording first; the name breaks ties, so the cut is the same on every run. Not the
      // mtime: each copy into the sandbox and back (seedCacheDir, the export) resets it.
      .sort((a, b) => b.recordedMs - a.recordedMs || a.file.localeCompare(b.file))
      .slice(0, MAX_SEED_ENTRIES);
    // Also within checkSeed()'s byte cap, so the next launch never refuses the seed.
    let bytes = 0;
    const kept = entries.findIndex((entry) => (bytes += entry.size) > MAX_SEED_BYTES);
    if (kept >= 0) entries.splice(kept);
    if (entries.length === 0) continue;
    fs.mkdirSync(path.dirname(seed), { recursive: true });
    // A sibling first, then the swap: a failed copy leaves the old seed in place.
    const next = fs.mkdtempSync(`${seed}.next-`);
    try {
      for (const { file } of entries) {
        const to = path.join(next, path.basename(file));
        fs.copyFileSync(file, to, fs.constants.COPYFILE_EXCL);
      }
      fs.rmSync(seed, { recursive: true, force: true });
      fs.renameSync(next, seed);
    } catch (error) {
      fs.rmSync(next, { recursive: true, force: true });
      throw error;
    }
    // The launcher runs this same check on the next run: fail here, where the cause is.
    const names = checkSeed(seed, (reason) => new Error(`next seed: ${reason}`));
    if (names.length !== entries.length)
      throw new Error(`next seed: ${names.length} files, expected ${entries.length}`);
    return names.length;
  }
  return null;
}

if (import.meta.main) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stdout.write(summarize(root));
  } else if (args.length === 2 && args[0] === "--next-seed") {
    const count = nextSeed(root, path.resolve(args[1]));
    console.error(
      count == null
        ? "next seed: no story job recorded a cache entry; the seed stays as it was"
        : `next seed: ${count} entries`
    );
  } else {
    console.error("usage: bun tests/stories/summary.ts [--next-seed <dir>]");
    process.exit(2);
  }
}
