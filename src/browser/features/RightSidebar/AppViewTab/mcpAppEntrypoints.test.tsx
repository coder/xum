import React from "react";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  useWorkspaceStoreRaw,
  type WorkspaceState,
  type WorkspaceStore,
} from "@/browser/stores/WorkspaceStore";
import { createTestApiClient } from "@/browser/testUtils";
import { publishAgentPluginsMutated } from "@/browser/utils/agentPluginMutations";
import {
  getDefaultRightSidebarLayoutState,
  selectOrAddTab,
} from "@/browser/utils/rightSidebarLayout";
import {
  publishGlobalMcpEnablementChanged,
  publishProjectTrustChanged,
  publishWorkspaceMcpOverridesSaved,
} from "@/browser/utils/workspaceMcpMutations";
import { getRightSidebarLayoutKey } from "@/common/constants/storage";
import type { McpAppEntrypoint } from "@/common/orpc/schemas/mcpApps";
import { appViewTabFor } from "./appViewTabs";
import { useLoadMcpAppEntrypoints, useMcpAppEntrypoints } from "./mcpAppEntrypoints";
import { useMcpAppView, useMcpAppViews } from "../ArtifactsTab/mcpAppViewsStore";
import { AppViewTabLabel, AppViewTabTooltip } from "./AppViewTab";
import { openMcpAppEntrypoint, openMcpAppEntrypointInNewTab } from "./openMcpAppEntrypoint";

function entrypoint(title: string): McpAppEntrypoint {
  return {
    serverName: "cad",
    serverLabel: "cad",
    toolName: "cad.library",
    title,
    resourceUri: "ui://cad/library",
    type: "global",
    viewKey: "entrypoint:cad:cad.library:global",
  };
}

/** Every workspace's transcript is loaded and empty, so only entry points can name a view. */
function loadedTranscripts(store: WorkspaceStore): () => void {
  const registered = spyOn(store, "hasRegisteredWorkspace").mockImplementation(() => true);
  const state = spyOn(store, "getWorkspaceState").mockImplementation(
    () =>
      ({
        messages: [],
        loading: false,
        isHydratingTranscript: false,
      }) as unknown as WorkspaceState
  );
  return () => {
    registered.mockRestore();
    state.mockRestore();
  };
}

/** A view-record answer: `stored` IDs have a record, the rest none. */
function viewRecords(stored: readonly string[]) {
  return (input: { toolCallIds: string[] }) =>
    Promise.resolve({
      success: true as const,
      data: input.toolCallIds.map((toolCallId) => ({
        toolCallId,
        view: stored.includes(toolCallId)
          ? {
              serverName: "cad",
              toolName: "cad.library",
              resourceUri: "ui://cad/library",
              arguments: {},
            }
          : null,
      })),
    });
}

describe("MCP App entry points", () => {
  let cleanupDom: (() => void) | null = null;
  beforeEach(() => {
    cleanupDom = installDom();
  });
  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("re-list after plugin, MCP and trust changes; the old list is gone meanwhile", async () => {
    let title = "Library";
    let release: (() => void) | null = null;
    let calls = 0;
    const client = createTestApiClient({
      mcpApps: {
        listEntrypoints: () => {
          calls += 1;
          if (calls < 5) return Promise.resolve([entrypoint(title)]);
          // The re-list after the trust change waits until the test releases it.
          return new Promise((resolve) => {
            release = () => resolve([]);
          });
        },
      },
    });
    const wrapper = (props: { children: React.ReactNode }) => (
      <APIProvider client={client}>{props.children}</APIProvider>
    );
    const { result } = renderHook(
      () => {
        useLoadMcpAppEntrypoints("ws-1", true);
        return useMcpAppEntrypoints("ws-1");
      },
      { wrapper }
    );
    await waitFor(() => expect(result.current?.[0]?.title).toBe("Library"));

    title = "Library 2";
    act(() => publishWorkspaceMcpOverridesSaved("ws-other"));
    expect(calls).toBe(1);
    act(() => publishWorkspaceMcpOverridesSaved("ws-1"));
    await waitFor(() => expect(result.current?.[0]?.title).toBe("Library 2"));
    title = "Library 3";
    act(() => publishAgentPluginsMutated());
    await waitFor(() => expect(result.current?.[0]?.title).toBe("Library 3"));
    title = "Library 4";
    act(() => publishGlobalMcpEnablementChanged());
    await waitFor(() => expect(result.current?.[0]?.title).toBe("Library 4"));
    expect(calls).toBe(4);

    act(() => publishProjectTrustChanged());
    // A stale entry never outlives the change, even while discovery runs.
    expect(result.current).toBeUndefined();
    await waitFor(() => expect(release).not.toBeNull());
    act(() => release?.());
    await waitFor(() => expect(result.current).toEqual([]));
  });

  test("a client that throws at once (disconnected) settles the list empty", async () => {
    const client = createTestApiClient({
      mcpApps: {
        listEntrypoints: () => {
          throw new Error("client disposed");
        },
      },
    });
    const wrapper = (props: { children: React.ReactNode }) => (
      <APIProvider client={client}>{props.children}</APIProvider>
    );
    // The listing starts in an effect: a synchronous throw there would break the render.
    const { result } = renderHook(
      () => {
        useLoadMcpAppEntrypoints("ws-throws", true);
        return useMcpAppEntrypoints("ws-throws");
      },
      { wrapper }
    );
    await waitFor(() => expect(result.current).toEqual([]));
  });

  test("a restored entry point tab waits for the listing, then resolves its view", async () => {
    let release: ((list: McpAppEntrypoint[]) => void) | null = null;
    const client = createTestApiClient({
      mcpApps: {
        listEntrypoints: () =>
          new Promise<McpAppEntrypoint[]>((resolve) => {
            release = resolve;
          }),
      },
    });
    const wrapper = (props: { children: React.ReactNode }) => (
      <APIProvider client={client}>{props.children}</APIProvider>
    );
    // The transcript is loaded, so only the entry point listing can keep the view loading.
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
    try {
      const viewKey = entrypoint("Library").viewKey;
      const { result } = renderHook(
        () => {
          useLoadMcpAppEntrypoints("ws-restore", true);
          return useMcpAppView("ws-restore", viewKey);
        },
        { wrapper }
      );
      // No transcript row exists for it: "loading", never "no longer available".
      expect(result.current).toBe("loading");
      await waitFor(() => expect(release).not.toBeNull());
      act(() => release?.([entrypoint("Library")]));
      await waitFor(() =>
        expect(result.current).toMatchObject({
          toolCallId: viewKey,
          label: "Library",
          arguments: {},
        })
      );
    } finally {
      registered.mockRestore();
      state.mockRestore();
    }
  });

  test("opening calls the tool once; an open tab is only focused", async () => {
    const opens: unknown[] = [];
    const client = createTestApiClient({
      mcpApps: {
        openEntrypoint: (input: unknown) => {
          opens.push(input);
          return Promise.resolve({ success: true as const, data: entrypoint("Library") });
        },
        getViewRecords: viewRecords([entrypoint("Library").viewKey]),
      },
    });
    const shown: string[] = [];
    const show = (view: { toolCallId: string }) => shown.push(view.toolCallId);
    const target = entrypoint("Library");

    expect(await openMcpAppEntrypoint(client, "ws-open", target, show)).toBeNull();
    expect(opens).toEqual([
      { workspaceId: "ws-open", serverName: "cad", toolName: "cad.library", type: "global" },
    ]);
    expect(shown).toEqual([target.viewKey]);

    // The tab is now in the workspace layout: a second open focuses it without a tool call.
    updatePersistedState(
      getRightSidebarLayoutKey("ws-open"),
      selectOrAddTab(getDefaultRightSidebarLayoutState(), appViewTabFor(target.viewKey))
    );
    expect(await openMcpAppEntrypoint(client, "ws-open", target, show)).toBeNull();
    expect(opens).toHaveLength(1);
    expect(shown).toEqual([target.viewKey, target.viewKey]);
  });

  test("a launcher open that a later pick made stale never replaces the pane's choice", async () => {
    const target = entrypoint("Library");
    const client = createTestApiClient({
      mcpApps: {
        openEntrypoint: () => Promise.resolve({ success: true as const, data: target }),
      },
    });
    const replaced: string[] = [];
    for (const current of [false, true]) {
      expect(
        await openMcpAppEntrypointInNewTab(
          client,
          `ws-launcher-${String(current)}`,
          target,
          () => current,
          (tab) => replaced.push(tab)
        )
      ).toBeNull();
    }
    expect(replaced).toEqual([appViewTabFor(target.viewKey)]);
  });

  test("two opens of one entry point started together share one tool call", async () => {
    let opens = 0;
    let finish: (() => void) | null = null;
    const target = entrypoint("Library");
    const client = createTestApiClient({
      mcpApps: {
        openEntrypoint: () => {
          opens += 1;
          return new Promise((resolve) => {
            finish = () => resolve({ success: true as const, data: target });
          });
        },
      },
    });
    // E.g. two split-pane launchers: each shows (or drops) the shared result itself.
    const shown: unknown[][] = [[], []];
    const first = openMcpAppEntrypoint(client, "ws-together", target, (view) =>
      shown[0].push(view)
    );
    const second = openMcpAppEntrypoint(client, "ws-together", target, (view) =>
      shown[1].push(view)
    );
    await waitFor(() => expect(finish).not.toBeNull());
    act(() => finish?.());
    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect(opens).toBe(1);
    expect(shown[0]).toHaveLength(1);
    expect(shown[1][0]).toBe(shown[0][0]);
    // Settled: a later open is a new one (the tab is not in this layout, so it runs again).
    finish = null;
    const third = openMcpAppEntrypoint(client, "ws-together", target, () => undefined);
    await waitFor(() => expect(finish).not.toBeNull());
    act(() => finish?.());
    expect(await third).toBeNull();
    expect(opens).toBe(2);
  });

  test("a picked entry point whose record was evicted runs again", async () => {
    let opens = 0;
    const target = entrypoint("Library");
    const client = createTestApiClient({
      mcpApps: {
        openEntrypoint: () => {
          opens += 1;
          return Promise.resolve({ success: true as const, data: target });
        },
        // The result store evicted the record: the open tab would show no result.
        getViewRecords: viewRecords([]),
      },
    });
    updatePersistedState(
      getRightSidebarLayoutKey("ws-evicted"),
      selectOrAddTab(getDefaultRightSidebarLayoutState(), appViewTabFor(target.viewKey))
    );
    const shown: string[] = [];
    expect(
      await openMcpAppEntrypoint(client, "ws-evicted", target, (view) =>
        shown.push(view.toolCallId)
      )
    ).toBeNull();
    expect(opens).toBe(1);
    expect(shown).toEqual([target.viewKey]);
  });

  test("a picked entry point whose record names another view runs again", async () => {
    let opens = 0;
    // A plugin update moved the view: the open tab's record still names the old resourceUri,
    // which getView would refuse for the current entry point after a remount.
    const target = { ...entrypoint("Library"), resourceUri: "ui://cad/library-v2" };
    const client = createTestApiClient({
      mcpApps: {
        openEntrypoint: () => {
          opens += 1;
          return Promise.resolve({ success: true as const, data: target });
        },
        getViewRecords: viewRecords([target.viewKey]),
      },
    });
    updatePersistedState(
      getRightSidebarLayoutKey("ws-rebound"),
      selectOrAddTab(getDefaultRightSidebarLayoutState(), appViewTabFor(target.viewKey))
    );
    expect(await openMcpAppEntrypoint(client, "ws-rebound", target, () => undefined)).toBeNull();
    expect(opens).toBe(1);
    // A record bound to another server is not this entry point's view either.
    const moved = { ...entrypoint("Library"), serverName: "cad-2" };
    expect(await openMcpAppEntrypoint(client, "ws-rebound", moved, () => undefined)).toBeNull();
    expect(opens).toBe(2);
  });

  test("an open shows the entry point the backend returned, not the listed one", async () => {
    const listed = entrypoint("Library");
    const moved = { ...listed, resourceUri: "ui://cad/library-v2", title: "Library v2" };
    const client = createTestApiClient({
      mcpApps: {
        listEntrypoints: () => Promise.resolve([listed]),
        openEntrypoint: () => Promise.resolve({ success: true as const, data: moved }),
      },
    });
    const wrapper = (props: { children: React.ReactNode }) => (
      <APIProvider client={client}>{props.children}</APIProvider>
    );
    const restore = loadedTranscripts(useWorkspaceStoreRaw());
    try {
      const { result } = renderHook(
        () => {
          useLoadMcpAppEntrypoints("ws-moved", true);
          return useMcpAppView("ws-moved", listed.viewKey);
        },
        { wrapper }
      );
      await waitFor(() =>
        expect(result.current).toMatchObject({ resourceUri: "ui://cad/library" })
      );
      const shown: unknown[] = [];
      await act(async () => {
        await openMcpAppEntrypoint(client, "ws-moved", listed, (view) => shown.push(view));
      });
      expect(shown).toMatchObject([{ resourceUri: "ui://cad/library-v2", label: "Library v2" }]);
      // The tab resolves to it too: getView checks the record's resourceUri.
      expect(result.current).toMatchObject({ resourceUri: "ui://cad/library-v2" });
    } finally {
      restore();
    }
  });

  test("an opened entry point's view goes unavailable once a re-list lacks it", async () => {
    let list = [entrypoint("Library")];
    let release: (() => void) | null = null;
    let lookups = 0;
    const client = createTestApiClient({
      mcpApps: {
        listEntrypoints: () =>
          new Promise<McpAppEntrypoint[]>((resolve) => {
            release = () => resolve(list);
          }),
        openEntrypoint: () => Promise.resolve({ success: true as const, data: list[0] }),
        // The record outlives the server: a record lookup would bring the view back.
        getViewRecords: (input: { toolCallIds: string[] }) => {
          lookups += 1;
          return viewRecords(input.toolCallIds)(input);
        },
      },
    });
    const wrapper = (props: { children: React.ReactNode }) => (
      <APIProvider client={client}>{props.children}</APIProvider>
    );
    const restore = loadedTranscripts(useWorkspaceStoreRaw());
    try {
      const viewKey = entrypoint("Library").viewKey;
      const { result } = renderHook(
        () => {
          useLoadMcpAppEntrypoints("ws-gone", true);
          return useMcpAppView("ws-gone", viewKey);
        },
        { wrapper }
      );
      // The session's view list (palette "Open App View", tab labels) never holds it either.
      const sessionViews = renderHook(() => useMcpAppViews("ws-gone"), { wrapper });
      await waitFor(() => expect(release).not.toBeNull());
      act(() => release?.());
      await waitFor(() => expect(result.current).toMatchObject({ toolCallId: viewKey }));
      // Opened through the default path (OPEN_MCP_APP_VIEW).
      await act(async () => {
        expect(await openMcpAppEntrypoint(client, "ws-gone", entrypoint("Library"))).toBeNull();
      });
      const opened = result.current;

      // The server is disabled: while the re-list runs the open view stays (no remount).
      release = null;
      list = [];
      act(() => publishGlobalMcpEnablementChanged());
      expect(result.current).toBe(opened);
      await waitFor(() => expect(release).not.toBeNull());
      act(() => release?.());
      await waitFor(() => expect(result.current).toBeNull());
      expect(lookups).toBe(0);
      expect(sessionViews.result.current.map((view) => view.toolCallId)).not.toContain(viewKey);
    } finally {
      restore();
    }
  });

  test("with the experiment off the list settles empty, so a restored tab stops loading", async () => {
    const client = createTestApiClient({ mcpApps: { getViewRecords: viewRecords([]) } });
    const wrapper = (props: { children: React.ReactNode }) => (
      <APIProvider client={client}>{props.children}</APIProvider>
    );
    const restore = loadedTranscripts(useWorkspaceStoreRaw());
    try {
      const { result } = renderHook(
        () => {
          useLoadMcpAppEntrypoints("ws-off", false);
          return [
            useMcpAppEntrypoints("ws-off"),
            useMcpAppView("ws-off", entrypoint("Library").viewKey),
          ] as const;
        },
        { wrapper }
      );
      await waitFor(() => expect(result.current).toEqual([[], null]));
    } finally {
      restore();
    }
  });

  test("a tool call ID that looks like an entry point key is an ordinary view", async () => {
    // Not listed: it is a model tool call whose record the backend has.
    const toolCallId = "entrypoint:cad:cad.library:global";
    const client = createTestApiClient({
      mcpApps: {
        listEntrypoints: () => Promise.resolve([]),
        getViewRecords: viewRecords([toolCallId]),
      },
    });
    const wrapper = (props: { children: React.ReactNode }) => (
      <APIProvider client={client}>{props.children}</APIProvider>
    );
    const restore = loadedTranscripts(useWorkspaceStoreRaw());
    try {
      const { result } = renderHook(
        () => {
          useLoadMcpAppEntrypoints("ws-lookalike", true);
          return useMcpAppView("ws-lookalike", toolCallId);
        },
        { wrapper }
      );
      await waitFor(() =>
        expect(result.current).toMatchObject({ toolCallId, resourceUri: "ui://cad/library" })
      );
    } finally {
      restore();
    }
  });

  test("an entry point tab names its server by the label, never the plugin key", async () => {
    const plugin = {
      ...entrypoint("Parts Tray"),
      serverName: "plugin:0123456789abcdef:tray",
      serverLabel: "bits-and-bolts · tray",
      viewKey: "entrypoint:plugin%3A0123456789abcdef%3Atray:cad.library:global",
    };
    const client = createTestApiClient({
      mcpApps: { listEntrypoints: () => Promise.resolve([plugin]) },
    });
    const restore = loadedTranscripts(useWorkspaceStoreRaw());
    function Tab() {
      useLoadMcpAppEntrypoints("ws-label", true);
      return (
        <>
          <AppViewTabLabel workspaceId="ws-label" toolCallId={plugin.viewKey} />
          <AppViewTabTooltip workspaceId="ws-label" toolCallId={plugin.viewKey} />
        </>
      );
    }
    try {
      const view = render(
        <APIProvider client={client}>
          <Tab />
        </APIProvider>
      );
      await view.findByText("bits-and-bolts · tray");
      expect(view.container.textContent).toContain("Parts Tray · bits-and-bolts · tray");
      expect(view.container.textContent).not.toContain("0123456789abcdef");
    } finally {
      restore();
    }
  });
  test("after a restart, a tab whose entry point is gone shows unavailable, not its record", async () => {
    // A fresh workspace ID stands in for a restarted renderer: no ref or retired key is held.
    const target = entrypoint("Library");
    const client = createTestApiClient({
      mcpApps: {
        // The server was disabled: the list lacks the entry point.
        listEntrypoints: () => Promise.resolve([]),
        // Its record outlives the server and says it belongs to an entry point.
        getViewRecords: (input: { toolCallIds: string[] }) =>
          Promise.resolve({
            success: true as const,
            data: input.toolCallIds.map((toolCallId) => ({
              toolCallId,
              view: {
                serverName: "cad",
                toolName: "cad.library",
                resourceUri: "ui://cad/library",
                arguments: {},
                entrypoint: true,
              },
            })),
          }),
      },
    });
    const wrapper = (props: { children: React.ReactNode }) => (
      <APIProvider client={client}>{props.children}</APIProvider>
    );
    const restore = loadedTranscripts(useWorkspaceStoreRaw());
    try {
      const { result } = renderHook(
        () => {
          useLoadMcpAppEntrypoints("ws-restarted", true);
          return useMcpAppView("ws-restarted", target.viewKey);
        },
        { wrapper }
      );
      await waitFor(() => expect(result.current).toBeNull());
      // It stays unavailable: the record never brings it back as a tool call's view, so the
      // tab never takes the record's tool name as its label either.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(result.current).toBeNull();
      const label = render(
        <APIProvider client={client}>
          <AppViewTabLabel workspaceId="ws-restarted" toolCallId={target.viewKey} />
        </APIProvider>
      );
      expect(label.container.textContent).toBe("App view");
    } finally {
      restore();
    }
  });

  test("a thread entry point's tab names its scope", async () => {
    const thread = {
      ...entrypoint("Library"),
      type: "thread" as const,
      viewKey: "entrypoint:cad:cad.library:thread",
    };
    const client = createTestApiClient({
      mcpApps: { listEntrypoints: () => Promise.resolve([entrypoint("Library"), thread]) },
    });
    const restore = loadedTranscripts(useWorkspaceStoreRaw());
    function Tabs() {
      useLoadMcpAppEntrypoints("ws-scope", true);
      return (
        <>
          <div data-testid="global">
            <AppViewTabLabel workspaceId="ws-scope" toolCallId={entrypoint("Library").viewKey} />
            <AppViewTabTooltip workspaceId="ws-scope" toolCallId={entrypoint("Library").viewKey} />
          </div>
          <div data-testid="thread">
            <AppViewTabLabel workspaceId="ws-scope" toolCallId={thread.viewKey} />
            <AppViewTabTooltip workspaceId="ws-scope" toolCallId={thread.viewKey} />
          </div>
        </>
      );
    }
    try {
      const view = render(
        <APIProvider client={client}>
          <Tabs />
        </APIProvider>
      );
      await waitFor(() => expect(view.getByTestId("thread").textContent).toContain("Library"));
      expect(view.getByTestId("thread").textContent).toBe(
        "Librarycad · this chatLibrary · cad · this chat"
      );
      expect(view.getByTestId("global").textContent).toBe("LibrarycadLibrary · cad");
    } finally {
      restore();
    }
  });
});
