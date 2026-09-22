import { describe, expect, test } from "bun:test";
import { MAX_TOOL_PAYLOAD_JSON_DEPTH } from "@/constants/json";
import { TOOL_PAYLOAD_DEPTH_REJECTION, jsonTextExceedsDepth } from "./toolPayloadDepth";

const nestedText = (depth: number) => "[".repeat(depth) + "1" + "]".repeat(depth);

describe("jsonTextExceedsDepth", () => {
  test("limit edges: at the bound passes, one deeper fails", () => {
    expect(jsonTextExceedsDepth(nestedText(MAX_TOOL_PAYLOAD_JSON_DEPTH))).toBe(false);
    expect(jsonTextExceedsDepth(nestedText(MAX_TOOL_PAYLOAD_JSON_DEPTH + 1))).toBe(true);
    expect(jsonTextExceedsDepth('{"a":{"b":[1]}}', 3)).toBe(false);
    expect(jsonTextExceedsDepth('{"a":{"b":[1]}}', 2)).toBe(true);
  });

  test("brackets inside strings and escaped quotes do not nest", () => {
    const text = JSON.stringify({ script: "[".repeat(1000) + '\\"{{' + "]".repeat(3) });
    expect(jsonTextExceedsDepth(text, 2)).toBe(false);
    // Depth resumes correctly after the string closes.
    expect(jsonTextExceedsDepth('{"s":"\\"[","t":[[1]]}', 2)).toBe(true);
    expect(jsonTextExceedsDepth('{"s":"\\"[","t":[1]}', 2)).toBe(false);
  });

  test("siblings do not accumulate", () => {
    expect(jsonTextExceedsDepth("[[1],[2],[3]]", 2)).toBe(false);
  });
});

describe("TOOL_PAYLOAD_DEPTH_REJECTION", () => {
  test("the rejection text is not parseable as JSON", () => {
    expect(() => {
      JSON.parse(TOOL_PAYLOAD_DEPTH_REJECTION);
    }).toThrow(SyntaxError);
  });
});
