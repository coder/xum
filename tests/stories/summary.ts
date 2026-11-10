/**
 * The story lane's CI helper (.github/workflows/stories.yml), after one `make test-stories`.
 *
 * - `bun tests/stories/summary.ts` prints the page for the job summary: e2e's own page
 *   (renderMarkdownReport) of every story job (`tests/stories/.e2e/stories-*`), Electron story
 *   job (`tests/stories/.e2e/stories-electron-*`) and agent-repros job
 *   (`tests/bugbash/.e2e/agent-repros-*`), each with its spend from `<job>.spend.json`
 *   (launch.ts) under its headline. The PR comment (prComment.ts) is this same page, so the job
 *   summary looks like it (the user's pick). A missing or broken report gives a headline that
 *   says so: the summary runs after a failed run too, and must show what is there.
 * - `--next-seed <dir>` replaces `<dir>` with the replay caches (`<job>/cache/*.json`) of the
 *   newest web story job and the newest Electron story job that recorded one, so the next run
 *   replays them. Both jobs start from the one seed (seedCacheDir copies it into each cache), so
 *   the next seed is their union, less each entry of `<dir>` that one of them deleted (e2e deletes
 *   an entry that replayed into a failure). Only names that checkSeed accepts are copied: the
 *   newest by `createdAt`, at most MAX_SEED_ENTRIES and MAX_SEED_BYTES in all, so the next launch
 *   never refuses the seed. Without such a job, `<dir>` stays as it is.
 * - `--upstream-fault` decides the lane's one retry: exit 0 only when a job failed and every
 *   failed job's proxy record (`<job>.proxy.jsonl`, launch.ts) holds a provider 5xx, else exit 1.
 *   It prints one line that says why.
 *
 * No import beyond node, the repo and e2e: CI runs it with plain bun, and the PR comment job
 * installs with no lifecycle scripts (pr.yml stories-pr-comment).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdownReport } from "e2e";
import {
  checkSeed,
  isSeedEntry,
  MAX_SEED_BYTES,
  MAX_SEED_ENTRIES,
} from "../bugbash/sandbox/cacheSeed";
import { UNREACHABLE } from "../bugbash/sandbox/proxy";

/**
 * Where make test-stories puts each job's output folder; the story kinds record a cache. The
 * `project` is the job's e2e project (its config's folder), which the report's paths start at.
 */
const JOB_KINDS = [
  {
    dir: "tests/stories/.e2e",
    prefix: "stories-",
    not: "stories-electron-",
    cache: true,
    label: "stories",
    project: "tests/stories",
  },
  {
    dir: "tests/stories/.e2e",
    prefix: "stories-electron-",
    cache: true,
    label: "Electron stories",
    project: "tests/stories",
  },
  {
    dir: "tests/bugbash/.e2e",
    prefix: "agent-repros-",
    cache: false,
    label: "agent repros",
    project: "tests/bugbash",
  },
] as const;
type JobKind = (typeof JOB_KINDS)[number];

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  v != null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const PROXY_LOG = ".proxy.jsonl";

/**
 * The job output folders of one kind, oldest first. The names carry the UTC start time
 * (Makefile), so name order is start order. The preflight's name is not a job. With
 * `logOnly`, also the outputs that have only a proxy record: a job whose probe call failed
 * (launch.ts) never made its folder.
 */
function jobFolders(root: string, kind: JobKind, logOnly = false): string[] {
  const base = path.join(root, kind.dir);
  if (!fs.existsSync(base)) return [];
  const not = "not" in kind ? kind.not : undefined;
  const names = fs.readdirSync(base, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return [e.name];
    if (logOnly && e.isFile() && e.name.endsWith(PROXY_LOG))
      return [e.name.slice(0, -PROXY_LOG.length)];
    return [];
  });
  return [...new Set(names)]
    .filter((name) => name.startsWith(kind.prefix))
    .filter((name) => not == null || !name.startsWith(not))
    .filter((name) => !name.endsWith("-preflight"))
    .map((name) => path.join(base, name))
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

/** What a job's page links to and names. prComment.ts passes the links, the job summary none. */
export interface PageOptions {
  /** The lane's model (BUGBASH_MODEL), named in each page's title: "stories (Haiku)". */
  model?: string;
  /** Where the run's artifacts are (the run page's #artifacts): each evidence link goes there. */
  artifactsUrl?: string;
  /** A link to a line of a file at the tested commit, the path from the checkout root. */
  sourceUrl?: (file: string, line: number) => string;
}

/** One job's part of the page: the e2e page with our spend line under its headline. */
export interface JobSection {
  passed: boolean;
  /** The headline, e2e's spend line and ours: what a passing job folds to. */
  head: string;
  /** The rest of the e2e page: the failures, the folds and the footer. */
  rest: string;
}

/** "Haiku" for anthropic:claude-haiku-5-5; the model name for a model of another family. */
function modelLabel(model: string): string {
  const family = /haiku|sonnet|opus/i.exec(model)?.[0];
  if (family != null) return family[0].toUpperCase() + family.slice(1).toLowerCase();
  return model.replace(/^[^:]*:/, "");
}

/**
 * The job's spend from `<job>.spend.json` (launch.ts): the proxy ledger, at list price. e2e's
 * own spend line shows no cost for these jobs (their reports carry no estimatedCostUsd).
 */
/**
 * Untrusted text as one inline code span: GitHub renders no link, mention or markup inside it.
 * The fence is one backtick longer than the longest run in the text, so the text cannot close it.
 */
function codeSpan(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ");
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

function spendLine(folder: string): string {
  const read = readJson(`${folder}.spend.json`);
  const spend = "value" in read ? obj(read.value) : undefined;
  // spend.json comes back from the sandbox, so a PR run controls its text: only numbers and
  // code spans reach the comment (Phase 4 advisor review of #7140).
  if (spend == null)
    return `Spend: no record (spend.json ${"problem" in read ? codeSpan(read.problem) : "is not an object"})`;
  const usd = (v: unknown) => `$${(num(v) ?? 0).toFixed(2)}`;
  let line = `Spend: ${usd(spend.spentUsd)} of the ${usd(spend.capUsd)} cap (proxy ledger)`;
  const refused = num(spend.refused) ?? 0;
  if (refused > 0)
    line += `, ${refused} calls refused ${codeSpan(JSON.stringify(spend.refusedBy ?? {}))}`;
  return line;
}

type Report = Parameters<typeof renderMarkdownReport>[0];

/** One job's section: the e2e page of its report.json, or a headline that says what is wrong. */
function jobSection(folder: string, kind: JobKind, options: PageOptions): JobSection {
  const title = options.model ? `${kind.label} (${modelLabel(options.model)})` : kind.label;
  const spend = spendLine(folder);
  const broken = (problem: string): JobSection => ({
    passed: false,
    head: `### 🔴 e2e ${title}: report.json ${problem}\n${spend}`,
    rest: "",
  });
  const read = readJson(path.join(folder, "report.json"));
  if ("problem" in read) return broken(read.problem);
  const report = obj(read.value);
  const run = obj(report?.run);
  if (report?.schemaVersion !== "report-1" || !Array.isArray(run?.results))
    return broken("is not an e2e report-1 document");
  const sourceUrl = options.sourceUrl;
  let page: string;
  try {
    page = renderMarkdownReport(report as unknown as Report, {
      title,
      artifactsUrl: options.artifactsUrl,
      // The report's files are relative to the e2e project (the config's folder).
      sourceUrl:
        sourceUrl && ((file, line) => sourceUrl(path.posix.join(kind.project, file), line)),
    });
  } catch {
    // The file is the job's output, made in the sandbox: a shape e2e cannot read is a broken job.
    return broken("could not be rendered");
  }
  // e2e's page opens with its head (the headline, then its spend line) and a blank line.
  const cut = page.indexOf("\n\n");
  const head = cut === -1 ? page.trimEnd() : page.slice(0, cut);
  const rest = cut === -1 ? "" : page.slice(cut + 2);
  return { passed: run?.status === "passed", head: `${head}\n${spend}`, rest };
}

/** Each job's section, in JOB_KINDS order (the order make test-stories runs them), oldest first. */
export function jobSections(root: string, options: PageOptions = {}): JobSection[] {
  return JOB_KINDS.flatMap((kind) =>
    jobFolders(root, kind).map((folder) => jobSection(folder, kind, options))
  );
}

export const NO_OUTPUT_NOTE =
  "No job left output: `make test-stories` stopped before its first job. See the run log.";
export const CLIPPED_NOTE =
  "_Clipped to fit a pull request comment: the full reports are in the run artifacts._";

/** The first lines of `text` that fit in `max` characters with the note, its open folds closed. */
function clip(text: string, max: number): string {
  const lines = text.split("\n");
  const render = (count: number) => {
    const kept = lines.slice(0, count);
    const tags = (tag: string) => kept.filter((line) => line.includes(tag)).length;
    const unclosed = Math.max(0, tags("<details") - tags("</details>"));
    return [...kept, ...Array<string>(unclosed).fill("</details>"), "", CLIPPED_NOTE].join("\n");
  };
  let count = 0;
  let size = CLIPPED_NOTE.length + 2;
  while (count < lines.length && size + lines[count].length + 1 <= max)
    size += lines[count++].length + 1;
  while (count > 0 && render(count).length > max) count--; // room for the closing tags
  return render(count);
}

/**
 * The page of the jobs (jobSections), one section per job, at most `maxChars` long. The PR
 * comment (prComment.ts) and the job summary show this same page (the user's pick: one format
 * everywhere). Over the limit, passing jobs fold to their head first; then each other job's rest
 * gets an equal share and is clipped to it.
 */
export function storyPage(
  sections: readonly JobSection[],
  maxChars = Number.POSITIVE_INFINITY
): string {
  if (sections.length === 0) return `${NO_OUTPUT_NOTE}\n`;
  const render = (parts: readonly JobSection[]) =>
    parts.map((p) => (p.rest === "" ? `${p.head}\n` : `${p.head}\n\n${p.rest}`)).join("\n");
  let parts = [...sections];
  if (render(parts).length <= maxChars) return render(parts);
  parts = parts.map((p) => (p.passed ? { ...p, rest: "" } : p));
  if (render(parts).length <= maxChars) return render(parts);
  const heads = render(parts.map((p) => ({ ...p, rest: "" }))).length;
  const open = parts.filter((p) => p.rest !== "").length;
  // Each rest adds a blank line before it and a newline after it.
  const share = Math.floor((maxChars - heads) / open) - 2;
  return render(parts.map((p) => (p.rest === "" ? p : { ...p, rest: `${clip(p.rest, share)}\n` })));
}

/**
 * Whether a proxy record line is a provider fault: a 5xx from the provider itself (no reason),
 * or a call the proxy could not get to it or through it. Not the proxy's own 502s (a deadline,
 * a client that went away, a redirect): those are no provider 5xx. Its refusals are all 4xx.
 */
function providerFault(line: string, started: boolean): boolean {
  let record: Json | undefined;
  try {
    record = obj(JSON.parse(line));
  } catch {
    return false; // a cut-off last line
  }
  const status = num(record?.status);
  if (status == null || status < 500) return false;
  const reason = record?.reason;
  if (reason == null || reason === UNREACHABLE || reason === "upstream: failed") return true;
  // A job with no folder never started: the launcher refused it after its model probe. A
  // deadline abort there means the provider did not answer the probe in time (a silent
  // upstream, seen in local runs), not a test that timed out mid-call (#7070 item 1).
  return !started && typeof reason === "string" && reason.startsWith("aborted:");
}

/**
 * Whether `make test-stories` gets its one more run (header): every job that failed, and at
 * least one did, has a provider 5xx in its proxy record. A job failed when its report is not
 * an e2e pass (or is missing). Make stops at the first failed job, so the jobs after it left no
 * output and do not count.
 */
export function upstreamFault(root: string): { retry: boolean; reason: string } {
  const jobs = JOB_KINDS.flatMap((kind) => jobFolders(root, kind, true)).map((folder) => {
    const report = readJson(path.join(folder, "report.json"));
    const run = "value" in report ? obj(obj(report.value)?.run) : undefined;
    // The launcher creates the job folder only once the job starts, after its model probe.
    return { folder, started: fs.existsSync(folder), passed: run?.status === "passed" };
  });
  const failed = jobs.filter((job) => !job.passed);
  if (failed.length === 0) return { retry: false, reason: "no job failed" };
  for (const { folder, started } of failed) {
    let text: string;
    try {
      text = fs.readFileSync(`${folder}${PROXY_LOG}`, "utf8");
    } catch {
      return { retry: false, reason: `\`${path.basename(folder)}\` failed with no proxy record` };
    }
    if (!text.split("\n").some((line) => providerFault(line, started)))
      return { retry: false, reason: `\`${path.basename(folder)}\` failed with no provider 5xx` };
  }
  const names = failed.map(({ folder }) => `\`${path.basename(folder)}\``).join(", ");
  return { retry: true, reason: `every failed job got a provider 5xx: ${names}` };
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

interface CacheEntry {
  file: string;
  recordedMs: number;
  size: number;
}

/** The valid entries of the newest job of `kind` whose cache holds one, or null. */
function newestCache(root: string, kind: JobKind): CacheEntry[] | null {
  for (const folder of jobFolders(root, kind).reverse()) {
    const cache = path.join(folder, "cache");
    if (!fs.existsSync(cache)) continue;
    const entries = fs
      .readdirSync(cache)
      .map((name) => path.join(cache, name))
      .filter(isSeedEntry)
      .map((file) => {
        const st = fs.statSync(file);
        return { file, recordedMs: recordedAt(file) ?? st.mtimeMs, size: st.size };
      });
    if (entries.length > 0) return entries;
  }
  return null;
}

/**
 * Replaces the seed folder `seed` with the story jobs' cache entries (header). Returns the
 * number of entries, or null when no job recorded one and `seed` was left alone.
 */
export function nextSeed(root: string, seed: string): number | null {
  const before = fs.existsSync(seed) ? fs.readdirSync(seed) : [];
  const byName = new Map<string, CacheEntry>();
  const deleted = new Set<string>();
  let found = false;
  for (const kind of JOB_KINDS.filter((k) => k.cache)) {
    const entries = newestCache(root, kind);
    if (entries == null) continue;
    found = true;
    const names = new Set(entries.map((e) => path.basename(e.file)));
    // The job's cache started as a copy of this seed: an entry it lacks, e2e deleted.
    for (const name of before) if (!names.has(name)) deleted.add(name);
    for (const entry of entries) {
      const name = path.basename(entry.file);
      const other = byName.get(name);
      if (other == null || entry.recordedMs > other.recordedMs) byName.set(name, entry);
    }
  }
  if (!found) return null;
  for (const name of deleted) byName.delete(name);
  const entries = [...byName.values()]
    // Newest recording first; the name breaks ties, so the cut is the same on every run. Not the
    // mtime: each copy into the sandbox and back (seedCacheDir, the export) resets it.
    .sort(
      (a, b) =>
        b.recordedMs - a.recordedMs || path.basename(a.file).localeCompare(path.basename(b.file))
    )
    .slice(0, MAX_SEED_ENTRIES);
  // Also within checkSeed()'s byte cap, so the next launch never refuses the seed.
  let bytes = 0;
  const kept = entries.findIndex((entry) => (bytes += entry.size) > MAX_SEED_BYTES);
  if (kept >= 0) entries.splice(kept);
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

if (import.meta.main) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stdout.write(storyPage(jobSections(root, { model: process.env.BUGBASH_MODEL })));
  } else if (args.length === 2 && args[0] === "--next-seed") {
    const count = nextSeed(root, path.resolve(args[1]));
    console.error(
      count == null
        ? "next seed: no story job recorded a cache entry; the seed stays as it was"
        : `next seed: ${count} entries`
    );
  } else if (args.length === 1 && args[0] === "--upstream-fault") {
    const { retry, reason } = upstreamFault(root);
    console.log(`${retry ? "Retrying make test-stories once" : "No retry"}: ${reason}.`);
    process.exit(retry ? 0 : 1);
  } else {
    console.error("usage: bun tests/stories/summary.ts [--next-seed <dir> | --upstream-fault]");
    process.exit(2);
  }
}
