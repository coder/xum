import { describe, expect, test } from "bun:test";
import {
  applyDebt,
  evaluate,
  parseChangedLines,
  type ChangedLines,
  type FunctionRow,
} from "./policy";

const PATH = "src/demo/mod.ts";

function row(
  name: string,
  complexity: number,
  lines: [number, number],
  coverage: number | null = null
): FunctionRow {
  const crap = coverage === null ? null : complexity ** 2 * (1 - coverage) ** 3 + complexity;
  return {
    path: PATH,
    name,
    namespace: "demo.mod",
    startLine: lines[0],
    endLine: lines[1],
    complexity,
    coverage,
    crap,
  };
}

function touchedAt(start: number, end = start): ChangedLines {
  return new Map([[PATH, [[start, end]]]]);
}

const NOTHING_CHANGED: ChangedLines = new Map();

function verdicts(base: FunctionRow[], head: FunctionRow[], changed = NOTHING_CHANGED) {
  return evaluate(base, head, changed).findings.map((finding) => [
    finding.rule,
    finding.severity,
    finding.key,
  ]);
}

describe("floor", () => {
  test("a kept function may not gain CC, touched or not", () => {
    expect(verdicts([row("f", 5, [1, 9])], [row("f", 6, [1, 10])])).toEqual([
      ["floor-cc", "violation", `${PATH}::demo.mod::f`],
    ]);
    expect(verdicts([row("f", 5, [1, 9])], [row("f", 4, [1, 8])])).toEqual([]);
  });

  test("with coverage on both sides it may not gain CRAP at equal CC", () => {
    expect(verdicts([row("f", 5, [1, 9], 1)], [row("f", 5, [1, 9], 0.5)])).toEqual([
      ["floor-crap", "violation", `${PATH}::demo.mod::f`],
    ]);
    // Without base coverage the CRAP floor has nothing to compare.
    expect(verdicts([row("f", 5, [1, 9])], [row("f", 5, [1, 9], 0.5)])).toEqual([]);
  });

  test("a CC gain in a touched hotspot reports the floor, not the tax", () => {
    expect(verdicts([row("big", 40, [1, 99])], [row("big", 41, [1, 99])], touchedAt(50))).toEqual([
      ["floor-cc", "violation", `${PATH}::demo.mod::big`],
    ]);
  });
});

describe("new functions", () => {
  test("are judged by CC without coverage and by CRAP with it", () => {
    expect(verdicts([], [row("ok", 8, [1, 9]), row("tooBig", 9, [10, 30])])).toEqual([
      ["new-function", "violation", `${PATH}::demo.mod::tooBig`],
    ]);
    // CC 6 passes alone, but untested its CRAP is 42.
    expect(verdicts([], [row("untested", 6, [1, 9], 0)])).toEqual([
      ["new-function", "violation", `${PATH}::demo.mod::untested`],
    ]);
    expect(verdicts([], [row("tested", 6, [1, 9], 1)])).toEqual([]);
  });

  test("net-extraction relief warns only when the changed files' total CC drops", () => {
    const base = [row("big", 40, [1, 99])];
    const split = (bigCc: number) => [row("big", bigCc, [1, 60]), row("piece", 12, [61, 99])];
    const piece = `${PATH}::demo.mod::piece`;
    expect(verdicts(base, split(25))).toEqual([["new-function", "warning", piece]]);
    expect(verdicts(base, split(28))).toEqual([["new-function", "violation", piece]]);
    expect(verdicts(base, split(35))).toEqual([["new-function", "violation", piece]]);
  });
});

describe("CRAP tax", () => {
  const hotspot = row("big", 40, [10, 90]);

  test("without coverage a touched hotspot that kept its CC is a warning", () => {
    const { findings } = evaluate([hotspot], [hotspot], touchedAt(50));
    expect(findings.map((finding) => [finding.rule, finding.severity])).toEqual([
      ["crap-tax", "warning"],
    ]);
    expect(findings[0].message).toContain("CC 40 unchanged");
  });

  test("with coverage on both sides a touched hotspot must lower its CRAP", () => {
    const covered = row("big", 40, [10, 90], 0.5);
    expect(verdicts([covered], [covered], touchedAt(50))).toEqual([
      ["crap-tax", "violation", `${PATH}::demo.mod::big`],
    ]);
    expect(verdicts([covered], [row("big", 40, [10, 90], 0.6)], touchedAt(50))).toEqual([]);
  });

  test("skips untouched, lowered and at-stage functions", () => {
    expect(verdicts([hotspot], [hotspot], touchedAt(95))).toEqual([]);
    expect(verdicts([hotspot], [row("big", 39, [10, 90])], touchedAt(50))).toEqual([]);
    const atStage = row("edge", 30, [10, 90]);
    expect(verdicts([atStage], [atStage], touchedAt(50))).toEqual([]);
  });

  test("a pure deletion touches only the function around both of its neighbor lines", () => {
    const left = row("left", 40, [10, 20]);
    const right = row("right", 40, [21, 30]);
    // `@@ -16,2 +15,0 @@` deletes base lines 16-17, between head lines 15 and 16.
    const inside = parseChangedLines(`+++ b/${PATH}\n@@ -16,2 +15,0 @@\n`);
    expect(verdicts([left, right], [left, right], inside)).toEqual([
      ["crap-tax", "warning", `${PATH}::demo.mod::left`],
    ]);
    // Deleting between head lines 20 and 21 is on the boundary of both.
    const between = parseChangedLines(`+++ b/${PATH}\n@@ -21,3 +20,0 @@\n`);
    expect(verdicts([left, right], [left, right], between)).toEqual([]);
  });

  test("a path with a space keeps its spans despite Git's trailing tab", () => {
    const spaced = { ...row("big", 40, [10, 90]), path: "src/demo/a b.ts" };
    const diff = parseChangedLines("+++ b/src/demo/a b.ts\t\n@@ -50 +50 @@\n");
    expect(evaluate([spaced], [spaced], diff).findings.map((finding) => finding.rule)).toEqual([
      "crap-tax",
    ]);
  });
});

test("duplicate keys pair up by start-line order", () => {
  const getter = row("size", 1, [16, 18]);
  const setter = row("size", 2, [19, 21]);
  // Input order must not matter: the setter is listed first on both sides.
  const findings = verdicts([setter, getter], [row("size", 3, [19, 22]), getter]);
  expect(findings).toEqual([["floor-cc", "violation", `${PATH}::demo.mod::size[2]`]]);
});

test("a Crap-Debt downgrades every violation to a warning", () => {
  const { findings } = evaluate([row("f", 5, [1, 9])], [row("f", 6, [1, 9])], NOTHING_CHANGED);
  expect(applyDebt(findings, []).map((finding) => finding.severity)).toEqual(["violation"]);
  const debt = [{ source: "--debt", reason: "hotfix" }];
  expect(applyDebt(findings, debt).map((finding) => finding.severity)).toEqual(["warning"]);
});
