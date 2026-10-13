// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import {
  appViewDetails,
  openMcpAppViewTab,
  type McpAppViewRef,
} from "../ArtifactsTab/mcpAppViewsStore";
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

  test("tabs of two plugin installs with one server name show their instance markers", () => {
    for (const [id, key] of [
      ["m1", "plugin:0123456789abcdef:tray"],
      ["m2", "plugin:fedcba9876543210:tray"],
    ] as const) {
      openMcpAppViewTab("ws-markers", {
        toolCallId: id,
        serverName: key,
        resourceUri: "ui://tray/view",
        toolName: "tray_show",
        label: "show",
        arguments: {},
        cancelled: false,
        failed: false,
      });
    }
    const store = useWorkspaceStoreRaw();
    const registered = spyOn(store, "hasRegisteredWorkspace").mockImplementation(() => false);
    try {
      const label = (toolCallId: string) =>
        render(
          <APIProvider client={createTestApiClient({})}>
            <AppViewTabLabel workspaceId="ws-markers" toolCallId={toolCallId} />
          </APIProvider>
        ).container.textContent;
      expect([label("m1"), label("m2")]).toEqual([
        "showtray (plugin 01234567)",
        "showtray (plugin fedcba98)",
      ]);
    } finally {
      registered.mockRestore();
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

describe("app view details", () => {
  const view = (toolCallId: string, args: unknown, failed = false): McpAppViewRef => ({
    toolCallId,
    serverName: "dice",
    resourceUri: "ui://dice/board.html",
    toolName: "show_dice_board",
    label: "Board",
    arguments: args,
    cancelled: failed,
    failed,
  });
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
  });

  test("tab labels of several calls of one tool differ; a lone call shows none", () => {
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
    for (const [id, args] of [
      ["d-old", { count: 4 }],
      ["d-new", { count: 6 }],
    ] as const) {
      openMcpAppViewTab("ws-details", view(id, args));
    }
    openMcpAppViewTab("ws-lone", view("lone", { count: 1 }));
    try {
      const label = (workspaceId: string, toolCallId: string) =>
        // The label hook can ask the backend for a view outside the transcript (useAPI).
        render(
          <APIProvider client={createTestApiClient({})}>
            <AppViewTabLabel workspaceId={workspaceId} toolCallId={toolCallId} />
          </APIProvider>
        ).container.textContent;
      const [older, newer] = [label("ws-details", "d-old"), label("ws-details", "d-new")];
      expect(older).not.toBe(newer);
      expect(older?.startsWith("Boarddice")).toBe(true);
      expect(label("ws-lone", "lone")).toBe("Boarddice");
    } finally {
      registered.mockRestore();
      state.mockRestore();
    }
  });

  test("numbers repeats of the same call, oldest first", () => {
    const details = appViewDetails([
      view("new", { count: 4 }),
      view("other", { count: 6 }),
      view("old", { count: 4 }),
    ]);
    expect(new Set(details).size).toBe(3);
    expect(details[0].endsWith("#2")).toBe(true);
    expect(details[2].endsWith("#1")).toBe(true);
    expect(details[1]).not.toContain("#");
  });

  test("shows control and bidi characters from model arguments as escapes", () => {
    const [detail] = appViewDetails([view("a", { label: "safe\u202Eexe.txt\nnext" })]);
    expect(detail).not.toMatch(/[\u202E\n]/);
    expect(detail).toContain("\\u202e");
  });
});
