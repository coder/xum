import { describe, expect, test } from "bun:test";
import {
  advertisedMCPSettingsToolNames,
  boundMCPSettingsError,
  MAX_MCP_SETTING_ENUM_OPTIONS,
  MAX_MCP_SETTING_NAME,
  MAX_MCP_SETTINGS,
  parseMCPSettingsCapability,
  parseMCPSettingsReadResult,
  validateMCPSettingValue,
} from "./mcpSettings";

const capability = { "openai/settings": { readTool: "s.read", updateTool: "s.update" } };

describe("parseMCPSettingsCapability", () => {
  test("reads extensions (2026-07-28+) or legacy experimental; rejects blank names", () => {
    const expected = { readTool: "s.read", updateTool: "s.update" };
    expect(parseMCPSettingsCapability({ extensions: capability })).toEqual(expected);
    expect(parseMCPSettingsCapability({ experimental: capability })).toEqual(expected);
    expect(
      parseMCPSettingsCapability({
        experimental: { "openai/settings": { readTool: " ", updateTool: "s.update" } },
      })
    ).toBeUndefined();
    expect(parseMCPSettingsCapability({ tools: {} })).toBeUndefined();
  });

  test("a half-malformed capability still names its valid tool, so the host hides it", () => {
    const half = { experimental: { "openai/settings": { readTool: "", updateTool: "s.update" } } };
    expect(parseMCPSettingsCapability(half)).toBeUndefined();
    expect(advertisedMCPSettingsToolNames(half)).toEqual(["s.update"]);
  });
});

describe("parseMCPSettingsReadResult", () => {
  test("keeps valid settings, drops bad ones with warnings, and groups the rest last", () => {
    const result = parseMCPSettingsReadResult({
      schema: {
        type: "object",
        properties: {
          units: { type: "string", title: "Units", enum: ["mm", "in"] },
          grid: { type: "boolean", title: "Show grid" },
          zoom: { type: "integer", title: "Zoom", minimum: 1, maximum: 5 },
          color: { type: "object", title: "Unsupported type" },
          badEnum: { type: "string", title: "Bad", enum: ["a", 1] },
          noTitle: { type: "boolean" },
          wrongValue: { type: "number", title: "Wrong value" },
          // Declared with no value: must not survive through Object.prototype.toString.
          toString: { type: "boolean", title: "Inherited name" },
        },
      },
      values: { units: "in", grid: false, zoom: 2, badEnum: "a", noTitle: true, wrongValue: "9" },
      layout: [
        {
          kind: "group",
          title: "Display",
          items: [
            { kind: "property", property: "units" },
            { kind: "tool", tool: "cad.library" },
            { kind: "property", property: "color" },
            // Inherited, not declared: must not resolve through Object.prototype.
            { kind: "property", property: "toString" },
            { kind: "mystery" },
          ],
        },
        { kind: "page", title: "Not a group" },
      ],
    });
    if ("error" in result) throw new Error(result.error);
    expect(Object.keys(result.properties)).toEqual(["units", "grid", "zoom"]);
    expect(result.values).toEqual({ units: "in", grid: false, zoom: 2 });
    expect(result.layout).toEqual([
      {
        title: "Display",
        items: [
          { kind: "property", property: "units" },
          { kind: "tool", tool: "cad.library" },
        ],
      },
      {
        title: "Other settings",
        items: [
          { kind: "property", property: "grid" },
          { kind: "property", property: "zoom" },
        ],
      },
    ]);
    // color, badEnum, noTitle (schema); wrongValue, toString (value); mystery item; page group.
    expect(result.warnings).toHaveLength(7);
    // Settings the UI cannot show: color, badEnum, noTitle, wrongValue and toString.
    expect(result.droppedSettingCount).toBe(5);
  });

  test("ignores a server pattern (never runs server regexes) and accepts an empty enum option", () => {
    const result = parseMCPSettingsReadResult({
      schema: {
        type: "object",
        properties: {
          // A value that breaks its pattern stays: the server's update tool is the judge.
          code: { type: "string", title: "Code", pattern: "^x$" },
          mode: { type: "string", title: "Mode", enum: ["", "fast"] },
        },
      },
      values: { code: "y", mode: "" },
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.values).toEqual({ code: "y", mode: "" });
    expect(result.properties.code).toEqual({ type: "string", title: "Code" });
    expect(result.warnings).toEqual([]);
  });

  test("bounds the settings and layout a server can send; excess settings count as dropped", () => {
    const names = Array.from({ length: MAX_MCP_SETTINGS + 5 }, (_, i) => `s${i}`);
    const result = parseMCPSettingsReadResult({
      schema: {
        type: "object",
        properties: Object.fromEntries(names.map((n) => [n, { type: "boolean", title: n }])),
      },
      values: Object.fromEntries(names.map((n) => [n, true])),
      layout: Array.from({ length: 30 }, (_, i) => ({
        kind: "group",
        title: `g${i}`,
        items: Array.from({ length: 150 }, () => ({ kind: "tool", tool: "t" })),
      })),
    });
    if ("error" in result) throw new Error(result.error);
    expect(Object.keys(result.properties)).toHaveLength(MAX_MCP_SETTINGS);
    expect(result.droppedSettingCount).toBe(5);
    // 20 groups of at most 100 items, then "Other settings" for the ungrouped properties.
    expect(result.layout).toHaveLength(21);
    expect(Math.max(...result.layout.map((group) => group.items.length))).toBe(100);
  });

  test("drops a setting whose name is longer than the name limit (counted in code points)", () => {
    const fits = "😀".repeat(MAX_MCP_SETTING_NAME);
    const tooLong = "a".repeat(MAX_MCP_SETTING_NAME + 1);
    const result = parseMCPSettingsReadResult({
      schema: {
        type: "object",
        properties: {
          [fits]: { type: "boolean", title: "Fits" },
          [tooLong]: { type: "boolean", title: "Too long" },
        },
      },
      values: { [fits]: true, [tooLong]: true },
    });
    if ("error" in result) throw new Error(result.error);
    expect(Object.keys(result.properties)).toEqual([fits]);
    expect(result.droppedSettingCount).toBe(1);
    // The warning does not echo the overlong name.
    expect(result.warnings.join("\n")).not.toContain(tooLong);
  });

  test("drops a setting with more enum options than a Select can show", () => {
    const options = (n: number) => Array.from({ length: n }, (_, i) => `o${i}`);
    const result = parseMCPSettingsReadResult({
      schema: {
        type: "object",
        properties: {
          ok: { type: "string", title: "Ok", enum: options(MAX_MCP_SETTING_ENUM_OPTIONS) },
          huge: { type: "string", title: "Huge", enum: options(MAX_MCP_SETTING_ENUM_OPTIONS + 1) },
        },
      },
      values: { ok: "o0", huge: "o0" },
    });
    if ("error" in result) throw new Error(result.error);
    expect(Object.keys(result.properties)).toEqual(["ok"]);
    expect(result.droppedSettingCount).toBe(1);
  });

  test("a setting named __proto__ stays an own key of properties, values and layout", () => {
    // JSON.parse keeps "__proto__" as an own key, as a server's JSON response would.
    const result = parseMCPSettingsReadResult(
      JSON.parse(
        '{"schema":{"type":"object","properties":{"__proto__":{"type":"boolean","title":"P"}}},"values":{"__proto__":true}}'
      )
    );
    if ("error" in result) throw new Error(result.error);
    expect(Object.keys(result.properties)).toEqual(["__proto__"]);
    expect(Object.hasOwn(result.values, "__proto__")).toBe(true);
    expect(result.layout).toEqual([
      { title: "Other settings", items: [{ kind: "property", property: "__proto__" }] },
    ]);
  });

  test("a result without an object schema is an error", () => {
    expect(parseMCPSettingsReadResult({ values: {} })).toHaveProperty("error");
  });
});

test("validateMCPSettingValue checks enum, code-point lengths, bounds and multipleOf", () => {
  expect(validateMCPSettingValue({ type: "string", title: "t", enum: ["a"] }, "b")).not.toBeNull();
  // Lengths count code points (JSON Schema), not UTF-16 units.
  expect(validateMCPSettingValue({ type: "string", title: "t", maxLength: 1 }, "😀")).toBeNull();
  expect(
    validateMCPSettingValue({ type: "string", title: "t", minLength: 2 }, "😀")
  ).not.toBeNull();
  expect(
    validateMCPSettingValue({ type: "string", title: "t", maxLength: 2 }, "abc")
  ).not.toBeNull();
  // The host's own text limit counts code points too: 3000 emoji fit, 4097 do not.
  expect(validateMCPSettingValue({ type: "string", title: "t" }, "😀".repeat(3000))).toBeNull();
  expect(validateMCPSettingValue({ type: "string", title: "t" }, "😀".repeat(4097))).not.toBeNull();
  expect(validateMCPSettingValue({ type: "number", title: "t", maximum: 1 }, 2)).not.toBeNull();
  expect(validateMCPSettingValue({ type: "number", title: "t", multipleOf: 0.1 }, 0.3)).toBeNull();
  // Large magnitudes: the quotient's float error scales with it.
  expect(
    validateMCPSettingValue({ type: "number", title: "t", multipleOf: 0.1 }, 1000000000.3)
  ).toBeNull();
  expect(
    validateMCPSettingValue({ type: "number", title: "t", multipleOf: 0.1 }, 1000000000.35)
  ).not.toBeNull();
  expect(validateMCPSettingValue({ type: "integer", title: "t" }, 1.5)).not.toBeNull();
  expect(validateMCPSettingValue({ type: "boolean", title: "t" }, "true")).not.toBeNull();
});

test("boundMCPSettingsError cuts long server error text without splitting a code point", () => {
  expect(boundMCPSettingsError("short")).toBe("short");
  const bounded = boundMCPSettingsError(`x${"😀".repeat(100_000)}`);
  expect(bounded.length).toBeLessThanOrEqual(1025);
  expect(bounded.endsWith("😀…")).toBe(true);
});
