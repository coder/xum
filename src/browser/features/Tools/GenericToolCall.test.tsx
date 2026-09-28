import "../../../../tests/ui/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, within } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { APIContext } from "@/browser/contexts/API";
import type { MCPToolCallDisplay } from "@/common/types/mcp";
import { GenericToolCall } from "./GenericToolCall";

/** Canonical Agent Plugin connection key: `plugin:<16 hex instance id>:<server>`. */
const PLUGIN_KEY = "plugin:656443adaa7377b9:coder";
/** Exactly what the backend hands the model for that server's `coder_create_chat`. */
const PLUGIN_TOOL = "plugin_656443adaa7377b9_coder_coder_create_chat";

function snapshot(key: string): MCPToolCallDisplay {
  return {
    connection: { key, transport: "stdio" },
    identity: { name: "coder-mcp", title: "Coder", version: "2.0.0" },
    source: "connection",
  };
}

describe("GenericToolCall MCP header label", () => {
  let cleanupDom: () => void;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom();
  });

  function renderCall(toolName: string, mcpServer?: MCPToolCallDisplay) {
    // Snapshots without an iconRef never call the API; the context only has to exist.
    const view = render(
      <APIContext.Provider
        value={{
          status: "connecting",
          api: null,
          error: null,
          authenticate: () => undefined,
          retry: () => undefined,
        }}
      >
        <GenericToolCall toolName={toolName} args={{ task: "x" }} mcpServer={mcpServer} />
      </APIContext.Provider>
    );
    const badge = view.queryByRole("button", { name: /^Server information: / });
    const header = badge?.parentElement ?? view.container.querySelector("div > div");
    if (!header) throw new Error("Tool header not rendered");
    return { view, badge, header };
  }

  test("a captured plugin call shows the server badge beside the short tool identifier", () => {
    const { badge, header } = renderCall(PLUGIN_TOOL, snapshot(PLUGIN_KEY));
    if (!badge) throw new Error("Server badge not rendered");
    expect(badge.textContent).toBe("Coder");
    expect(within(header).getByText("coder_create_chat", { exact: true })).toBeDefined();
    expect(within(header).queryByText(PLUGIN_TOOL, { exact: true })).toBeNull();
    // The installation hash stays out of the prominent label but the exact
    // configured connection is still what the server-info control names.
    expect(badge.getAttribute("aria-label")).toBe(`Server information: ${PLUGIN_KEY}`);
  });

  test("the same model-facing name without a snapshot renders verbatim", () => {
    const { badge, header } = renderCall(PLUGIN_TOOL);
    expect(badge).toBeNull();
    expect(within(header).getByText(PLUGIN_TOOL, { exact: true })).toBeDefined();
  });

  test("a snapshot from a different plugin instance never shortens another instance's tool", () => {
    const { header } = renderCall(PLUGIN_TOOL, snapshot("plugin:0000000000000000:coder"));
    expect(within(header).getByText(PLUGIN_TOOL, { exact: true })).toBeDefined();
  });

  test("non-plugin MCP servers keep the raw tool name even when the prefix matches", () => {
    const { badge, header } = renderCall("notion_work_notion_ai_search", snapshot("notion-work"));
    if (!badge) throw new Error("Server badge not rendered");
    expect(within(header).getByText("notion_work_notion_ai_search", { exact: true })).toBeDefined();
  });
});
