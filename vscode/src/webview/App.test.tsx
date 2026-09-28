import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { installDom } from "../../../tests/ui/dom";
import { readPersistedState, updatePersistedState } from "xum/browser/hooks/usePersistedState";
import {
  BASH_COLLAPSED_SUMMARY_MODE_KEY,
  GLOBAL_SCOPE_ID,
  getAgentIdKey,
  getModelKey,
  getThinkingLevelKey,
} from "xum/common/constants/storage";
import { resetAiSelectionIntentForTests } from "xum/browser/utils/aiSelectionIntent";
import { formatModelDisplayName } from "xum/common/utils/ai/modelDisplay";
import { getAppConfigStore } from "xum/browser/stores/AppConfigStore";
import { getProvidersConfigStore } from "xum/browser/stores/ProvidersConfigStore";
import { createMuxMessage, type MuxMetadata } from "xum/common/types/message";
import { formatAgentMessageEnvelope } from "xum/common/utils/agentMessageEnvelope";
import { App } from "./App";
import type { UiWorkspace, WebviewToExtensionMessage } from "./protocol";
import type { VscodeBridge } from "./vscodeBridge";

function createBridge(): VscodeBridge {
  return {
    traceId: "test",
    startedAtMs: 0,
    postMessage: mock(() => undefined),
    onMessage: () => () => undefined,
    debugLog: () => undefined,
  };
}

// Records what the webview posts to the extension host and lets a test play the host's side.
class TestBridge implements VscodeBridge {
  traceId = "test";
  startedAtMs = 0;
  readonly sent: WebviewToExtensionMessage[] = [];
  private readonly listeners = new Set<(data: unknown) => void>();

  postMessage(payload: WebviewToExtensionMessage): void {
    this.sent.push(payload);
  }

  onMessage(handler: (data: unknown) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  debugLog(): void {
    // Not needed by these tests.
  }

  async emit(data: unknown): Promise<void> {
    await act(async () => {
      for (const listener of this.listeners) {
        listener(data);
      }
      await Promise.resolve();
    });
  }

  // Plays the host answering every call of `path` so far with `value`.
  async answer(path: string, value: unknown): Promise<void> {
    for (const call of this.orpcCalls(path)) {
      await this.emit({ type: "orpcResponse", requestId: call.requestId, ok: true, kind: "value", value });
    }
  }

  orpcCalls(path: string): Array<Extract<WebviewToExtensionMessage, { type: "orpcCall" }>> {
    return this.sent.filter(
      (message): message is Extract<WebviewToExtensionMessage, { type: "orpcCall" }> =>
        message.type === "orpcCall" && message.path.join(".") === path
    );
  }
}

const WORKSPACE: UiWorkspace = {
  id: "ws-1",
  projectName: "xum",
  workspaceName: "webview-fix",
  projectPath: "/home/alice/xum",
  streaming: false,
  runtimeType: "worktree",
  createdAt: "2026-09-26T00:00:00.000Z",
};

// ProvidersConfigStore is an app-wide singleton with no reset. A test that loads a providers config
// clears it through the still-mounted app (refetch answered with null) so later tests start without
// one.
async function clearProvidersConfig(bridge: TestBridge): Promise<void> {
  const refreshed = getProvidersConfigStore().refresh();
  await bridge.answer("providers.getConfig", null);
  await refreshed;
}

async function selectWorkspace(bridge: TestBridge, history: unknown[] = []): Promise<void> {
  await bridge.emit({ type: "connectionStatus", status: { mode: "api", baseUrl: "http://x" } });
  await bridge.emit({ type: "workspaces", workspaces: [WORKSPACE] });
  await bridge.emit({ type: "setSelectedWorkspace", workspaceId: WORKSPACE.id });
  for (const event of history) {
    await bridge.emit({ type: "chatEvent", workspaceId: WORKSPACE.id, event });
  }
  await bridge.emit({ type: "chatEvent", workspaceId: WORKSPACE.id, event: { type: "caught-up" } });
}

function toolMessage(
  id: string,
  sequence: number,
  toolName: string,
  input: unknown,
  output: unknown
) {
  return {
    type: "message",
    id,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolCallId: `${id}-call`,
        toolName,
        state: "output-available",
        input,
        output,
      },
    ],
    metadata: { historySequence: sequence, timestamp: sequence },
  };
}

// happy-dom does not route fireEvent.change through React's controlled-input tracking, so call
// the textarea's React onChange directly (same workaround as SshPromptDialog.test.tsx).
async function typeInto(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps"));
  if (!propsKey) throw new Error("textarea does not expose React props");
  const props = (textarea as unknown as Record<string, { onChange?: (event: unknown) => void }>)[
    propsKey
  ];
  if (!props.onChange) throw new Error("textarea has no onChange handler");
  await act(async () => {
    props.onChange?.({ target: { value }, currentTarget: { value } });
    await Promise.resolve();
  });
}

// Same happy-dom limitation as typeInto: fireEvent.keyDown reaches the textarea's native listeners
// but not React's, so call the textarea's React onKeyDown with a minimal keyboard event.
async function pressKey(
  textarea: HTMLTextAreaElement,
  init: { key: string; ctrlKey?: boolean; altKey?: boolean }
): Promise<void> {
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps"));
  if (!propsKey) throw new Error("textarea does not expose React props");
  const props = (textarea as unknown as Record<string, { onKeyDown?: (event: unknown) => void }>)[
    propsKey
  ];
  if (!props.onKeyDown) throw new Error("textarea has no onKeyDown handler");
  let defaultPrevented = false;
  await act(async () => {
    props.onKeyDown?.({
      key: init.key,
      code: "",
      ctrlKey: init.ctrlKey ?? false,
      altKey: init.altKey ?? false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      get defaultPrevented() {
        return defaultPrevented;
      },
      preventDefault: () => {
        defaultPrevented = true;
      },
      stopPropagation: () => undefined,
      nativeEvent: { stopImmediatePropagation: () => undefined },
    });
    await Promise.resolve();
  });
}

// Pins a scrollable geometry on the transcript scrollport; happy-dom has no layout, so every
// element otherwise reports 0 heights and always reads as "at the bottom".
function setScrollGeometry(element: HTMLElement, geometry: { scrollTop: number }) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 200 });
  element.scrollTop = geometry.scrollTop;
}

const AGENT_DESCRIPTORS = [
  { id: "exec", scope: "built-in", name: "Exec", uiSelectable: true, subagentRunnable: true },
  { id: "plan", scope: "built-in", name: "Plan", uiSelectable: true, subagentRunnable: false },
];

function agentPicker(view: ReturnType<typeof render>): HTMLButtonElement {
  return view.getByRole("button", { name: "Select agent" }) as HTMLButtonElement;
}

// Switches the agent through the composer's agent picker (needs agents.list answered).
async function pickAgent(view: ReturnType<typeof render>, agentId: string): Promise<void> {
  await act(async () => {
    fireEvent.click(agentPicker(view));
    await Promise.resolve();
  });
  const option = view.container.querySelector(
    `[data-testid="agent-option"][data-agent-id="${agentId}"]`
  );
  if (!option) throw new Error(`agent picker has no ${agentId} option`);
  await act(async () => {
    fireEvent.click(option);
    await Promise.resolve();
  });
}

describe("vscode webview transcript auto-scroll", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("uses the bottom sentinel as the only scroll anchor while locked, and releases it on user scroll", async () => {
    const view = render(<App bridge={createBridge()} />);

    const sentinel = view.getByTestId("transcript-bottom-sentinel");
    const scrollport = sentinel.parentElement;
    if (!scrollport) throw new Error("sentinel must live inside the transcript scrollport");
    const content = scrollport.firstElementChild as HTMLElement | null;
    if (!content || content === sentinel)
      throw new Error("transcript content must precede the sentinel");

    // The sentinel is the scrollport's last child, so rows append above it and native scroll
    // anchoring keeps it (the bottom) pinned.
    expect(scrollport.lastElementChild).toBe(sentinel);
    expect(sentinel.style.overflowAnchor).toBe("auto");
    // Locked at the bottom: transcript content opts out so the sentinel is the only anchor.
    expect(content.style.overflowAnchor).toBe("none");

    // A user wheel followed by a scroll away from the bottom releases the lock...
    setScrollGeometry(scrollport, { scrollTop: 800 });
    await act(async () => {
      fireEvent.scroll(scrollport);
      fireEvent.wheel(scrollport, { deltaY: -120 });
      setScrollGeometry(scrollport, { scrollTop: 300 });
      fireEvent.scroll(scrollport);
      await Promise.resolve();
    });

    // ...so rows become anchor candidates again and the reading position is preserved.
    expect(content.style.overflowAnchor).toBe("");
    expect(sentinel.style.overflowAnchor).toBe("auto");
  });
});

describe("vscode webview workspace selection", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("selecting a workspace renders the composer, and Send posts workspace.sendMessage through the bridge", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge);

    const textarea = view.container.querySelector("textarea");
    if (!textarea) throw new Error("composer textarea did not render");
    await typeInto(textarea, "hello from the webview");

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send message" }));
      await Promise.resolve();
    });

    const sends = bridge.orpcCalls("workspace.sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0].input).toMatchObject({
      workspaceId: WORKSPACE.id,
      message: "hello from the webview",
    });

    await bridge.emit({
      type: "orpcResponse",
      requestId: sends[0].requestId,
      ok: true,
      kind: "value",
      value: { success: true, data: undefined },
    });
    expect(view.container.textContent).not.toContain("Failed to send");
  });

  test("selecting a workspace whose history has bash and propose_plan calls and a stream error renders the transcript", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge, [
      toolMessage(
        "m1",
        1,
        "bash",
        { script: "echo webview", timeout_secs: 5, display_name: "Webview probe" },
        { success: true, output: "webview", exitCode: 0, wall_duration_ms: 3 }
      ),
      // Current-format plan results omit planContent; only the latest plan fetches it from disk.
      toolMessage("m2", 2, "propose_plan", {}, { success: true, planPath: "/home/alice/old.md" }),
      toolMessage("m3", 3, "propose_plan", {}, { success: true, planPath: "/home/alice/plan.md" }),
      // A persisted failed turn renders through StreamErrorMessage.
      {
        type: "message",
        id: "m4",
        role: "assistant",
        parts: [],
        metadata: {
          historySequence: 4,
          timestamp: 4,
          error: "provider exploded",
          errorType: "unknown",
        },
      },
    ]);

    expect(view.container.textContent).toContain("echo webview");
    expect(view.container.textContent).toContain("provider exploded");

    const planFetches = bridge.orpcCalls("workspace.getPlanContent");
    expect(planFetches).toHaveLength(1);
    await bridge.emit({
      type: "orpcResponse",
      requestId: planFetches[0].requestId,
      ok: true,
      kind: "value",
      value: { success: true, data: { content: "# Webview plan", path: "/home/alice/plan.md" } },
    });
    expect(view.container.textContent).toContain("Webview plan");
  });

  test("a running bash card shows live output from bash-output events (#4750)", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge);

    const chat = (event: Record<string, unknown>) =>
      bridge.emit({
        type: "chatEvent",
        workspaceId: WORKSPACE.id,
        event: { workspaceId: WORKSPACE.id, ...event },
      });
    await chat({
      type: "stream-start",
      messageId: "a1",
      model: "anthropic:claude-sonnet-4-5",
      historySequence: 1,
      startTime: 1,
    });
    await chat({
      type: "tool-call-start",
      messageId: "a1",
      toolCallId: "call-1",
      toolName: "bash",
      args: { script: "make build", timeout_secs: 60, display_name: "Build" },
      tokens: 1,
      timestamp: 2,
    });
    // Live output renders inside the expanded card.
    await act(async () => {
      fireEvent.click(view.getByText("make build"));
      await Promise.resolve();
    });
    await chat({
      type: "bash-output",
      toolCallId: "call-1",
      text: "compiling step one\n",
      isError: false,
      timestamp: 3,
    });
    await chat({
      type: "bash-output",
      toolCallId: "call-1",
      text: "warning: slow disk\n",
      isError: true,
      timestamp: 4,
    });

    expect(view.container.textContent).toContain("compiling step one");
    expect(view.container.textContent).toContain("warning: slow disk");

    // A resubscription (chatReset + replay) must not show the previous feed's live output.
    await bridge.emit({ type: "chatReset", workspaceId: WORKSPACE.id });
    await bridge.emit({
      type: "chatEvent",
      workspaceId: WORKSPACE.id,
      event: { type: "caught-up" },
    });
    await chat({
      type: "stream-start",
      messageId: "a1",
      model: "anthropic:claude-sonnet-4-5",
      historySequence: 1,
      startTime: 1,
    });
    await chat({
      type: "tool-call-start",
      messageId: "a1",
      toolCallId: "call-1",
      toolName: "bash",
      args: { script: "make build", timeout_secs: 60, display_name: "Build" },
      tokens: 1,
      timestamp: 2,
    });
    await chat({
      type: "bash-output",
      toolCallId: "call-1",
      text: "fresh line\n",
      isError: false,
      timestamp: 5,
    });
    // Expand the new card if the expansion preference did not carry over.
    if (!view.container.textContent?.includes("fresh line")) {
      await act(async () => {
        fireEvent.click(view.getByText("make build"));
        await Promise.resolve();
      });
    }
    expect(view.container.textContent).toContain("fresh line");
    expect(view.container.textContent).not.toContain("compiling step one");
  });

  test("reselecting the current workspace keeps the transcript; selecting another clears it (#4949)", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge, [
      toolMessage(
        "m1",
        1,
        "bash",
        { script: "echo kept", timeout_secs: 5, display_name: "Probe" },
        { success: true, output: "kept", exitCode: 0, wall_duration_ms: 3 }
      ),
    ]);
    const textarea = () => view.container.querySelector("textarea");
    expect(view.container.textContent).toContain("echo kept");
    expect(textarea()?.disabled).toBe(false);

    // Clicking the selected row: the host re-posts the same selection, but its live
    // subscription sends no chatReset or replay, so nothing would refill a cleared transcript.
    await bridge.emit({ type: "setSelectedWorkspace", workspaceId: WORKSPACE.id });
    expect(view.container.textContent).toContain("echo kept");
    expect(textarea()?.disabled).toBe(false);

    const other: UiWorkspace = { ...WORKSPACE, id: "ws-2", workspaceName: "other" };
    await bridge.emit({ type: "workspaces", workspaces: [WORKSPACE, other] });
    await bridge.emit({ type: "setSelectedWorkspace", workspaceId: other.id });
    expect(view.container.textContent).not.toContain("echo kept");
  });

  test("keeps the composer disabled until the history replay catches up", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await bridge.emit({ type: "connectionStatus", status: { mode: "api", baseUrl: "http://x" } });
    await bridge.emit({ type: "workspaces", workspaces: [WORKSPACE] });
    await bridge.emit({ type: "setSelectedWorkspace", workspaceId: WORKSPACE.id });

    // Sending before the transcript is complete would act on partial context.
    const textarea = view.container.querySelector("textarea");
    if (!textarea) throw new Error("composer textarea did not render");
    expect(textarea.disabled).toBe(true);

    await bridge.emit({
      type: "chatEvent",
      workspaceId: WORKSPACE.id,
      event: { type: "caught-up" },
    });
    expect(view.container.querySelector("textarea")?.disabled).toBe(false);
  });
});

// #4971: the webview renders the desktop turn-status barrier and jump-to-bottom pill.
describe("vscode webview turn status and jump to bottom (#4971)", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  const startStream = (bridge: TestBridge) =>
    bridge.emit({
      type: "chatEvent",
      workspaceId: WORKSPACE.id,
      event: {
        type: "stream-start",
        workspaceId: WORKSPACE.id,
        messageId: "a1",
        model: "anthropic:claude-sonnet-4-5",
        historySequence: 1,
        startTime: 1,
      },
    });

  // Stop and Esc share one interrupt path; both must reach the host and mark the stream.
  const interruptTriggers: Array<[string, (view: ReturnType<typeof render>) => void]> = [
    ["Stop", (view) => fireEvent.click(view.getByRole("button", { name: "Stop streaming" }))],
    ["Esc", () => fireEvent.keyDown(window, { key: "Escape" })],
    [
      "Esc in the composer",
      (view) => {
        const textarea = view.container.querySelector("textarea");
        if (!textarea) throw new Error("composer textarea did not render");
        fireEvent.keyDown(textarea, { key: "Escape" });
      },
    ],
  ];
  for (const [name, trigger] of interruptTriggers) {
    test(`${name} interrupts the stream through the host and shows interrupting`, async () => {
      const bridge = new TestBridge();
      const view = render(<App bridge={bridge} />);
      await selectWorkspace(bridge);
      await startStream(bridge);

      await act(async () => {
        trigger(view);
        await Promise.resolve();
      });

      const calls = bridge.orpcCalls("workspace.interruptStream");
      expect(calls).toHaveLength(1);
      // User-Stop semantics, as desktop stopStream sends them.
      expect(calls[0].input).toEqual({
        workspaceId: WORKSPACE.id,
        options: { disableAutoRetry: true, retireBashMonitorAttention: true },
      });
      expect(view.container.textContent).toContain("interrupting...");

      // A Stop the backend refused is reported, not shown as success.
      await bridge.answer("workspace.interruptStream", { success: false, error: "stop refused" });
      expect(view.container.textContent).toContain("Failed to interrupt stream. (stop refused)");
    });
  }

  test("Esc in a text field outside the composer does not interrupt", async () => {
    const bridge = new TestBridge();
    render(<App bridge={bridge} />);
    await selectWorkspace(bridge);
    await startStream(bridge);
    const input = document.createElement("input");
    document.body.appendChild(input);

    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
      await Promise.resolve();
    });

    expect(bridge.orpcCalls("workspace.interruptStream")).toHaveLength(0);
    input.remove();
  });

  test("Esc stops a turn that is still starting, like its Stop button", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge);
    await bridge.emit({
      type: "chatEvent",
      workspaceId: WORKSPACE.id,
      event: {
        type: "stream-lifecycle",
        workspaceId: WORKSPACE.id,
        phase: "preparing",
        hadAnyOutput: false,
      },
    });
    expect(view.getByRole("button", { name: "Stop streaming" })).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
      await Promise.resolve();
    });

    expect(bridge.orpcCalls("workspace.interruptStream")).toHaveLength(1);
  });

  test("an armed monitor with no stream shows the waiting status until it disarms or the workspace changes", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge);
    const waiting = "Waiting on background bash monitor...";
    const activity = (workspaceId: string, activeBashMonitorCount: number) =>
      bridge.emit({ type: "workspaceActivity", workspaceId, activeBashMonitorCount });

    await activity(WORKSPACE.id, 1);
    expect(view.container.textContent).toContain(waiting);
    expect(view.queryByRole("button", { name: "Stop streaming" })).toBeNull();

    // A resubscribe to the same workspace keeps the count until the host sends a new one.
    await bridge.emit({ type: "chatReset", workspaceId: WORKSPACE.id });
    await bridge.emit({ type: "chatEvent", workspaceId: WORKSPACE.id, event: { type: "caught-up" } });
    expect(view.container.textContent).toContain(waiting);

    await activity(WORKSPACE.id, 0);
    expect(view.container.textContent).not.toContain(waiting);

    // A count left from the previous workspace must not show on the next one.
    await activity(WORKSPACE.id, 1);
    const other: UiWorkspace = { ...WORKSPACE, id: "ws-2", workspaceName: "other" };
    await bridge.emit({ type: "workspaces", workspaces: [WORKSPACE, other] });
    await bridge.emit({ type: "setSelectedWorkspace", workspaceId: other.id });
    await bridge.emit({ type: "chatReset", workspaceId: other.id });
    await bridge.emit({ type: "chatEvent", workspaceId: other.id, event: { type: "caught-up" } });
    expect(view.container.textContent).not.toContain(waiting);
    // Late activity for the old workspace is ignored.
    await activity(WORKSPACE.id, 1);
    expect(view.container.textContent).not.toContain(waiting);
  });

  test("scrolling up shows Jump to bottom; the pill and Shift+G return to the bottom, typing Shift+G does not", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge);

    const sentinel = view.getByTestId("transcript-bottom-sentinel");
    const scrollport = sentinel.parentElement as HTMLElement;
    const content = scrollport.firstElementChild as HTMLElement;
    const scrollUp = () =>
      act(async () => {
        setScrollGeometry(scrollport, { scrollTop: 800 });
        fireEvent.scroll(scrollport);
        fireEvent.wheel(scrollport, { deltaY: -120 });
        setScrollGeometry(scrollport, { scrollTop: 300 });
        fireEvent.scroll(scrollport);
        await Promise.resolve();
      });
    const pressShiftG = (target: Element) =>
      act(async () => {
        fireEvent.keyDown(target, { key: "G", shiftKey: true });
        await Promise.resolve();
      });

    expect(view.queryByRole("button", { name: /Jump to bottom/ })).toBeNull();

    await scrollUp();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /Jump to bottom/ }));
      await Promise.resolve();
    });
    expect(content.style.overflowAnchor).toBe("none");
    expect(view.queryByRole("button", { name: /Jump to bottom/ })).toBeNull();

    await scrollUp();
    const textarea = view.container.querySelector("textarea");
    if (!textarea) throw new Error("composer textarea did not render");
    await pressShiftG(textarea);
    expect(view.queryByRole("button", { name: /Jump to bottom/ })).not.toBeNull();

    await pressShiftG(document.body);
    expect(content.style.overflowAnchor).toBe("none");
    expect(view.queryByRole("button", { name: /Jump to bottom/ })).toBeNull();
  });
});

// #4755: the webview never loads the workspace's AI settings, so a send must not persist its local
// defaults onto the workspace.
describe("vscode webview held inputs (#4771)", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  const held = (id: string, displayText: string) => ({
    id,
    reason: "interrupted",
    displayText,
    attachmentCount: 0,
    reviewCount: 0,
  });
  const heldInputsChanged = (heldInputs: unknown[]) => ({
    type: "chatEvent",
    workspaceId: WORKSPACE.id,
    event: { type: "held-inputs-changed", workspaceId: WORKSPACE.id, heldInputs },
  });

  test("shows held inputs with Send and Discard, and never takes a restore on its own", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge);

    // A Stop returns the queued input; the webview has no restore handling, so it must leave the
    // backend's held copy alone (no discardHeldInput ack) and show that copy instead.
    await bridge.emit({
      type: "chatEvent",
      workspaceId: WORKSPACE.id,
      event: {
        type: "restore-to-input",
        workspaceId: WORKSPACE.id,
        text: "run the migration",
        heldInputIds: ["held-1"],
      },
    });
    await bridge.emit(
      heldInputsChanged([held("held-1", "run the migration"), held("held-2", "then deploy")])
    );

    expect(view.container.textContent).toContain("run the migration");
    expect(view.container.textContent).toContain("then deploy");
    expect(bridge.orpcCalls("workspace.discardHeldInput")).toHaveLength(0);

    const sendButtons = view.getAllByRole("button", { name: /^Send/ });
    await act(async () => {
      fireEvent.click(sendButtons[0]);
      await Promise.resolve();
    });
    expect(bridge.orpcCalls("workspace.sendHeldInput").map((call) => call.input)).toEqual([
      { workspaceId: WORKSPACE.id, heldInputId: "held-1" },
    ]);

    const discardButtons = view.getAllByRole("button", { name: /^Discard/ });
    await act(async () => {
      fireEvent.click(discardButtons[1]);
      await Promise.resolve();
    });
    expect(bridge.orpcCalls("workspace.discardHeldInput").map((call) => call.input)).toEqual([
      { workspaceId: WORKSPACE.id, heldInputId: "held-2" },
    ]);

    // The backend's next list is authoritative.
    await bridge.emit(heldInputsChanged([]));
    expect(view.container.textContent).not.toContain("run the migration");
  });

  test("the held-input shortcuts act on the oldest held input from an empty composer", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge);
    await bridge.emit(heldInputsChanged([held("held-1", "first"), held("held-2", "second")]));

    const textarea = view.container.querySelector("textarea");
    if (!textarea) throw new Error("composer textarea did not render");
    await pressKey(textarea, { key: "Backspace", ctrlKey: true, altKey: true });
    expect(bridge.orpcCalls("workspace.discardHeldInput").map((call) => call.input)).toEqual([
      { workspaceId: WORKSPACE.id, heldInputId: "held-1" },
    ]);
  });

  test("clears held inputs when another workspace is selected, and keeps them on a reselect", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge);
    await bridge.emit(heldInputsChanged([held("held-1", "left behind")]));
    expect(view.container.textContent).toContain("left behind");

    // Clicking the selected row makes the host re-send the same selection without a new
    // subscription, so no held-inputs snapshot follows; the banner must stay.
    await bridge.emit({ type: "setSelectedWorkspace", workspaceId: WORKSPACE.id });
    expect(view.container.textContent).toContain("left behind");

    const other: UiWorkspace = { ...WORKSPACE, id: "ws-2", workspaceName: "other" };
    await bridge.emit({ type: "workspaces", workspaces: [WORKSPACE, other] });
    await bridge.emit({ type: "setSelectedWorkspace", workspaceId: other.id });
    expect(view.container.textContent).not.toContain("left behind");
  });
});

// #4942: the latest plan's actions gate on the transcript barrier. The webview provides its own
// barrier (it never registers in WorkspaceStore) and cannot replace chat history.
describe("vscode webview plan actions (#4942)", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  const planHistory = [
    toolMessage("m1", 1, "propose_plan", {}, { success: true, planPath: "/home/alice/plan.md" }),
  ];
  const implementButton = (view: ReturnType<typeof render>) =>
    view.getByRole("button", { name: /Implement/ }) as HTMLButtonElement;

  test("enables Implement once the replay caught up and sends it without replacing history", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge, planHistory);

    // Start Here always replaces chat history, which the webview cannot do.
    expect(view.queryByRole("button", { name: /Start Here/ })).toBeNull();
    expect(implementButton(view).disabled).toBe(false);

    await act(async () => {
      fireEvent.click(implementButton(view));
      await Promise.resolve();
    });
    // The webview's projected config carries no replace setting here.
    await bridge.answer("config.getConfig", {});
    const sends = bridge.orpcCalls("workspace.sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0].input).toMatchObject({
      workspaceId: WORKSPACE.id,
      message: "Implement the plan",
      options: { agentId: "exec" },
    });
    expect(bridge.orpcCalls("workspace.replaceChatHistory")).toHaveLength(0);
  });

  test("disables Implement when the server connection drops", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge, planHistory);
    expect(implementButton(view).disabled).toBe(false);

    await bridge.emit({ type: "connectionStatus", status: { mode: "file", error: "offline" } });
    expect(implementButton(view).disabled).toBe(true);
  });

  test("keeps Implement disabled after a forced catch-up showed a partial transcript", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    // More history than the replay buffer holds forces a catch-up before caught-up arrives.
    const filler = Array.from({ length: 500 }, (_, index) => ({
      type: "message",
      id: `u${index}`,
      role: "user",
      parts: [{ type: "text", text: `filler ${index}` }],
      metadata: { historySequence: index + 1, timestamp: index + 1 },
    }));
    await selectWorkspace(bridge, [
      ...filler,
      toolMessage("m1", 501, "propose_plan", {}, { success: true, planPath: "/home/alice/plan.md" }),
    ]);

    expect(view.container.textContent).toContain("did not finish loading");
    expect(implementButton(view).disabled).toBe(true);
  });

  test("keeps Implement disabled when the user's setting says it replaces chat history", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge, planHistory);
    await bridge.answer("config.getConfig", {
      taskSettings: { proposePlanImplementReplacesChatHistory: true },
    });

    expect(implementButton(view).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(implementButton(view));
      await Promise.resolve();
    });
    expect(bridge.orpcCalls("workspace.sendMessage")).toHaveLength(0);

    // Turning the setting off while the card is mounted re-enables it (config change refresh).
    // This also clears the app-wide AppConfigStore singleton for later tests.
    const refreshed = getAppConfigStore().refresh();
    await bridge.answer("config.getConfig", {});
    await refreshed;
    expect(implementButton(view).disabled).toBe(false);
  });
});

describe("vscode webview backend preferences (#4972, #4962)", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    resetAiSelectionIntentForTests();
  });

  afterEach(() => {
    cleanup();
    // The store is an app-wide singleton; drop what a test loaded so later tests start clean.
    getAppConfigStore().updateOptimistically({
      bashCollapsedSummaryMode: undefined,
      transcriptDensity: undefined,
      agentAiDefaults: undefined,
    });
    cleanupDom?.();
    cleanupDom = null;
  });

  test("bash headers follow the user's collapsed-summary mode once config arrives", async () => {
    const script = "ls -la && git log --oneline -3";
    // Left over from an earlier webview session; it must not apply before this server's config.
    updatePersistedState(BASH_COLLAPSED_SUMMARY_MODE_KEY, "intent");
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge, [
      toolMessage(
        "m1",
        1,
        "bash",
        {
          script,
          timeout_secs: 10,
          display_name: "List files",
          model_intent: "List the repository files",
        },
        { success: true, output: "ok", exitCode: 0, wall_duration_ms: 5 }
      ),
    ]);

    // Default mode: the intent above the command.
    expect(view.getByText("List the repository files")).toBeDefined();
    expect(view.queryByText(script)).not.toBeNull();

    await bridge.answer("config.getConfig", {
      userPreferences: { appearance: { bashCollapsedSummaryMode: "intent" } },
    });
    expect(view.getByText("List the repository files")).toBeDefined();
    expect(view.queryByText(script)).toBeNull();

    // Another server's preferences are unknown until its config loads: back to the default mode,
    // not the previous server's.
    await bridge.emit({ type: "connectionStatus", status: { mode: "api", baseUrl: "http://y" } });
    expect(view.queryByText(script)).not.toBeNull();
  });

  test("hyper transcript density collapses a finished turn's work into a work bundle (#4979)", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge, [
      {
        type: "message",
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Audit the auth module" }],
        metadata: { historySequence: 1, timestamp: 0 },
      },
      {
        type: "message",
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "I'll gather context first." },
          ...[
            ["b1", "grep -rn verify src/auth.ts"],
            ["b2", "make typecheck"],
          ].map(([id, script]) => ({
            type: "dynamic-tool",
            toolCallId: id,
            toolName: "bash",
            state: "output-available",
            input: { script, timeout_secs: 10, display_name: id },
            output: { success: true, output: "ok", exitCode: 0, wall_duration_ms: 5 },
          })),
          { type: "text", text: "Implemented the auth audit fix." },
        ],
        metadata: { historySequence: 2, timestamp: 1_000 },
      },
    ]);
    await bridge.answer("config.getConfig", {
      userPreferences: { appearance: { transcriptDensity: "hyper" } },
    });

    const toggle = view.getByTestId("work-bundle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByText("Audit the auth module")).not.toBeNull();
    expect(view.queryByText("Implemented the auth audit fix.")).not.toBeNull();
    expect(view.queryByText("make typecheck")).toBeNull();
    expect(view.queryByText("I'll gather context first.")).toBeNull();

    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(view.queryByText("I'll gather context first.")).not.toBeNull();
    // Hyper density also groups the expanded bundle's tool rows, as on desktop.
    expect(view.getByTestId("operational-bundle").textContent).toContain("2 shell commands");
  });

  test("consecutive task_await polls collapse into one operational bundle in the default density (#4979)", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(
      bridge,
      ["await-1", "await-2"].map((id, index) =>
        toolMessage(
          id,
          index + 1,
          "task_await",
          { task_ids: ["task-1"], timeout_secs: 30 },
          { results: [{ status: "running", taskId: "task-1" }] }
        )
      )
    );

    const bundles = view.getAllByTestId("operational-bundle");
    expect(bundles).toHaveLength(1);
    expect(bundles[0].textContent).toContain("Checked task status 2 times");
    const toggle = bundles[0].querySelector("button");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryAllByText("Still waiting for 1 task")).toHaveLength(0);

    await act(async () => {
      fireEvent.click(toggle!);
      await Promise.resolve();
    });
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(view.queryAllByText("Still waiting for 1 task")).toHaveLength(2);
  });

  test("Implement uses the configured Exec default when the workspace has no Exec settings", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await bridge.emit({ type: "connectionStatus", status: { mode: "api", baseUrl: "http://x" } });
    await bridge.emit({
      type: "workspaces",
      workspaces: [
        {
          ...WORKSPACE,
          ai: {
            agentId: "plan",
            aiSettingsByAgent: { plan: { model: "openai:gpt-5.6-terra", thinkingLevel: "high" } },
          },
        },
      ],
    });
    await bridge.emit({ type: "setSelectedWorkspace", workspaceId: WORKSPACE.id });
    await bridge.emit({
      type: "chatEvent",
      workspaceId: WORKSPACE.id,
      event: toolMessage(
        "m1",
        1,
        "propose_plan",
        {},
        { success: true, planPath: "/home/alice/plan.md" }
      ),
    });
    await bridge.emit({
      type: "chatEvent",
      workspaceId: WORKSPACE.id,
      event: { type: "caught-up" },
    });
    await bridge.answer("config.getConfig", {
      agentAiDefaults: { exec: { modelString: "anthropic:claude-opus-5-5", thinkingLevel: "low" } },
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /Implement/ }));
      await Promise.resolve();
    });
    await bridge.answer("config.getConfig", {
      agentAiDefaults: { exec: { modelString: "anthropic:claude-opus-5-5", thinkingLevel: "low" } },
    });
    const sends = bridge.orpcCalls("workspace.sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0].input).toMatchObject({
      options: { agentId: "exec", model: "anthropic:claude-opus-5-5", thinkingLevel: "low" },
    });
  });
});

describe("vscode webview AI settings persistence", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  async function renderSelected(): Promise<{
    bridge: TestBridge;
    view: ReturnType<typeof render>;
  }> {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge);
    return { bridge, view };
  }

  function composerTextarea(view: ReturnType<typeof render>): HTMLTextAreaElement {
    const textarea = view.container.querySelector("textarea");
    if (!textarea) throw new Error("composer textarea did not render");
    return textarea;
  }

  async function sendMessage(
    bridge: TestBridge,
    view: ReturnType<typeof render>
  ): Promise<Record<string, unknown>> {
    await typeInto(composerTextarea(view), "hello");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send message" }));
      await Promise.resolve();
    });
    const sends = bridge.orpcCalls("workspace.sendMessage");
    expect(sends).toHaveLength(1);
    const input = sends[0].input as { options?: Record<string, unknown> };
    if (!input.options) throw new Error("sendMessage carried no options");
    return input.options;
  }

  test("sends without persisting AI settings onto the workspace", async () => {
    const { bridge, view } = await renderSelected();
    const options = await sendMessage(bridge, view);
    expect(options.skipAiSettingsPersistence).toBe(true);
  });

  test("sends the selected thinking level without raising it to a client-side floor", async () => {
    // The webview only knows built-in minimum levels, not the user's configured ones, so it must
    // not clamp; the backend applies the authoritative floor to the turn.
    // "low" is below the default model's built-in minimum (medium), so a client-side clamp would
    // raise it; it is also not the default, so the test proves the stored choice is what is sent.
    updatePersistedState(getThinkingLevelKey(WORKSPACE.id), "low");
    const { bridge, view } = await renderSelected();
    const options = await sendMessage(bridge, view);
    expect(options.thinkingLevel).toBe("low");
  });
});

// #4738: the extension sends each workspace's AI settings, so the webview uses (and may persist)
// the workspace's real settings and honors the sub-agent agent lock.
describe("vscode webview workspace AI settings", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    // Picks are recorded in a module-level map; start each test without earlier tests' picks.
    resetAiSelectionIntentForTests();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  async function selectWorkspaceWith(workspace: UiWorkspace) {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await bridge.emit({ type: "connectionStatus", status: { mode: "api", baseUrl: "http://x" } });
    await bridge.emit({ type: "workspaces", workspaces: [workspace] });
    await bridge.emit({ type: "setSelectedWorkspace", workspaceId: workspace.id });
    await bridge.emit({
      type: "chatEvent",
      workspaceId: workspace.id,
      event: { type: "caught-up" },
    });
    return { bridge, view };
  }

  async function send(bridge: TestBridge, view: ReturnType<typeof render>) {
    const textarea = view.container.querySelector("textarea");
    if (!textarea) throw new Error("composer textarea did not render");
    await typeInto(textarea, "hello");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send message" }));
      await Promise.resolve();
    });
    const sends = bridge.orpcCalls("workspace.sendMessage");
    expect(sends).toHaveLength(1);
    const input = sends[0].input as { options?: Record<string, unknown> };
    if (!input.options) throw new Error("sendMessage carried no options");
    return input.options;
  }

  test("uses the workspace's own agent, model and thinking level", async () => {
    const { bridge, view } = await selectWorkspaceWith({
      ...WORKSPACE,
      ai: {
        agentId: "plan",
        aiSettingsByAgent: {
          plan: { model: "openai:gpt-5.6-terra", thinkingLevel: "high" },
          exec: { model: "anthropic:claude-opus-5-5", thinkingLevel: "medium" },
        },
      },
    });

    expect(agentPicker(view).textContent).toBe("Plan");
    const options = await send(bridge, view);
    expect(options).toMatchObject({
      agentId: "plan",
      model: "openai:gpt-5.6-terra",
      thinkingLevel: "high",
    });
    // Persisting from the webview stays off even with known settings (#4778 review: saving needs the
    // desktop's selection-intent, gateway-route and write-ordering handling).
    expect(options.skipAiSettingsPersistence).toBe(true);
  });

  test("locks a sub-agent workspace to its assigned agent", async () => {
    // agentId was restamped by a recovery send; agentType is the child's creation-time identity.
    const { bridge, view } = await selectWorkspaceWith({
      ...WORKSPACE,
      ai: { parentWorkspaceId: "ws-parent", agentId: "plan", agentType: "exec" },
    });
    // A stale local pick must not change the agent a child task runs with.
    await act(async () => {
      updatePersistedState(getAgentIdKey(WORKSPACE.id), "plan");
      await Promise.resolve();
    });

    expect(agentPicker(view).textContent).toBe("Exec");
    expect(agentPicker(view).disabled).toBe(true);
    // Agent cycling is locked too, so the composer does not advertise it.
    expect(view.queryByText("- change agent")).toBeNull();
    const options = await send(bridge, view);
    expect(options.agentId).toBe("exec");
  });

  test("switching the agent restores that agent's own settings", async () => {
    const { bridge, view } = await selectWorkspaceWith({
      ...WORKSPACE,
      ai: {
        agentId: "plan",
        aiSettingsByAgent: {
          plan: { model: "openai:gpt-5.6-terra", thinkingLevel: "high" },
          exec: { model: "anthropic:claude-opus-5-5", thinkingLevel: "low" },
        },
      },
    });

    await bridge.answer("agents.list", AGENT_DESCRIPTORS);
    await pickAgent(view, "exec");
    const options = await send(bridge, view);
    expect(options).toMatchObject({
      agentId: "exec",
      model: "anthropic:claude-opus-5-5",
      thinkingLevel: "low",
    });
  });

  test("keeps a model picked for one agent after switching agents and back", async () => {
    const { bridge, view } = await selectWorkspaceWith({
      ...WORKSPACE,
      ai: {
        agentId: "plan",
        aiSettingsByAgent: {
          plan: { model: "openai:gpt-5.6-terra", thinkingLevel: "high" },
          exec: { model: "anthropic:claude-opus-5-5", thinkingLevel: "low" },
        },
      },
    });

    // Pick Sonnet 5.5 for Plan from the model dropdown (the list shows every suggested model).
    await act(async () => {
      fireEvent.click(view.getByRole("combobox"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByText("Sonnet 5.5"));
      await Promise.resolve();
    });
    await bridge.answer("agents.list", AGENT_DESCRIPTORS);
    await pickAgent(view, "exec");
    await pickAgent(view, "plan");

    const options = await send(bridge, view);
    expect(options.agentId).toBe("plan");
    expect(String(options.model)).toContain("sonnet");
    // No pick-time write reaches the workspace; the send carries the pick (#4781).
    expect(bridge.orpcCalls("workspace.updateAgentAISettings")).toHaveLength(0);
    // Settle the persisting send so this webview session has no unresolved one (#4781).
    await bridge.answer("workspace.sendMessage", { success: true, data: {} });
  });

  test("sends a gateway-routed model pick with its gateway ID", async () => {
    const { bridge, view } = await selectWorkspaceWith(WORKSPACE);
    // A configured gateway provider lists its custom models under the gateway prefix.
    await bridge.answer("providers.getConfig", {
      openrouter: { apiKeySet: true, isEnabled: true, isConfigured: true, models: ["openai/gpt-5"] },
    });

    try {
      await act(async () => {
        fireEvent.click(view.getByRole("combobox"));
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(view.getByText(formatModelDisplayName("openai/gpt-5")));
        await Promise.resolve();
      });

      const options = await send(bridge, view);
      expect(options.model).toBe("openrouter:openai/gpt-5");
    } finally {
      await clearProvidersConfig(bridge);
    }
  });

  test("keeps a sub-agent's unsent model pick across a metadata refresh", async () => {
    const child: UiWorkspace = {
      ...WORKSPACE,
      ai: {
        parentWorkspaceId: "ws-parent",
        agentId: "exec",
        agentType: "exec",
        aiSettingsByAgent: { exec: { model: "openai:gpt-5.6-terra", thinkingLevel: "high" } },
      },
    };
    const { bridge, view } = await selectWorkspaceWith(child);

    await act(async () => {
      fireEvent.click(view.getByRole("combobox"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByText("Sonnet 5.5"));
      await Promise.resolve();
    });
    // A sub-agent follows its backend settings on every refresh, except a deliberate unsent pick.
    await bridge.emit({ type: "workspaces", workspaces: [child] });

    const options = await send(bridge, view);
    expect(String(options.model)).toContain("sonnet");
    await bridge.answer("workspace.sendMessage", { success: true, data: {} });
  });

  test("shows the actual custom agent instead of mislabeling it as Exec", async () => {
    const { bridge, view } = await selectWorkspaceWith({
      ...WORKSPACE,
      ai: { parentWorkspaceId: "ws-parent", agentId: "explore", agentType: "explore" },
    });

    expect(agentPicker(view).textContent).toBe("Explore");
    expect(agentPicker(view).disabled).toBe(true);
    const options = await send(bridge, view);
    expect(options.agentId).toBe("explore");
  });
});

// #4751: the extension host only answers agents.list for workspaces it has listed.
describe("vscode webview agent lookup", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("waits for the workspace list before looking up a restored selection's agents", async () => {
    const bridge = new TestBridge();
    render(<App bridge={bridge} />);
    // A fresh extension host posts the restored selection before the workspace list.
    await bridge.emit({ type: "setSelectedWorkspace", workspaceId: WORKSPACE.id });
    expect(bridge.orpcCalls("agents.list")).toHaveLength(0);

    await bridge.emit({ type: "connectionStatus", status: { mode: "api", baseUrl: "http://x" } });
    await bridge.emit({ type: "workspaces", workspaces: [WORKSPACE] });
    const lookups = bridge.orpcCalls("agents.list");
    expect(lookups).toHaveLength(1);
    expect(lookups[0].input).toMatchObject({ workspaceId: WORKSPACE.id });
  });

  test("keeps the agent toggle disabled while agent state has no workspace scope (#4820)", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    const toggle = () => agentPicker(view);

    // File mode lists and selects the workspace, but agent state stays unscoped (#4797).
    await bridge.emit({ type: "connectionStatus", status: { mode: "file", error: "offline" } });
    await bridge.emit({ type: "workspaces", workspaces: [WORKSPACE] });
    await bridge.emit({ type: "setSelectedWorkspace", workspaceId: WORKSPACE.id });
    expect(toggle().disabled).toBe(true);
    expect(view.queryByText("- change agent")).toBeNull();

    // With a server connection, the scope follows the listed selection.
    await bridge.emit({ type: "connectionStatus", status: { mode: "api", baseUrl: "http://x" } });
    expect(toggle().disabled).toBe(false);
    expect(view.queryByText("- change agent")).not.toBeNull();
  });

  test("keeps the agent toggle disabled for a restored selection until the workspace list arrives (#4820)", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await bridge.emit({ type: "connectionStatus", status: { mode: "api", baseUrl: "http://x" } });
    await bridge.emit({ type: "setSelectedWorkspace", workspaceId: WORKSPACE.id });
    await bridge.emit({ type: "chatEvent", workspaceId: WORKSPACE.id, event: { type: "caught-up" } });

    const toggle = agentPicker(view);
    expect(toggle.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(toggle);
      await Promise.resolve();
    });
    // The click must not open the picker: an unscoped pick would write the webview's global agent key.
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(readPersistedState(getAgentIdKey(GLOBAL_SCOPE_ID), null)).toBeNull();
  });

  test("looks up agents again when the connection recovers from file mode (#4797)", async () => {
    const bridge = new TestBridge();
    render(<App bridge={bridge} />);
    // File mode still lists workspaces from local files, but the host rejects agents.list without a
    // server connection, so the webview must not spend its lookup there.
    await bridge.emit({ type: "connectionStatus", status: { mode: "file", error: "offline" } });
    await bridge.emit({ type: "workspaces", workspaces: [WORKSPACE] });
    await bridge.emit({ type: "setSelectedWorkspace", workspaceId: WORKSPACE.id });
    const fileModeLookups = bridge.orpcCalls("agents.list").length;
    expect(fileModeLookups).toBe(0);

    // Recovery refreshes the same list and selection; only the connection mode changes.
    await bridge.emit({ type: "connectionStatus", status: { mode: "api", baseUrl: "http://x" } });
    await bridge.emit({ type: "workspaces", workspaces: [WORKSPACE] });
    await bridge.emit({ type: "setSelectedWorkspace", workspaceId: WORKSPACE.id });
    const recoveryLookups = bridge.orpcCalls("agents.list").slice(fileModeLookups);
    expect(recoveryLookups).toHaveLength(1);
    expect(recoveryLookups[0].input).toMatchObject({ workspaceId: WORKSPACE.id });
  });
});

// #4808: the admin policy can exclude the workspace's selected model (persisted, seeded or revoked).
describe("vscode webview policy-excluded model", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function enforcedPolicy(providerAccess: Array<{ id: string; allowedModels: string[] | null }>) {
    return {
      source: "governor",
      status: { state: "enforced" },
      policy: {
        policyFormatVersion: "0.1",
        providerAccess,
        mcp: { allowUserDefined: { stdio: true, remote: true } },
        runtimes: null,
      },
    };
  }

  async function renderWithPolicy(policy: unknown) {
    updatePersistedState(getModelKey(WORKSPACE.id), "anthropic:claude-opus-5-5");
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge);
    await bridge.answer("policy.get", policy);
    const textarea = view.container.querySelector("textarea");
    if (!textarea) throw new Error("composer textarea did not render");
    await typeInto(textarea, "hello");
    return { bridge, view };
  }

  async function clickSend(view: ReturnType<typeof render>) {
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send message" }));
      await Promise.resolve();
    });
  }

  test("sends with the first allowed model, says so, and keeps the stored choice", async () => {
    const { bridge, view } = await renderWithPolicy(
      enforcedPolicy([{ id: "openai", allowedModels: ["gpt-5.6-terra"] }])
    );
    await bridge.answer("providers.getConfig", {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    });

    expect(view.getByRole("status").textContent).toContain("anthropic:claude-opus-5-5");
    await clickSend(view);
    const sends = bridge.orpcCalls("workspace.sendMessage");
    expect(sends).toHaveLength(1);
    const input = sends[0].input as { options: Record<string, unknown> };
    expect(input.options.model).toBe("openai:gpt-5.6-terra");
    // Local fallback only: nothing is written, locally or to the workspace.
    expect(readPersistedState(getModelKey(WORKSPACE.id), "")).toBe("anthropic:claude-opus-5-5");
    expect(bridge.orpcCalls("workspace.updateAgentAISettings")).toHaveLength(0);
    await clearProvidersConfig(bridge);
  });

  test("keeps the stored model and says so when the policy allows no listed model", async () => {
    const { bridge, view } = await renderWithPolicy(
      enforcedPolicy([{ id: "openai", allowedModels: ["not-a-listed-model"] }])
    );

    expect(view.getByRole("status").textContent).toContain("anthropic:claude-opus-5-5");
    await clickSend(view);
    const input = bridge.orpcCalls("workspace.sendMessage")[0].input as {
      options: Record<string, unknown>;
    };
    expect(input.options.model).toBe("anthropic:claude-opus-5-5");
  });

  test("keeps an allowed selection unchanged", async () => {
    const { bridge, view } = await renderWithPolicy(
      enforcedPolicy([{ id: "anthropic", allowedModels: null }])
    );

    expect(view.queryByRole("status")).toBeNull();
    await clickSend(view);
    const input = bridge.orpcCalls("workspace.sendMessage")[0].input as {
      options: Record<string, unknown>;
    };
    expect(input.options.model).toBe("anthropic:claude-opus-5-5");
  });
});

// #4766: the webview loads the user's routing and thinking-floor config and the providers config.
describe("vscode webview app and providers config", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    // The store is an app-wide singleton; drop the floors a test loaded so later tests start clean.
    getAppConfigStore().updateOptimistically({ minThinkingLevelByModel: undefined });
    cleanupDom?.();
    cleanupDom = null;
  });

  test("shows the thinking level raised to the user's configured minimum", async () => {
    // "low" is below both the built-in minimum (MED) and the configured one (HIGH).
    updatePersistedState(getThinkingLevelKey(WORKSPACE.id), "low");
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge);
    expect(bridge.orpcCalls("config.getConfig")).toHaveLength(1);
    expect(bridge.orpcCalls("providers.getConfig")).toHaveLength(1);

    await bridge.answer("config.getConfig", {
      minThinkingLevelByModel: { "anthropic:claude-opus-5-5": "high" },
    });
    expect(view.getByText("HIGH")).toBeDefined();
    expect(view.queryByText("MED")).toBeNull();
  });

  test("falls back to a policy-allowed model of a configured provider (#4808 review)", async () => {
    updatePersistedState(getModelKey(WORKSPACE.id), "openai:gpt-5.6-terra");
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge);
    // Anthropic is allowed and listed first, but only Google has credentials.
    await bridge.answer("policy.get", {
      source: "governor",
      status: { state: "enforced" },
      policy: {
        policyFormatVersion: "0.1",
        providerAccess: [
          { id: "anthropic", allowedModels: null },
          { id: "google", allowedModels: null },
        ],
        mcp: { allowUserDefined: { stdio: true, remote: true } },
        runtimes: null,
      },
    });
    await bridge.answer("providers.getConfig", {
      google: { apiKeySet: true, isEnabled: true, isConfigured: true },
    });

    const textarea = view.container.querySelector("textarea");
    if (!textarea) throw new Error("composer textarea did not render");
    await typeInto(textarea, "hello");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send message" }));
      await Promise.resolve();
    });
    const input = bridge.orpcCalls("workspace.sendMessage")[0].input as {
      options: Record<string, unknown>;
    };
    expect(String(input.options.model)).toStartWith("google:");
    await clearProvidersConfig(bridge);
  });

  test("does not pick a fallback before the providers config arrives (#4813 review)", async () => {
    updatePersistedState(getModelKey(WORKSPACE.id), "openai:gpt-5.6-terra");
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge);
    await bridge.answer("policy.get", {
      source: "governor",
      status: { state: "enforced" },
      policy: {
        policyFormatVersion: "0.1",
        providerAccess: [{ id: "anthropic", allowedModels: null }],
        mcp: { allowUserDefined: { stdio: true, remote: true } },
        runtimes: null,
      },
    });
    // providers.getConfig is still pending: availability is unknown, so nothing is substituted.
    const textarea = view.container.querySelector("textarea");
    if (!textarea) throw new Error("composer textarea did not render");
    await typeInto(textarea, "hello");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send message" }));
      await Promise.resolve();
    });
    const input = bridge.orpcCalls("workspace.sendMessage")[0].input as {
      options: Record<string, unknown>;
    };
    expect(input.options.model).toBe("openai:gpt-5.6-terra");
  });

  test("reloads the config when the connection switches to another server (#4813 review)", async () => {
    const bridge = new TestBridge();
    render(<App bridge={bridge} />);
    await bridge.emit({ type: "connectionStatus", status: { mode: "api", baseUrl: "http://a" } });
    // A refresh against the same server does not refetch.
    await bridge.emit({ type: "connectionStatus", status: { mode: "api", baseUrl: "http://a" } });
    expect(bridge.orpcCalls("config.getConfig")).toHaveLength(1);

    await bridge.emit({ type: "connectionStatus", status: { mode: "api", baseUrl: "http://b" } });
    expect(bridge.orpcCalls("config.getConfig")).toHaveLength(2);
    expect(bridge.orpcCalls("providers.getConfig")).toHaveLength(2);
  });

  test("loads the config again when the connection recovers from file mode", async () => {
    const bridge = new TestBridge();
    render(<App bridge={bridge} />);
    await bridge.emit({ type: "connectionStatus", status: { mode: "file", error: "offline" } });
    expect(bridge.orpcCalls("config.getConfig")).toHaveLength(0);
    expect(bridge.orpcCalls("providers.getConfig")).toHaveLength(0);

    await bridge.emit({ type: "connectionStatus", status: { mode: "api", baseUrl: "http://x" } });
    expect(bridge.orpcCalls("config.getConfig")).toHaveLength(1);
    expect(bridge.orpcCalls("providers.getConfig")).toHaveLength(1);
  });
});

// #4781: a send persists AI settings only for an explicit, still-current pick, once the workspace's
// settings are loaded, while admin policy allows the stored model, and never while an earlier
// persisting send for the workspace is unresolved.
describe("vscode webview explicit AI-setting persistence", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    resetAiSelectionIntentForTests();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function mainWorkspace(
    plan: { model: string; thinkingLevel: "low" | "medium" | "high" },
    id = WORKSPACE.id
  ): UiWorkspace {
    return {
      ...WORKSPACE,
      id,
      ai: {
        agentId: "plan",
        aiSettingsByAgent: {
          plan,
          exec: { model: "anthropic:claude-opus-5-5", thinkingLevel: "medium" },
        },
      },
    };
  }

  const TERRA_HIGH = { model: "openai:gpt-5.6-terra", thinkingLevel: "high" } as const;

  async function selectById(bridge: TestBridge, workspaceId: string) {
    await bridge.emit({ type: "setSelectedWorkspace", workspaceId });
    await bridge.emit({ type: "chatEvent", workspaceId, event: { type: "caught-up" } });
  }

  // `policy: "pending"` leaves policy.get unanswered; by default it answers "no policy".
  async function open(workspaces: UiWorkspace[], policy: "none" | "pending" = "none") {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await bridge.emit({ type: "connectionStatus", status: { mode: "api", baseUrl: "http://x" } });
    await bridge.emit({ type: "workspaces", workspaces });
    await selectById(bridge, workspaces[0].id);
    if (policy === "none") {
      await bridge.answer("policy.get", null);
    }
    return { bridge, view };
  }

  async function pickModel(view: ReturnType<typeof render>, label: string) {
    await act(async () => {
      fireEvent.click(view.getByRole("combobox"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByText(label));
      await Promise.resolve();
    });
  }

  async function pickThinking(view: ReturnType<typeof render>, label: string) {
    const trigger = view.container.querySelector<HTMLElement>("[data-thinking-selector-trigger]");
    if (!trigger) throw new Error("thinking selector did not render");
    await act(async () => {
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    const option = Array.from(
      view.container.querySelectorAll<HTMLElement>('[role="option"]')
    ).find((row) => row.getAttribute("aria-label") === label);
    if (!option) throw new Error(`thinking option ${label} did not render`);
    await act(async () => {
      fireEvent.click(option);
      await Promise.resolve();
    });
  }

  function textarea(view: ReturnType<typeof render>): HTMLTextAreaElement {
    const element = view.container.querySelector("textarea");
    if (!element) throw new Error("composer textarea did not render");
    return element;
  }

  // Types and clicks Send; returns the options of the new sendMessage call.
  async function send(bridge: TestBridge, view: ReturnType<typeof render>) {
    const before = bridge.orpcCalls("workspace.sendMessage").length;
    await typeInto(textarea(view), "hello");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send message" }));
      await Promise.resolve();
    });
    const sends = bridge.orpcCalls("workspace.sendMessage");
    expect(sends).toHaveLength(before + 1);
    const input = sends[before].input as { options?: Record<string, unknown> };
    if (!input.options) throw new Error("sendMessage carried no options");
    return input.options;
  }

  // Plays the host's reply to one sendMessage call (the newest by default).
  async function reply(bridge: TestBridge, value: unknown, index = -1) {
    const sends = bridge.orpcCalls("workspace.sendMessage");
    const call = sends.at(index);
    if (!call) throw new Error("no sendMessage call to answer");
    await bridge.emit({ type: "orpcResponse", requestId: call.requestId, ok: true, kind: "value", value });
  }

  const OK = { success: true, data: {} };

  test("does not persist a send without an explicit pick", async () => {
    const { bridge, view } = await open([mainWorkspace(TERRA_HIGH)]);
    const options = await send(bridge, view);
    expect(options.skipAiSettingsPersistence).toBe(true);
    expect(options.aiSelectionIntent).toBeUndefined();
    await reply(bridge, OK);
  });

  test("persists an explicit model pick once, at the next send", async () => {
    // "low" is below Opus 5.5's built-in minimum (MED): the companion thinking level must be sent
    // (and so persisted) as stored, not raised to a client-side floor.
    const { bridge, view } = await open([
      mainWorkspace({ model: "openai:gpt-5.6-terra", thinkingLevel: "low" }),
    ]);
    await pickModel(view, "Opus 5.5");

    const first = await send(bridge, view);
    expect(first).toMatchObject({
      agentId: "plan",
      model: "anthropic:claude-opus-5-5",
      thinkingLevel: "low",
      skipAiSettingsPersistence: false,
      aiSelectionIntent: { model: true },
    });
    await reply(bridge, OK);

    const second = await send(bridge, view);
    expect(second.skipAiSettingsPersistence).toBe(true);
    expect(second.aiSelectionIntent).toBeUndefined();
    await reply(bridge, OK);
    expect(bridge.orpcCalls("workspace.updateAgentAISettings")).toHaveLength(0);
  });

  test("persists only the last of several rapid picks", async () => {
    const { bridge, view } = await open([mainWorkspace(TERRA_HIGH)]);
    await pickModel(view, "Sonnet 5.5");
    await pickModel(view, "Opus 5.5");

    const options = await send(bridge, view);
    expect(options).toMatchObject({
      model: "anthropic:claude-opus-5-5",
      skipAiSettingsPersistence: false,
      aiSelectionIntent: { model: true },
    });
    await reply(bridge, OK);
  });

  test("persists an explicit thinking pick as selected", async () => {
    const { bridge, view } = await open([
      mainWorkspace({ model: "openai:gpt-5.6-terra", thinkingLevel: "medium" }),
    ]);
    await pickThinking(view, "High");

    const options = await send(bridge, view);
    expect(options).toMatchObject({
      thinkingLevel: "high",
      skipAiSettingsPersistence: false,
      aiSelectionIntent: { thinkingLevel: true },
    });
    await reply(bridge, OK);
  });

  test("never persists for a workspace without loaded AI settings", async () => {
    const { bridge, view } = await open([WORKSPACE]);
    await pickModel(view, "Sonnet 5.5");

    const options = await send(bridge, view);
    expect(String(options.model)).toContain("sonnet");
    expect(options.skipAiSettingsPersistence).toBe(true);
    expect(options.aiSelectionIntent).toBeUndefined();
    await reply(bridge, OK);
  });

  test("never persists the admin-policy fallback model", async () => {
    // Exec is seeded with Opus 5.5, which the policy excludes.
    const workspace: UiWorkspace = {
      ...mainWorkspace(TERRA_HIGH),
      ai: { ...mainWorkspace(TERRA_HIGH).ai, agentId: "exec" },
    };
    const { bridge, view } = await open([workspace], "pending");
    await bridge.answer("policy.get", {
      source: "governor",
      status: { state: "enforced" },
      policy: {
        policyFormatVersion: "0.1",
        providerAccess: [{ id: "openai", allowedModels: ["gpt-5.6-terra"] }],
        mcp: { allowUserDefined: { stdio: true, remote: true } },
        runtimes: null,
      },
    });
    await bridge.answer("providers.getConfig", {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    });
    try {
      await pickThinking(view, "High");

      const options = await send(bridge, view);
      expect(options.model).toBe("openai:gpt-5.6-terra");
      expect(options.skipAiSettingsPersistence).toBe(true);
      expect(options.aiSelectionIntent).toBeUndefined();
      await reply(bridge, OK);
    } finally {
      await clearProvidersConfig(bridge);
    }
  });

  test("does not persist while the admin policy is still loading", async () => {
    // Until policy.get answers, the model list is unfiltered and the policy looks disabled, so a
    // pick could be a model the policy forbids.
    const { bridge, view } = await open([mainWorkspace(TERRA_HIGH)], "pending");
    await pickModel(view, "Sonnet 5.5");

    const options = await send(bridge, view);
    expect(String(options.model)).toContain("sonnet");
    expect(options.skipAiSettingsPersistence).toBe(true);
    expect(options.aiSelectionIntent).toBeUndefined();
    await reply(bridge, OK);
  });

  test("persists a locked sub-agent's pick only into its locked agent", async () => {
    // agentId was restamped by a recovery send; agentType is the child's creation-time identity.
    const { bridge, view } = await open([
      {
        ...WORKSPACE,
        ai: {
          parentWorkspaceId: "ws-parent",
          agentId: "plan",
          agentType: "exec",
          aiSettingsByAgent: { exec: TERRA_HIGH },
        },
      },
    ]);
    await pickModel(view, "Sonnet 5.5");

    expect(agentPicker(view).disabled).toBe(true);
    const options = await send(bridge, view);
    expect(options).toMatchObject({
      agentId: "exec",
      skipAiSettingsPersistence: false,
      aiSelectionIntent: { model: true },
    });
    expect(String(options.model)).toContain("sonnet");
    await reply(bridge, OK);
  });

  test("keeps one persisting send per workspace in flight; the next send writes the latest pick", async () => {
    const other = mainWorkspace(TERRA_HIGH, "ws-2");
    const { bridge, view } = await open([mainWorkspace(TERRA_HIGH), other]);
    await pickModel(view, "Sonnet 5.5");
    const first = await send(bridge, view);
    expect(first.skipAiSettingsPersistence).toBe(false);

    // Enter must not start a second send while the first is in flight (the Send button is disabled).
    await typeInto(textarea(view), "second");
    await act(async () => {
      fireEvent.keyDown(textarea(view), { key: "Enter" });
      await Promise.resolve();
    });
    expect(bridge.orpcCalls("workspace.sendMessage")).toHaveLength(1);

    // Switching workspaces remounts the composer; the first send is still unresolved.
    await selectById(bridge, other.id);
    await selectById(bridge, WORKSPACE.id);
    await pickModel(view, "Opus 5.5");
    const overlapping = await send(bridge, view);
    expect(overlapping.model).toBe("anthropic:claude-opus-5-5");
    expect(overlapping.skipAiSettingsPersistence).toBe(true);
    expect(overlapping.aiSelectionIntent).toBeUndefined();

    await reply(bridge, OK, 0);
    await reply(bridge, OK, 1);
    const next = await send(bridge, view);
    expect(next).toMatchObject({
      model: "anthropic:claude-opus-5-5",
      skipAiSettingsPersistence: false,
      aiSelectionIntent: { model: true },
    });
    await reply(bridge, OK);
  });

  test("stops persisting for a workspace after a send ends without a server result", async () => {
    // Own workspace ID: the unknown outcome lasts for this webview session.
    const { bridge, view } = await open([mainWorkspace(TERRA_HIGH, "ws-unknown-outcome")]);
    await pickModel(view, "Sonnet 5.5");
    const first = await send(bridge, view);
    expect(first.skipAiSettingsPersistence).toBe(false);
    const call = bridge.orpcCalls("workspace.sendMessage")[0];
    await bridge.emit({ type: "orpcResponse", requestId: call.requestId, ok: false, error: "network" });

    await pickModel(view, "Opus 5.5");
    const next = await send(bridge, view);
    expect(next.skipAiSettingsPersistence).toBe(true);
    expect(next.aiSelectionIntent).toBeUndefined();
    await reply(bridge, OK);
  });

  test("keeps a pick pending after a server-reported send failure", async () => {
    const { bridge, view } = await open([mainWorkspace(TERRA_HIGH)]);
    await pickModel(view, "Sonnet 5.5");
    const first = await send(bridge, view);
    expect(first.skipAiSettingsPersistence).toBe(false);
    await reply(bridge, { success: false, error: { type: "policy_denied", message: "denied" } });

    const retry = await send(bridge, view);
    expect(retry).toMatchObject({
      skipAiSettingsPersistence: false,
      aiSelectionIntent: { model: true },
    });
    expect(String(retry.model)).toContain("sonnet");
    await reply(bridge, OK);
  });
});

// The webview renders every row through the desktop MessageRenderer (#4971), so machine rows keep
// their desktop presentation instead of degrading to plain user or assistant bubbles.
describe("vscode webview message rows", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function historyMessage(
    id: string,
    role: "user" | "assistant",
    text: string,
    metadata: MuxMetadata
  ) {
    return { type: "message", ...createMuxMessage(id, role, text, metadata) };
  }

  test("machine rows render their desktop components, not chat bubbles", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    const wakeText = "A background bash monitor matched.";
    const warningText = "Record the current objective in the workspace notes.";
    await selectWorkspace(bridge, [
      historyMessage("summary", "assistant", "Older context summary", {
        historySequence: 1,
        compacted: true,
        compactionBoundary: true,
        compactionEpoch: 1,
        muxMetadata: { type: "compaction-summary" },
      }),
      historyMessage("wake", "user", wakeText, {
        historySequence: 2,
        synthetic: true,
        uiVisible: true,
        muxMetadata: {
          type: "bash-monitor-wake",
          records: [
            { kind: "match", displayName: "Dev Server", filter: "ready", filterExclude: false },
          ],
        },
      }),
      historyMessage("warning", "user", warningText, {
        historySequence: 3,
        synthetic: true,
        uiVisible: true,
        muxMetadata: {
          type: "context-budget-warning",
          contextTokens: 800,
          maxTokens: 1000,
          budgetTokens: 700,
        },
      }),
      historyMessage(
        "peer",
        "assistant",
        formatAgentMessageEnvelope({ from: "ws-peer", relationship: "unrelated", message: "hello" }),
        {
          historySequence: 4,
          synthetic: true,
          uiVisible: true,
          muxMetadata: {
            type: "agent-peer-message",
            fromWorkspaceId: "ws-peer",
            relationship: "unrelated",
          },
        }
      ),
    ]);

    const container = view.container;
    expect(container.querySelector('[data-testid="compaction-boundary"]')).not.toBeNull();
    expect(container.querySelector("[data-bash-monitor-wake]")).not.toBeNull();
    expect(container.querySelector("[data-context-budget-warning]")).not.toBeNull();
    expect(container.querySelector("[data-agent-peer-message]")).not.toBeNull();
    // The machine prompts stay collapsed instead of showing as user bubbles.
    expect(view.queryByText(wakeText)).toBeNull();
    expect(view.queryByText(warningText)).toBeNull();
  });

  // Close must act on the webview's own aggregator; WorkspaceStore has none for this workspace.
  test("closing a plan-display preview removes it from the transcript", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    await selectWorkspace(bridge, [
      historyMessage("plan", "assistant", "# Plan\n\nShip the parity fix.", {
        historySequence: 1,
        muxMetadata: { type: "plan-display", path: "/home/alice/.xum/plans/xum/plan.md" },
      }),
    ]);

    expect(view.queryByText("Ship the parity fix.")).not.toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /Close/ }));
      await Promise.resolve();
    });
    expect(view.queryByText("Ship the parity fix.")).toBeNull();
  });

  test("Load all reveals history rows hidden by the display cap", async () => {
    const bridge = new TestBridge();
    const view = render(<App bridge={bridge} />);
    const replies = Array.from({ length: 80 }, (_, index) =>
      historyMessage(`reply-${index}`, "assistant", `reply number ${index}`, {
        historySequence: index + 2,
      })
    );
    await selectWorkspace(bridge, [
      historyMessage("prompt", "user", "start", { historySequence: 1 }),
      ...replies,
    ]);

    expect(view.queryByText("reply number 0")).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Load all" }));
      await Promise.resolve();
    });
    expect(view.queryByText("reply number 0")).not.toBeNull();
  });
});
