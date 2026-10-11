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
        render(<AppViewTabLabel workspaceId={workspaceId} toolCallId={toolCallId} />).container
          .textContent;
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
