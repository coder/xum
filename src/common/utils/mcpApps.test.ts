import { describe, expect, test } from "bun:test";
import { isAppCallableTool, isModelVisibleTool, parseMCPToolUiMeta } from "./mcpApps";

describe("parseMCPToolUiMeta", () => {
  test("reads _meta.ui and defaults visibility to model + app", () => {
    expect(parseMCPToolUiMeta({ ui: { resourceUri: "ui://a/view" } })).toEqual({
      resourceUri: "ui://a/view",
      visibility: ["model", "app"],
    });
    expect(
      parseMCPToolUiMeta({
        ui: { resourceUri: "ui://a/view", visibility: ["app", "bogus", "app"] },
      })
    ).toEqual({ resourceUri: "ui://a/view", visibility: ["app"] });
  });

  test("falls back to the deprecated flat key", () => {
    expect(parseMCPToolUiMeta({ "ui/resourceUri": "ui://legacy" })?.resourceUri).toBe(
      "ui://legacy"
    );
  });

  test("ignores tools without a valid ui:// resource", () => {
    expect(parseMCPToolUiMeta(undefined)).toBeUndefined();
    expect(parseMCPToolUiMeta({ ui: { resourceUri: "https://x/view.html" } })).toBeUndefined();
    expect(parseMCPToolUiMeta({ ui: { resourceUri: "ui://" } })).toBeUndefined();
    expect(parseMCPToolUiMeta({ ui: { resourceUri: `ui://${"x".repeat(600)}` } })).toBeUndefined();
  });
});

describe("parseMCPToolUiMeta visibility without a view", () => {
  test("keeps a declared visibility when the tool has no (valid) ui:// view", () => {
    const helper = parseMCPToolUiMeta({ ui: { visibility: ["app"] } });
    expect(helper).toEqual({ visibility: ["app"] });
    expect(isModelVisibleTool(helper)).toBe(false);
    expect(isAppCallableTool(helper)).toBe(true);
    // An invalid view URI drops only the view.
    expect(
      parseMCPToolUiMeta({ ui: { resourceUri: "https://x/view.html", visibility: ["app"] } })
    ).toEqual({ visibility: ["app"] });
  });
});

describe("visibility rules", () => {
  test("app-only tools are hidden from the model; model-only tools are not app-callable", () => {
    const appOnly = { resourceUri: "ui://v", visibility: ["app" as const] };
    const modelOnly = { resourceUri: "ui://v", visibility: ["model" as const] };
    expect(isModelVisibleTool(appOnly)).toBe(false);
    expect(isAppCallableTool(appOnly)).toBe(true);
    expect(isModelVisibleTool(modelOnly)).toBe(true);
    expect(isAppCallableTool(modelOnly)).toBe(false);
    // Plain tools get the spec default.
    expect(isModelVisibleTool(undefined)).toBe(true);
    expect(isAppCallableTool(undefined)).toBe(true);
  });
});
