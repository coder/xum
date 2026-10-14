import { describe, expect, test } from "bun:test";
import {
  isAppCallableTool,
  isModelVisibleTool,
  mcpAppEntrypointKey,
  parseMCPAppEntrypoints,
  parseMCPToolUiMeta,
} from "./mcpApps";

describe("parseMCPAppEntrypoints", () => {
  test("keeps global and thread, skips file and unknown types, reads at most three", () => {
    const entrypoints = (list: unknown) => ({ "openai/ui": { entrypoints: list } });
    expect(
      parseMCPAppEntrypoints(
        entrypoints([
          { type: "thread" },
          { type: "file", extensions: [".stl"] },
          { type: "global" },
        ])
      )
    ).toEqual({ types: ["thread", "global"], skippedFile: true });
    // The spec allows three; a fourth is ignored. Duplicates collapse.
    expect(
      parseMCPAppEntrypoints(
        entrypoints([{ type: "global" }, { type: "global" }, { type: "nav" }, { type: "thread" }])
      )
    ).toEqual({ types: ["global"], skippedFile: false });
    for (const meta of [undefined, {}, { "openai/ui": [] }, entrypoints("global")]) {
      expect(parseMCPAppEntrypoints(meta)).toEqual({ types: [], skippedFile: false });
    }
  });
});

describe("mcpAppEntrypointKey", () => {
  test("names one server, tool and type: a colon in a name cannot shift the split", () => {
    expect(mcpAppEntrypointKey("a", "b:c", "global")).not.toBe(
      mcpAppEntrypointKey("a:b", "c", "global")
    );
    expect(mcpAppEntrypointKey("a", "b", "global")).not.toBe(
      mcpAppEntrypointKey("a", "b", "thread")
    );
  });
});

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

  test("accepts ChatGPT's openai/outputTemplate alias at the lowest precedence", () => {
    expect(parseMCPToolUiMeta({ "openai/outputTemplate": "ui://widget/a.html" })).toEqual({
      resourceUri: "ui://widget/a.html",
      visibility: ["model", "app"],
    });
    const all = {
      ui: { resourceUri: "ui://spec" },
      "ui/resourceUri": "ui://legacy",
      "openai/outputTemplate": "ui://openai",
    };
    expect(parseMCPToolUiMeta(all)?.resourceUri).toBe("ui://spec");
    expect(parseMCPToolUiMeta({ ...all, ui: {} })?.resourceUri).toBe("ui://legacy");
    // The alias keeps the ui:// rule.
    expect(parseMCPToolUiMeta({ "openai/outputTemplate": "https://x/a.html" })).toBeUndefined();
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
