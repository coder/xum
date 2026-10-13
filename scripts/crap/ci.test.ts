import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotation, coverageStatus, lcovFiles } from "./ci";
import type { Finding } from "./policy";

test("coverage is partial when any expected shard report is missing", () => {
  const expected = { unit: 2, integration: 1 };
  const all = ["crap-lcov-unit-1", "crap-lcov-unit-2", "crap-lcov-integration-1"];
  expect(coverageStatus(all, expected)).toEqual({ unit: 2, integration: 1, partial: false });
  // Integration shards skip themselves when no backend or browser file changed.
  expect(coverageStatus(all.slice(0, 2), expected)).toEqual({
    unit: 2,
    integration: 0,
    partial: true,
  });
  expect(coverageStatus([], expected).partial).toBe(true);
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
    const write = (path: string) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), "");
    };
    // A unit shard: shared process, two isolated files and the tooling run.
    write("crap-lcov-unit-1/lcov.info");
    write("crap-lcov-unit-1/isolated/12/lcov.info");
    write("crap-lcov-unit-1/isolated/3/lcov.info");
    write("crap-lcov-unit-1/tooling/lcov.info");
    write("crap-lcov-integration-1/lcov.info");
    // A shard whose shared process ran its last retry without coverage: its isolated
    // reports still count as coverage, but the shard is not a complete report.
    write("crap-lcov-unit-2/isolated/0/lcov.info");
    // Neither an artifact without a report nor a stray file is a shard report.
    write("crap-lcov-unit-3/other.txt");
    write("stray.info");

    const { artifacts, files } = lcovFiles(dir);
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
    });
    expect(lcovFiles(join(dir, "missing"))).toEqual({ artifacts: [], files: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
