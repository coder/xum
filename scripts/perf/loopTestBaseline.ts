/**
 * Loop test baseline (agent loop refactor, phase 1): times every loop test file in fresh
 * `bun test` processes and records time, failed runs, temp-dir use, time patching, and the share
 * of time with an fs call or a real timer open (scripts/perf/loopTests.preload.ts).
 *
 * Usage: make test-loop-baseline [RUNS=10] [FILTER=<substring>] [JOBS=6], or
 *        bun scripts/perf/loopTestBaseline.ts [--runs 10] [--jobs 6] [--filter <substring>]
 *
 * It writes artifacts/loop-tests/<sha>[-dirty].json and .md (git-ignored: never commit a record,
 * it goes stale). The numbers are tripwire data for the refactor, not targets. The script exits 0
 * after it writes the record, 2 on bad input or a runner error, and prints "loop-tests: ..." last.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { gitState, repoRoot } from "./bench";
import {
  type LoopTestFileRecord,
  type LoopTestRecord,
  type LoopTestRun,
  median,
  type PreloadOutput,
  summarizeFile,
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

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "10" },
      jobs: { type: "string", default: "6" },
      filter: { type: "string" },
    },
  });
  const runs = Number(values.runs);
  const jobs = Number(values.jobs);
  assert(Number.isInteger(runs) && runs >= 1, `invalid --runs ${values.runs}`);
  const root = repoRoot();
  const files = loopTestFiles(root, values.filter);
  assert(files.length > 0, `no loop test files match --filter ${values.filter}`);
  // Scan first, so a scan error stops the run before any test process starts.
  const timePatched = files.map((file) => patchesGlobalTime(root, file));
  const state = gitState(root);
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-tests-"));
  const loadavg = [os.loadavg()[0]];
  const sampler = setInterval(() => loadavg.push(os.loadavg()[0]), 60_000);
  console.error(`loop tests · ${files.length} files · ${runs} rounds · ${jobs} jobs`);
  try {
    // Round-major order, as the spike ran: the rounds of one file do not run side by side.
    const tasks = Array.from({ length: runs }, () =>
      files.map((file) => () => runFile(root, file, scratchDir))
    ).flat();
    const results = await runPool(tasks, jobs);
    const record: LoopTestRecord = {
      commit: state.gitSha,
      dirty: state.dirty,
      bun: Bun.version,
      loadavg,
      rounds: runs,
      files: files.map((file, i) =>
        summarizeFile(
          file,
          Array.from({ length: runs }, (_, round) => results[round * files.length + i]),
          timePatched[i]
        )
      ),
    };
    const outDir = path.join(root, "artifacts", "loop-tests");
    fs.mkdirSync(outDir, { recursive: true });
    const name = `${state.gitSha.slice(0, 10)}${state.dirty ? "-dirty" : ""}`;
    const markdown = renderRecord(record);
    fs.writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, `${name}.md`), markdown);
    console.log(markdown);
    console.log(`wrote artifacts/loop-tests/${name}.json and .md`);
    console.log("loop-tests: record");
    return 0;
  } finally {
    clearInterval(sampler);
    fs.rmSync(scratchDir, { recursive: true, force: true });
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
