// make mutate-check: run mutants in the functions changed since BASE and list
// the ones the unit tests do not kill (scripts/mutate/mutate_report.py). The
// mutation gate only warns: a surviving mutant can be equivalent (no input
// tells it apart), and only a reader can tell.
// Exit 0 no survivors, 1 survivors, 2 tool error (no report), 3 a test file
// failed without a mutant (the report lists it; its mutants did not run).
//
//   bun scripts/mutate/check.ts --base <ref> [--json] [--coverage <lcov>]...
//       [--workers N] [--max-mutants N] [--max-seconds N]
//
// Call the script, not `make mutate-check`, when the exit code matters: make
// turns every failing recipe into exit 2.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { changesSince } from "../crap/changes";

const ADAPTER = join(import.meta.dir, "mutate_report.py");

export type Outcome = "killed" | "survived" | "uncovered" | "no-test" | "not-run" | "error";

export interface MutantRow {
  path: string;
  /** The Crapper name of the function, as crap-check names it. */
  function: string;
  line: number;
  original: string;
  /** The replacement; "" deletes the original token. */
  mutant: string;
  outcome: Outcome;
  /** Why an "error" row has no result (the runner's exception). */
  reason?: string;
}

export interface MutateReport {
  base: string;
  mutants: MutantRow[];
  /** Source file -> the test files that ran against its mutants. */
  tests: Record<string, string[]>;
  /** Sources with more importing tests than the cap. */
  cappedTests: string[];
  /** Test files that failed without a mutant, so they did not run. */
  droppedTests: Array<{ path: string; reason: string }>;
  seconds: number;
}

export function counts(report: MutateReport): Record<Outcome, number> {
  const result: Record<Outcome, number> = {
    killed: 0,
    survived: 0,
    uncovered: 0,
    "no-test": 0,
    "not-run": 0,
    error: 0,
  };
  for (const row of report.mutants) result[row.outcome]++;
  return result;
}

export function describe(row: MutantRow): string {
  return row.mutant === "" ? `delete ${row.original}` : `${row.original} -> ${row.mutant}`;
}

export function exitCode(report: MutateReport): 0 | 1 | 3 {
  if (report.droppedTests.length > 0) return 3;
  return counts(report).survived === 0 ? 0 : 1;
}

function verdict(report: MutateReport): string {
  const survived = counts(report).survived;
  const parts = report.droppedTests.length > 0 ? ["BASELINE FAILED"] : [];
  const notRun = counts(report)["not-run"];
  if (survived > 0 || parts.length > 0) parts.push(`${survived} survived`);
  else parts.push(notRun > 0 ? `PASS (${notRun} not run)` : "PASS");
  return parts.join(", ");
}

export function formatReport(report: MutateReport): string {
  const c = counts(report);
  const lines = [
    `mutate-check: ${verdict(report)}, ${c.killed} killed, ${c.uncovered} uncovered, ${c["no-test"]} without a test, ${c["not-run"]} not run${c.error > 0 ? `, ${c.error} error(s)` : ""} (base ${report.base.slice(0, 10)}, ${report.seconds}s)`,
  ];
  const survivors = report.mutants.filter((row) => row.outcome === "survived");
  for (const path of [...new Set(survivors.map((row) => row.path))]) {
    lines.push(`  ${path}  (tests: ${(report.tests[path] ?? []).join(", ")})`);
    for (const row of survivors.filter((r) => r.path === path)) {
      lines.push(`    survived :${row.line} ${describe(row)}  ${row.function}`);
    }
  }
  const untested = [
    ...new Set(report.mutants.filter((r) => r.outcome === "no-test").map((r) => r.path)),
  ];
  if (untested.length > 0) lines.push(`  no passing unit test imports: ${untested.join(", ")}`);
  for (const dropped of report.droppedTests) {
    lines.push(`  dropped test ${dropped.path}: ${dropped.reason}`);
  }
  for (const row of report.mutants.filter((r) => r.outcome === "error")) {
    lines.push(`  error :${row.line} ${describe(row)} in ${row.path}: ${row.reason ?? "unknown"}`);
  }
  if (report.cappedTests.length > 0) {
    lines.push(`  only the nearest test files ran for: ${report.cappedTests.join(", ")}`);
  }
  if (survivors.length > 0) {
    lines.push(
      "Repair: add a test that fails for the mutant. Do not change the code only to kill it (see .xum/skills/gauntlet)."
    );
  }
  return lines.join("\n");
}

export interface CheckOptions {
  coverage: readonly string[];
  workers?: string;
  maxMutants?: string;
  maxSeconds?: string;
}

export function runCheck(cwd: string, baseRef: string, options: CheckOptions): MutateReport {
  const { root, base, files, changed } = changesSince(cwd, baseRef);
  const empty: MutateReport = {
    base,
    mutants: [],
    tests: {},
    cappedTests: [],
    droppedTests: [],
    seconds: 0,
  };
  if (files.every((file) => file.headPath === null)) return empty;
  const scratch = mkdtempSync(join(tmpdir(), "mutate-check-"));
  try {
    const changes = join(scratch, "changes.json");
    writeFileSync(changes, JSON.stringify({ files, spans: Object.fromEntries(changed) }));
    // The Bun unit lane decides which tests count: jest and e2e tests do not run here.
    const lane = join(scratch, "lane.txt");
    writeFileSync(
      lane,
      execFileSync("bash", ["scripts/test-unit-ci.sh", "--list-all"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      })
    );
    const args = ["run", "--quiet", "--script", ADAPTER, "--root", root];
    args.push("--changes", changes, "--lane", lane);
    for (const report of options.coverage) args.push("--lcov", report);
    if (options.workers) args.push("--workers", options.workers);
    if (options.maxMutants) args.push("--max-mutants", options.maxMutants);
    if (options.maxSeconds) args.push("--max-seconds", options.maxSeconds);
    const out = execFileSync("uv", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return { base, ...(JSON.parse(out) as Omit<MutateReport, "base">) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      json: { type: "boolean", default: false },
      coverage: { type: "string", multiple: true, default: [] },
      workers: { type: "string" },
      "max-mutants": { type: "string" },
      "max-seconds": { type: "string" },
    },
  });
  if (!values.base) throw new Error("--base <ref> is required");
  const report = runCheck(process.cwd(), values.base, {
    coverage: values.coverage,
    workers: values.workers,
    maxMutants: values["max-mutants"],
    maxSeconds: values["max-seconds"],
  });
  console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return exitCode(report);
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    // A broken runner (no uv, offline grammar download, bad ref) is not a
    // finding: exit 2 so callers can tell it from survivors.
    console.error(
      `mutate-check: tool error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 2;
  }
}
