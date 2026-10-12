// make crap-check: score the files changed since BASE at the base and in the
// working tree, then apply the policy rules (policy.ts).
// Exit 0 pass, 1 violations, 2 tool error.
//
//   bun scripts/crap/check.ts --base <ref> [--json] [--coverage <lcov>]...
//       [--base-coverage <lcov>]... [--debt <reason>]...
//
// Call the script, not `make crap-check`, when the exit code matters: make
// turns every failing recipe into exit 2.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  applyDebt,
  evaluate,
  parseChangedLines,
  type DebtUse,
  type Finding,
  type FunctionRow,
} from "./policy";

const ADAPTER = join(import.meta.dir, "crapper_report.py");

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function score(
  root: string,
  files: string[],
  lcov: readonly string[],
  renames: ReadonlyArray<[string, string]> = []
): FunctionRow[] {
  // The adapter scores all of src/ when given no files, so never call it empty.
  if (files.length === 0) return [];
  const args = ["run", "--quiet", "--script", ADAPTER, "--root", root];
  for (const report of lcov) args.push("--lcov", report);
  for (const [from, to] of renames) args.push("--rename", from, to);
  const out = execFileSync("uv", [...args, ...files], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(out) as FunctionRow[];
}

// Cheap pre-filter so binaries and lockfiles never reach the temp tree. The
// adapter applies the full production-file rule (crapper_report.py).
const SCORED = /^src\/.*\.[cm]?[jt]sx?$/;

/**
 * One changed file since `base`. `basePath` is null for an added file,
 * `headPath` null for a deleted one. `-M` pairs a renamed file's two paths so
 * its functions keep their identity (the policy keys on the path).
 */
interface ChangedFile {
  basePath: string | null;
  headPath: string | null;
}

function parseNameStatus(output: string): ChangedFile[] {
  const fields = output.split("\0");
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < fields.length && fields[i] !== "") {
    const status = fields[i];
    // `-M` without `-C` reports renames (R<similarity>) but never copies.
    if (status.startsWith("R")) {
      files.push({ basePath: fields[i + 1], headPath: fields[i + 2] });
      i += 3;
    } else {
      const path = fields[i + 1];
      files.push({
        basePath: status === "A" ? null : path,
        headPath: status === "D" ? null : path,
      });
      i += 2;
    }
  }
  return files.filter((file) => [file.basePath, file.headPath].some((p) => p && SCORED.test(p)));
}

/** `Crap-Debt: <reason>` trailers on the commits in base..HEAD. */
function readDebt(root: string, base: string): DebtUse[] {
  const log = git(root, [
    "log",
    "--format=%h%x09%(trailers:key=Crap-Debt,valueonly,separator=%x1f)",
    `${base}..HEAD`,
  ]);
  const uses: DebtUse[] = [];
  for (const line of log.split("\n")) {
    const [sha, reasons = ""] = line.split("\t");
    for (const reason of reasons.split("\x1f").map((value) => value.trim())) {
      if (reason) uses.push({ source: `commit ${sha}`, reason });
    }
  }
  return uses;
}

/**
 * Scores the base side in a temp tree that keeps the base paths, so the
 * adapter applies its production filter and base coverage to the old path.
 * A renamed file's functions are reported under the head path, so their
 * identities match the head. A file renamed from a test or story into
 * production has no base rows, and its functions count as new.
 */
function scoreBase(
  root: string,
  base: string,
  files: readonly ChangedFile[],
  lcov: readonly string[]
): FunctionRow[] {
  const tree = mkdtempSync(join(tmpdir(), "crap-base-"));
  try {
    const paths: string[] = [];
    const renames: Array<[string, string]> = [];
    for (const { basePath, headPath } of files) {
      if (basePath === null) continue;
      mkdirSync(dirname(join(tree, basePath)), { recursive: true });
      const blob = execFileSync("git", ["show", `${base}:${basePath}`], {
        cwd: root,
        maxBuffer: 256 * 1024 * 1024,
      });
      writeFileSync(join(tree, basePath), blob);
      paths.push(basePath);
      // A rename to an unscored type (foo.ts -> foo.txt) is a removal.
      if (headPath !== null && headPath !== basePath && SCORED.test(headPath)) {
        renames.push([basePath, headPath]);
      }
    }
    return score(tree, paths, lcov, renames);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

interface Report {
  base: string;
  coverage: { base: boolean; head: boolean };
  findings: Finding[];
  totalComplexity: { base: number; head: number };
  debt: DebtUse[];
  ok: boolean;
}

function formatReport(report: Report): string {
  const violations = report.findings.filter((finding) => finding.severity === "violation");
  const warnings = report.findings.length - violations.length;
  const mode = report.coverage.head
    ? report.coverage.base
      ? "base and head coverage"
      : "head coverage only"
    : "complexity only";
  const lines = [
    `crap-check: ${report.ok ? "PASS" : "FAIL"}, ${violations.length} violation(s), ${warnings} warning(s) (base ${report.base.slice(0, 10)}, ${mode}, changed files total CC ${report.totalComplexity.base} -> ${report.totalComplexity.head})`,
    ...report.findings.map(
      (finding) =>
        `  ${finding.severity === "violation" ? "VIOLATION" : "warning  "} ${finding.rule.padEnd(12)} ${finding.message}`
    ),
    ...report.debt.map((use) => `  Crap-Debt (${use.source}): ${use.reason}`),
  ];
  if (report.findings.length > 0) {
    lines.push(
      "Repair: shrink the function (extract pure logic, a named hook or a child component) or test it."
    );
  }
  return lines.join("\n");
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      json: { type: "boolean", default: false },
      coverage: { type: "string", multiple: true, default: [] },
      "base-coverage": { type: "string", multiple: true, default: [] },
      debt: { type: "string", multiple: true, default: [] },
    },
  });
  if (!values.base) throw new Error("--base <ref> is required");
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const base = git(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${values.base}^{commit}`,
  ]).trim();
  // The working tree is the head: unstaged edits count, untracked files do not.
  // Pin the output format against user config (diff.mnemonicPrefix,
  // diff.noprefix, core.quotePath) so paths match the scorer's.
  const diffArgs = [
    "-c",
    "core.quotePath=false",
    "diff",
    "-M",
    "--default-prefix",
    "--no-color",
    "--no-ext-diff",
    base,
  ];
  const files = parseNameStatus(git(root, [...diffArgs, "--name-status", "-z"])).filter(
    (file) => file.headPath === null || existsSync(join(root, file.headPath))
  );
  const headPaths = files.flatMap((file) => (file.headPath ? [file.headPath] : []));
  const pathspec = files.flatMap((file) =>
    [file.basePath, file.headPath].filter((p) => p !== null)
  );
  const changed = parseChangedLines(git(root, [...diffArgs, "-U0", "--", ...new Set(pathspec)]));
  const { findings, totalComplexity } = evaluate(
    scoreBase(root, base, files, values["base-coverage"]),
    score(root, headPaths, values.coverage),
    changed
  );
  const debt = [
    ...readDebt(root, base),
    ...values.debt.map((reason) => ({ source: "--debt", reason })),
  ];
  const final = applyDebt(findings, debt);
  const report: Report = {
    base,
    coverage: { base: values["base-coverage"].length > 0, head: values.coverage.length > 0 },
    findings: final,
    totalComplexity,
    debt,
    ok: final.every((finding) => finding.severity !== "violation"),
  };
  console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.ok ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    // A broken scorer (no uv, offline grammar download, bad ref) is not a
    // policy verdict: exit 2 so callers can tell it from violations.
    console.error(
      `crap-check: tool error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 2;
  }
}
