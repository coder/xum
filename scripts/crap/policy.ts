// Pure CRAP gate rules: compare a base and a head snapshot of
// crapper_report.py rows. check.ts does the git and scorer I/O.
import {
  CRAP_TAX_STAGE,
  NEW_FUNCTION_MAX_SCORE,
  NEW_FUNCTION_ON_NET_DECREASE,
  TAX_WITHOUT_COVERAGE,
  netExtractionRelief,
  type Severity,
} from "./thresholds";

export type { Severity };

export interface FunctionRow {
  path: string;
  name: string;
  namespace: string;
  startLine: number;
  endLine: number;
  complexity: number;
  /** Fraction 0..1, or null when the snapshot has no coverage data. */
  coverage: number | null;
  crap: number | null;
}

export type Rule = "floor-cc" | "floor-crap" | "new-function" | "crap-tax";

export interface Finding {
  rule: Rule;
  severity: Severity;
  key: string;
  head: FunctionRow;
  base: FunctionRow | null;
  message: string;
}

/** Head-side line spans of `git diff -U0` hunks, per path. */
export type ChangedLines = Map<string, Array<[number, number]>>;

/**
 * Identity is `path::namespace::name`. Crapper reports several functions with
 * one key (a getter and setter pair, two same-named classes in one module), so
 * the 2nd and later get an ordinal suffix in start-line order. A function
 * renamed or moved to another file gets a new key and counts as new. check.ts
 * scores a renamed file's base content at its head path, so its functions keep
 * their keys.
 */
export function keyRows(rows: readonly FunctionRow[]): Map<string, FunctionRow> {
  const sorted = [...rows].sort((a, b) => a.startLine - b.startLine);
  const keyed = new Map<string, FunctionRow>();
  const seen = new Map<string, number>();
  for (const row of sorted) {
    const key = `${row.path}::${row.namespace}::${row.name}`;
    const ordinal = (seen.get(key) ?? 0) + 1;
    seen.set(key, ordinal);
    keyed.set(ordinal === 1 ? key : `${key}[${ordinal}]`, row);
  }
  return keyed;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses `git diff -U0 --default-prefix` output (with `core.quotePath=false`)
 * into head-side line spans. Git ends a `+++` path that contains a space with
 * a tab. It still quotes a path with a tab, quote, backslash or control
 * character: such files get no spans, so the CRAP tax skips them.
 */
export function parseChangedLines(diff: string): ChangedLines {
  const changed: ChangedLines = new Map();
  let spans: Array<[number, number]> | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).replace(/\t$/, "");
      spans = target === "/dev/null" ? null : [];
      if (spans) changed.set(target.replace(/^b\//, ""), spans);
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (!hunk || !spans) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    // A pure deletion sits between head lines `start` and `start + 1`. The
    // half-line span touches only a function that contains both of them.
    spans.push(count === 0 ? [start + 0.5, start + 0.5] : [start, start + count - 1]);
  }
  return changed;
}

function touched(row: FunctionRow, changed: ChangedLines): boolean {
  const spans = changed.get(row.path) ?? [];
  return spans.some(([start, end]) => row.startLine <= end && start <= row.endLine);
}

function where(row: FunctionRow): string {
  return `${row.path}:${row.startLine}-${row.endLine} ${row.name}`;
}

function compare(
  key: string,
  base: FunctionRow,
  head: FunctionRow,
  changed: ChangedLines
): Finding | null {
  const finding = (rule: Rule, severity: Severity, message: string): Finding => ({
    rule,
    severity,
    key,
    head,
    base,
    message: `${where(head)}: ${message}`,
  });
  if (head.complexity > base.complexity) {
    return finding(
      "floor-cc",
      "violation",
      `CC ${base.complexity} -> ${head.complexity} (must not grow)`
    );
  }
  const baseCrap = base.crap;
  const headCrap = head.crap;
  const scored = baseCrap !== null && headCrap !== null;
  if (scored && headCrap > baseCrap) {
    return finding("floor-crap", "violation", `CRAP ${baseCrap} -> ${headCrap} (must not grow)`);
  }
  const baseScore = scored ? baseCrap : base.complexity;
  const headScore = scored ? headCrap : head.complexity;
  if (baseScore > CRAP_TAX_STAGE && headScore >= baseScore && touched(head, changed)) {
    const unit = scored ? "CRAP" : "CC";
    const severity = scored ? "violation" : TAX_WITHOUT_COVERAGE;
    const change = headScore === baseScore ? "unchanged" : `-> ${headScore}`;
    const ask =
      severity === "violation"
        ? `above ${CRAP_TAX_STAGE}, must end lower`
        : "consider shrinking it";
    return finding("crap-tax", severity, `touched hotspot, ${unit} ${baseScore} ${change}: ${ask}`);
  }
  return null;
}

function judgeNew(
  key: string,
  head: FunctionRow,
  totals: { base: number; head: number }
): Finding | null {
  const unit = head.crap === null ? "CC" : "CRAP";
  const score = head.crap ?? head.complexity;
  if (score <= NEW_FUNCTION_MAX_SCORE) return null;
  const relieved = netExtractionRelief(totals.base, totals.head);
  const relief = relieved
    ? `, net-extraction relief: total CC ${totals.base} -> ${totals.head}`
    : "";
  return {
    rule: "new-function",
    severity: relieved ? NEW_FUNCTION_ON_NET_DECREASE : "violation",
    key,
    head,
    base: null,
    message: `${where(head)}: new function ${unit} ${score} (max ${NEW_FUNCTION_MAX_SCORE}${relief})`,
  };
}

function totalComplexity(rows: readonly FunctionRow[]): number {
  return rows.reduce((sum, row) => sum + row.complexity, 0);
}

export interface Evaluation {
  findings: Finding[];
  /** Total CC of every scored function in the changed files. */
  totalComplexity: { base: number; head: number };
}

/**
 * Applies the floor, new-function and CRAP tax rules, at most one finding per
 * function. `baseRows` and `headRows` must cover the same changed files.
 */
export function evaluate(
  baseRows: readonly FunctionRow[],
  headRows: readonly FunctionRow[],
  changed: ChangedLines
): Evaluation {
  const totals = { base: totalComplexity(baseRows), head: totalComplexity(headRows) };
  const base = keyRows(baseRows);
  const findings: Finding[] = [];
  for (const [key, head] of keyRows(headRows)) {
    const before = base.get(key);
    const finding = before ? compare(key, before, head, changed) : judgeNew(key, head, totals);
    if (finding) findings.push(finding);
  }
  findings.sort((a, b) => a.key.localeCompare(b.key));
  return { findings, totalComplexity: totals };
}

export interface DebtUse {
  /** "commit <sha>" for a Crap-Debt trailer, "--debt" for the flag (CI passes the PR label). */
  source: string;
  reason: string;
}

/** A recorded Crap-Debt downgrades every violation to a warning. */
export function applyDebt(findings: readonly Finding[], debt: readonly DebtUse[]): Finding[] {
  if (debt.length === 0) return [...findings];
  return findings.map((finding) => ({ ...finding, severity: "warning" }));
}
