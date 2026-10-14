import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  annotation,
  coverageStatus,
  crapMode,
  exitCode,
  expectedShards,
  incompleteCoverageReason,
  lcovFiles,
  summary,
} from "./ci";
import type { Finding } from "./policy";

test("coverage is partial when any expected shard report is missing", () => {
  const expected = { unit: 2, integration: 1 };
  const all = ["crap-lcov-unit-1", "crap-lcov-unit-2", "crap-lcov-integration-1"];
  expect(coverageStatus(all, expected)).toEqual({
    unit: 2,
    integration: 1,
    partial: false,
    withoutCoverage: [],
  });
  expect(incompleteCoverageReason(coverageStatus(all, expected), expected)).toBeNull();
  // Integration shards skip themselves when no backend or browser file changed.
  expect(coverageStatus(all.slice(0, 2), expected)).toEqual({
    unit: 2,
    integration: 0,
    partial: true,
    withoutCoverage: [],
  });
  expect(coverageStatus([], expected).partial).toBe(true);
  expect(incompleteCoverageReason(coverageStatus(all.slice(0, 2), expected), expected)).toBe(
    "shard reports missing (2/2 unit, 0/1 integration)"
  );
  // A run that fell back to no coverage makes a complete set incomplete too.
  const fellBack = coverageStatus(all, expected, ["crap-lcov-unit-1: src/a.test.ts"]);
  expect(incompleteCoverageReason(fellBack, expected)).toBe(
    "ran without coverage: crap-lcov-unit-1: src/a.test.ts"
  );
});

test("annotations escape workflow-command syntax in paths and messages", () => {
  const finding: Finding = {
    rule: "new-function",
    severity: "violation",
    key: "k",
    base: null,
    head: {
      path: "src/a,b:c.ts",
      name: "f",
      namespace: "a",
      startLine: 3,
      endLine: 9,
      complexity: 12,
      coverage: null,
      crap: null,
    },
    message: "100% new\n::error::x",
  };
  expect(annotation(finding)).toBe(
    "::warning file=src/a%2Cb%3Ac.ts,line=3,endLine=9,title=CRAP new-function (violation)::100%25 new%0A::error::x"
  );
});

test("reads every nested lcov.info, but counts only artifacts with a top-level report", () => {
  const dir = mkdtempSync(join(tmpdir(), "crap-ci-"));
  try {
    const write = (path: string, text = "") => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    // A unit shard: shared process, two isolated files and the tooling run.
    write("crap-lcov-unit-1/lcov.info");
    write("crap-lcov-unit-1/isolated/12/lcov.info");
    write("crap-lcov-unit-1/isolated/3/lcov.info");
    write("crap-lcov-unit-1/tooling/lcov.info");
    // An isolated run that fell back to no coverage leaves only its marker.
    write("crap-lcov-unit-1/isolated/7/ran-without-coverage.txt", "src/b.test.ts\n");
    write("crap-lcov-integration-1/lcov.info");
    // A shard whose shared process ran its last retry without coverage: its isolated
    // reports still count as coverage, but the shard is not a complete report.
    write("crap-lcov-unit-2/isolated/0/lcov.info");
    // Neither an artifact without a report nor a stray file is a shard report.
    write("crap-lcov-unit-3/other.txt");
    write("stray.info");

    const { artifacts, files, withoutCoverage } = lcovFiles(dir);
    expect(withoutCoverage).toEqual(["crap-lcov-unit-1: src/b.test.ts"]);
    expect(artifacts).toEqual(["crap-lcov-integration-1", "crap-lcov-unit-1"]);
    expect(files.map((file) => file.slice(dir.length + 1))).toEqual([
      "crap-lcov-integration-1/lcov.info",
      "crap-lcov-unit-1/isolated/12/lcov.info",
      "crap-lcov-unit-1/isolated/3/lcov.info",
      "crap-lcov-unit-1/lcov.info",
      "crap-lcov-unit-1/tooling/lcov.info",
      "crap-lcov-unit-2/isolated/0/lcov.info",
    ]);
    expect(coverageStatus(artifacts, { unit: 2, integration: 1 })).toEqual({
      unit: 1,
      integration: 1,
      partial: true,
      withoutCoverage: [],
    });
    expect(lcovFiles(join(dir, "missing"))).toEqual({
      artifacts: [],
      files: [],
      withoutCoverage: [],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the summary lists Bun inlined-const suspects in their own group", () => {
  const head = {
    path: "src/a.ts",
    name: "f",
    namespace: "a",
    startLine: 1,
    endLine: 9,
    complexity: 12,
    coverage: 0,
    crap: 156,
  };
  const findings: Finding[] = [
    { rule: "floor-cc", severity: "violation", key: "a", base: null, head, message: "grew" },
    {
      rule: "new-function",
      severity: "warning",
      key: "b",
      base: null,
      head: { ...head, bunInlinedConstSuspect: true },
      message: "hidden",
      bunInlinedConstSuspect: true,
    },
  ];
  const expected = { unit: 1, integration: 0 };
  const text = summary({ findings, debt: [], ok: false }, coverageStatus(["crap-lcov-unit-1"], expected), expected, "");
  const group = text.indexOf("### Coverage Bun may hide (1 warning(s))");
  expect(group).toBeGreaterThan(0);
  expect(text.indexOf("| violation | floor-cc | grew |")).toBeLessThan(group);
  expect(text.indexOf("| warning | new-function | hidden |")).toBeGreaterThan(group);
  expect(text).toContain("**1 violation(s), 1 warning(s).**");
});

test("only block mode with violations exits 1; warn mode and tool errors never block", () => {
  expect(crapMode("block")).toBe("block");
  for (const value of [undefined, "", "warn", "Block", "true"]) expect(crapMode(value)).toBe("warn");
  const failing = { findings: [], debt: [], ok: false };
  const passing = { findings: [], debt: [], ok: true };
  expect(exitCode("block", failing)).toBe(1);
  expect(exitCode("block", passing)).toBe(0);
  expect(exitCode("block", null)).toBe(0);
  expect(exitCode("warn", failing)).toBe(0);
});

test("a PR whose integration shards skip their tests expects no integration report", () => {
  const env = { EXPECTED_UNIT: "6", EXPECTED_INTEGRATION: "3" };
  expect(expectedShards({ ...env, INTEGRATION_RAN: "true" })).toEqual({ unit: 6, integration: 3 });
  // Unknown (no changes output) keeps the full count: missing reports then only warn.
  expect(expectedShards(env)).toEqual({ unit: 6, integration: 3 });
  const skipped = expectedShards({ ...env, INTEGRATION_RAN: "false" });
  expect(skipped).toEqual({ unit: 6, integration: 0 });
  const units = ["1", "2", "3", "4", "5", "6"].map((shard) => `crap-lcov-unit-${shard}`);
  expect(incompleteCoverageReason(coverageStatus(units, skipped), skipped)).toBeNull();
});
