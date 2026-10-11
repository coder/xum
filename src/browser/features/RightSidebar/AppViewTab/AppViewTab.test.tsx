// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { openMcpAppViewTab } from "../ArtifactsTab/mcpAppViewsStore";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import { useWorkspaceStoreRaw, type WorkspaceState } from "@/browser/stores/WorkspaceStore";
import { createTestApiClient } from "@/browser/testUtils";
import { AppViewTabLabel, AppViewTabPanel } from "./AppViewTab";

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

  test("the phone sheet and a tab in the hidden sidebar never both run the view", async () => {
    const store = useWorkspaceStoreRaw();
    const registered = spyOn(store, "hasRegisteredWorkspace").mockImplementation(
      (id) => id === "ws-sheet"
    );
    const state = spyOn(store, "getWorkspaceState").mockImplementation(
      () =>
        ({
          messages: [],
          loading: false,
          isHydratingTranscript: false,
        }) as unknown as WorkspaceState
    );
    openMcpAppViewTab("ws-sheet", {
      toolCallId: "call-s",
      serverName: "dice",
      resourceUri: "ui://dice/board.html",
      toolName: "show",
      label: "Board",
      arguments: {},
      cancelled: false,
      failed: false,
    });
    const client = createTestApiClient({
      mcpApps: {
        getView: () =>
          Promise.resolve({
            success: true as const,
            data: {
              html: "<p>view</p>",
              csp: {},
              prefersBorder: null,
              resultAvailable: true,
              result: { content: [] },
              invocation: null,
            },
          }),
      },
    });
    try {
      const panel = (host: "tab" | "sheet") => (
        <AppViewTabPanel
          workspaceId="ws-sheet"
          toolCallId="call-s"
          host={host}
          onClose={() => undefined}
        />
      );
      const view = render(
        <ThemeProvider forcedTheme="dark">
          <APIProvider client={client}>
            {panel("tab")}
            {panel("sheet")}
          </APIProvider>
        </ThemeProvider>
      );
      await view.findByTestId("mcp-app-frame");
      await waitFor(() => expect(view.getByRole("button", { name: "Go to tab" })).toBeTruthy());
      expect(view.getAllByTestId("mcp-app-frame")).toHaveLength(1);
    } finally {
      registered.mockRestore();
      state.mockRestore();
    }
  });
});
