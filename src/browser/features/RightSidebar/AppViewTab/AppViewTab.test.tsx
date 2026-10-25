// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import {
  appViewDetails,
  openMcpAppViewTab,
  type McpAppViewRef,
} from "../ArtifactsTab/mcpAppViewsStore";
import { installDom, stubNarrowViewport } from "../../../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import { useWorkspaceStoreRaw, type WorkspaceState } from "@/browser/stores/WorkspaceStore";
import { createTestApiClient } from "@/browser/testUtils";
import {
  AppViewTabLabel,
  AppViewTabPanel,
  AppViewTabTooltip,
  findOwnMaximizedAppPanel,
} from "./AppViewTab";

/**
 * Run the view document's preamble (its first script) as the frame's document would: it opens
 * the document's channel to the host (mcpAppDocumentChannel.ts), whose open announcement comes
 * from the frame's window. Returns the view's `window.parent`, which posts over that channel.
 * `onMessage` gets every message the host sends the document.
 */
function bootViewDocument(
  frame: HTMLIFrameElement,
  onMessage: (message: { method?: string; params?: unknown }) => void,
  /** Gets the document's window listeners (keydown, pagehide), by event type. */
  listeners = new Map<string, (event: unknown) => void>()
): { postMessage: (message: unknown, targetOrigin: string) => void } {
  const doc = new window.DOMParser().parseFromString(frame.getAttribute("srcdoc")!, "text/html");
  const preamble = doc.querySelector("script")?.textContent ?? "";
  const documentWindow: Record<string, unknown> = {
    parent: {
      postMessage: (data: unknown, _origin: string, ports: unknown[] = []) => {
        const event = new window.Event("message");
        Object.defineProperty(event, "data", { value: data });
        Object.defineProperty(event, "source", { value: frame.contentWindow });
        Object.defineProperty(event, "ports", { value: ports });
        act(() => {
          window.dispatchEvent(event);
        });
      },
    },
    MessageEvent: class {
      constructor(
        readonly type: string,
        readonly init: { data: { method?: string; params?: unknown } }
      ) {}
    },
    dispatchEvent: (event: { init: { data: { method?: string; params?: unknown } } }) => {
      onMessage(event.init.data);
      return true;
    },
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs our own generated script
  (new Function("window", preamble) as (window: unknown) => void)(documentWindow);
  return documentWindow.parent as { postMessage: (message: unknown, targetOrigin: string) => void };
}

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
      // A missing record is final: asking again cannot find the view.
      expect(view.queryByRole("button", { name: "Reload" })).toBeNull();
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

  test("a tab whose view failed to load offers Reload, which loads it again", async () => {
    let calls = 0;
    const client = createTestApiClient({
      mcpApps: {
        getView: () => {
          calls += 1;
          return Promise.resolve(
            calls === 1
              ? { success: false as const, error: "server not connected" }
              : {
                  success: true as const,
                  data: {
                    html: "<p>view</p>",
                    csp: {},
                    prefersBorder: null,
                    resultAvailable: true,
                    result: { content: [] },
                    invocation: null,
                  },
                }
          );
        },
      },
    });
    openMcpAppViewTab("ws-retry", {
      toolCallId: "call-retry",
      serverName: "dice",
      resourceUri: "ui://dice/board.html",
      toolName: "show",
      label: "Board",
      arguments: {},
      cancelled: false,
      failed: false,
    });
    const view = render(
      <ThemeProvider forcedTheme="dark">
        <APIProvider client={client}>
          <AppViewTabPanel
            workspaceId="ws-retry"
            toolCallId="call-retry"
            onClose={() => undefined}
          />
        </APIProvider>
      </ThemeProvider>
    );
    expect(await view.findByText(/server not connected/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Reload" }));
    await view.findByTestId("mcp-app-frame");
    expect(calls).toBe(2);
  });

  test("a restored tab of a failed or interrupted call outside the transcript gets tool-cancelled", async () => {
    // Restored after a restart, before the last compaction boundary: only the result record
    // knows how the call ended.
    const store = useWorkspaceStoreRaw();
    const registered = spyOn(store, "hasRegisteredWorkspace").mockImplementation(
      (id) => id === "ws-ended"
    );
    const state = spyOn(store, "getWorkspaceState").mockImplementation(
      () =>
        ({
          messages: [],
          loading: false,
          isHydratingTranscript: false,
        }) as unknown as WorkspaceState
    );
    const client = createTestApiClient({
      mcpApps: {
        getViewRecords: (input: { toolCallIds: string[] }) =>
          Promise.resolve({
            success: true as const,
            data: input.toolCallIds.map((toolCallId) => ({
              toolCallId,
              view: {
                serverName: "dice",
                toolName: "dice_show_dice_board",
                resourceUri: "ui://dice/board.html",
                arguments: {},
                outcome:
                  toolCallId === "call-failed" ? ("failed" as const) : ("interrupted" as const),
              },
            })),
          }),
        getView: () =>
          Promise.resolve({
            success: true as const,
            data: {
              html: "<p>view</p>",
              csp: {},
              prefersBorder: null,
              resultAvailable: false,
              result: null,
              invocation: null,
            },
          }),
      },
    });
    try {
      for (const [toolCallId, reason] of [
        ["call-failed", "failed"],
        ["call-interrupted", "interrupted"],
      ] as const) {
        const view = render(
          <ThemeProvider forcedTheme="dark">
            <APIProvider client={client}>
              <AppViewTabPanel
                workspaceId="ws-ended"
                toolCallId={toolCallId}
                onClose={() => undefined}
              />
            </APIProvider>
          </ThemeProvider>
        );
        const frame = (await view.findByTestId("mcp-app-frame")) as HTMLIFrameElement;
        const posted: Array<{ method?: string; params?: unknown }> = [];
        const viewWindow = bootViewDocument(frame, (message) => posted.push(message));
        act(() => {
          viewWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
        });
        await waitFor(() =>
          expect(
            posted.find((m) => m.method === "ui/notifications/tool-cancelled")?.params
          ).toEqual({ reason })
        );
        view.unmount();
      }
    } finally {
      registered.mockRestore();
      state.mockRestore();
    }
  });

  // #6165: fullscreen display mode as the spec means it. The panel is pinned in place (no portal),
  // so the view's frame never reloads. A narrow window covers the whole window (a modal dialog); a
  // wide one covers the workspace shell only, like immersive review, so the left sidebar beside it
  // stays usable (a region).
  for (const narrow of [true, false]) {
    test(`Maximize pins the app tab until Restore or Escape (${narrow ? "narrow: the window" : "wide: the workspace shell"})`, async () => {
      stubNarrowViewport(narrow);
      openMcpAppViewTab("ws-max", {
        toolCallId: "call-max",
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
      const view = render(
        <ThemeProvider forcedTheme="dark">
          <div data-testid="left-sidebar">projects</div>
          <div data-workspace-shell="">
            <div data-testid="outside">chat</div>
            <APIProvider client={client}>
              <AppViewTabPanel
                workspaceId="ws-max"
                toolCallId="call-max"
                onClose={() => undefined}
              />
            </APIProvider>
          </div>
        </ThemeProvider>
      );
      const frame = await view.findByTestId("mcp-app-frame");
      const panel = () => view.getByTestId("app-view-tab-panel");
      fireEvent.click(view.getByRole("button", { name: "Maximize view" }));
      expect(panel().className).toContain("fixed");
      // The covered content is inert. Narrow: everything, and the panel is a modal dialog. Wide:
      // the shell only, and the panel is a region beside the usable left sidebar.
      expect(panel().getAttribute("role")).toBe(narrow ? "dialog" : "region");
      expect(panel().getAttribute("aria-modal")).toBe(narrow ? "true" : null);
      expect(view.getByTestId("outside").inert).toBe(true);
      expect(view.getByTestId("left-sidebar").inert).toBe(narrow);
      // The same frame, not a remounted one.
      expect(view.getByTestId("mcp-app-frame")).toBe(frame);

      fireEvent.click(view.getByRole("button", { name: "Restore view" }));
      expect(panel().className).not.toContain("fixed");
      expect(view.getByTestId("outside").inert).toBe(false);

      // Wide: Escape from the usable left sidebar restores the panel too, and is consumed.
      if (!narrow) {
        fireEvent.click(view.getByRole("button", { name: "Maximize view" }));
        expect(panel().className).toContain("fixed");
        expect(fireEvent.keyDown(view.getByTestId("left-sidebar"), { key: "Escape" })).toBe(false);
        expect(panel().className).not.toContain("fixed");
      }

      // The keyboard path: the Artifacts fullscreen shortcut toggles it, Escape restores it.
      fireEvent.keyDown(panel(), { key: "F", shiftKey: true });
      expect(panel().className).toContain("fixed");
      // A held key auto-repeats: the repeats must not flip the panel back (#6181).
      fireEvent.keyDown(panel(), { key: "F", shiftKey: true, repeat: true });
      expect(panel().className).toContain("fixed");
      // Cmd/Ctrl+W: the sidebar treats its own maximized panel as its tab, not as a blocking
      // modal (#6181), but only while no other modal is open.
      expect(findOwnMaximizedAppPanel(view.container)).toBe(panel());
      expect(findOwnMaximizedAppPanel(document.createElement("div"))).toBeNull();
      const otherModal = document.createElement("div");
      otherModal.setAttribute("role", "dialog");
      otherModal.setAttribute("aria-modal", "true");
      document.body.appendChild(otherModal);
      expect(findOwnMaximizedAppPanel(view.container)).toBeNull();
      otherModal.remove();
      // Escape restores the panel only: it must not reach window handlers (Escape-to-interrupt).
      let windowEscapes = 0;
      const onWindowKey = (event: KeyboardEvent) => {
        if (event.key === "Escape") windowEscapes++;
      };
      window.addEventListener("keydown", onWindowKey);
      try {
        fireEvent.keyDown(panel(), { key: "Escape" });
      } finally {
        window.removeEventListener("keydown", onWindowKey);
      }
      expect(panel().className).not.toContain("fixed");
      expect(windowEscapes).toBe(0);
      expect(view.getByTestId("mcp-app-frame")).toBe(frame);

      // Focus inside the view's frame: its keys never reach the panel, so the frame forwards an
      // Escape the view did not handle.
      const documentListeners = new Map<string, (event: unknown) => void>();
      bootViewDocument(frame as HTMLIFrameElement, () => undefined, documentListeners);
      fireEvent.click(view.getByRole("button", { name: "Maximize view" }));
      expect(panel().className).toContain("fixed");
      await act(async () => {
        documentListeners.get("keydown")?.({
          key: "Escape",
          shiftKey: false,
          defaultPrevented: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(panel().className).not.toContain("fixed");
    });
  }

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
      // Until it is retried, a failed lookup shows no view, only Reload and Close.
      expect(await first.findByRole("button", { name: "Reload" })).toBeTruthy();
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

  // E.g. the backend restarted while the layout was restored: the tab must not stay stuck until
  // it remounts.
  test("a restored tab whose record lookup failed offers Reload, which asks again", async () => {
    const store = useWorkspaceStoreRaw();
    const registered = spyOn(store, "hasRegisteredWorkspace").mockImplementation(
      (id) => id === "ws-retry"
    );
    const state = spyOn(store, "getWorkspaceState").mockImplementation(
      () =>
        ({
          messages: [],
          loading: false,
          isHydratingTranscript: false,
        }) as unknown as WorkspaceState
    );
    let reachable = false;
    const client = createTestApiClient({
      mcpApps: {
        getViewRecords: (input: { toolCallIds: string[] }) => {
          if (!reachable) return Promise.reject(new Error("disconnected"));
          return Promise.resolve({
            success: true as const,
            data: input.toolCallIds.map((toolCallId) => ({
              toolCallId,
              view: {
                serverName: "dice",
                toolName: "dice_show_dice_board",
                resourceUri: "ui://dice/board.html",
                arguments: {},
              },
            })),
          });
        },
        getView: () => new Promise<never>(() => undefined),
      },
    });
    try {
      const view = render(
        <ThemeProvider forcedTheme="dark">
          <APIProvider client={client}>
            <AppViewTabLabel workspaceId="ws-retry" toolCallId="call-r" />
            <AppViewTabPanel workspaceId="ws-retry" toolCallId="call-r" onClose={() => undefined} />
          </APIProvider>
        </ThemeProvider>
      );
      const reload = await view.findByRole("button", { name: "Reload" });
      reachable = true;
      fireEvent.click(reload);
      expect(await view.findByText("dice_show_dice_board")).toBeTruthy();
      expect(view.queryByRole("button", { name: "Reload" })).toBeNull();
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

  // A narrow tab cuts the label's detail off, so the tooltip carries it too.
  test("the tooltip of one of several calls of a tool names that call's detail", () => {
    for (const [id, args] of [
      ["t-old", { count: 4 }],
      ["t-new", { count: 6 }],
    ] as const) {
      openMcpAppViewTab("ws-tooltip", view(id, args));
    }
    const tooltip = (toolCallId: string) =>
      render(
        <APIProvider client={createTestApiClient({})}>
          <AppViewTabTooltip workspaceId="ws-tooltip" toolCallId={toolCallId} />
        </APIProvider>
      ).container.textContent;
    expect(tooltip("t-old")).toBe("Board · dice · count: 4");
    expect(tooltip("t-new")).toBe("Board · dice · count: 6");
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
