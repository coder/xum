import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
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
import { useMcpAppView } from "../ArtifactsTab/mcpAppViewsStore";
import { openMcpAppEntrypoint } from "./openMcpAppEntrypoint";

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
      expect(result.current).toMatchObject({ toolCallId: viewKey, label: "Library", arguments: {} })
    );
  });

  test("opening calls the tool once; an open tab is only focused", async () => {
    const opens: unknown[] = [];
    const client = createTestApiClient({
      mcpApps: {
        openEntrypoint: (input: unknown) => {
          opens.push(input);
          return Promise.resolve({ success: true as const, data: entrypoint("Library") });
        },
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
});
