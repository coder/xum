// Quality / CRAP (.github/workflows/pr.yml): run check.ts on the PR with every
// downloaded shard LCOV, then write a step summary and warning annotations.
// The job is informational, so this script always exits 0: a violation, a
// missing artifact or a broken scorer is reported, never a failed check.
//
// Env: BASE_REF, LCOV_DIR (one folder per `crap-lcov-<lane>-<shard>` artifact),
// EXPECTED_UNIT and EXPECTED_INTEGRATION (shard counts), CRAP_DEBT_LABEL
// ("true" when the PR has the crap-debt label), GITHUB_STEP_SUMMARY.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
}

/** Counts shard reports by artifact name. Missing shards (skipped, failed, expired) make it partial. */
export function coverageStatus(
  artifacts: readonly string[],
  expected: { unit: number; integration: number }
): CoverageStatus {
  const count = (lane: string) =>
    artifacts.filter((name) => name.startsWith(`crap-lcov-${lane}-`)).length;
  const unit = count("unit");
  const integration = count("integration");
  return { unit, integration, partial: unit < expected.unit || integration < expected.integration };
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
  const lines = [
    "## Quality / CRAP (informational)",
    "",
    coverage,
    "Unit reports cover the shared-process suites only (isolated suites run without coverage). No base coverage: the CRAP tax compares CC and only warns.",
    "`.tsx` coverage comes from Bun unit tests only, because Jest does not collect `.tsx` coverage yet: a component only Jest UI tests render scores 0%.",
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
  if (report.findings.length > 0) {
    lines.push("| Severity | Rule | Finding |", "| --- | --- | --- |");
    for (const finding of report.findings) {
      lines.push(`| ${finding.severity} | ${finding.rule} | ${cell(finding.message)} |`);
    }
  }
  for (const use of report.debt) lines.push("", `Crap-Debt (${use.source}): ${cell(use.reason)}`);
  return `${lines.join("\n")}\n`;
}

function lcovFiles(dir: string): { artifacts: string[]; files: string[] } {
  if (!existsSync(dir)) return { artifacts: [], files: [] };
  const artifacts = readdirSync(dir).filter((name) => existsSync(join(dir, name, "lcov.info")));
  return { artifacts, files: artifacts.map((name) => join(dir, name, "lcov.info")) };
}

function main(): void {
  const env = process.env;
  const expected = {
    unit: Number(env.EXPECTED_UNIT ?? 0),
    integration: Number(env.EXPECTED_INTEGRATION ?? 0),
  };
  const { artifacts, files } = lcovFiles(env.LCOV_DIR ?? "coverage-shards");
  const status = coverageStatus(artifacts, expected);
  const args = [join(import.meta.dir, "check.ts"), "--base", env.BASE_REF ?? "", "--json"];
  for (const file of files) args.push("--coverage", file);
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
