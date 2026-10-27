// Pure CRAP gate rules: compare a base and a head snapshot of
// crapper_report.py rows. check.ts does the git and scorer I/O.
import {
  CRAP_TAX_SEVERITY,
  CRAP_TAX_STAGE,
  GROWTH_MAX_CC_WITHOUT_COVERAGE,
  NEW_FUNCTION_ON_NET_DECREASE,
  RELIEF_MAX_CRAP,
  floorAllowsGrowth,
  moveRelief,
  netExtractionRelief,
  newFunctionMax,
  reliefAllowsCrap,
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
  /**
   * True when the Bun inlined-const coverage bug probably hid some of this
   * function's coverage (crapper_report.py, inlined_const_suspect). Absent in
   * rows scored before the field existed.
   */
  bunInlinedConstSuspect?: boolean;
}

export type Rule = "floor-cc" | "floor-crap" | "new-function" | "crap-tax";

export interface Finding {
  rule: Rule;
  severity: Severity;
  key: string;
  head: FunctionRow;
  base: FunctionRow | null;
  message: string;
  /** Set when coverageRelief turned the finding into a warning for the Bun bug. */
  bunInlinedConstSuspect?: boolean;
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

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** One `git diff -U0` hunk: [baseStart, baseCount, headStart, headCount]. */
export type Hunk = [number, number, number, number];

/**
 * The file and hunk headers of a `git diff -U0`, in order. A file header
 * names the head path (null for a deleted file). Each hunk's body lines are
 * skipped by count, because an added source line `++ x` renders as `+++ x`
 * and is not a file header. A line with no body prefix ends the body early.
 */
export function* diffHeaders(
  diff: string
): Generator<{ kind: "file"; path: string | null } | { kind: "hunk"; hunk: Hunk }> {
  // Body lines left in the current hunk, per side. A context line (from
  // diff.interHunkContext) counts on both sides, a "-" line on the base, a "+"
  // line on the head, and "\ No newline at end of file" on neither.
  let base = 0;
  let head = 0;
  for (const line of diff.split("\n")) {
    const sign = line[0];
    if (base + head > 0 && (sign === "-" || sign === "+" || sign === " " || sign === "\\")) {
      if (sign !== "+" && sign !== "\\") base--;
      if (sign !== "-" && sign !== "\\") head--;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).replace(/\t$/, "");
      yield { kind: "file", path: target === "/dev/null" ? null : target.replace(/^b\//, "") };
      continue;
    }
    const match = HUNK_HEADER.exec(line);
    if (!match) continue;
    const count = (value: string | undefined) => (value === undefined ? 1 : Number(value));
    const hunk: Hunk = [Number(match[1]), count(match[2]), Number(match[3]), count(match[4])];
    [base, head] = [hunk[1], hunk[3]];
    yield { kind: "hunk", hunk };
  }
}

/**
 * Parses `git diff -U0 --default-prefix` output (with `core.quotePath=false`)
 * into head-side line spans. Git ends a `+++` path that contains a space with
 * a tab. It still quotes a path with a tab, quote, backslash or control
 * character: such files get no spans, so the CRAP tax skips them.
 */
export function parseChangedLines(diff: string): ChangedLines {
  const changed: ChangedLines = new Map();
  let spans: Array<[number, number]> | null = null;
  for (const header of diffHeaders(diff)) {
    if (header.kind === "file") {
      spans = header.path === null ? null : [];
      if (spans && header.path !== null) changed.set(header.path, spans);
      continue;
    }
    if (!spans) continue;
    const [, , start, count] = header.hunk;
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
  const floor = floorBreach(base, head);
  if (floor) return finding(floor.rule, "violation", floor.message);
  const baseCrap = base.crap;
  const headCrap = head.crap;
  const scored = baseCrap !== null && headCrap !== null;
  const baseScore = scored ? baseCrap : base.complexity;
  const headScore = scored ? headCrap : head.complexity;
  if (baseScore > CRAP_TAX_STAGE && headScore >= baseScore && touched(head, changed)) {
    const unit = scored ? "CRAP" : "CC";
    const change = headScore === baseScore ? "unchanged" : `-> ${headScore}`;
    return finding(
      "crap-tax",
      CRAP_TAX_SEVERITY,
      `touched hotspot, ${unit} ${baseScore} ${change}: consider shrinking it`
    );
  }
  return null;
}

/**
 * The floor: growth (CC, or CRAP with coverage on both sides) is a violation
 * only when the head ends above the growth line (floorAllowsGrowth). A CC gain
 * reports floor-cc, a CRAP gain at equal or lower CC floor-crap.
 */
function floorBreach(
  base: FunctionRow,
  head: FunctionRow
): { rule: "floor-cc" | "floor-crap"; message: string } | null {
  const grewCc = head.complexity > base.complexity;
  const grewCrap = base.crap !== null && head.crap !== null && head.crap > base.crap;
  if (!(grewCc || grewCrap) || floorAllowsGrowth(head.complexity, head.crap)) return null;
  const line =
    head.crap === null
      ? `head CC above ${GROWTH_MAX_CC_WITHOUT_COVERAGE}`
      : `head CRAP ${head.crap} above ${CRAP_TAX_STAGE}`;
  return grewCc
    ? {
        rule: "floor-cc",
        message: `CC ${base.complexity} -> ${head.complexity} (${line}: must not grow)`,
      }
    : { rule: "floor-crap", message: `CRAP ${base.crap} -> ${head.crap} (${line}: must not grow)` };
}

/** CC that kept functions lost, and the decision points of the new functions. */
interface MoveTotals {
  keptDrop: number;
  newDecisions: number;
}

function moveTotals(
  base: ReadonlyMap<string, FunctionRow>,
  head: ReadonlyMap<string, FunctionRow>
): MoveTotals {
  let keptDrop = 0;
  let newDecisions = 0;
  for (const [key, row] of head) {
    const before = base.get(key);
    // A kept function that grew lowers the drop: it already has a floor violation.
    if (before) keptDrop += before.complexity - row.complexity;
    else newDecisions += row.complexity - 1;
  }
  return { keptDrop, newDecisions };
}

/** The relief note for a new function above the limit, or null when none applies. */
function reliefNote(
  head: FunctionRow,
  totals: { base: number; head: number },
  moves: MoveTotals
): string | null {
  if (netExtractionRelief(totals.base, totals.head)) {
    return `net-extraction relief: total CC ${totals.base} -> ${totals.head}`;
  }
  if (moveRelief(moves.keptDrop, moves.newDecisions, head.complexity)) {
    return `move relief: kept functions lost CC ${moves.keptDrop} >= ${moves.newDecisions} new decision points`;
  }
  return null;
}

/** Relief applies only up to RELIEF_MAX_CRAP; above it the note says why it did not. */
function relief(
  head: FunctionRow,
  totals: { base: number; head: number },
  moves: MoveTotals
): { note: string; relieved: boolean } | null {
  const note = reliefNote(head, totals, moves);
  if (note === null) return null;
  if (reliefAllowsCrap(head.crap)) return { note, relieved: true };
  return { note: `${note}, but relief needs CRAP <= ${RELIEF_MAX_CRAP}`, relieved: false };
}

function judgeNew(
  key: string,
  head: FunctionRow,
  totals: { base: number; head: number },
  moves: MoveTotals
): Finding | null {
  const unit = head.crap === null ? "CC" : "CRAP";
  const score = head.crap ?? head.complexity;
  const max = newFunctionMax(head.crap);
  if (score <= max) return null;
  const granted = relief(head, totals, moves);
  return {
    rule: "new-function",
    severity: granted?.relieved ? NEW_FUNCTION_ON_NET_DECREASE : "violation",
    key,
    head,
    base: null,
    message: `${where(head)}: new function ${unit} ${score} (max ${max}${granted ? `, ${granted.note}` : ""})`,
  };
}

/**
 * Coverage-based findings become warnings when the head's coverage may be too
 * low, so its score may be too high and must not block:
 *
 * - The Bun inlined-const bug may hide this function's hits
 *   (bunInlinedConstSuspect). Remove this case with the detector (see the
 *   REMOVAL TRIGGER in crapper_report.py).
 * - The coverage is incomplete (`incompleteCoverage` names why): an expected
 *   shard report is missing, or a test lane ran a file without coverage. This
 *   is the check block mode relies on: it blocks only on a complete report.
 *
 * Only the head counts: missing hits only lower coverage, so a base score is
 * no lower than the real one and a head above it still regressed. The relief
 * applies only when the same rules raise no violation on the head at full
 * coverage (CRAP = CC), so a finding that CC alone proves keeps its verdict:
 * for example a CC gain to a head CC above CRAP_TAX_STAGE.
 */
function coverageRelief(
  finding: Finding,
  judge: (head: FunctionRow) => Finding | null,
  incompleteCoverage: string | null
): Finding {
  const { head } = finding;
  const bun = head.bunInlinedConstSuspect === true;
  if (
    head.crap === null ||
    (!bun && (incompleteCoverage === null || finding.severity !== "violation"))
  ) {
    return finding;
  }
  const atFullCoverage = judge({ ...head, coverage: 1, crap: head.complexity });
  // A relieved new function is still a warning finding at full coverage. Only
  // its CRAP above RELIEF_MAX_CRAP made it a violation, and that is coverage-based.
  if (
    atFullCoverage !== null &&
    (atFullCoverage.severity === "violation" || finding.severity === "warning")
  ) {
    return finding;
  }
  const why = bun
    ? "Bun's coverage may hide this function's tests (inlined-const bug, bunInlinedConstSuspect)"
    : `incomplete coverage, ${incompleteCoverage}`;
  return {
    ...finding,
    severity: "warning",
    ...(bun ? { bunInlinedConstSuspect: true } : {}),
    message: `${finding.message} [warning only: ${why}]`,
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
 * `incompleteCoverage` is null for a complete head coverage report, else the
 * reason it is incomplete (see coverageRelief).
 */
export function evaluate(
  baseRows: readonly FunctionRow[],
  headRows: readonly FunctionRow[],
  changed: ChangedLines,
  incompleteCoverage: string | null = null
): Evaluation {
  const totals = { base: totalComplexity(baseRows), head: totalComplexity(headRows) };
  const base = keyRows(baseRows);
  const heads = keyRows(headRows);
  const moves = moveTotals(base, heads);
  const findings: Finding[] = [];
  for (const [key, head] of heads) {
    const before = base.get(key);
    const judge = (row: FunctionRow) =>
      before ? compare(key, before, row, changed) : judgeNew(key, row, totals, moves);
    const finding = judge(head);
    if (finding) findings.push(coverageRelief(finding, judge, incompleteCoverage));
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
