import { describe, expect, test } from "bun:test";
import * as stats from "./pageTimingStats";

const { gate, median, NO_REGRESSION_LIMIT, qualifyPage, signalQualifies } = stats;
const quiet = [0.02, -0.03, 0.01, 0, -0.01, 0.04, -0.02, 0.03]; // median 0.005, d(7) 0.03
const shift = (s: number) => quiet.map((d) => d + s);
const page = (ucs: number[]) => ({ ucs, ir: quiet });

describe("qualification", () => {
  test("a failed first A/A block needs exactly one confirmatory block, and a second failure is final", () => {
    expect(qualifyPage([page(quiet)])).toBe("qualified");
    expect(qualifyPage([page(shift(0.2))])).toBe("needs-confirmation");
    expect(qualifyPage([page(shift(0.2)), page(quiet)])).toBe("qualified");
    expect(qualifyPage([page(shift(0.2)), page(shift(-0.2))])).toBe("inconclusive");
    expect(() => qualifyPage([page(quiet), page(quiet)])).toThrow(
      "only after a failed first block"
    );
  });

  test("UCS tolerates 3 outlier pairs beyond 0.25 s but not 4; IR checks only its median", () => {
    const outliers = (n: number) => quiet.map((d, i) => (i < n ? (i % 2 ? -0.7 : 0.7) : d));
    expect(signalQualifies("ucs", outliers(3))).toBe(true);
    expect(signalQualifies("ucs", outliers(4))).toBe(false);
    expect(Math.abs(median(outliers(4)))).toBeLessThan(0.1);
    expect(signalQualifies("ir", outliers(4))).toBe(true);
    expect(signalQualifies("ir", shift(0.31))).toBe(false);
  });
});

describe("gate", () => {
  const ucs = { qualification: "qualified", signal: "ucs", mdi: 1.4 } as const;

  test("no-regression gates the median", () => {
    expect(gate({ ...ucs, d: shift(NO_REGRESSION_LIMIT.ucs - 0.01) }).verdict).toBe("pass");
    expect(gate({ ...ucs, d: shift(NO_REGRESSION_LIMIT.ucs) })).toMatchObject({
      verdict: "fail",
      rule: "no-regression",
    });
  });

  test("a predicted saving at or above the MDI needs d(7) <= -saving / 2", () => {
    // One slow pair (+0.5 s) does not fail it: d(7) skips the largest difference.
    const oneSlowPair = [0.5, ...shift(-1.1).slice(1)];
    expect(gate({ ...ucs, d: oneSlowPair, predictedSaving: 2 })).toMatchObject({
      verdict: "pass",
      rule: "improvement",
    });
    expect(gate({ ...ucs, d: shift(-0.9), predictedSaving: 2 })).toMatchObject({
      verdict: "fail",
      rule: "improvement",
    });
  });

  test("a predicted saving below the MDI switches to no-regression", () => {
    const d = shift(-0.2); // a real gain, but less than half of the 1 s prediction
    expect(gate({ ...ucs, mdi: 0.9, d, predictedSaving: 1 }).verdict).toBe("fail");
    expect(gate({ ...ucs, d, predictedSaving: 1 })).toMatchObject({
      verdict: "pass",
      rule: "no-regression",
    });
  });

  test("an inconclusive host gives no verdict, and an unconfirmed one refuses to gate", () => {
    expect(gate({ ...ucs, qualification: "inconclusive", d: shift(5) }).verdict).toBe(
      "inconclusive"
    );
    expect(() => gate({ ...ucs, qualification: "needs-confirmation", d: quiet })).toThrow(
      "confirmatory"
    );
  });
});

// The 14 A/A pairs per page and signal from two blocks on the dev host (main built twice), in ms. Expected
// rates and MDIs come from the prototype bootstrap (scratch an/qualsim3.py, 200,000 blocks).
const ms = (s: string) => s.split(" ").map((x) => Number(x) / 1000);
const fixture: Array<[string, stats.Signal, number[], number, number, number]> = [
  // name, signal, pairs, MDI (s), qualification false-fail (%), no-regression false-fail (%)
  ["P1 UCS", "ucs", ms("68 12 -56 -28 -204 92 -16 680 -52 128 -44 -152 -204 -124"), 1.36, 8.1, 0.1],
  [
    "P1 IR",
    "ir",
    ms("-562.9 -554.9 111.4 605.7 17.4 144.4 364.5 21.4 222.4 -112.8 90 -78.6 27.4 38.2"),
    1.2114,
    1.4,
    0.4,
  ],
  ["P2 UCS", "ucs", ms("80 -28 -52 716 -20 96 108 -68 -12 0 -28 20 0 132"), 1.432, 3.5, 0.1],
  [
    "P2 IR",
    "ir",
    ms("-23 38.9 99.4 -14.6 9.2 7.9 -1159.5 46.7 -105.2 -44.1 -32 92.6 -121.8 60.8"),
    0.1988,
    0.1,
    0,
  ],
];

test("the MDI is twice the 95th percentile of d(7)", () => {
  // One 0.5 s pair in 16: d(7) = 0.5 in 8.5% of blocks (two or more draws), so p95 = 0.5 but p90 = 0.
  expect(stats.minimumDetectableImprovement([0.5, ...Array<number>(15).fill(0)])).toBe(1);
  // One 1 s pair in 32: d(7) = 1 in only 2.4% of blocks, so one outlier pair cannot raise the MDI.
  expect(stats.minimumDetectableImprovement([1, ...Array<number>(31).fill(0)])).toBe(0);
});

test.each(fixture)(
  "%s A/A pairs reproduce the prototype bootstrap",
  (_, signal, aa, mdi, qualFail, nrFail) => {
    expect(stats.minimumDetectableImprovement(aa)).toBeCloseTo(mdi, 4);
    const blocks = stats.bootstrapBlocks(aa, 20_000, 7);
    const rate = (fails: (b: number[]) => boolean) =>
      (100 * blocks.filter(fails).length) / blocks.length;
    // At 20,000 blocks the standard error of an 8% rate is 0.2 points.
    expect(Math.abs(rate((b) => !signalQualifies(signal, b)) - qualFail)).toBeLessThan(0.8);
    expect(Math.abs(rate((b) => median(b) > NO_REGRESSION_LIMIT[signal]) - nrFail)).toBeLessThan(
      0.3
    );
  }
);
