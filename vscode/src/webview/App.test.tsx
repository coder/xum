import "../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { installDom } from "../../../tests/ui/dom";
import { readPersistedState, updatePersistedState } from "xum/browser/hooks/usePersistedState";
import { getAgentIdKey, getModelKey, getThinkingLevelKey } from "xum/common/constants/storage";
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

// #4738: the extension sends each workspace's AI settings, so the webview uses (and may persist)
// the workspace's real settings and honors the sub-agent agent lock.
describe("vscode webview workspace AI settings", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
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

    expect(view.getByRole("button", { name: "Plan" })).toBeDefined();
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

    const toggle = view.getByRole("button", { name: "Exec" });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
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

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Plan" }));
      await Promise.resolve();
    });
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

    // Pick Sonnet 5 for Plan from the model dropdown (the list shows every suggested model).
    await act(async () => {
      fireEvent.click(view.getByRole("combobox"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByText("Sonnet 5"));
      await Promise.resolve();
    });
    for (const name of ["Plan", "Exec"]) {
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name }));
        await Promise.resolve();
      });
    }

    const options = await send(bridge, view);
    expect(options.agentId).toBe("plan");
    expect(String(options.model)).toContain("sonnet");
    // The pick stays local (#4755): no AI-settings write reaches the workspace.
    expect(bridge.orpcCalls("workspace.updateAgentAISettings")).toHaveLength(0);
  });

  test("shows the actual custom agent instead of mislabeling it as Exec", async () => {
    const { bridge, view } = await selectWorkspaceWith({
      ...WORKSPACE,
      ai: { parentWorkspaceId: "ws-parent", agentId: "explore", agentType: "explore" },
    });

    const toggle = view.getByRole("button", { name: "explore" });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(view.queryByRole("button", { name: "Exec" })).toBeNull();
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

    expect(view.getByRole("status").textContent).toContain("anthropic:claude-opus-5-5");
    await clickSend(view);
    const sends = bridge.orpcCalls("workspace.sendMessage");
    expect(sends).toHaveLength(1);
    const input = sends[0].input as { options: Record<string, unknown> };
    expect(input.options.model).toBe("openai:gpt-5.6-terra");
    // Local fallback only: nothing is written, locally or to the workspace.
    expect(readPersistedState(getModelKey(WORKSPACE.id), "")).toBe("anthropic:claude-opus-5-5");
    expect(bridge.orpcCalls("workspace.updateAgentAISettings")).toHaveLength(0);
  });

  test("blocks the send when the policy allows no listed model", async () => {
    const { bridge, view } = await renderWithPolicy(
      enforcedPolicy([{ id: "openai", allowedModels: ["not-a-listed-model"] }])
    );

    expect(view.getByRole("status").textContent).toContain("anthropic:claude-opus-5-5");
    await clickSend(view);
    expect(bridge.orpcCalls("workspace.sendMessage")).toHaveLength(0);
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
