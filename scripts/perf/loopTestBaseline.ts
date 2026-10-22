/**
 * Loop test baseline (agent loop refactor, phase 1): times every loop test file in fresh
 * `bun test` processes and records time, failed runs, temp-dir use, time patching, and the share
 * of time with an fs call or a real timer open (scripts/perf/loopTests.preload.ts).
 *
 * Usage: make test-loop-baseline [RUNS=10] [FILTER=<substring>] [JOBS=6] [BASE=<ref>], or
 *        bun scripts/perf/loopTestBaseline.ts [--runs 10] [--jobs 6] [--filter <substring>]
 *          [--base <ref>]
 *
 * It writes artifacts/loop-tests/<sha>[-dirty].json and .md (git-ignored: never commit a record,
 * it goes stale). With --base it also measures <ref> in a temporary worktree, pairs the rounds of
 * each file, and writes compare-<base>-<head>.json and .md with the trips of loopTestStats.ts.
 * The numbers are tripwire data for the refactor, not targets: a trip pauses the PR for review.
 * Exit codes: 0 no trip (or a record), 1 a trip, 2 bad input or a runner error. The last line is
 * "loop-tests: ...". make reports every failure as 2, so gates call this script directly.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { git, gitState, repoRoot } from "./bench";
import {
  type LoopTestCompare,
  type LoopTestFileRecord,
  type LoopTestRecord,
  type LoopTestRun,
  median,
  type PreloadOutput,
  summarizeFile,
  trips,
} from "./loopTestStats";

const S = "src/node/services/";
/** The tests of the code that phases 2 to 5 of the refactor change (243 files on ba9e451cab). */
export const LOOP_TEST_GLOBS = [
  ...[
    "agentSession",
    "streamManager",
    "aiService",
    "historyService",
    "partialService",
    "retryManager",
    "taskService",
    "workspaceTurnManager",
    "turn",
    "messagePipeline",
    "backgroundProcessManager",
    "historyAppendProvenance",
    "historyScanner",
    "historyReplacementRows",
    "historyRowScanner",
    "sendIds",
    "compactionPendingState",
    "compactionCancellation",
    "continuousCompactionJournal",
  ].map((name) => `${S}${name}*.test.ts`),
  `${S}tools/**/*.test.ts`,
  `${S}contextManagement/**/*.test.ts`,
  "src/node/utils/concurrency/{withTimeout,fileLock}*.test.ts",
  "src/node/utils/writeFileAtomic*.test.ts",
];

/** The loop test files under `root`, sorted, as repo-relative paths. */
export function loopTestFiles(root: string, filter?: string): string[] {
  const files = new Set<string>();
  for (const pattern of LOOP_TEST_GLOBS) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: root })) files.add(file);
  }
  return [...files].filter((file) => filter === undefined || file.includes(filter)).sort();
}

/** Calls that change global time for the whole process. Comparisons (`Date.now ===`) do not match. */
export const TIME_PATCH =
  /\b(useFakeTimers|setSystemTime)\s*\(|\bDate\.now\s*=[^=]|spyOn\(\s*(Date|performance)\b|spyOn\(\s*globalThis\s*,\s*["'](setTimeout|setInterval)\b/;

const TEST_HELPER = /(\.testHarness|\.testUtils|\/test[A-Z][^/]*|\/testHelpers)\.tsx?$/;

function resolveImport(root: string, fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(root, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * True when the test file, or a test helper it imports (directly or through other helpers),
 * matches TIME_PATCH. A source scan, because a hook in the preload runs outside the test's own
 * beforeEach/afterEach and missed every file that sets the time in the spike.
 */
export function patchesGlobalTime(root: string, file: string): boolean {
  const transpilers = {
    ts: new Bun.Transpiler({ loader: "ts" }),
    tsx: new Bun.Transpiler({ loader: "tsx" }),
  };
  const seen = new Set<string>();
  const visit = (absolute: string): boolean => {
    if (seen.has(absolute)) return false;
    seen.add(absolute);
    const source = fs.readFileSync(absolute, "utf8");
    if (TIME_PATCH.test(source)) return true;
    const transpiler = absolute.endsWith(".tsx") ? transpilers.tsx : transpilers.ts;
    return transpiler.scanImports(source).some(({ path: specifier }) => {
      const target = resolveImport(root, absolute, specifier);
      return target !== null && TEST_HELPER.test(target) && visit(target);
    });
  };
  return visit(path.join(root, file));
}

const PRELOAD_PATH = path.join(import.meta.dir, "loopTests.preload.ts");

/** Runs one test file in a fresh `bun test` process from `cwd`, with the measuring preload. */
export async function runFile(cwd: string, file: string, scratchDir: string): Promise<LoopTestRun> {
  const out = path.join(scratchDir, `${file.replaceAll("/", "_")}-${crypto.randomUUID()}.json`);
  const start = performance.now();
  const child = Bun.spawn(["bun", "test", "--preload", PRELOAD_PATH, `./${file}`], {
    cwd,
    env: { ...process.env, LOOP_TESTS_OUT: out },
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await child.exited;
  const wallMs = performance.now() - start;
  const preload = fs.existsSync(out)
    ? (JSON.parse(fs.readFileSync(out, "utf8")) as PreloadOutput)
    : null;
  fs.rmSync(out, { force: true });
  return { wallMs, exitCode, preload };
}

/** Runs `jobs` tasks at a time, in order of `tasks`. */
export async function runPool<T>(tasks: Array<() => Promise<T>>, jobs: number): Promise<T[]> {
  assert(Number.isInteger(jobs) && jobs >= 1, `invalid --jobs ${jobs}`);
  const results: T[] = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
  return results;
}

const pct = (share: number | null) => (share === null ? "-" : share.toFixed(2));

export function renderRecord(record: LoopTestRecord): string {
  const rows = record.files.map(
    (f: LoopTestFileRecord) =>
      `| ${f.file} | ${(median(f.wallMs) / 1000).toFixed(1)} s | ${f.failedRuns}/${f.wallMs.length} | ` +
      `${f.usesTempDir ? "yes" : "no"} | ${f.patchesGlobalTime ? "yes" : "no"} | ` +
      `${pct(f.fsShare)} | ${pct(f.timerShare)} |`
  );
  return [
    `Loop tests: ${record.files.length} files, ${record.rounds} rounds, ${record.commit.slice(0, 10)}` +
      `${record.dirty ? " (dirty)" : ""}, bun ${record.bun}, load ${record.loadavg.map((l) => l.toFixed(1)).join(" ")}`,
    "",
    "| file | median | failed | temp dir | patches time | fs share | timer share |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** Slow test files that a short (RUNS below 5) compare runs only when its own code changed. */
export const HEAVY_TESTS: Record<string, readonly string[]> = {
  // 250 s per process in the spike, a third of all loop test time.
  "src/node/services/backgroundProcessManager.test.ts": [
    "src/node/services/backgroundProcessManager.ts",
    "src/node/services/backgroundProcessManager.test.ts",
  ],
};
export const FULL_RUNS = 5;

/** The heavy tests to leave out of a compare with `runs` rounds and these changed files. */
export function heavySkips(runs: number, changedFiles: readonly string[]): string[] {
  if (runs >= FULL_RUNS) return [];
  return Object.entries(HEAVY_TESTS)
    .filter(([, sources]) => !sources.some((source) => changedFiles.includes(source)))
    .map(([test]) => test);
}

/** Files that differ between the merge base of `baseSha` and HEAD, plus working-tree edits. */
function changedFiles(root: string, baseSha: string): string[] {
  const committed = git(root, ["diff", "--name-only", `${baseSha}...HEAD`]).split("\n");
  const edited = git(root, ["status", "--porcelain"])
    .split("\n")
    .map((line) => line.slice(3));
  return [...committed, ...edited].filter(Boolean);
}

/** A detached worktree of `sha` in `dir`, with the caller's node_modules and src/version.ts. */
function addWorktree(root: string, dir: string, sha: string): void {
  git(root, ["worktree", "add", "--detach", dir, sha]);
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
  // src/version.ts is generated and git-ignored; without it some loop tests fail at import.
  const versionFile = path.join(root, "src", "version.ts");
  if (fs.existsSync(versionFile)) fs.copyFileSync(versionFile, path.join(dir, "src", "version.ts"));
}

interface Side {
  label: "base" | "head";
  root: string;
  commit: string;
  dirty: boolean;
}

function renderCompare(compare: LoopTestCompare): string {
  const lines = [
    `Loop test compare: base ${compare.base.commit.slice(0, 10)}, head ${compare.head.commit.slice(0, 10)}` +
      `${compare.head.dirty ? " (dirty)" : ""}, ${compare.head.files.length} files, ${compare.head.rounds} paired rounds`,
    "",
  ];
  for (const file of compare.skipped) lines.push(`skip ${file} (no change to it)`);
  for (const file of compare.newFiles) lines.push(`new ${file} (no base, no trip)`);
  for (const trip of compare.trips) {
    const c = trip.comparison;
    const b = compare.base.files.find((f) => f.file === trip.file);
    const h = compare.head.files.find((f) => f.file === trip.file);
    const kinds = [trip.slower ? "slower" : "", trip.failsMore ? "fails more" : ""].filter(Boolean);
    lines.push(
      `TRIP ${trip.file} ${kinds.join(", ")}: ${c.deltaPct.toFixed(0)}% ` +
        `[${c.ciLowPct.toFixed(0)}%, ${c.ciHighPct.toFixed(0)}%], ` +
        `${c.baseMedian.toFixed(0)} ms -> ${c.headMedian.toFixed(0)} ms, ` +
        `failed base ${b?.failedRuns}/${b?.wallMs.length} head ${h?.failedRuns}/${h?.wallMs.length}`
    );
  }
  lines.push("", "Base", "", renderRecord(compare.base), "Head", "", renderRecord(compare.head));
  return lines.join("\n");
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "10" },
      jobs: { type: "string", default: "6" },
      filter: { type: "string" },
      base: { type: "string" },
    },
  });
  const runs = Number(values.runs);
  const jobs = Number(values.jobs);
  assert(Number.isInteger(runs) && runs >= 1, `invalid --runs ${values.runs}`);
  assert(values.base === undefined || runs >= 2, "a compare needs --runs 2 or more");
  const root = repoRoot();
  const state = gitState(root);
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-tests-"));
  const baseDir = path.join(scratchDir, "base");
  let worktreeAdded = false;
  const cleanup = () => {
    if (worktreeAdded) git(root, ["worktree", "remove", "--force", baseDir]);
    worktreeAdded = false;
    fs.rmSync(scratchDir, { recursive: true, force: true });
  };
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.once(signal, () => {
      cleanup();
      process.exit(code);
    });
  }
  const loadavg = [os.loadavg()[0]];
  const sampler = setInterval(() => loadavg.push(os.loadavg()[0]), 60_000);
  try {
    const sides: Side[] = [{ label: "head", root, commit: state.gitSha, dirty: state.dirty }];
    let skipped: string[] = [];
    let newFiles: string[] = [];
    let files = loopTestFiles(root, values.filter);
    if (values.base !== undefined) {
      const baseSha = git(root, ["rev-parse", "--verify", `${values.base}^{commit}`]);
      addWorktree(root, baseDir, baseSha);
      worktreeAdded = true;
      sides.unshift({ label: "base", root: baseDir, commit: baseSha, dirty: false });
      const baseFiles = new Set(loopTestFiles(baseDir, values.filter));
      newFiles = files.filter((file) => !baseFiles.has(file));
      skipped = heavySkips(runs, changedFiles(root, baseSha)).filter((file) =>
        files.includes(file)
      );
      files = files.filter((file) => baseFiles.has(file) && !skipped.includes(file));
    }
    assert(files.length > 0, `no loop test files match --filter ${values.filter}`);
    // Scan first, so a scan error stops the run before any test process starts.
    const timePatched = sides.map((side) =>
      files.map((file) => patchesGlobalTime(side.root, file))
    );
    console.error(
      `loop tests · ${files.length} files · ${runs} ${sides.length > 1 ? "paired " : ""}rounds · ${jobs} jobs`
    );
    // Round-major order, as the spike ran: the rounds of one file do not run side by side. In a
    // compare each task runs one file on base, then on head (the order flips each round), so
    // host load drift hits both sides of a round alike.
    const tasks = Array.from({ length: runs }, (_, round) =>
      files.map((file) => async () => {
        const order = round % 2 === 0 ? sides : [...sides].reverse();
        const byLabel = new Map<Side["label"], LoopTestRun>();
        for (const side of order)
          byLabel.set(side.label, await runFile(side.root, file, scratchDir));
        return byLabel;
      })
    ).flat();
    const results = await runPool(tasks, jobs);
    const records = sides.map(
      (side, s): LoopTestRecord => ({
        commit: side.commit,
        dirty: side.dirty,
        bun: Bun.version,
        loadavg,
        rounds: runs,
        files: files.map((file, i) => {
          const fileRuns = Array.from({ length: runs }, (_, round) => {
            const run = results[round * files.length + i].get(side.label);
            assert(run, `${side.label} ${file} round ${round}: no run`);
            return run;
          });
          return summarizeFile(file, fileRuns, timePatched[s][i]);
        }),
      })
    );
    const outDir = path.join(root, "artifacts", "loop-tests");
    fs.mkdirSync(outDir, { recursive: true });
    const headName = `${state.gitSha.slice(0, 10)}${state.dirty ? "-dirty" : ""}`;
    const head = records[records.length - 1];
    if (records.length === 1) {
      const markdown = renderRecord(head);
      fs.writeFileSync(path.join(outDir, `${headName}.json`), `${JSON.stringify(head, null, 2)}\n`);
      fs.writeFileSync(path.join(outDir, `${headName}.md`), markdown);
      console.log(markdown);
      console.log(`wrote artifacts/loop-tests/${headName}.json and .md`);
      console.log("loop-tests: record");
      return 0;
    }
    const base = records[0];
    const compare: LoopTestCompare = { base, head, skipped, trips: trips(base, head), newFiles };
    const name = `compare-${base.commit.slice(0, 10)}-${headName}`;
    const markdown = renderCompare(compare);
    fs.writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(compare, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, `${name}.md`), markdown);
    console.log(markdown);
    console.log(`wrote artifacts/loop-tests/${name}.json and .md`);
    console.log(`loop-tests: ${compare.trips.length} trips`);
    return compare.trips.length > 0 ? 1 : 0;
  } finally {
    clearInterval(sampler);
    cleanup();
  }
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      console.log("loop-tests: error");
      process.exit(2);
    }
  );
}
