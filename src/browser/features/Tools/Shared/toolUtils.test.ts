import { describe, expect, test } from "bun:test";

import { getNestedToolStatus, normalizeToolResultForRendering } from "./toolUtils";

describe("getNestedToolStatus", () => {
  test("explicit failed flag wins for output-available calls", () => {
    // Reload-time reconstruction persists no output to sniff; failure arrives
    // out-of-band via the failed flag.
    expect(getNestedToolStatus("output-available", undefined, false, true)).toBe("failed");
    expect(getNestedToolStatus("output-available", undefined, false)).toBe("completed");
  });

  test("real outputs matching the old synthetic summary shape get normal detection", () => {
    // {suppressed, ok, bytes} from an actual tool is ordinary output: its ok
    // bit must not override shape-based error detection.
    expect(
      getNestedToolStatus("output-available", { suppressed: true, ok: false, bytes: 0 }, false)
    ).toBe("completed");
    expect(
      getNestedToolStatus(
        "output-available",
        { suppressed: true, ok: true, bytes: 9, success: false },
        false
      )
    ).toBe("failed");
  });
});

describe("normalizeToolResultForRendering", () => {
  const date = new Date(0);
  const list = [{ hook_output: "kept inside arrays" }];

  test.each([
    {
      name: "unwraps the SDK JSON container",
      input: { type: "json", value: { ok: 1 }, hook_output: "outer" },
      expected: { ok: 1 },
    },
    {
      name: "keeps a type:json object without value",
      input: { type: "json" },
      expected: { type: "json" },
    },
    {
      name: "passes an unwrapped primitive through",
      input: { type: "json", value: "text" },
      expected: "text",
    },
    { name: "passes null through", input: null, expected: null },
    { name: "passes undefined through", input: undefined, expected: undefined },
    { name: "passes arrays through", input: list, expected: list },
    { name: "passes class instances through", input: date, expected: date },
    {
      name: "strips hook and ui-only fields",
      input: {
        success: true,
        data: 1,
        hook_output: "o",
        hook_duration_ms: 5,
        hook_path: "p",
        ui_only: {},
      },
      expected: { success: true, data: 1 },
    },
    {
      name: "maps a bare pre-hook error to a tool error result",
      input: { error: "blocked", hook_output: "o", extra: 1 },
      expected: { success: false, error: "blocked" },
    },
    {
      name: "maps a wrapped bare error to a tool error result",
      input: { type: "json", value: { error: "blocked" } },
      expected: { success: false, error: "blocked" },
    },
    {
      name: "keeps an error that carries a success flag",
      input: { success: true, error: "partial", hook_path: "p" },
      expected: { success: true, error: "partial" },
    },
    {
      name: "keeps an error that carries a status",
      input: { status: "refused", error: "busy" },
      expected: { status: "refused", error: "busy" },
    },
    {
      name: "keeps a non-string error",
      input: { error: { code: 1 } },
      expected: { error: { code: 1 } },
    },
  ])("$name", ({ input, expected }) => {
    // Hook/UI displays read the original result, so normalization must copy, never mutate:
    // deleting from a frozen object throws in strict-mode modules.
    expect(normalizeToolResultForRendering(deepFreeze(input))).toEqual(expected);
  });
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
