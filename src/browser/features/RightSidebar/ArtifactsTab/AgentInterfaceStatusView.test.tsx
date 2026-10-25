// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef, useState, type ReactNode } from "react";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import {
  createTestApiClient,
  resetTestExperiments,
  setTestExperiment,
  type TestApiOverrides,
} from "@/browser/testUtils";
import { AGENT_INTERFACE_STATUS_ARTIFACT } from "@/common/constants/artifacts";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ArtifactListing, ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import { AgentInterfaceStatusView } from "./AgentInterfaceStatusView";
import { useMainPaneAgentInterfaceView } from "./agentInterfaceView";

function page(content: string): ArtifactReadResult {
  // One fixed mtime: remote runtimes list whole seconds, so a quick rewrite can keep it.
  return {
    status: "ok",
    path: AGENT_INTERFACE_STATUS_ARTIFACT,
    kind: "html",
    size: content.length,
    modifiedMs: 1_000,
    encoding: "utf8",
    content,
  };
}

let current = page("<p>AAAA</p>");
/** What the listing shows: the page, a truncated listing without it, or a complete one without it. */
let listed: "page" | "truncated" | "absent" = "page";
let failingReads = 0;
let reads = 0;
let lists = 0;

function listing(): ArtifactListing {
  const entry = { path: current.path, kind: current.kind, size: current.size, modifiedMs: 1_000 };
  return {
    available: true,
    dir: "/scratch/artifacts",
    entries: listed === "page" ? [entry] : [],
    truncated: listed === "truncated",
  };
}

function Wrapper(props: { children: ReactNode }) {
  const api: TestApiOverrides<APIClient> = {
    artifacts: {
      list: () => {
        lists += 1;
        return Promise.resolve({ success: true as const, data: listing() });
      },
      read: () => {
        reads += 1;
        if (failingReads > 0) {
          failingReads -= 1;
          return Promise.resolve({ success: false as const, error: "runtime unreachable" });
        }
        return Promise.resolve({ success: true as const, data: current });
      },
      getState: () => Promise.resolve({ success: true as const, data: { state: null } }),
    },
  };
  const [client] = useState(() => createTestApiClient(api));
  return (
    <ThemeProvider forcedTheme="dark">
      <APIProvider client={client}>{props.children}</APIProvider>
    </ThemeProvider>
  );
}

/** The main pane's wiring: the poll and shortcut hook, then the status view it selects. */
function MainPane(props: { workspaceId: string }) {
  const view = useMainPaneAgentInterfaceView(props.workspaceId);
  const dockRef = useRef<HTMLDivElement>(null);
  const composerApiRef = useRef(null);
  return (
    <>
      <AgentInterfaceStatusView
        workspaceId={props.workspaceId}
        view={view}
        dockRef={dockRef}
        composerApiRef={composerApiRef}
      />
      <div ref={dockRef} />
    </>
  );
}

function shownPage(view: ReturnType<typeof render>): string {
  return view.queryByTestId("artifact-frame")?.getAttribute("srcdoc") ?? "";
}

describe("Agent interface status view", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    setTestExperiment(EXPERIMENT_IDS.ARTIFACTS, true);
    setTestExperiment(EXPERIMENT_IDS.ARTIFACTS_AGENT_INTERFACE, true);
    current = page("<p>AAAA</p>");
    listed = "page";
    failingReads = 0;
    reads = 0;
    lists = 0;
  });

  afterEach(() => {
    cleanup();
    resetTestExperiments();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("a failed read is retried on the next poll, with no change to the file", async () => {
    // bun-types lacks advanceTimersByTime; bun implements it.
    const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };
    const flush = () =>
      act(async () => {
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
    failingReads = 1;
    jest.useFakeTimers();
    try {
      const view = render(<MainPane workspaceId="ws-read-retry" />, { wrapper: Wrapper });
      await flush();
      expect(reads).toBe(1);
      expect(view.getByText("Loading…")).toBeTruthy();

      await act(async () => {
        fakeTimers.advanceTimersByTime(3_000);
        await Promise.resolve();
      });
      await flush();
      expect(reads).toBe(2);
      expect(view.queryByText("Loading…")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a same-size rewrite in the same second shows after the tool call that wrote it", async () => {
    const view = render(<MainPane workspaceId="ws-same-size" />, { wrapper: Wrapper });
    await waitFor(() => expect(shownPage(view)).toContain("<p>AAAA</p>"));

    current = page("<p>BBBB</p>");
    act(() => workspaceStore.simulateFileModifyingToolEnd("ws-same-size"));
    await waitFor(() => expect(shownPage(view)).toContain("<p>BBBB</p>"));
  });

  test("only a complete listing without the page switches the pane back to the chat", async () => {
    const view = render(<MainPane workspaceId="ws-truncated" />, { wrapper: Wrapper });
    await waitFor(() => expect(shownPage(view)).toContain("<p>AAAA</p>"));

    // Past the listing cap the page may still exist: the status page stays.
    listed = "truncated";
    const listsBefore = lists;
    act(() => workspaceStore.simulateFileModifyingToolEnd("ws-truncated"));
    await waitFor(() => expect(lists).toBeGreaterThan(listsBefore));
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.queryByTestId("agent-interface-status-view")).not.toBeNull();

    listed = "absent";
    act(() => workspaceStore.simulateFileModifyingToolEnd("ws-truncated"));
    await waitFor(() => expect(view.queryByTestId("agent-interface-status-view")).toBeNull());
  });
});
