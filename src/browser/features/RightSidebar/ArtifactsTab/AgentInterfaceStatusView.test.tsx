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

  test("a blank page rewritten at the same size and second shows after the tool call", async () => {
    // A comment only: nothing to show, so the pane falls back to the chat.
    current = page("<!-- xx -->");
    const view = render(<MainPane workspaceId="ws-unshowable" />, { wrapper: Wrapper });
    await waitFor(() => expect(reads).toBe(1));
    await waitFor(() => expect(view.queryByTestId("agent-interface-status-view")).toBeNull());

    // Same size and listed mtime: only the tool call tells the pane to look again.
    current = page("<p>AAAA</p>");
    act(() => workspaceStore.simulateFileModifyingToolEnd("ws-unshowable"));
    await waitFor(() => expect(shownPage(view)).toContain("<p>AAAA</p>"));
  });

  test("the interrupt key pressed in the page reaches the chat's handler only during the user's gesture", async () => {
    let activation = { isActive: false };
    Object.defineProperty(window.navigator, "userActivation", {
      configurable: true,
      get: () => activation,
    });
    // The host builds the replayed event with the global constructor, which the DOM harness lacks.
    const globalKeyboardEvent = globalThis.KeyboardEvent;
    globalThis.KeyboardEvent = window.KeyboardEvent;
    let interrupts = 0;
    let frame: HTMLIFrameElement | null = null;
    // Where useAIViewKeybinds listens: window, bubble phase.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target === frame && event.key === "Escape") interrupts++;
    };
    window.addEventListener("keydown", onKeyDown);
    try {
      const view = render(<MainPane workspaceId="ws-interrupt" />, { wrapper: Wrapper });
      await waitFor(() => expect(shownPage(view)).toContain("<p>AAAA</p>"));
      frame = view.getByTestId("artifact-frame") as HTMLIFrameElement;
      const post = (keybind: "normal" | "vim") =>
        act(() => {
          const event = new window.Event("message");
          Object.defineProperty(event, "data", {
            value: { xumArtifact: 1, type: "interruptKey", keybind },
          });
          Object.defineProperty(event, "source", { value: frame?.contentWindow });
          window.dispatchEvent(event);
        });

      // The page's script posting it by itself, even after taking focus with window.focus().
      post("normal");
      act(() => frame?.focus());
      post("normal");
      expect(interrupts).toBe(0);

      // The user's key press in the page; only the keybind for the Vim setting (off) counts.
      activation = { isActive: true };
      post("vim");
      expect(interrupts).toBe(0);
      post("normal");
      expect(interrupts).toBe(1);
    } finally {
      window.removeEventListener("keydown", onKeyDown);
      globalThis.KeyboardEvent = globalKeyboardEvent;
      Reflect.deleteProperty(window.navigator, "userActivation");
    }
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
