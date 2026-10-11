// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { openMcpAppViewTab } from "../ArtifactsTab/mcpAppViewsStore";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import { useWorkspaceStoreRaw, type WorkspaceState } from "@/browser/stores/WorkspaceStore";
import { createTestApiClient } from "@/browser/testUtils";
import { AppViewTabLabel, AppViewTabPanel, AppViewTabTooltip } from "./AppViewTab";

describe("AppViewTabPanel", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
  });

  test("a tab whose view is gone shows the unavailable state with Close", () => {
    const store = useWorkspaceStoreRaw();
    const registered = spyOn(store, "hasRegisteredWorkspace").mockImplementation(
      (id) => id === "ws-gone"
    );
    const state = spyOn(store, "getWorkspaceState").mockImplementation(
      () =>
        ({
          messages: [],
          loading: false,
          isHydratingTranscript: false,
        }) as unknown as WorkspaceState
    );
    let closed = 0;
    try {
      const view = render(
        <APIProvider client={createTestApiClient({})}>
          <AppViewTabLabel workspaceId="ws-gone" toolCallId="call-x" />
          <AppViewTabPanel workspaceId="ws-gone" toolCallId="call-x" onClose={() => closed++} />
        </APIProvider>
      );
      expect(view.getByText("This view is no longer available.")).toBeTruthy();
      expect(view.getByText("App view")).toBeTruthy();
      expect(view.queryByTestId("mcp-app-frame")).toBeNull();
      fireEvent.click(view.getByRole("button", { name: "Close" }));
      expect(closed).toBe(1);
    } finally {
      registered.mockRestore();
      state.mockRestore();
    }
  });

  test("a plugin view's tab shows its server part; the tooltip names the full key", () => {
    const key = "plugin:0123456789abcdef:tray";
    openMcpAppViewTab("ws-plugin", {
      toolCallId: "call-p",
      serverName: key,
      resourceUri: "ui://tray/view",
      toolName: "show",
      label: "Parts tray",
      arguments: {},
      cancelled: false,
      failed: false,
    });
    const view = render(
      <APIProvider client={createTestApiClient({})}>
        <div data-testid="label">
          <AppViewTabLabel workspaceId="ws-plugin" toolCallId="call-p" />
        </div>
        <div data-testid="tooltip">
          <AppViewTabTooltip workspaceId="ws-plugin" toolCallId="call-p" />
        </div>
      </APIProvider>
    );
    expect(view.getByTestId("label").textContent).toBe("Parts traytray");
    expect(view.getByTestId("tooltip").textContent).toBe(`Parts tray · ${key}`);
  });
});
