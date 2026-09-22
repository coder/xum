import { describe, expect, test } from "bun:test";
import { MAX_TOOL_PAYLOAD_JSON_DEPTH } from "@/constants/json";
import {
  TOOL_PAYLOAD_DEPTH_REJECTION,
  boundToolPayloadDepth,
  jsonTextExceedsDepth,
  valueExceedsDepth,
} from "./toolPayloadDepth";

const nestedText = (depth: number) => "[".repeat(depth) + "1" + "]".repeat(depth);
function nestedValue(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) value = i % 2 === 0 ? [value] : { k: value };
  return value;
}

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

describe("valueExceedsDepth", () => {
  test("agrees with the text scanner on mixed arrays/objects at the bound", () => {
    expect(valueExceedsDepth(nestedValue(MAX_TOOL_PAYLOAD_JSON_DEPTH))).toBe(false);
    expect(valueExceedsDepth(nestedValue(MAX_TOOL_PAYLOAD_JSON_DEPTH + 1))).toBe(true);
    expect(valueExceedsDepth("a string", 0)).toBe(false);
    expect(valueExceedsDepth({}, 0)).toBe(true);
  });

  test("measures a value far too deep for JSON.stringify without overflowing", () => {
    expect(valueExceedsDepth(nestedValue(200_000))).toBe(true);
  });
});

describe("boundToolPayloadDepth", () => {
  const shallowRow = {
    id: "m",
    role: "assistant",
    metadata: { historySequence: 3 },
    parts: [
      { type: "text", text: "hi" },
      { type: "dynamic-tool", toolCallId: "c", toolName: "t", input: { a: [1] }, output: { b: 2 } },
    ],
  };

  test("returns the same reference when nothing exceeds the bound", () => {
    expect(boundToolPayloadDepth(shallowRow)).toBe(shallowRow);
    const noParts = { id: "no-parts", role: "user", parts: [] };
    expect(boundToolPayloadDepth(noParts)).toBe(noParts);
  });

  test("replaces only the offending input/output and keeps everything else", () => {
    const deep = nestedValue(MAX_TOOL_PAYLOAD_JSON_DEPTH + 1);
    const row = {
      ...shallowRow,
      parts: [
        shallowRow.parts[0],
        { type: "dynamic-tool", toolCallId: "d", toolName: "t", input: deep, output: { ok: true } },
        { type: "dynamic-tool", toolCallId: "e", toolName: "t", input: { ok: true }, output: deep },
        shallowRow.parts[1],
      ],
    };
    const bounded = boundToolPayloadDepth(row);
    expect(bounded).not.toBe(row);
    expect(bounded.metadata).toBe(row.metadata);
    expect(bounded.parts[0]).toBe(row.parts[0]);
    expect(bounded.parts[3]).toBe(row.parts[3]);
    expect(bounded.parts[1]).toEqual({
      type: "dynamic-tool",
      toolCallId: "d",
      toolName: "t",
      input: TOOL_PAYLOAD_DEPTH_REJECTION,
      output: { ok: true },
    });
    expect(bounded.parts[2]).toMatchObject({
      input: { ok: true },
      output: TOOL_PAYLOAD_DEPTH_REJECTION,
    });
    // The source row is never mutated.
    expect(row.parts[1].input).toBe(deep);
  });

  test("the rejection text is not parseable as JSON", () => {
    expect(() => {
      JSON.parse(TOOL_PAYLOAD_DEPTH_REJECTION);
    }).toThrow(SyntaxError);
  });
});
