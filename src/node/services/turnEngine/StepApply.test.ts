import { describe, expect, test } from "bun:test";

import { summarizeToolResultForLog } from "./StepApply";

describe("summarizeToolResultForLog", () => {
  test("strings log their length and a preview cut at 160 characters", () => {
    expect(summarizeToolResultForLog("x".repeat(500))).toEqual({
      outputType: "string",
      outputLength: 500,
      outputPreview: "x".repeat(160),
    });
  });

  test("null, numbers and booleans log their type and value", () => {
    expect(summarizeToolResultForLog(null)).toEqual({ outputType: "null" });
    expect(summarizeToolResultForLog(42)).toEqual({ outputType: "number", outputPreview: "42" });
    expect(summarizeToolResultForLog(false)).toEqual({
      outputType: "boolean",
      outputPreview: "false",
    });
  });

  test("arrays log their length and the type of their first item", () => {
    expect(summarizeToolResultForLog([{ a: 1 }, "b"])).toEqual({
      outputType: "array",
      outputLength: 2,
      firstItemType: "object",
    });
    expect(summarizeToolResultForLog([null])).toEqual({
      outputType: "array",
      outputLength: 1,
      firstItemType: "null",
    });
    expect(summarizeToolResultForLog([])).toEqual({
      outputType: "array",
      outputLength: 0,
      firstItemType: undefined,
    });
  });

  test("objects log at most 8 keys, plus the format and value length of typed results", () => {
    const keys = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    expect(summarizeToolResultForLog(keys)).toEqual({
      outputType: "object",
      outputKeyCount: 10,
      outputKeys: ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"],
    });
    expect(summarizeToolResultForLog({ type: "json", value: [1, 2, 3] })).toEqual({
      outputType: "object",
      outputKeyCount: 2,
      outputKeys: ["type", "value"],
      outputFormat: "json",
      outputValueLength: 3,
    });
    // A non-string type and a non-array value are not reported.
    expect(summarizeToolResultForLog({ type: 1, value: "v" })).toEqual({
      outputType: "object",
      outputKeyCount: 2,
      outputKeys: ["type", "value"],
    });
  });

  test("other values log their type", () => {
    expect(summarizeToolResultForLog(undefined)).toEqual({
      outputType: "undefined",
      outputPreview: undefined,
    });
  });
});
