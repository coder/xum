// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { openMcpAppViewTab } from "../ArtifactsTab/mcpAppViewsStore";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import { useWorkspaceStoreRaw, type WorkspaceState } from "@/browser/stores/WorkspaceStore";
import { createTestApiClient } from "@/browser/testUtils";
import { AppViewTabLabel, AppViewTabPanel, AppViewTabTooltip } from "./AppViewTab";
import { AppViewDialog } from "./AppViewDialog";

describe("AppViewTabPanel", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
  });

  test("a tab whose view is gone shows the unavailable state with Close", async () => {
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
    // Not in the transcript and no result record in the backend either.
    const client = createTestApiClient({
      mcpApps: {
        getViewRecords: (input: { toolCallIds: string[] }) =>
          Promise.resolve({
            success: true as const,
            data: input.toolCallIds.map((toolCallId) => ({ toolCallId, view: null })),
          }),
      },
    });
    try {
      const view = render(
        <APIProvider client={client}>
          <AppViewTabLabel workspaceId="ws-gone" toolCallId="call-x" />
          <AppViewTabPanel workspaceId="ws-gone" toolCallId="call-x" onClose={() => closed++} />
        </APIProvider>
      );
      expect(await view.findByText("This view is no longer available.")).toBeTruthy();
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

  test("a restored tab outside the loaded transcript finds its view in the result store", async () => {
    // E.g. the call is before the last compaction boundary: the transcript is loaded, the view
    // is not in it, but the backend still has the call's result record.
    const store = useWorkspaceStoreRaw();
    const registered = spyOn(store, "hasRegisteredWorkspace").mockImplementation(
      (id) => id === "ws-older"
    );
    const state = spyOn(store, "getWorkspaceState").mockImplementation(
      () =>
        ({
          messages: [],
          loading: false,
          isHydratingTranscript: false,
        }) as unknown as WorkspaceState
    );
    const opened: Array<{ serverName: string; resourceUri: string }> = [];
    const client = createTestApiClient({
      mcpApps: {
        getViewRecords: (input: { toolCallIds: string[] }) =>
          Promise.resolve({
            success: true as const,
            data: input.toolCallIds.map((toolCallId) => ({
              toolCallId,
              view:
                toolCallId === "call-old"
                  ? {
                      serverName: "dice",
                      toolName: "dice_show_dice_board",
                      resourceUri: "ui://dice/board.html",
                      arguments: { count: 4 },
                    }
                  : null,
            })),
          }),
        getView: (input: { serverName: string; resourceUri: string }) => {
          opened.push({ serverName: input.serverName, resourceUri: input.resourceUri });
          return Promise.resolve({
            success: true as const,
            data: {
              html: "<p>view</p>",
              csp: {},
              prefersBorder: null,
              resultAvailable: true,
              result: { content: [] },
              invocation: null,
            },
          });
        },
      },
    });
    try {
      const view = render(
        <ThemeProvider forcedTheme="dark">
          <APIProvider client={client}>
            <AppViewTabLabel workspaceId="ws-older" toolCallId="call-old" />
            <AppViewTabPanel
              workspaceId="ws-older"
              toolCallId="call-old"
              onClose={() => undefined}
            />
          </APIProvider>
        </ThemeProvider>
      );
      await view.findByTestId("mcp-app-frame");
      expect(view.queryByText("This view is no longer available.")).toBeNull();
      expect(view.getByText("dice_show_dice_board")).toBeTruthy();
      await waitFor(() =>
        expect(opened).toEqual([{ serverName: "dice", resourceUri: "ui://dice/board.html" }])
      );
    } finally {
      registered.mockRestore();
      state.mockRestore();
    }
  });

  test("restored tabs outside the transcript share one record lookup; a failed one is retried", async () => {
    const store = useWorkspaceStoreRaw();
    const registered = spyOn(store, "hasRegisteredWorkspace").mockImplementation(
      (id) => id === "ws-batch"
    );
    const state = spyOn(store, "getWorkspaceState").mockImplementation(
      () =>
        ({
          messages: [],
          loading: false,
          isHydratingTranscript: false,
        }) as unknown as WorkspaceState
    );
    const requests: string[][] = [];
    let reachable = false;
    const client = createTestApiClient({
      mcpApps: {
        getViewRecords: (input: { toolCallIds: string[] }) => {
          requests.push(input.toolCallIds);
          // E.g. the backend restarts while the layout is restored.
          if (!reachable) return Promise.reject(new Error("disconnected"));
          return Promise.resolve({
            success: true as const,
            data: input.toolCallIds.map((toolCallId) => ({
              toolCallId,
              view: {
                serverName: "dice",
                toolName: `tool_${toolCallId}`,
                resourceUri: "ui://dice/board.html",
                arguments: {},
              },
            })),
          });
        },
      },
    });
    const labels = (panel: boolean) => (
      <APIProvider client={client}>
        {["b1", "b2", "b3"].map((id) => (
          <AppViewTabLabel key={id} workspaceId="ws-batch" toolCallId={id} />
        ))}
        {panel && (
          <AppViewTabPanel workspaceId="ws-batch" toolCallId="b1" onClose={() => undefined} />
        )}
      </APIProvider>
    );
    try {
      const first = render(labels(true));
      // Until it is retried, a failed lookup reads as unavailable.
      expect(await first.findByText("This view is no longer available.")).toBeTruthy();
      // Three restored tabs, one request.
      expect(requests).toEqual([["b1", "b2", "b3"]]);
      first.unmount();

      reachable = true;
      const second = render(labels(false));
      // The failure was not cached as "no record": the tabs ask again and find their views.
      expect(await second.findByText("tool_b3")).toBeTruthy();
      expect(requests).toEqual([
        ["b1", "b2", "b3"],
        ["b1", "b2", "b3"],
      ]);
    } finally {
      registered.mockRestore();
      state.mockRestore();
    }
  });

  test("lookups of two workspaces in one tick go out as one request per workspace", async () => {
    const store = useWorkspaceStoreRaw();
    const registered = spyOn(store, "hasRegisteredWorkspace").mockImplementation(() => true);
    const state = spyOn(store, "getWorkspaceState").mockImplementation(
      () =>
        ({
          messages: [],
          loading: false,
          isHydratingTranscript: false,
        }) as unknown as WorkspaceState
    );
    const requests: Array<{ workspaceId: string; toolCallIds: string[] }> = [];
    const client = createTestApiClient({
      mcpApps: {
        getViewRecords: (input: { workspaceId: string; toolCallIds: string[] }) => {
          requests.push(input);
          return Promise.resolve({
            success: true as const,
            data: input.toolCallIds.map((toolCallId) => ({ toolCallId, view: null })),
          });
        },
      },
    });
    try {
      render(
        <APIProvider client={client}>
          <AppViewTabLabel workspaceId="ws-one" toolCallId="one-a" />
          <AppViewTabLabel workspaceId="ws-two" toolCallId="two-a" />
          <AppViewTabLabel workspaceId="ws-one" toolCallId="one-b" />
        </APIProvider>
      );
      await waitFor(() => expect(requests).toHaveLength(2));
      expect([...requests].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))).toEqual([
        { workspaceId: "ws-one", toolCallIds: ["one-a", "one-b"] },
        { workspaceId: "ws-two", toolCallIds: ["two-a"] },
      ]);
    } finally {
      registered.mockRestore();
      state.mockRestore();
    }
  });

  test("a long unbroken server name truncates in the phone sheet header, not the close button", () => {
    // The longest configured key, without a break opportunity. happy-dom cannot measure layout,
    // so this pins the flex contract: every box from the header row down to the server text can
    // shrink and clips, and the close button follows in the same row without shrinking.
    const server = "s".repeat(80);
    openMcpAppViewTab("ws-long", {
      toolCallId: "call-long",
      serverName: server,
      resourceUri: "ui://long/view",
      toolName: "show",
      label: "Board",
      arguments: {},
      cancelled: false,
      failed: false,
    });
    const store = useWorkspaceStoreRaw();
    const registered = spyOn(store, "hasRegisteredWorkspace").mockImplementation(() => false);
    try {
      const client = createTestApiClient({
        mcpApps: { getView: () => Promise.resolve({ success: false as const, error: "offline" }) },
      });
      const view = render(
        <ThemeProvider forcedTheme="dark">
          <APIProvider client={client}>
            <AppViewDialog
              workspaceId="ws-long"
              toolCallId="call-long"
              open
              onOpenChange={() => undefined}
            />
            <div data-testid="tab-strip">
              <AppViewTabLabel workspaceId="ws-long" toolCallId="call-long" />
            </div>
          </APIProvider>
        </ThemeProvider>
      );
      const dialog = within(view.getByTestId("app-view-dialog"));
      const title = dialog.getByRole("heading");
      const row = title.parentElement;
      const close = dialog.getByRole("button", { name: "Close" });
      expect(close.parentElement).toBe(row);
      expect(close.previousElementSibling).toBe(title);
      expect(close.classList.contains("shrink-0")).toBe(true);
      const serverText = within(title).getByText(server);
      expect(serverText.classList.contains("truncate")).toBe(true);
      for (
        let el: HTMLElement | null = serverText;
        el !== row && el != null;
        el = el.parentElement
      ) {
        expect([el.tagName, el.classList.contains("min-w-0")]).toEqual([el.tagName, true]);
        expect([el.tagName, el.classList.contains("shrink-0")]).toEqual([el.tagName, false]);
      }
      // The tab strip label is unchanged: its server keeps its width (the tab clips it).
      const tabServer = within(view.getByTestId("tab-strip")).getByText(server);
      expect(tabServer.classList.contains("shrink-0")).toBe(true);
    } finally {
      registered.mockRestore();
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
