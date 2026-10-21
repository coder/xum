// Quality / DRY (.github/workflows/pr.yml): run dry/check.ts on the PR, then
// write a step summary and one warning annotation per new duplicate. The DRY
// gate only warns, so this script always exits 0, also on a tool error.
//
// Env: BASE_REF, GITHUB_STEP_SUMMARY.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { cell, escapeData, escapeProperty } from "../crap/ci";
import type { DryPair, DryReport } from "./check";

export function annotation(pair: DryPair): string {
  const { left, right } = pair;
  const where = `file=${escapeProperty(left.path)},line=${left.startLine},endLine=${left.endLine}`;
  const title = escapeProperty(`DRY new duplicate (score ${pair.score.toFixed(2)})`);
  const message = `${left.name} matches ${right.name} at ${right.path}:${right.startLine}-${right.endLine}. Extract the shared shape if both must change together; else keep both and say why.`;
  return `::warning ${where},title=${title}::${escapeData(message)}`;
}

export function summary(report: DryReport | null, toolError: string): string {
  if (report === null) {
    return `## DRY\n\ndry-check failed, so there is no report. It never blocks.\n\n\`\`\`\n${toolError.trim()}\n\`\`\`\n`;
  }
  const head = `## DRY\n\n${report.pairs.length} new near-duplicate(s) in ${report.changedFunctions} changed function(s), compared with ${report.compared}. This check only warns.\n`;
  if (report.pairs.length === 0) return head;
  const rows = report.pairs.map(
    (pair) =>
      `| ${pair.score.toFixed(2)} | \`${cell(pair.left.path)}:${pair.left.startLine}\` ${cell(pair.left.name)} | \`${cell(pair.right.path)}:${pair.right.startLine}\` ${cell(pair.right.name)} |`
  );
  return `${head}\n| Score | Changed function | Matches |\n| --- | --- | --- |\n${rows.join("\n")}\n\nSee \`.xum/skills/gauntlet\` for the repairs.\n`;
}

function main(): void {
  const env = process.env;
  const args = [join(import.meta.dir, "check.ts"), "--base", env.BASE_REF ?? "", "--json"];
  const run = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // check.ts exits 1 on findings: that is still a report. Only 2 (or a crash) is a tool error.
  const report =
    run.status === 0 || run.status === 1 ? (JSON.parse(run.stdout) as DryReport) : null;
  const toolError = `${run.stderr ?? ""}${run.error ? String(run.error) : ""}`;
  if (report === null)
    console.log(`::warning title=DRY::dry-check failed: ${escapeData(toolError.trim())}`);
  for (const pair of report?.pairs ?? []) console.log(annotation(pair));
  const text = summary(report, toolError);
  console.log(text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.log(`::warning title=DRY::Quality / DRY failed: ${escapeData(String(error))}`);
  }
}
