import { expect, test } from "bun:test";
import { annotation, coverageStatus } from "./ci";
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
