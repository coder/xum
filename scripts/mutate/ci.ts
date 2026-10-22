// Quality / Mutation (.github/workflows/pr.yml): run mutate/check.ts on the
// PR, then write a step summary and one warning annotation per surviving
// mutant. In warn mode (the default) this script always exits 0. In block
// mode (MUTATION_MODE=block) it exits 1 when a survivor that no
// `mutation-equivalent:` marker accepts remains. A tool error, a baseline
// failure, an "error" row or a mutant that did not run never blocks.
//
// Coverage: with every Test / Unit shard report (crap-lcov-unit-*), a site on
// a line that no unit test ran is "uncovered" and does not run. With a shard
// missing, every site runs, and the summary says so.
//
// Env: BASE_REF, LCOV_DIR, EXPECTED_UNIT (shard count), MUTATION_MODE,
// GITHUB_STEP_SUMMARY, GITHUB_OUTPUT.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  cell,
  crapMode as gateMode,
  escapeData,
  escapeProperty,
  lcovFiles,
  type CrapMode,
} from "../crap/ci";
import { counts, describe, type MutantRow, type MutateReport } from "./check";

// Kept under the report step's 18-minute timeout (pr.yml), with room for setup.
export const MAX_MUTANTS = 300;
export const MAX_SECONDS = 15 * 60;

export function annotation(row: MutantRow): string {
  const where = `file=${escapeProperty(row.path)},line=${row.line}`;
  const title = escapeProperty(`Mutation survived: ${describe(row)}`);
  const message = `No unit test failed when ${row.function} had ${describe(row)}. Add a test that tells them apart, or say why they are equivalent.`;
  return `::warning ${where},title=${title}::${escapeData(message)}`;
}

/**
 * Unit shard LCOV files, or none when coverage is incomplete (then every site
 * runs): a shard is missing, or a unit run fell back to no coverage
 * (scripts/test-unit-ci.sh), so lines only it ran would look uncovered.
 */
export function unitCoverage(
  dir: string,
  expectedUnit: number
): { files: string[]; complete: boolean } {
  const { artifacts, files, withoutCoverage } = lcovFiles(dir);
  const unit = artifacts.filter((name) => name.startsWith("crap-lcov-unit-"));
  const fellBack = withoutCoverage.some((label) => label.startsWith("crap-lcov-unit-"));
  const complete = expectedUnit > 0 && unit.length === expectedUnit && !fellBack;
  return {
    files: complete
      ? files.filter((file) => relative(dir, file).startsWith("crap-lcov-unit-"))
      : [],
    complete,
  };
}

/**
 * 1 only in block mode with a complete report that has unaccepted survivors.
 * A dropped baseline test makes the report partial: a survivor there can be a
 * mutant that the dropped test kills, and a baseline failure never blocks.
 * A survivor in a capped source (more importing tests than the run used) can
 * be one that a skipped test kills, so it warns and never blocks.
 */
export function exitCode(mode: CrapMode, report: MutateReport | null): number {
  if (mode !== "block" || report === null || report.droppedTests.length > 0) return 0;
  const capped = new Set(report.cappedTests);
  const blocking = report.mutants.filter(
    (row) => row.outcome === "survived" && !capped.has(row.path)
  );
  return blocking.length > 0 ? 1 : 0;
}

/** The summary's mode sentence, from the same rule as exitCode(). */
function blockNote(mode: CrapMode, report: MutateReport, survived: number): string {
  if (mode !== "block") return "This check only warns.";
  if (exitCode(mode, report) === 1)
    return "Block mode: the survivors fail this check until a test or a marker clears them.";
  return survived > 0
    ? "Block mode: no survivor blocks, because a dropped test or a capped source makes the run partial."
    : "Block mode.";
}

export function summary(
  report: MutateReport | null,
  coverage: boolean,
  toolError: string,
  mode: CrapMode = "warn"
): string {
  if (report === null) {
    return `## Mutation\n\nmutate-check failed, so there is no report. A tool error never blocks.\n\n\`\`\`\n${toolError.trim()}\n\`\`\`\n`;
  }
  const c = counts(report);
  const lines = [
    "## Mutation",
    "",
    `${c.survived} survived, ${c.killed} killed, ${c.uncovered} uncovered, ${c["no-test"]} without a passing test, ${c["not-run"]} not run, ${c.error} error(s), ${c.equivalent} accepted as equivalent (${report.seconds}s). ${blockNote(mode, report, c.survived)}`,
    coverage
      ? "Sites on lines that no unit test ran were skipped (uncovered)."
      : "Unit coverage was incomplete, so every site ran.",
  ];
  const survivors = report.mutants.filter((row) => row.outcome === "survived");
  if (survivors.length > 0) {
    lines.push("", "| Line | Mutant | Function |", "| --- | --- | --- |");
    for (const row of survivors) {
      lines.push(
        `| \`${cell(row.path)}:${row.line}\` | \`${cell(describe(row))}\` | ${cell(row.function)} |`
      );
    }
  }
  if (report.cappedTests.length > 0) {
    const sources = report.cappedTests.map((path) => `\`${cell(path)}\``).join(", ");
    lines.push(
      "",
      `More unit tests import ${sources} than the run uses: only the nearest ran, so a survivor there can be a mutant that a skipped test kills.`
    );
  }
  for (const row of report.mutants.filter((r) => r.outcome === "error")) {
    lines.push(
      "",
      `Error at \`${cell(row.path)}:${row.line}\` (\`${cell(describe(row))}\`): ${cell(row.reason ?? "unknown")}.`
    );
  }
  for (const dropped of report.droppedTests) {
    lines.push("", `Dropped \`${cell(dropped.path)}\`: ${dropped.reason}.`);
  }
  if (c["not-run"] > 0) {
    lines.push("", `The run stopped at ${MAX_MUTANTS} mutants or ${MAX_SECONDS / 60} minutes.`);
  }
  lines.push("", "See `.xum/skills/gauntlet` for the repairs.");
  return `${lines.join("\n")}\n`;
}

function main(): number {
  const env = process.env;
  const mode = gateMode(env.MUTATION_MODE);
  const coverage = unitCoverage(env.LCOV_DIR ?? "coverage-shards", Number(env.EXPECTED_UNIT ?? 0));
  const args = [join(import.meta.dir, "check.ts"), "--base", env.BASE_REF ?? "", "--json"];
  args.push("--max-mutants", String(MAX_MUTANTS), "--max-seconds", String(MAX_SECONDS));
  for (const file of coverage.files) args.push("--coverage", file);
  const run = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // check.ts prints a report with exit 0, 1 (survivors) or 3 (baseline failure).
  const report =
    run.status === 0 || run.status === 1 || run.status === 3
      ? (JSON.parse(run.stdout) as MutateReport)
      : null;
  const toolError = `${run.stderr ?? ""}${run.error ? String(run.error) : ""}`;
  if (report === null)
    console.log(`::warning title=Mutation::mutate-check failed: ${escapeData(toolError.trim())}`);
  for (const row of report?.mutants ?? []) {
    if (row.outcome === "survived") console.log(annotation(row));
  }
  const text = summary(report, coverage.complete, toolError, mode);
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  const code = exitCode(mode, report);
  // pr.yml's Verdict step fails the job only on this output, so a timeout or
  // crash of this step (no output) never blocks.
  if (code === 1 && env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, "verdict=violations\n");
  return code;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    // A crash in this script is a tool error: it never blocks, in either mode.
    console.log(
      `::warning title=Mutation::Quality / Mutation failed: ${escapeData(String(error))}`
    );
  }
}
