import { expect, test } from "bun:test";
import { annotation, exitCode, summary } from "./ci";
import type { DryPair } from "./check";

const pair: DryPair = {
  score: 1,
  left: { path: "src/a,b.ts", name: "fee", startLine: 3, endLine: 8 },
  right: { path: "src/c.ts", name: "cents", startLine: 10, endLine: 15 },
};

test("the annotation sits on the changed function and escapes the path", () => {
  const line = annotation(pair);
  expect(line.startsWith("::warning file=src/a%2Cb.ts,line=3,endLine=8,")).toBe(true);
  expect(line).toContain("src/c.ts:10-15");
});

test("a pipe in a function name does not break the summary table", () => {
  const text = summary(
    {
      base: "abc",
      compared: 9,
      changedFunctions: 1,
      pairs: [{ ...pair, left: { ...pair.left, name: "a|b" } }],
    },
    "",
    "warn"
  );
  expect(text).toContain("a\\|b");
});

test("a tool error still writes a summary", () => {
  expect(summary(null, "uv: not found\n", "block")).toContain("uv: not found");
});

test("block mode fails only on a duplicate that no marker accepts", () => {
  const report = (pairs: DryPair[]) => ({ base: "abc", compared: 9, changedFunctions: 1, pairs });
  expect(exitCode("block", report([pair]))).toBe(1);
  expect(exitCode("block", report([{ ...pair, accepted: "v1 and v2 must differ" }]))).toBe(0);
  expect(exitCode("warn", report([pair]))).toBe(0);
  // A tool error (no report) never blocks.
  expect(exitCode("block", null)).toBe(0);
});
