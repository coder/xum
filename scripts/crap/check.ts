// make crap-check: score the files changed since BASE at the base and in the
// working tree, then apply the policy rules (policy.ts).
// Exit 0 pass, 1 violations, 2 tool error.
//
//   bun scripts/crap/check.ts --base <ref> [--json] [--coverage <lcov>]...
//       [--base-coverage <lcov>]... [--debt <reason>]...
//       [--incomplete-coverage <reason>]
//
// --incomplete-coverage says the --coverage reports miss some test runs (CI:
// a missing shard, or a file that ran without coverage), so coverage-based
// violations become warnings (policy.ts, coverageRelief).
//
// Call the script, not `make crap-check`, when the exit code matters: make
// turns every failing recipe into exit 2.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { changesSince, git, SCORED, writeBaseTree, type ChangedFile } from "./changes";
import { applyDebt, evaluate, type DebtUse, type Finding, type FunctionRow } from "./policy";

const ADAPTER = join(import.meta.dir, "crapper_report.py");

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
  const { tree, paths } = writeBaseTree(root, base, files);
  try {
    const renames: Array<[string, string]> = [];
    for (const { basePath, headPath } of files) {
      // A rename to an unscored type (foo.ts -> foo.txt) is a removal.
      if (
        basePath !== null &&
        headPath !== null &&
        headPath !== basePath &&
        SCORED.test(headPath)
      ) {
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
      "incomplete-coverage": { type: "string" },
    },
  });
  if (!values.base) throw new Error("--base <ref> is required");
  const { root, base, files, changed } = changesSince(process.cwd(), values.base);
  const headPaths = files.flatMap((file) => (file.headPath ? [file.headPath] : []));
  const { findings, totalComplexity } = evaluate(
    scoreBase(root, base, files, values["base-coverage"]),
    score(root, headPaths, values.coverage),
    changed,
    values["incomplete-coverage"] ?? null
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
