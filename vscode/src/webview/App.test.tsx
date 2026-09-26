import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { installDom } from "../../../tests/ui/dom";
import { updatePersistedState } from "xum/browser/hooks/usePersistedState";
import { getThinkingLevelKey } from "xum/common/constants/storage";
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

// Pins a scrollable geometry on the transcript scrollport; happy-dom has no layout, so every
// element otherwise reports 0 heights and always reads as "at the bottom".
function setScrollGeometry(element: HTMLElement, geometry: { scrollTop: number }) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 200 });
  element.scrollTop = geometry.scrollTop;
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

// #4755: the webview never loads the workspace's AI settings, so a send must not persist its local
// defaults onto the workspace.
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
