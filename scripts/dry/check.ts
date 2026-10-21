// make dry-check: report near-duplicate functions that the changes since BASE
// make (scripts/dry/dryer_report.py). The DRY gate only warns: a duplicate
// can be on purpose, and only a reader can tell.
// Exit 0 no findings, 1 findings, 2 tool error.
//
//   bun scripts/dry/check.ts --base <ref> [--json]
//
// Call the script, not `make dry-check`, when the exit code matters: make
// turns every failing recipe into exit 2.
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { changesSince, writeBaseTree } from "../crap/changes";

const ADAPTER = join(import.meta.dir, "dryer_report.py");

export interface DrySpan {
  path: string;
  name: string;
  startLine: number;
  endLine: number;
}

export interface DryPair {
  /** Jaccard similarity of the two structural fingerprint sets, 0..1. */
  score: number;
  /** A function that the diff changed. */
  left: DrySpan;
  right: DrySpan;
}

export interface DryReport {
  base: string;
  compared: number;
  changedFunctions: number;
  pairs: DryPair[];
}

function where(span: DrySpan): string {
  return `${span.path}:${span.startLine}-${span.endLine} ${span.name}`;
}

export function formatReport(report: DryReport): string {
  const lines = [
    `dry-check: ${report.pairs.length === 0 ? "PASS" : `${report.pairs.length} warning(s)`} (base ${report.base.slice(0, 10)}, ${report.changedFunctions} changed function(s), ${report.compared} compared)`,
    ...report.pairs.map(
      (pair) =>
        `  warning  new-duplicate score ${pair.score.toFixed(2)} ${where(pair.left)}\n           matches ${where(pair.right)}`
    ),
  ];
  if (report.pairs.length > 0) {
    lines.push(
      "Repair: extract the shared shape if both must change together; else keep both and say why (see .xum/skills/gauntlet)."
    );
  }
  return lines.join("\n");
}

export function runCheck(cwd: string, baseRef: string): DryReport {
  const { root, base, files, changed } = changesSince(cwd, baseRef);
  const empty = { base, compared: 0, changedFunctions: 0, pairs: [] };
  if (files.every((file) => file.headPath === null)) return empty;
  const { tree } = writeBaseTree(root, base, files);
  try {
    const changes = join(tree, ".dry-changes.json");
    writeFileSync(changes, JSON.stringify({ files, spans: Object.fromEntries(changed) }));
    const out = execFileSync(
      "uv",
      [
        "run",
        "--quiet",
        "--script",
        ADAPTER,
        "--root",
        root,
        "--base-root",
        tree,
        "--changes",
        changes,
      ],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
    );
    return { base, ...(JSON.parse(out) as Omit<DryReport, "base">) };
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { base: { type: "string" }, json: { type: "boolean", default: false } },
  });
  if (!values.base) throw new Error("--base <ref> is required");
  const report = runCheck(process.cwd(), values.base);
  console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.pairs.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    // A broken scorer (no uv, offline grammar download, bad ref) is not a
    // finding: exit 2 so callers can tell it from duplicates.
    console.error(
      `dry-check: tool error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 2;
  }
}
