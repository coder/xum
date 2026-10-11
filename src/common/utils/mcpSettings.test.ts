import { describe, expect, test } from "bun:test";
import {
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
    // color, badEnum, noTitle (schema); wrongValue (value); mystery item; page group.
    expect(result.warnings).toHaveLength(6);
    // Settings the UI cannot show: color, badRegex, noTitle and wrongValue (not layout items).
    expect(result.droppedSettingCount).toBe(4);
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
  expect(validateMCPSettingValue({ type: "number", title: "t", maximum: 1 }, 2)).not.toBeNull();
  expect(validateMCPSettingValue({ type: "number", title: "t", multipleOf: 0.1 }, 0.3)).toBeNull();
  expect(validateMCPSettingValue({ type: "integer", title: "t" }, 1.5)).not.toBeNull();
  expect(validateMCPSettingValue({ type: "boolean", title: "t" }, "true")).not.toBeNull();
});
