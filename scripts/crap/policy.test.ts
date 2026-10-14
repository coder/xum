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
    // big lost 5, but piece holds 11 decision points: code was added, not moved.
    expect(verdicts(base, split(35))).toEqual([["new-function", "violation", piece]]);
  });

  describe("move relief", () => {
    const base = [row("big", 40, [1, 99])];
    const key = (name: string) => `${PATH}::demo.mod::${name}`;

    test("warns on a pure move, whose total CC rises by 1", () => {
      // 11 decision points leave big and land in piece (CC 12).
      const head = [row("big", 29, [1, 60]), row("piece", 12, [61, 99])];
      expect(verdicts(base, head)).toEqual([["new-function", "warning", key("piece")]]);
    });

    test("stays a violation when the moved step also grew", () => {
      const head = [row("big", 30, [1, 60]), row("piece", 12, [61, 99])];
      expect(verdicts(base, head)).toEqual([["new-function", "violation", key("piece")]]);
    });

    test("covers several pieces only when the drop pays for all of them", () => {
      const head = [row("big", 20, [1, 50]), row("a", 11, [51, 75]), row("b", 11, [76, 99])];
      expect(verdicts(base, head)).toEqual([
        ["new-function", "warning", key("a")],
        ["new-function", "warning", key("b")],
      ]);
      // The small helper's decision point is new code the drop of 11 no longer covers.
      const withHelper = [
        row("big", 29, [1, 50]),
        row("piece", 12, [51, 90]),
        row("h", 2, [91, 99]),
      ];
      expect(verdicts(base, withHelper)).toEqual([["new-function", "violation", key("piece")]]);
    });

    test("does not cover a step above the cap", () => {
      const head = [row("big", 19, [1, 40]), row("piece", 22, [41, 99])];
      expect(verdicts(base, head)).toEqual([["new-function", "violation", key("piece")]]);
    });

    test("does not cover a rename, or new code that a smaller cut does not pay for", () => {
      expect(verdicts([row("f", 50, [1, 99])], [row("g", 50, [1, 99])])).toEqual([
        ["new-function", "violation", key("g")],
      ]);
      expect(
        verdicts([row("a", 10, [1, 20])], [row("a", 5, [1, 10]), row("feat", 12, [11, 40])])
      ).toEqual([["new-function", "violation", key("feat")]]);
    });

    test("is aggregate, like net-extraction relief: a large enough cut pays for new code", () => {
      // The gate cannot tell a move from a cut plus new code. Net-extraction
      // relief already warns at a cut of 13; move relief warns at 11.
      const head = [row("existing", 19, [1, 20]), row("feature", 12, [21, 40])];
      expect(verdicts([row("existing", 30, [1, 40])], head)).toEqual([
        ["new-function", "warning", key("feature")],
      ]);
    });
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

describe("Bun inlined-const suspects", () => {
  const suspect = (base: FunctionRow): FunctionRow => ({ ...base, bunInlinedConstSuspect: true });

  test("coverage-based findings on a suspect head warn", () => {
    const base = row("f", 5, [1, 9], 1);
    const lost = row("f", 5, [1, 9], 0);
    expect(verdicts([base], [lost])).toEqual([["floor-crap", "violation", `${PATH}::demo.mod::f`]]);
    expect(verdicts([base], [suspect(lost)])).toEqual([
      ["floor-crap", "warning", `${PATH}::demo.mod::f`],
    ]);
    const hotspot = row("f", 6, [1, 9], 0);
    expect(verdicts([hotspot], [hotspot], touchedAt(3))).toEqual([
      ["crap-tax", "violation", `${PATH}::demo.mod::f`],
    ]);
    expect(verdicts([hotspot], [suspect(hotspot)], touchedAt(3))).toEqual([
      ["crap-tax", "warning", `${PATH}::demo.mod::f`],
    ]);
    expect(verdicts([], [row("g", 3, [1, 9], 0)])).toEqual([
      ["new-function", "violation", `${PATH}::demo.mod::g`],
    ]);
    expect(verdicts([], [suspect(row("g", 3, [1, 9], 0))])).toEqual([
      ["new-function", "warning", `${PATH}::demo.mod::g`],
    ]);
  });

  test("a suspect base gets no relief: the bug can only raise its score", () => {
    const hotspot = row("f", 6, [1, 9], 0);
    expect(verdicts([suspect(hotspot)], [hotspot], touchedAt(3))).toEqual([
      ["crap-tax", "violation", `${PATH}::demo.mod::f`],
    ]);
  });

  test("findings that CC alone proves stay violations", () => {
    // CRAP is at least CC: a new CC 9 function fails even at full coverage.
    expect(verdicts([], [suspect(row("g", 9, [1, 9], 0))])).toEqual([
      ["new-function", "violation", `${PATH}::demo.mod::g`],
    ]);
    // A fully covered CC 31 hotspot that keeps its CC cannot end lower: at
    // full coverage it passes the CRAP floor but still owes the CRAP tax.
    expect(verdicts([row("f", 31, [1, 9], 1)], [suspect(row("f", 31, [1, 9], 0))], touchedAt(3))).toEqual([
      ["floor-crap", "violation", `${PATH}::demo.mod::f`],
    ]);
  });

  test("the warning says why, and a complexity gain stays a violation", () => {
    const { findings } = evaluate(
      [row("f", 5, [1, 9], 1), row("h", 2, [11, 12], 1)],
      [suspect(row("f", 5, [1, 9], 0)), suspect(row("h", 3, [11, 13], 0))],
      NOTHING_CHANGED
    );
    expect(findings.map((finding) => [finding.rule, finding.severity])).toEqual([
      ["floor-crap", "warning"],
      ["floor-cc", "violation"],
    ]);
    expect(findings[0].bunInlinedConstSuspect).toBe(true);
    expect(findings[0].message).toContain("inlined-const");
    expect(findings[1].bunInlinedConstSuspect).toBeUndefined();
  });
});

describe("incomplete coverage", () => {
  const INCOMPLETE = "shard reports missing (5/6 unit, 3/3 integration)";

  test("coverage-based violations warn and say why, complexity-only verdicts stand", () => {
    const changed = touchedAt(1, 49);
    const base = [row("f", 5, [1, 9], 1), row("t", 31, [11, 19], 0), row("h", 2, [21, 22], 1)];
    const head = [
      row("f", 5, [1, 9], 0.5), // floor-crap
      row("t", 31, [11, 19], 0), // crap-tax: CRAP 992 unchanged, but 31 at full coverage
      row("h", 3, [21, 23], 1), // floor-cc
      row("g", 3, [31, 39], 0), // new function, CRAP 12 but CC 3
      row("k", 9, [41, 49], 1), // new function, CC 9 > 8 at any coverage
    ];
    const complete = evaluate(base, head, changed);
    const incomplete = evaluate(base, head, changed, INCOMPLETE);
    const verdicts = (findings: typeof complete.findings) =>
      findings.map((finding) => [finding.head.name, finding.rule, finding.severity]);
    expect(verdicts(complete.findings)).toEqual([
      ["f", "floor-crap", "violation"],
      ["g", "new-function", "violation"],
      ["h", "floor-cc", "violation"],
      ["k", "new-function", "violation"],
      ["t", "crap-tax", "violation"],
    ]);
    expect(verdicts(incomplete.findings)).toEqual([
      ["f", "floor-crap", "warning"],
      ["g", "new-function", "warning"],
      ["h", "floor-cc", "violation"],
      ["k", "new-function", "violation"],
      ["t", "crap-tax", "warning"],
    ]);
    const relieved = incomplete.findings.find((finding) => finding.head.name === "g");
    expect(relieved?.message).toContain(INCOMPLETE);
    expect(relieved?.bunInlinedConstSuspect).toBeUndefined();
  });

  test("leaves complexity-only reports and existing warnings alone", () => {
    // Without coverage the rules compare CC, which a missing report cannot change.
    expect(verdicts([], [row("g", 9, [1, 9])])).toEqual([
      ["new-function", "violation", `${PATH}::demo.mod::g`],
    ]);
    const { findings } = evaluate([], [row("g", 9, [1, 9])], NOTHING_CHANGED, INCOMPLETE);
    expect(findings.map((finding) => finding.severity)).toEqual(["violation"]);
    const hotspot = row("t", 31, [1, 9]);
    const tax = evaluate([hotspot], [hotspot], touchedAt(3), INCOMPLETE).findings;
    expect(
      tax.map((finding) => [finding.rule, finding.severity, finding.message.includes("incomplete")])
    ).toEqual([["crap-tax", "warning", false]]);
  });
});
