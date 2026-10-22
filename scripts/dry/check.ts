// make dry-check: report near-duplicate functions that the changes since BASE
// make (scripts/dry/dryer_report.py). A duplicate can be on purpose: a
// `dry-duplicate-ok: <reason>` comment in the changed function accepts it
// (scripts/crap/markers.py), and the report lists it with the reason.
// Exit 0 no findings, 1 findings that no marker accepts, 2 tool error.
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
  /** The reason of a `dry-duplicate-ok:` marker on a changed side, if any. */
  accepted?: string;
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

/** Pairs that no `dry-duplicate-ok:` marker accepts. */
export function findings(report: DryReport): DryPair[] {
  return report.pairs.filter((pair) => pair.accepted === undefined);
}

export function formatReport(report: DryReport): string {
  const open = findings(report);
  const accepted = report.pairs.length - open.length;
  const lines = [
    `dry-check: ${open.length === 0 ? "PASS" : `${open.length} warning(s)`}${accepted > 0 ? `, ${accepted} accepted` : ""} (base ${report.base.slice(0, 10)}, ${report.changedFunctions} changed function(s), ${report.compared} compared)`,
    ...report.pairs.map(
      (pair) =>
        `  ${pair.accepted === undefined ? "warning " : "accepted"} new-duplicate score ${pair.score.toFixed(2)} ${where(pair.left)}\n           matches ${where(pair.right)}${pair.accepted === undefined ? "" : `\n           dry-duplicate-ok: ${pair.accepted}`}`
    ),
  ];
  if (open.length > 0) {
    lines.push(
      "Repair: extract the shared shape if both must change together; else keep both and say why (see .xum/skills/gauntlet)."
    );
  }
  return lines.join("\n");
}

export function runCheck(cwd: string, baseRef: string): DryReport {
  const { root, base, files, changed, hunks } = changesSince(cwd, baseRef);
  const empty = { base, compared: 0, changedFunctions: 0, pairs: [] };
  if (files.every((file) => file.headPath === null)) return empty;
  const { tree } = writeBaseTree(root, base, files);
  try {
    const changes = join(tree, ".dry-changes.json");
    writeFileSync(
      changes,
      JSON.stringify({
        files,
        spans: Object.fromEntries(changed),
        hunks: Object.fromEntries(hunks),
      })
    );
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
  return findings(report).length === 0 ? 0 : 1;
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
