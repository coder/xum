// Quality / Mutation (.github/workflows/pr.yml): run mutate/check.ts on the
// PR, then write a step summary and one warning annotation per surviving
// mutant. The mutation gate only warns, so this script always exits 0.
//
// Coverage: with every Test / Unit shard report (crap-lcov-unit-*), a site on
// a line that no unit test ran is "uncovered" and does not run. With a shard
// missing, every site runs, and the summary says so.
//
// Env: BASE_REF, LCOV_DIR, EXPECTED_UNIT (shard count), GITHUB_STEP_SUMMARY.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cell, escapeData, escapeProperty, lcovFiles } from "../crap/ci";
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

/** Unit shard LCOV files, or none when a shard is missing (then every site runs). */
export function unitCoverage(
  dir: string,
  expectedUnit: number
): { files: string[]; complete: boolean } {
  const { artifacts, files } = lcovFiles(dir);
  const unit = artifacts.filter((name) => name.startsWith("crap-lcov-unit-"));
  const complete = expectedUnit > 0 && unit.length === expectedUnit;
  return {
    files: complete
      ? files.filter((file) => relative(dir, file).startsWith("crap-lcov-unit-"))
      : [],
    complete,
  };
}

export function summary(report: MutateReport | null, coverage: boolean, toolError: string): string {
  if (report === null) {
    return `## Mutation\n\nmutate-check failed, so there is no report. It never blocks.\n\n\`\`\`\n${toolError.trim()}\n\`\`\`\n`;
  }
  const c = counts(report);
  const lines = [
    "## Mutation",
    "",
    `${c.survived} survived, ${c.killed} killed, ${c.uncovered} uncovered, ${c["no-test"]} without a passing test, ${c["not-run"]} not run, ${c.error} error(s) (${report.seconds}s). This check only warns.`,
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
  for (const dropped of report.droppedTests) {
    lines.push("", `Dropped \`${cell(dropped.path)}\`: ${dropped.reason}.`);
  }
  if (c["not-run"] > 0) {
    lines.push("", `The run stopped at ${MAX_MUTANTS} mutants or ${MAX_SECONDS / 60} minutes.`);
  }
  lines.push("", "See `.xum/skills/gauntlet` for the repairs.");
  return `${lines.join("\n")}\n`;
}

function main(): void {
  const env = process.env;
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
  const text = summary(report, coverage.complete, toolError);
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.log(
      `::warning title=Mutation::Quality / Mutation failed: ${escapeData(String(error))}`
    );
  }
}
