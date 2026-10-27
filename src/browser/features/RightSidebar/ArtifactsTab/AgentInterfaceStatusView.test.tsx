// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { useRef, useState, type ReactNode } from "react";
import { installDom } from "../../../../../tests/ui/dom";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import { workspaceStore, type WorkspaceState } from "@/browser/stores/WorkspaceStore";
import { overlayWorkspaceStoreRaw } from "@/browser/stores/workspaceStoreTestOverlay";
import { KEYBINDS } from "@/browser/utils/ui/keybinds";
import {
  createTestApiClient,
  resetTestExperiments,
  setTestExperiment,
  type TestApiOverrides,
} from "@/browser/testUtils";
import { AGENT_INTERFACE_STATUS_ARTIFACT } from "@/common/constants/artifacts";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ArtifactListing, ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import type { DisplayedMessage } from "@/common/types/message";
import { AgentInterfaceStatusView } from "./AgentInterfaceStatusView";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { useMainPaneAgentInterfaceView } from "./agentInterfaceView";
import { CONFIRM_ARM_DELAY_MS } from "./confirmArming";

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
/** Reads that reject, as a call does when the connection drops. */
let rejectingReads = 0;
/** The page is gone: reads find no file. */
let deleted = false;
let reads = 0;
let lists = 0;
/** Messages the page's `window.xum.send` delivered. */
let sends: Array<{ path: string; text: string }> = [];
/** The page's persisted `window.xum.state`, and what its `setState` calls saved. */
let persistedState: unknown = null;
let savedStates: unknown[] = [];

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
        if (rejectingReads > 0) {
          rejectingReads -= 1;
          return Promise.reject(new Error("connection lost"));
        }
        if (deleted) {
          return Promise.resolve({
            success: false as const,
            error: `Artifact not found: ${AGENT_INTERFACE_STATUS_ARTIFACT}`,
            missing: true as const,
          });
        }
        return Promise.resolve({ success: true as const, data: current });
      },
      getState: () => Promise.resolve({ success: true as const, data: { state: persistedState } }),
      setState: (input: { state: unknown }) => {
        savedStates.push(input.state);
        return Promise.resolve({ success: true as const, data: undefined });
      },
      sendInteraction: (input: { path: string; text: string }) => {
        sends.push({ path: input.path, text: input.text });
        return Promise.resolve({ success: true as const, data: { id: "i1" } });
      },
      // What the Artifacts panel lists besides the folder: nothing.
      listPinned: () =>
        Promise.resolve({ success: true as const, data: { available: true as const, files: [] } }),
      listShelf: () =>
        Promise.resolve({
          success: true as const,
          data: { project: { available: true as const, entries: [] }, global: [] },
        }),
      listVersions: (input: { workspaceId: string; path: string }) =>
        Promise.resolve({
          success: true as const,
          data: { artifactId: input.path, path: input.path, pin: null, versions: [] },
        }),
      capabilities: () => Promise.resolve({ agentBrowserAvailable: true }),
    },
  };
  const [client] = useState(() => createTestApiClient(api));
  return (
    <ThemeProvider forcedTheme="dark">
      <APIProvider client={client}>{props.children}</APIProvider>
    </ThemeProvider>
  );
}

/** The real store getter, captured before any spy (not a hook: it only returns the singleton). */
const readRealWorkspaceStore = WorkspaceStoreModule.useWorkspaceStoreRaw;

/** Workspace states the status bar reads, for workspaces the real store never registered. */
const seededStates = new Map<string, WorkspaceState>();
const restoreSpies: Array<() => void> = [];

function seedWorkspace(workspaceId: string, patch: Partial<WorkspaceState>) {
  if (restoreSpies.length === 0) {
    const realStore = readRealWorkspaceStore();
    const store = overlayWorkspaceStoreRaw(realStore, {
      hasRegisteredWorkspace: (id: string) =>
        seededStates.has(id) || realStore.hasRegisteredWorkspace(id),
      getWorkspaceState: (id: string) => seededStates.get(id) ?? realStore.getWorkspaceState(id),
    });
    const storeSpy = spyOn(WorkspaceStoreModule, "useWorkspaceStoreRaw").mockReturnValue(store);
    // Start Here's transcript barrier: a seeded workspace has a complete replay.
    const realCaughtUp = workspaceStore.isWorkspaceTranscriptCaughtUp;
    const barrierSpy = spyOn(workspaceStore, "isWorkspaceTranscriptCaughtUp").mockImplementation(
      (id: string) => seededStates.has(id) || realCaughtUp(id)
    );
    restoreSpies.push(
      () => storeSpy.mockRestore(),
      () => barrierSpy.mockRestore()
    );
  }
  seededStates.set(workspaceId, {
    name: workspaceId,
    messages: [],
    queuedMessage: null,
    heldInputs: [],
    canInterrupt: false,
    isCompacting: false,
    isStreamStarting: false,
    awaitingUserQuestion: false,
    loading: false,
    isTranscriptCaughtUp: true,
    transcriptReplayFailed: false,
    isHydratingTranscript: false,
    isTranscriptStale: false,
    isIncrementalCatchUp: false,
    hasOlderHistory: false,
    loadingOlderHistory: false,
    muxMessages: [],
    currentModel: null,
    currentThinkingLevel: null,
    recencyTimestamp: null,
    todos: [],
    loadedSkills: [],
    skillLoadErrors: [],
    agentStatus: undefined,
    activeWorkflowRunCount: 0,
    activeBashMonitorCount: 0,
    lastAbortReason: null,
    pendingStreamStartTime: null,
    pendingStreamModel: null,
    runtimeStatus: null,
    autoRetryStatus: null,
    ...patch,
  });
}

/** Changes a seeded workspace's state and notifies its subscribers, as a stream event does. */
function updateSeededWorkspace(workspaceId: string, patch: Partial<WorkspaceState>) {
  const state = seededStates.get(workspaceId);
  if (state == null) throw new Error(`${workspaceId} was not seeded`);
  seededStates.set(workspaceId, { ...state, ...patch });
  act(() => readRealWorkspaceStore().bumpState(workspaceId));
}

/** A turn mid-way: the user's prompt, the agent's reply so far, and a bash call still running. */
const MID_TURN: DisplayedMessage[] = [
  {
    type: "user",
    id: "u1",
    historyId: "u1",
    content: "Run the slow check",
    historySequence: 1,
    timestamp: Date.now(),
  },
  {
    type: "assistant",
    id: "a1",
    historyId: "a1",
    content: "Starting the check now.",
    historySequence: 2,
    isStreaming: false,
    isPartial: false,
    isCompacted: false,
    isIdleCompacted: false,
  },
  {
    type: "tool",
    id: "t1",
    historyId: "t1",
    toolCallId: "call1",
    toolName: "bash",
    args: { script: "sleep 20", display_name: "Slow check" },
    status: "executing",
    isPartial: false,
    historySequence: 3,
  },
];

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

/** The page the main pane's status view shows (the Artifacts panel may show it too). */
/** Delivers `data` to the host as a message from the page in `frame`. */
function postFromFrame(frame: HTMLIFrameElement, data: unknown) {
  act(() => {
    const event = new window.Event("message");
    Object.defineProperty(event, "data", { value: data });
    Object.defineProperty(event, "source", { value: frame.contentWindow });
    window.dispatchEvent(event);
  });
}

function shownPage(view: ReturnType<typeof render>): string {
  const statusView = view.queryByTestId("agent-interface-status-view");
  if (statusView == null) return "";
  return within(statusView).queryByTestId("artifact-frame")?.getAttribute("srcdoc") ?? "";
}

/**
 * Runs the bridge shim from `frame`'s srcdoc against a stand-in window whose posts reach the host
 * as the frame's messages; returns a trusted key press inside the frame.
 */
function runFrameShim(frame: HTMLIFrameElement) {
  const srcdoc = frame.getAttribute("srcdoc") ?? "";
  const shim = new window.DOMParser().parseFromString(srcdoc, "text/html").querySelector("script");
  const keydowns: Array<(event: unknown) => void> = [];
  const frameWindow = {
    parent: {
      postMessage: (data: unknown) => {
        const event = new window.Event("message");
        Object.defineProperty(event, "data", { value: data });
        Object.defineProperty(event, "source", { value: frame.contentWindow });
        window.dispatchEvent(event);
      },
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "keydown") keydowns.push(listener);
    },
    setTimeout: (callback: () => void) => callback(),
  };
  const frameDocument = {
    documentElement: { setAttribute: () => undefined },
    addEventListener: () => undefined,
    querySelectorAll: () => [],
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs our own generated script
  const run = new Function("window", "document", "CustomEvent", shim?.textContent ?? "") as (
    window: unknown,
    document: unknown,
    customEvent: unknown
  ) => void;
  run(frameWindow, frameDocument, class {});
  return (key: string, modifiers: { ctrlKey?: boolean; shiftKey?: boolean }) => {
    const event = {
      key,
      target: { nodeType: 1, tagName: "DIV", isContentEditable: false },
      isTrusted: true,
      repeat: false,
      ctrlKey: modifiers.ctrlKey ?? false,
      shiftKey: modifiers.shiftKey ?? false,
      metaKey: false,
      altKey: false,
      defaultPrevented: false,
      preventDefault: () => undefined,
    };
    for (const listener of keydowns) listener(event);
  };
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
    rejectingReads = 0;
    deleted = false;
    reads = 0;
    lists = 0;
    sends = [];
    persistedState = null;
    savedStates = [];
  });

  afterEach(() => {
    cleanup();
    for (const restore of restoreSpies.splice(0)) restore();
    seededStates.clear();
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
    await waitFor(() =>
      expect(view.queryByTestId("agent-interface-status-view") === null).toBe(true)
    );

    // Same size and listed mtime: only the tool call tells the pane to look again.
    current = page("<p>AAAA</p>");
    act(() => workspaceStore.simulateFileModifyingToolEnd("ws-unshowable"));
    await waitFor(() => expect(shownPage(view)).toContain("<p>AAAA</p>"));
  });

  test("the interrupt key pressed in the page is replayed only during the user's gesture and for the active keybind", async () => {
    let activation = { isActive: false };
    Object.defineProperty(window.navigator, "userActivation", {
      configurable: true,
      get: () => activation,
    });
    // The host builds the replayed event with the global constructor, which the DOM harness lacks.
    const globalKeyboardEvent = globalThis.KeyboardEvent;
    globalThis.KeyboardEvent = window.KeyboardEvent;
    // Every key replayed on the frame, so a replayed keybind the chat would not match counts too.
    const replayed: string[] = [];
    let frame: HTMLIFrameElement | null = null;
    // Where useAIViewKeybinds listens: window, bubble phase.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target === frame) replayed.push(`${event.ctrlKey ? "Ctrl+" : ""}${event.key}`);
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
      expect(replayed).toEqual([]);

      // The user's key press in the page; only the keybind for the Vim setting (off) is replayed.
      activation = { isActive: true };
      post("vim");
      expect(replayed).toEqual([]);
      post("normal");
      expect(replayed).toEqual(["Escape"]);
    } finally {
      window.removeEventListener("keydown", onKeyDown);
      globalThis.KeyboardEvent = globalKeyboardEvent;
      Reflect.deleteProperty(window.navigator, "userActivation");
    }
  });

  test("the view switch chord pressed in the page leaves it for the chat", async () => {
    Object.defineProperty(window.navigator, "userActivation", {
      configurable: true,
      get: () => ({ isActive: true }),
    });
    // The host builds the replayed event with the global constructor, which the DOM harness lacks.
    const globalKeyboardEvent = globalThis.KeyboardEvent;
    globalThis.KeyboardEvent = window.KeyboardEvent;
    try {
      const view = render(<MainPane workspaceId="ws-switch-chord" />, { wrapper: Wrapper });
      await waitFor(() => expect(shownPage(view)).toContain("<p>AAAA</p>"));
      const frame = view.getByTestId("artifact-frame") as HTMLIFrameElement;
      act(() => frame.focus());
      // The press goes through the shim this frame's srcdoc carries (happy-dom runs no frame
      // scripts), so a status page whose shim does not forward the chord fails here.
      const pressInFrame = runFrameShim(frame);
      act(() =>
        pressInFrame(KEYBINDS.TOGGLE_AGENT_INTERFACE_VIEW.key, { ctrlKey: true, shiftKey: true })
      );
      await waitFor(() =>
        expect(view.queryByTestId("agent-interface-status-view") === null).toBe(true)
      );
    } finally {
      globalThis.KeyboardEvent = globalKeyboardEvent;
      Reflect.deleteProperty(window.navigator, "userActivation");
    }
  });

  test("a send from the page asks in the confirm strip, also during the user's gesture", async () => {
    // Focus on the frame and live activation: what the Artifacts tab takes as a click in the page.
    Object.defineProperty(window.navigator, "userActivation", {
      configurable: true,
      get: () => ({ isActive: true }),
    });
    try {
      const view = render(<MainPane workspaceId="ws-send" />, { wrapper: Wrapper });
      await waitFor(() => expect(shownPage(view)).toContain("<p>AAAA</p>"));
      const frame = view.getByTestId("artifact-frame") as HTMLIFrameElement;
      act(() => frame.focus());
      postFromFrame(frame, { xumArtifact: 1, type: "send", text: "Run the tests" });

      const strip = await view.findByTestId("artifact-send-strip");
      expect(strip.textContent).toContain("Run the tests");
      expect(sends).toEqual([]);

      const sendButton = within(strip).getByRole("button", { name: "Send" });
      await waitFor(() => expect(sendButton.hasAttribute("disabled")).toBe(false), {
        timeout: CONFIRM_ARM_DELAY_MS + 1000,
      });
      fireEvent.click(sendButton);
      await waitFor(() =>
        expect(sends).toEqual([{ path: AGENT_INTERFACE_STATUS_ARTIFACT, text: "Run the tests" }])
      );
    } finally {
      Reflect.deleteProperty(window.navigator, "userActivation");
    }
  });

  test("the page's window.xum.state loads the saved state and setState saves it", async () => {
    persistedState = { step: 1 };
    const view = render(<MainPane workspaceId="ws-state" />, { wrapper: Wrapper });
    await waitFor(() => expect(shownPage(view)).toContain("<p>AAAA</p>"));
    const embedded = /var state = JSON\.parse\((.*)\);/.exec(shownPage(view))?.[1];
    expect(JSON.parse(JSON.parse(embedded ?? '"null"') as string)).toEqual({ step: 1 });

    const frame = view.getByTestId("artifact-frame") as HTMLIFrameElement;
    postFromFrame(frame, { xumArtifact: 1, type: "setState", state: { step: 2 } });
    await waitFor(() => expect(savedStates).toEqual([{ step: 2 }]));
  });

  test("a page that truncated listings leave out still shows, follows its later versions, and goes once deleted", async () => {
    // bun-types lacks advanceTimersByTime; bun implements it.
    const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };
    const flush = () =>
      act(async () => {
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
    const nextPoll = async () => {
      await act(async () => {
        fakeTimers.advanceTimersByTime(3_000);
        await Promise.resolve();
      });
      await flush();
    };
    // A crowded folder: past the listing caps, the page is in no listing at all.
    listed = "truncated";
    jest.useFakeTimers();
    try {
      const view = render(<MainPane workspaceId="ws-crowded" />, { wrapper: Wrapper });
      await flush();
      expect(shownPage(view)).toContain("<p>AAAA</p>");

      // A rewrite no tool call reported, found by the next poll alone.
      current = { ...page("<p>BBBBBB</p>"), modifiedMs: 2_000 };
      await nextPoll();
      expect(shownPage(view)).toContain("<p>BBBBBB</p>");

      // A read that fails (a reconnect) says nothing about the page: it stays, whether the
      // route answers with an error or the call itself rejects ...
      failingReads = 1;
      let readsBefore = reads;
      await nextPoll();
      expect(reads).toBe(readsBefore + 1);
      expect(shownPage(view)).toContain("<p>BBBBBB</p>");
      rejectingReads = 1;
      readsBefore = reads;
      await nextPoll();
      expect(reads).toBe(readsBefore + 1);
      expect(shownPage(view)).toContain("<p>BBBBBB</p>");
      // ... and the next poll reads it again.
      current = { ...page("<p>CCCCCCCC</p>"), modifiedMs: 3_000 };
      await nextPoll();
      expect(shownPage(view)).toContain("<p>CCCCCCCC</p>");

      // A read that finds no page does say something: the pane goes back to the chat.
      deleted = true;
      await nextPoll();
      expect(view.queryByTestId("agent-interface-status-view") == null).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test("with the Artifacts panel open, the folder is listed once per change and the page follows it", async () => {
    const view = render(
      <>
        <MainPane workspaceId="ws-shared" />
        <ArtifactsPanel workspaceId="ws-shared" />
      </>,
      { wrapper: Wrapper }
    );
    await waitFor(() => expect(shownPage(view)).toContain("<p>AAAA</p>"));
    const settle = () =>
      act(async () => {
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
    await settle();

    current = page("<p>BBBBBB</p>");
    const listsBefore = lists;
    act(() => workspaceStore.simulateFileModifyingToolEnd("ws-shared"));
    await waitFor(() => expect(shownPage(view)).toContain("<p>BBBBBB</p>"));
    await settle();
    // The panel's listing, which the main pane takes instead of walking the folder again.
    expect(lists).toBe(listsBefore + 1);

    // Once the panel closes, the main pane lists the folder itself again.
    view.rerender(<MainPane workspaceId="ws-shared" />);
    current = page("<p>CCCCCCCC</p>");
    act(() => workspaceStore.simulateFileModifyingToolEnd("ws-shared"));
    await waitFor(() => expect(shownPage(view)).toContain("<p>CCCCCCCC</p>"));
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
    await waitFor(() =>
      expect(view.queryByTestId("agent-interface-status-view") === null).toBe(true)
    );
  });
  test("the status bar names the running tool and its transcript peek opens and closes", async () => {
    seedWorkspace("ws-bar-busy", {
      messages: MID_TURN,
      canInterrupt: true,
      queuedMessage: { id: "q1", content: "Then roll to 50%" },
      heldInputs: [
        {
          id: "h1",
          reason: "reported",
          displayText: "An older send that failed",
          attachmentCount: 0,
          reviewCount: 0,
        },
      ],
    });
    const view = render(<MainPane workspaceId="ws-bar-busy" />, { wrapper: Wrapper });
    await waitFor(() => expect(shownPage(view)).toContain("<p>AAAA</p>"));
    const bar = view.getByTestId("agent-interface-status-bar");
    expect(within(bar).getByRole("status").textContent).toContain("Slow check");
    // The send made during the turn is the user's last message, still waiting in the queue; the
    // held input is counted, not shown in its place.
    const receipt = within(bar).getByTestId("agent-interface-status-receipt");
    expect(receipt.textContent).toContain("Then roll to 50%");
    expect(receipt.textContent).toContain("Queued");
    expect(receipt.textContent).toContain("+1 held");
    expect(receipt.textContent).not.toContain("An older send that failed");
    // Start Here would rewrite the context under the running turn.
    expect(within(bar).getByRole("button", { name: "Start here" }).hasAttribute("disabled")).toBe(
      true
    );

    const toggle = within(bar).getByRole("button", { name: "Show transcript" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.hasAttribute("aria-controls")).toBe(false);
    fireEvent.click(toggle);
    const peek = view.getByTestId("agent-interface-transcript-peek");
    expect(toggle.getAttribute("aria-controls")).toBe(peek.id);
    expect(peek.textContent).toContain("Run the slow check");
    expect(peek.textContent).toContain("Starting the check now.");
    fireEvent.click(within(bar).getByRole("button", { name: "Hide transcript" }));
    expect(view.queryByTestId("agent-interface-transcript-peek")).toBeNull();
  });

  test("Start here from the status bar opens the confirmation once the turn ends, and a turn that starts under it turns OK off", async () => {
    seedWorkspace("ws-bar-idle", { messages: MID_TURN.slice(0, 2) });
    const view = render(<MainPane workspaceId="ws-bar-idle" />, { wrapper: Wrapper });
    await waitFor(() => expect(shownPage(view)).toContain("<p>AAAA</p>"));
    const bar = view.getByTestId("agent-interface-status-bar");
    // The row's clock time, as the transcript shows it, not a relative time that goes stale.
    expect(within(bar).getByTestId("agent-interface-status-receipt").textContent).toMatch(
      /In transcript · \d{1,2}:\d\d\s[AP]M$/
    );
    const startHere = within(bar).getByRole("button", { name: "Start here" });
    expect(startHere.hasAttribute("disabled")).toBe(false);
    fireEvent.click(startHere);
    const dialog = await within(document.body).findByRole("dialog");
    expect(within(dialog).getByText("Start Here")).toBeTruthy();
    const ok = within(dialog).getByRole("button", { name: "OK" });
    expect(ok.hasAttribute("disabled")).toBe(false);

    // A queued send starts the next turn while the dialog is open: the boundary must not land
    // under it.
    updateSeededWorkspace("ws-bar-idle", { messages: MID_TURN, canInterrupt: true });
    expect(ok.hasAttribute("disabled")).toBe(true);
  });

  test("the transcript peek's shortcut opens and closes it, but not on a held chord or under a dialog", async () => {
    seedWorkspace("ws-bar-chord", { messages: MID_TURN.slice(0, 2) });
    const view = render(<MainPane workspaceId="ws-bar-chord" />, { wrapper: Wrapper });
    await waitFor(() => expect(shownPage(view)).toContain("<p>AAAA</p>"));
    const peekShown = () => view.queryByTestId("agent-interface-transcript-peek") != null;
    const { key, code } = KEYBINDS.TOGGLE_STATUS_TRANSCRIPT_PEEK;
    const chord = { key, code, ctrlKey: true, altKey: true, shiftKey: true };

    fireEvent.keyDown(window, chord);
    expect(peekShown()).toBe(true);
    fireEvent.keyDown(window, { ...chord, repeat: true });
    expect(peekShown()).toBe(true);
    fireEvent.keyDown(window, chord);
    expect(peekShown()).toBe(false);

    // An open dialog keeps its keystrokes.
    fireEvent.click(view.getByRole("button", { name: "Start here" }));
    await within(document.body).findByRole("dialog");
    fireEvent.keyDown(window, chord);
    expect(peekShown()).toBe(false);
  });
  test("before the first message the bar shows no receipt and Start here stays off", async () => {
    seedWorkspace("ws-bar-empty", {});
    const view = render(<MainPane workspaceId="ws-bar-empty" />, { wrapper: Wrapper });
    await waitFor(() => expect(shownPage(view)).toContain("<p>AAAA</p>"));
    const bar = view.getByTestId("agent-interface-status-bar");
    expect(within(bar).queryByTestId("agent-interface-status-receipt")).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "Show transcript" }));
    expect(view.getByTestId("agent-interface-transcript-peek").textContent).toContain(
      "No messages yet"
    );
    expect(within(bar).getByRole("button", { name: "Start here" }).hasAttribute("disabled")).toBe(
      true
    );
  });
});
