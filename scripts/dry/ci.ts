// Quality / DRY (.github/workflows/pr.yml): run dry/check.ts on the PR, then
// write a step summary and one warning annotation per new duplicate.
// In warn mode (the default) this script always exits 0. In block mode
// (DRY_MODE=block, from the repo variable) it exits 1 when a duplicate that no
// `dry-duplicate-ok:` marker accepts remains. A tool error never blocks.
//
// Env: BASE_REF, DRY_MODE, GITHUB_STEP_SUMMARY, GITHUB_OUTPUT.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { cell, crapMode as gateMode, escapeData, escapeProperty, type CrapMode } from "../crap/ci";
import { findings, type DryPair, type DryReport } from "./check";

export function annotation(pair: DryPair): string {
  const { left, right } = pair;
  const where = `file=${escapeProperty(left.path)},line=${left.startLine},endLine=${left.endLine}`;
  const title = escapeProperty(`DRY new duplicate (score ${pair.score.toFixed(2)})`);
  const message = `${left.name} matches ${right.name} at ${right.path}:${right.startLine}-${right.endLine}. Extract the shared shape if both must change together; else keep both and add a dry-duplicate-ok: <reason> comment.`;
  return `::warning ${where},title=${title}::${escapeData(message)}`;
}

/** 1 only in block mode with a report that has unaccepted findings. */
export function exitCode(mode: CrapMode, report: DryReport | null): number {
  return mode === "block" && report !== null && findings(report).length > 0 ? 1 : 0;
}

export function summary(report: DryReport | null, toolError: string, mode: CrapMode): string {
  if (report === null) {
    return `## DRY\n\ndry-check failed, so there is no report. A tool error never blocks.\n\n\`\`\`\n${toolError.trim()}\n\`\`\`\n`;
  }
  const open = findings(report).length;
  const verdict =
    mode === "block"
      ? open > 0
        ? "Block mode: these block the merge until a change or a marker clears them."
        : "Block mode."
      : "This check only warns.";
  const head = `## DRY\n\n${open} new near-duplicate(s), ${report.pairs.length - open} accepted, in ${report.changedFunctions} changed function(s), compared with ${report.compared}. ${verdict}\n`;
  if (report.pairs.length === 0) return head;
  const rows = report.pairs.map(
    (pair) =>
      `| ${pair.score.toFixed(2)} | \`${cell(pair.left.path)}:${pair.left.startLine}\` ${cell(pair.left.name)} | \`${cell(pair.right.path)}:${pair.right.startLine}\` ${cell(pair.right.name)} | ${pair.accepted === undefined ? "open" : `accepted: ${cell(pair.accepted)}`} |`
  );
  return `${head}\n| Score | Changed function | Matches | State |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n\nSee \`.xum/skills/gauntlet\` for the repairs.\n`;
}

function main(): number {
  const env = process.env;
  const mode = gateMode(env.DRY_MODE);
  const args = [join(import.meta.dir, "check.ts"), "--base", env.BASE_REF ?? "", "--json"];
  const run = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // check.ts exits 1 on findings: that is still a report. Only 2 (or a crash) is a tool error.
  const report =
    run.status === 0 || run.status === 1 ? (JSON.parse(run.stdout) as DryReport) : null;
  const toolError = `${run.stderr ?? ""}${run.error ? String(run.error) : ""}`;
  if (report === null)
    console.log(`::warning title=DRY::dry-check failed: ${escapeData(toolError.trim())}`);
  for (const pair of report === null ? [] : findings(report)) console.log(annotation(pair));
  const text = summary(report, toolError, mode);
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
    console.log(`::warning title=DRY::Quality / DRY failed: ${escapeData(String(error))}`);
  }
}
