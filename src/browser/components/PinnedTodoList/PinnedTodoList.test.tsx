import { cleanup, fireEvent, render, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import {
  useWorkspaceStoreRaw as getWorkspaceStoreRaw,
  type WorkspaceState,
} from "@/browser/stores/WorkspaceStore";
import type { TodoItem } from "@/common/types/tools";
import { ChatActivityPanelsProvider } from "../ChatPane/chatActivityPanels";
import { PinnedTodoList } from "./PinnedTodoList";

interface MockWorkspaceState {
  todos: TodoItem[];
}

const workspaceStates = new Map<string, MockWorkspaceState>();
const workspaceSubscribers = new Map<string, Set<() => void>>();

function getWorkspaceSubscribers(workspaceId: string): Set<() => void> {
  let subscribers = workspaceSubscribers.get(workspaceId);
  if (!subscribers) {
    subscribers = new Set();
    workspaceSubscribers.set(workspaceId, subscribers);
  }
  return subscribers;
}

function buildWorkspaceState(workspaceId: string, state: MockWorkspaceState): WorkspaceState {
  return {
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
    todos: state.todos,
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
  };
}

function seedWorkspaceState(workspaceId: string, state: MockWorkspaceState): void {
  workspaceStates.set(workspaceId, state);
}

function subscribeKey(workspaceId: string, callback: () => void): () => void {
  const subscribers = getWorkspaceSubscribers(workspaceId);
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

function getMockWorkspaceState(workspaceId: string): WorkspaceState {
  const state = workspaceStates.get(workspaceId);
  if (!state) {
    throw new Error(`Missing mock workspace state for ${workspaceId}`);
  }

  return buildWorkspaceState(workspaceId, state);
}

const workspaceStore = getWorkspaceStoreRaw();
const originalSubscribeKey = workspaceStore.subscribeKey.bind(workspaceStore);
const originalGetWorkspaceState = workspaceStore.getWorkspaceState.bind(workspaceStore);

const defaultTodos: TodoItem[] = [
  { content: "Add tests", status: "in_progress" },
  { content: "Run typecheck", status: "pending" },
];

// Rendered where the app renders it: as a chip in the composer's live line.
function renderPinnedTodoList(workspaceId: string): RenderResult {
  return render(
    <ChatActivityPanelsProvider>
      <PinnedTodoList workspaceId={workspaceId} />
    </ChatActivityPanelsProvider>
  );
}

function getHeader(renderResult: RenderResult): HTMLElement {
  return renderResult.getByRole("button", { name: /^todo/i });
}

describe("PinnedTodoList", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalLocalStorage: typeof globalThis.localStorage;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    globalThis.localStorage.clear();
    workspaceStates.clear();
    workspaceSubscribers.clear();
    workspaceStore.subscribeKey = subscribeKey;
    workspaceStore.getWorkspaceState = getMockWorkspaceState;
  });

  afterEach(() => {
    cleanup();
    workspaceStore.subscribeKey = originalSubscribeKey;
    workspaceStore.getWorkspaceState = originalGetWorkspaceState;
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
    workspaceStates.clear();
    workspaceSubscribers.clear();
  });

  test("opens closed and names the in-progress step on its chip", () => {
    seedWorkspaceState("ws-closed", { todos: defaultTodos });

    const renderResult = renderPinnedTodoList("ws-closed");

    expect(getHeader(renderResult).textContent).toContain("Add tests");
    expect(renderResult.queryByText("Run typecheck")).toBeNull();
  });

  test("names the first pending step when nothing is in progress", () => {
    seedWorkspaceState("ws-pending", {
      todos: [
        { content: "Add tests", status: "completed" },
        { content: "Run typecheck", status: "pending" },
        { content: "Open PR", status: "pending" },
      ],
    });

    const renderResult = renderPinnedTodoList("ws-pending");

    expect(getHeader(renderResult).textContent).toContain("Run typecheck");
    expect(getHeader(renderResult).textContent).not.toContain("Open PR");
  });

  test("spins the HTML wrapper instead of the in-progress SVG", () => {
    seedWorkspaceState("ws-composited-spinner", { todos: defaultTodos });

    const renderResult = renderPinnedTodoList("ws-composited-spinner");
    fireEvent.click(getHeader(renderResult));
    const spinner = renderResult.container.querySelector(".animate-spin");
    const icon = spinner?.querySelector("svg");

    expect(spinner?.tagName).toBe("SPAN");
    expect(icon).toBeTruthy();
    expect(icon?.classList.contains("animate-spin")).toBe(false);
  });

  test("renders nothing when there are no todos", () => {
    seedWorkspaceState("ws-empty", { todos: [] });

    const renderResult = renderPinnedTodoList("ws-empty");

    expect(renderResult.container.querySelector("[data-activity-chip]")).toBeNull();
  });

  test("the chip opens and closes the list", () => {
    seedWorkspaceState("ws-toggle", { todos: defaultTodos });

    const renderResult = renderPinnedTodoList("ws-toggle");

    fireEvent.click(getHeader(renderResult));
    expect(renderResult.getByText("Run typecheck")).toBeTruthy();

    fireEvent.click(getHeader(renderResult));
    expect(renderResult.queryByText("Run typecheck")).toBeNull();
  });
});
