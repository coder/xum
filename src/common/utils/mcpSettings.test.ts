import { describe, expect, test } from "bun:test";
import {
  advertisedMCPSettingsToolNames,
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
