import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutateReport } from "./check";
import { annotation, summary, unitCoverage } from "./ci";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mutate-ci-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function shard(name: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "lcov.info"), "");
}

test("unit coverage is used only when every unit shard reported", () => {
  shard("crap-lcov-unit-1");
  shard("crap-lcov-integration-1");
  expect(unitCoverage(dir, 2)).toEqual({ files: [], complete: false });

  shard("crap-lcov-unit-2");
  const full = unitCoverage(dir, 2);
  expect(full.complete).toBe(true);
  // Integration reports do not count: the mutants run unit tests only.
  expect(full.files.map((f) => f.slice(dir.length + 1)).sort()).toEqual([
    "crap-lcov-unit-1/lcov.info",
    "crap-lcov-unit-2/lcov.info",
  ]);
});

const report: MutateReport = {
  base: "abc",
  mutants: [
    { path: "src/a.ts", function: "f", line: 4, original: "a|b", mutant: "", outcome: "survived" },
    { path: "src/a.ts", function: "f", line: 5, original: ">", mutant: ">=", outcome: "killed" },
  ],
  tests: { "src/a.ts": ["src/a.test.ts"] },
  cappedTests: [],
  droppedTests: [],
  seconds: 1,
};

test("the summary lists survivors only, and escapes table cells", () => {
  const text = summary(report, true, "");
  expect(text).toContain("`delete a\\|b`");
  expect(text).not.toContain(":5`");
});

test("the annotation sits on the mutant's line", () => {
  expect(annotation(report.mutants[0]).startsWith("::warning file=src/a.ts,line=4,")).toBe(true);
});

test("a unit test that ran without coverage makes coverage incomplete", () => {
  shard("crap-lcov-unit-1");
  shard("crap-lcov-unit-2");
  // scripts/test-unit-ci.sh writes this marker when a retry ran without coverage.
  writeFileSync(join(dir, "crap-lcov-unit-2", "ran-without-coverage.txt"), "isolated/3\n");
  expect(unitCoverage(dir, 2)).toEqual({ files: [], complete: false });
});

test("the summary says when the run cut a source's test files", () => {
  const text = summary({ ...report, cappedTests: ["src/a.ts"] }, true, "");
  expect(text).toContain("src/a.ts");
  expect(text).toMatch(/nearest/);
});
