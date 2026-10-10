import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import { createTestApiClient } from "@/browser/testUtils";
import { publishWorkspaceMcpOverridesSaved } from "@/browser/utils/workspaceMcpMutations";
import type { McpAppPluginView } from "@/common/orpc/schemas/mcpApps";
import { usePluginViews } from "./usePluginViews";

function view(enabled: boolean): McpAppPluginView {
  return {
    pluginViewId: "0123456789abcdef/settings",
    title: "Review settings",
    pluginName: "review-bot",
    serverName: "settings",
    serverKey: "plugin:0123456789abcdef:settings",
    enabled,
  };
}

describe("usePluginViews", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("re-lists after this workspace's MCP configuration is saved, not another's", async () => {
    let serverEnabled = false;
    let calls = 0;
    const client = createTestApiClient({
      mcpApps: {
        listPluginViews: () => {
          calls += 1;
          return Promise.resolve({ success: true as const, data: [view(serverEnabled)] });
        },
      },
    });
    const wrapper = (props: { children: React.ReactNode }) => (
      <APIProvider client={client}>{props.children}</APIProvider>
    );
    const { result } = renderHook(() => usePluginViews("ws-1", true), { wrapper });
    await waitFor(() => expect(result.current?.views[0]?.enabled).toBe(false));

    // The user enables the view's server in the Workspace MCP dialog.
    serverEnabled = true;
    act(() => publishWorkspaceMcpOverridesSaved("ws-other"));
    expect(calls).toBe(1);
    act(() => publishWorkspaceMcpOverridesSaved("ws-1"));
    await waitFor(() => expect(result.current?.views[0]?.enabled).toBe(true));
    expect(calls).toBe(2);
  });
});
