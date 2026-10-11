import { describe, expect, test } from "bun:test";
import {
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
          badRegex: { type: "string", title: "Bad", pattern: "(" },
          noTitle: { type: "boolean" },
          wrongValue: { type: "number", title: "Wrong value" },
        },
      },
      values: { units: "in", grid: false, zoom: 2, badRegex: "x", noTitle: true, wrongValue: "9" },
      layout: [
        {
          kind: "group",
          title: "Display",
          items: [
            { kind: "property", property: "units" },
            { kind: "tool", tool: "cad.library" },
            { kind: "property", property: "color" },
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
    // color, badRegex, noTitle (schema); wrongValue (value); mystery item; page group.
    expect(result.warnings).toHaveLength(6);
    // Settings the UI cannot show: color, badRegex, noTitle and wrongValue (not layout items).
    expect(result.droppedSettingCount).toBe(4);
  });

  test("a result without an object schema is an error", () => {
    expect(parseMCPSettingsReadResult({ values: {} })).toHaveProperty("error");
  });
});

test("validateMCPSettingValue checks enum, bounds, pattern and multipleOf", () => {
  expect(validateMCPSettingValue({ type: "string", title: "t", enum: ["a"] }, "b")).not.toBeNull();
  expect(
    validateMCPSettingValue({ type: "string", title: "t", pattern: "^v\\d$" }, "v1")
  ).toBeNull();
  expect(
    validateMCPSettingValue({ type: "string", title: "t", maxLength: 2 }, "abc")
  ).not.toBeNull();
  expect(validateMCPSettingValue({ type: "number", title: "t", maximum: 1 }, 2)).not.toBeNull();
  expect(validateMCPSettingValue({ type: "number", title: "t", multipleOf: 0.1 }, 0.3)).toBeNull();
  expect(validateMCPSettingValue({ type: "integer", title: "t" }, 1.5)).not.toBeNull();
  expect(validateMCPSettingValue({ type: "boolean", title: "t" }, "true")).not.toBeNull();
});
