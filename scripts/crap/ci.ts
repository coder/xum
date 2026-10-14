// Quality / CRAP (.github/workflows/pr.yml): run check.ts on the PR with every
// downloaded shard LCOV, then write a step summary and warning annotations.
// The job is informational, so this script always exits 0: a violation, a
// missing artifact or a broken scorer is reported, never a failed check.
//
// Env: BASE_REF, LCOV_DIR (one folder per `crap-lcov-<lane>-<shard>` artifact),
// EXPECTED_UNIT and EXPECTED_INTEGRATION (shard counts), CRAP_DEBT_LABEL
// ("true" when the PR has the crap-debt label), GITHUB_STEP_SUMMARY.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DebtUse, Finding } from "./policy";

export interface CheckReport {
  findings: Finding[];
  debt: DebtUse[];
  ok: boolean;
}

export interface CoverageStatus {
  unit: number;
  integration: number;
  partial: boolean;
  /** Labels of test runs that fell back to no coverage (scripts/test-unit-ci.sh). */
  withoutCoverage: string[];
}

/**
 * scripts/test-unit-ci.sh writes this file, holding the run's label, next to
 * the lcov.info a run would have written when Bun crashed twice under coverage
 * and the run passed without it. The crap-lcov artifact carries it.
 */
export const RAN_WITHOUT_COVERAGE = "ran-without-coverage.txt";

/** Counts shard reports by artifact name. Missing shards (skipped, failed, expired) make it partial. */
export function coverageStatus(
  artifacts: readonly string[],
  expected: { unit: number; integration: number },
  withoutCoverage: readonly string[] = []
): CoverageStatus {
  const count = (lane: string) =>
    artifacts.filter((name) => name.startsWith(`crap-lcov-${lane}-`)).length;
  const unit = count("unit");
  const integration = count("integration");
  return {
    unit,
    integration,
    partial: unit < expected.unit || integration < expected.integration,
    withoutCoverage: [...withoutCoverage],
  };
}

/**
 * Why the coverage is incomplete, or null when every expected shard report is
 * there and every run kept its coverage. check.ts --incomplete-coverage then
 * turns coverage-based violations into warnings, so the gate blocks only on a
 * complete report.
 */
export function incompleteCoverageReason(
  status: CoverageStatus,
  expected: { unit: number; integration: number }
): string | null {
  const reasons: string[] = [];
  if (status.partial) {
    reasons.push(
      `shard reports missing (${status.unit}/${expected.unit} unit, ${status.integration}/${expected.integration} integration)`
    );
  }
  if (status.withoutCoverage.length > 0) {
    reasons.push(`ran without coverage: ${status.withoutCoverage.join(", ")}`);
  }
  return reasons.length === 0 ? null : reasons.join("; ");
}

// Workflow command escaping: https://github.com/actions/toolkit/blob/main/packages/core/src/command.ts
function escapeData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export function annotation(finding: Finding): string {
  const { head } = finding;
  const where = `file=${escapeProperty(head.path)},line=${head.startLine},endLine=${head.endLine}`;
  const title = escapeProperty(`CRAP ${finding.rule} (${finding.severity})`);
  return `::warning ${where},title=${title}::${escapeData(finding.message)}`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function summary(
  report: CheckReport | null,
  status: CoverageStatus,
  expected: { unit: number; integration: number },
  toolError: string
): string {
  const coverage = `${status.partial ? "Partial coverage" : "Coverage"}: ${status.unit}/${expected.unit} unit and ${status.integration}/${expected.integration} integration shard reports.`;
  const incomplete = incompleteCoverageReason(status, expected);
  const lines = [
    "## Quality / CRAP (informational)",
    "",
    coverage,
    ...(incomplete === null
      ? []
      : [
          `**Incomplete coverage (${incomplete}): coverage-based violations are warnings. Complexity-only verdicts stand.**`,
        ]),
    "Unit reports cover every Bun unit suite except the isolated ones marked `no-coverage:` in scripts/test-unit-ci.sh (Bun coverage crashes them). A suite whose coverage run crashed twice passes on a retry without coverage, so it has no report: its Test / Unit job shows a warning. No base coverage: the CRAP tax compares CC and only warns.",
    "",
  ];
  if (report === null) {
    lines.push(
      "crap-check failed to run, so no findings were computed:",
      "",
      "```",
      toolError.trim(),
      "```"
    );
    return `${lines.join("\n")}\n`;
  }
  const violations = report.findings.filter((finding) => finding.severity === "violation").length;
  lines.push(
    `**${violations} violation(s), ${report.findings.length - violations} warning(s).**`,
    ""
  );
  const table = (findings: readonly Finding[]) => {
    lines.push("| Severity | Rule | Finding |", "| --- | --- | --- |");
    for (const finding of findings) {
      lines.push(`| ${finding.severity} | ${finding.rule} | ${cell(finding.message)} |`);
    }
  };
  const suspects = report.findings.filter((finding) => finding.bunInlinedConstSuspect === true);
  const others = report.findings.filter((finding) => finding.bunInlinedConstSuspect !== true);
  if (others.length > 0) table(others);
  if (suspects.length > 0) {
    if (others.length > 0) lines.push("");
    lines.push(
      `### Coverage Bun may hide (${suspects.length} warning(s))`,
      "",
      "Bun's coverage reports these functions' lines as unrun when an uncalled function uses an inlined literal `const` above them (the inlined-const bug, see scripts/crap/crapper_report.py). Their score may be wrong, so these findings only warn. Check the function's tests by hand.",
      ""
    );
    table(suspects);
  }
  for (const use of report.debt) lines.push("", `Crap-Debt (${use.source}): ${cell(use.reason)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Lists every `lcov.info` under each artifact folder, at any depth: a unit shard
 * uploads one report for its shared process plus one per isolated file and one for
 * the tooling run (scripts/test-unit-ci.sh). An artifact counts as a shard report
 * only with its top-level `lcov.info`: when the shared process passes only on its
 * last retry, which runs without coverage, the shard's nested reports still count
 * as coverage but the summary shows it as partial.
 */
export function lcovFiles(dir: string): {
  artifacts: string[];
  files: string[];
  withoutCoverage: string[];
} {
  if (!existsSync(dir)) return { artifacts: [], files: [], withoutCoverage: [] };
  const artifacts: string[] = [];
  const files: string[] = [];
  const withoutCoverage: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const root = join(dir, name);
    if (!statSync(root).isDirectory()) continue;
    const paths = readdirSync(root, { recursive: true, encoding: "utf8" }).sort();
    const found = paths
      .filter((path) => basename(path) === "lcov.info")
      .map((path) => join(root, path));
    for (const path of paths.filter((p) => basename(p) === RAN_WITHOUT_COVERAGE)) {
      const label = readFileSync(join(root, path), "utf8").trim();
      withoutCoverage.push(`${name}: ${label || path}`);
    }
    if (existsSync(join(root, "lcov.info"))) artifacts.push(name);
    files.push(...found);
  }
  return { artifacts, files, withoutCoverage };
}

function main(): void {
  const env = process.env;
  const expected = {
    unit: Number(env.EXPECTED_UNIT ?? 0),
    integration: Number(env.EXPECTED_INTEGRATION ?? 0),
  };
  const { artifacts, files, withoutCoverage } = lcovFiles(env.LCOV_DIR ?? "coverage-shards");
  const status = coverageStatus(artifacts, expected, withoutCoverage);
  const args = [join(import.meta.dir, "check.ts"), "--base", env.BASE_REF ?? "", "--json"];
  for (const file of files) args.push("--coverage", file);
  const incomplete = incompleteCoverageReason(status, expected);
  if (incomplete !== null) args.push("--incomplete-coverage", incomplete);
  if (env.CRAP_DEBT_LABEL === "true") args.push("--debt", "crap-debt PR label");
  const run = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // check.ts exits 1 on violations: that is still a report. Only 2 (or a crash) is a tool error.
  const report =
    run.status === 0 || run.status === 1 ? (JSON.parse(run.stdout) as CheckReport) : null;
  const toolError = `${run.stderr ?? ""}${run.error ? String(run.error) : ""}`;
  if (report === null)
    console.log(`::warning title=CRAP::crap-check failed: ${escapeData(toolError.trim())}`);
  for (const finding of report?.findings ?? []) console.log(annotation(finding));
  const text = summary(report, status, expected, toolError);
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.log(`::warning title=CRAP::Quality / CRAP failed: ${escapeData(String(error))}`);
  }
}
