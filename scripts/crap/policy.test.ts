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

/** A row whose CRAP is set directly, for exact values on the growth line. */
function withCrap(base: FunctionRow, crap: number): FunctionRow {
  return { ...base, crap };
}

describe("floor", () => {
  const f = `${PATH}::demo.mod::f`;

  test("without coverage a function may grow while its head CC stays at or below 10", () => {
    expect(verdicts([row("f", 8, [1, 9])], [row("f", 10, [1, 9])])).toEqual([]);
    expect(verdicts([row("f", 10, [1, 9])], [row("f", 11, [1, 9])])).toEqual([
      ["floor-cc", "violation", f],
    ]);
    // Untouched or touched: the floor does not look at the diff.
    expect(verdicts([row("f", 40, [1, 9])], [row("f", 41, [1, 9])], touchedAt(3))).toEqual([
      ["floor-cc", "violation", f],
    ]);
    expect(verdicts([row("f", 40, [1, 9])], [row("f", 39, [1, 9])])).toEqual([]);
  });

  test("with head coverage a function may grow while its head CRAP stays at or below 30", () => {
    // CI today: the base has no coverage, the head does.
    expect(verdicts([row("f", 2, [1, 9])], [row("f", 3, [1, 9], 0)])).toEqual([]); // CRAP 12
    expect(verdicts([row("f", 7, [1, 9])], [row("f", 11, [1, 9], 0.92)])).toEqual([]); // CRAP 11.06
    expect(verdicts([row("f", 5, [1, 9])], [row("f", 6, [1, 9], 0)])).toEqual([
      ["floor-cc", "violation", f], // CRAP 42
    ]);
    const [finding] = evaluate(
      [row("f", 5, [1, 9])],
      [row("f", 6, [1, 9], 0)],
      NOTHING_CHANGED
    ).findings;
    expect(finding?.message).toContain("head CRAP 42 above 30");
  });

  test("with coverage on both sides CRAP may grow only up to 30", () => {
    const base = row("f", 6, [1, 9], 1);
    expect(verdicts([withCrap(base, 20)], [withCrap(base, 28)])).toEqual([]);
    expect(verdicts([withCrap(base, 25)], [withCrap(base, 35)])).toEqual([
      ["floor-crap", "violation", f],
    ]);
    // Without base coverage the CRAP floor has nothing to compare.
    expect(verdicts([row("f", 6, [1, 9])], [withCrap(base, 35)])).toEqual([]);
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

  test("with coverage the limit is CRAP 15, without it CC 8", () => {
    const key = (name: string) => `${PATH}::demo.mod::${name}`;
    expect(verdicts([], [row("small", 3, [1, 9], 0)])).toEqual([]); // CRAP 12
    expect(verdicts([], [row("full", 15, [1, 9], 1)])).toEqual([]); // CRAP 15
    expect(verdicts([], [row("untested", 4, [1, 9], 0)])).toEqual([
      ["new-function", "violation", key("untested")], // CRAP 20
    ]);
    expect(verdicts([], [withCrap(row("edge", 4, [1, 9], 0), 16)])).toEqual([
      ["new-function", "violation", key("edge")],
    ]);
    expect(verdicts([], [row("noCoverage", 9, [1, 9])])).toEqual([
      ["new-function", "violation", key("noCoverage")],
    ]);
  });

  test("net-extraction relief warns only when the changed files' total CC drops", () => {
    const base = [row("big", 40, [1, 99])];
    const split = (bigCc: number) => [row("big", bigCc, [1, 60]), row("piece", 12, [61, 99])];
    const piece = `${PATH}::demo.mod::piece`;
    expect(verdicts(base, split(25))).toEqual([["new-function", "warning", piece]]);
    // big lost 5, but piece holds 11 decision points: code was added, not moved.
    expect(verdicts(base, split(35))).toEqual([["new-function", "violation", piece]]);
  });

  describe("relief with coverage", () => {
    const base = [row("big", 40, [1, 99], 1)];
    const piece = `${PATH}::demo.mod::piece`;
    const withCrap = (crap: number): FunctionRow => ({ ...row("piece", 12, [61, 99], 0), crap });
    // big keeps 29 of 40: a pure move (move relief); 25: a net decrease.
    const moved = (bigCc: number, crap: number) => [row("big", bigCc, [1, 60], 1), withCrap(crap)];

    test("covers a piece up to CRAP 30, either kind", () => {
      for (const bigCc of [29, 25]) {
        expect(verdicts(base, moved(bigCc, 30))).toEqual([["new-function", "warning", piece]]);
        expect(verdicts(base, moved(bigCc, 30.5))).toEqual([["new-function", "violation", piece]]);
      }
    });

    test("does not cover an untested piece, and says why", () => {
      // CC 12 untested: CRAP 156. The CC-only move above warns for the same split.
      const head = [row("big", 29, [1, 60], 1), row("piece", 12, [61, 99], 0)];
      const [finding] = evaluate(base, head, NOTHING_CHANGED).findings;
      expect(finding?.severity).toBe("violation");
      expect(finding?.message).toContain("relief needs CRAP <= 30");
    });

    test("an incomplete coverage report turns the capped violation into a warning", () => {
      // At full coverage the piece scores CRAP 12, under the cap, so only coverage blocks it.
      const head = [row("big", 29, [1, 60], 1), row("piece", 12, [61, 99], 0)];
      const findings = evaluate(base, head, NOTHING_CHANGED, "shard reports missing").findings;
      expect(findings.map((finding) => finding.severity)).toEqual(["warning"]);
    });
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

// Defusing a hotspot step by step. CI shape: base rows without coverage, head
// rows with coverage, unless the test says otherwise.
describe("gradual hotspot defusing", () => {
  const hot = (cc: number, coverage: number | null) => row("AppInner", cc, [1, 2000], coverage);
  const helpers = (coverage: number) =>
    ["a", "b", "c"].map((name, i) =>
      row(`helper${name}`, 16, [3000 + i * 100, 3050 + i * 100], coverage)
    );
  const all = touchedAt(1, 4000);
  const findings = (base: FunctionRow[], head: FunctionRow[]) =>
    evaluate(base, head, all).findings.map((finding) => [
      finding.head.name,
      finding.rule,
      finding.severity,
    ]);

  test("S1: deleting code from a hotspot passes", () => {
    expect(findings([hot(246, null)], [hot(200, 0.56)])).toEqual([]);
  });

  test("S2: extracting tested helpers (CRAP 16) warns only (move relief)", () => {
    expect(findings([hot(246, null)], [hot(200, 0.56), ...helpers(0.9)])).toEqual([
      ["helpera", "new-function", "warning"],
      ["helperb", "new-function", "warning"],
      ["helperc", "new-function", "warning"],
    ]);
  });

  test("S3: growing a hotspot by one decision fails", () => {
    expect(findings([hot(246, null)], [hot(247, 0.56)])).toEqual([
      ["AppInner", "floor-cc", "violation"],
    ]);
  });

  test("S4: touching a hotspot without shrinking it warns", () => {
    expect(findings([hot(246, null)], [hot(246, 0.56)])).toEqual([
      ["AppInner", "crap-tax", "warning"],
    ]);
  });

  test("S5: extracting untested helpers fails: relief needs CRAP 30 or less", () => {
    expect(findings([hot(246, null)], [hot(200, 0), ...helpers(0)])).toEqual([
      ["helpera", "new-function", "violation"],
      ["helperb", "new-function", "violation"],
      ["helperc", "new-function", "violation"],
    ]);
  });

  test("S6: one extracted piece of CC 46 fails even at 95% coverage", () => {
    const piece = row("bigHelper", 46, [3000, 3300], 0.95);
    expect(findings([hot(246, null)], [hot(200, 0.56), piece])).toEqual([
      ["bigHelper", "new-function", "violation"],
    ]);
  });

  test("S7: with base coverage, touching a hotspot without shrinking it warns", () => {
    expect(findings([hot(246, 0.56)], [hot(246, 0.56)])).toEqual([
      ["AppInner", "crap-tax", "warning"],
    ]);
  });

  test("with base coverage, a hotspot that sheds CC but loses more coverage fails", () => {
    // CRAP 5401 -> 8840 at CC 246 -> 200: growth above CRAP 30 blocks, whatever the CC did.
    expect(findings([hot(246, 0.56)], [hot(200, 0.4)])).toEqual([
      ["AppInner", "floor-crap", "violation"],
    ]);
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

  test("with coverage on both sides a touched hotspot that kept its CRAP is a warning too", () => {
    const covered = row("big", 40, [10, 90], 0.5);
    expect(verdicts([covered], [covered], touchedAt(50))).toEqual([
      ["crap-tax", "warning", `${PATH}::demo.mod::big`],
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
  const setter = row("size", 11, [19, 21]);
  // Input order must not matter: the setter is listed first on both sides.
  const findings = verdicts([setter, getter], [row("size", 12, [19, 22]), getter]);
  expect(findings).toEqual([["floor-cc", "violation", `${PATH}::demo.mod::size[2]`]]);
});

test("a Crap-Debt downgrades every violation to a warning", () => {
  const { findings } = evaluate([row("f", 11, [1, 9])], [row("f", 12, [1, 9])], NOTHING_CHANGED);
  expect(applyDebt(findings, []).map((finding) => finding.severity)).toEqual(["violation"]);
  const debt = [{ source: "--debt", reason: "hotfix" }];
  expect(applyDebt(findings, debt).map((finding) => finding.severity)).toEqual(["warning"]);
});

describe("Bun inlined-const suspects", () => {
  const suspect = (base: FunctionRow): FunctionRow => ({ ...base, bunInlinedConstSuspect: true });
  const f = `${PATH}::demo.mod::f`;
  const g = `${PATH}::demo.mod::g`;

  test("coverage-based findings on a suspect head warn", () => {
    const base = row("f", 10, [1, 9], 1);
    const lost = row("f", 10, [1, 9], 0); // CRAP 10 -> 110
    expect(verdicts([base], [lost])).toEqual([["floor-crap", "violation", f]]);
    expect(verdicts([base], [suspect(lost)])).toEqual([["floor-crap", "warning", f]]);
    const grown = row("f", 6, [1, 9], 0); // CC 5 -> 6, CRAP 42
    expect(verdicts([row("f", 5, [1, 9])], [grown])).toEqual([["floor-cc", "violation", f]]);
    expect(verdicts([row("f", 5, [1, 9])], [suspect(grown)])).toEqual([["floor-cc", "warning", f]]);
    expect(verdicts([], [row("g", 4, [1, 9], 0)])).toEqual([["new-function", "violation", g]]);
    expect(verdicts([], [suspect(row("g", 4, [1, 9], 0))])).toEqual([
      ["new-function", "warning", g],
    ]);
  });

  test("a suspect base gets no relief: the bug can only raise its score", () => {
    const base = suspect(row("f", 10, [1, 9], 1));
    expect(verdicts([base], [row("f", 10, [1, 9], 0)])).toEqual([["floor-crap", "violation", f]]);
  });

  test("findings that CC alone proves stay violations", () => {
    // CRAP is at least CC: a new CC 16 function fails even at full coverage.
    expect(verdicts([], [suspect(row("g", 16, [1, 9], 0))])).toEqual([
      ["new-function", "violation", g],
    ]);
    // A CC gain to CC 31 is above CRAP 30 even at full coverage.
    expect(verdicts([row("f", 30, [1, 9], 1)], [suspect(row("f", 31, [1, 9], 0))])).toEqual([
      ["floor-cc", "violation", f],
    ]);
  });

  test("the warning says why, and a complexity gain stays a violation", () => {
    const { findings } = evaluate(
      [row("f", 10, [1, 9], 1), row("h", 30, [11, 12], 1)],
      [suspect(row("f", 10, [1, 9], 0)), suspect(row("h", 31, [11, 13], 0))],
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
    const base = [
      row("f", 10, [1, 9], 1),
      row("t", 31, [11, 19], 0),
      row("h", 30, [21, 22], 1),
      row("m", 5, [51, 59], 1),
    ];
    const head = [
      row("f", 10, [1, 9], 0), // floor-crap: CRAP 10 -> 110, but 10 at full coverage
      row("t", 31, [11, 19], 0), // crap-tax: always a warning
      row("h", 31, [21, 23], 1), // floor-cc: CC 31 is above CRAP 30 at any coverage
      row("g", 4, [31, 39], 0), // new function, CRAP 20 but CC 4
      row("k", 16, [41, 49], 1), // new function, CC 16 > 15 at any coverage
      row("m", 6, [51, 59], 0), // floor-cc: CRAP 42, but 6 at full coverage
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
      ["m", "floor-cc", "violation"],
      ["t", "crap-tax", "warning"],
    ]);
    expect(verdicts(incomplete.findings)).toEqual([
      ["f", "floor-crap", "warning"],
      ["g", "new-function", "warning"],
      ["h", "floor-cc", "violation"],
      ["k", "new-function", "violation"],
      ["m", "floor-cc", "warning"],
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
