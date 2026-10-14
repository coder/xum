// Bootstrap Happy DOM before react-dom evaluates (see MemoryTab.test.tsx).
import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../tests/ui/dom";
import { useChatInstructions } from "@/browser/components/InstructionsTab/AdditionalSystemContextScratchpad";
import { InstructionsTab } from "@/browser/components/InstructionsTab/InstructionsTab";
import { ProjectMCPOverview } from "@/browser/components/ProjectMCPOverview/ProjectMCPOverview";
import type { APIClient } from "@/browser/contexts/API";
import {
  createConnectionHarness,
  GAP_MODES,
  type ConnectionHarness,
} from "@/browser/contexts/connection.testHarness";
import { RouterProvider } from "@/browser/contexts/RouterContext";
import { SettingsProvider } from "@/browser/contexts/SettingsContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { TestApiOverrides } from "@/browser/testUtils";
import { GoalDefaultsSection } from "./GoalDefaultsSection";
import { useGoalDefaults } from "@/browser/utils/goals/useGoalDefaults";
import { useGoalBoard, type UseGoalBoardResult } from "./useGoalBoard";

/*
 * Panes that load once per workspace or project keep what they show across a dropped
 * connection: the new client reloads in the background, a read cut off by the drop changes
 * nothing, and only the read that lands replaces the shown data.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** What each server procedure answers; a test swaps them (or holds them) before a connect. */
let answerBoard: () => Promise<unknown>;
let answerServers: () => Promise<unknown>;
let answerInstructions: () => Promise<unknown>;
let answerChatInstructions: () => Promise<unknown>;
let answerOverride: () => Promise<unknown>;
let savedOverrides: unknown[] = [];
/** What each goalDefaults.set answers (after it is recorded in savedOverrides). */
let answerSet: () => Promise<void> = () => Promise.resolve();
let savedChatInstructions: Array<{ content: string; enabled: boolean }> = [];
let failChatSave: Error | null = null;

function board(goalId: string) {
  return { entries: [{ section: "upcoming", goal: { goalId } }] };
}

function servers(name: string) {
  return { [name]: { transport: "stdio", command: "run", disabled: false } };
}

function turnCapOverride(turnCap: number) {
  return { defaultBudgetCents: null, defaultTurnCap: turnCap, alwaysRequireExplicitBudget: null };
}

function serverOverrides(): TestApiOverrides<APIClient> {
  return {
    workspace: {
      getGoalBoard: () => answerBoard(),
      getInstructions: () => answerInstructions(),
      getAdditionalSystemContext: () => answerChatInstructions(),
      setAdditionalSystemContext: (input: { content: string; enabled: boolean }) => {
        if (failChatSave) return Promise.reject(failChatSave);
        savedChatInstructions.push({ content: input.content, enabled: input.enabled });
        return Promise.resolve({ content: input.content, enabled: input.enabled });
      },
      goalDefaults: {
        get: () => answerOverride(),
        set: (input: unknown) => {
          savedOverrides.push(input);
          return answerSet();
        },
      },
    },
    mcp: { list: () => answerServers() },
    config: { getConfig: () => Promise.resolve({}) },
  } as unknown as TestApiOverrides<APIClient>;
}

let harness: ConnectionHarness;

function Wrapper(props: { children: ReactNode }) {
  const Connection = harness.Wrapper;
  return (
    <Connection>
      <RouterProvider>
        <SettingsProvider>
          <TooltipProvider>{props.children}</TooltipProvider>
        </SettingsProvider>
      </RouterProvider>
    </Connection>
  );
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function drop() {
  await harness.drop();
  await flush();
}

async function reconnect() {
  harness.reconnect();
  await flush();
}

/** Never answers: the read stays in flight until a drop cuts it off. */
function pending(): Promise<unknown> {
  return new Promise(() => undefined);
}

function goalIds(result: { current: UseGoalBoardResult }): string[] {
  return result.current.board.entries.map((entry) => entry.goal.goalId);
}

describe.each([...GAP_MODES])("loaded panes across a dropped connection (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    harness = createConnectionHarness(mode, serverOverrides);
    savedOverrides = [];
    savedChatInstructions = [];
    failChatSave = null;
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("the goal board keeps its goals through a reload the drop cut off", async () => {
    answerBoard = () => Promise.resolve(board("goal-a"));
    const view = renderHook(() => useGoalBoard("ws-1"), { wrapper: Wrapper });
    await waitFor(() => expect(goalIds(view.result)).toEqual(["goal-a"]));

    await drop();
    expect(goalIds(view.result)).toEqual(["goal-a"]);

    // The new client's read is still in flight when a second drop cuts it off.
    answerBoard = pending;
    await reconnect();
    await drop();
    expect(goalIds(view.result)).toEqual(["goal-a"]);

    answerBoard = () => Promise.resolve(board("goal-b"));
    await reconnect();
    await waitFor(() => expect(goalIds(view.result)).toEqual(["goal-b"]));
  });

  test("the MCP overview keeps its servers through a reload the drop cut off", async () => {
    answerServers = () => Promise.resolve(servers("alpha"));
    const view = render(<ProjectMCPOverview projectPath="/projects/demo" />, {
      wrapper: Wrapper,
    });
    await view.findByText("alpha");

    await drop();
    expect(view.queryByText("alpha")).not.toBeNull();

    answerServers = pending;
    await reconnect();
    await drop();
    expect(view.queryByText("alpha")).not.toBeNull();
    expect(view.queryByText("No MCP servers enabled for this project.")).toBeNull();

    answerServers = () => Promise.resolve(servers("beta"));
    await reconnect();
    await view.findByText("beta");
  });

  test("the Instructions tab keeps its empty state and an enabled editor while it reloads", async () => {
    answerInstructions = () => Promise.resolve({ files: [], totalTokens: 0 });
    answerChatInstructions = () => Promise.resolve({ content: "be brief", enabled: true });
    const view = render(<InstructionsTab workspaceId="ws-instructions" />, { wrapper: Wrapper });
    const editor = (await view.findByLabelText("Chat Instructions editor")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("be brief"));
    await view.findByText("No instruction files loaded for this workspace.");
    expect(editor.disabled).toBe(false);

    await drop();
    const nextInstructions = deferred<unknown>();
    const nextChatInstructions = deferred<unknown>();
    answerInstructions = () => nextInstructions.promise;
    answerChatInstructions = () => nextChatInstructions.promise;
    await reconnect();
    expect(view.queryByText("No instruction files loaded for this workspace.")).not.toBeNull();
    expect(editor.disabled).toBe(false);
    expect(view.queryByText("Loading…")).toBeNull();

    nextInstructions.resolve({ files: [], totalTokens: 0 });
    nextChatInstructions.resolve({ content: "be precise", enabled: true });
    await waitFor(() => expect(editor.value).toBe("be precise"));
  });

  // The create forms prefill from these. A read cut off by the drop must not replace the shown
  // values with the canonical defaults.
  test("the effective goal defaults keep their values through a reload the drop cut off", async () => {
    answerOverride = () => Promise.resolve(turnCapOverride(5));
    const view = renderHook(() => useGoalDefaults("ws-1"), { wrapper: Wrapper });
    await waitFor(() => expect(view.result.current.defaults.defaultTurnCap).toBe(5));

    answerOverride = pending;
    await drop();
    await reconnect();
    await drop();
    expect(view.result.current.defaults.defaultTurnCap).toBe(5);

    answerOverride = () => Promise.resolve(turnCapOverride(7));
    await reconnect();
    await waitFor(() => expect(view.result.current.defaults.defaultTurnCap).toBe(7));
  });

  test("the goal defaults keep the override editable while they reload, and an edit wins", async () => {
    answerOverride = () => Promise.resolve(turnCapOverride(5));
    const view = render(<GoalDefaultsSection workspaceId="ws-1" embedded />, {
      wrapper: Wrapper,
    });
    const turnCap = () =>
      view.getByLabelText("Workspace default goal turn cap") as HTMLInputElement;
    await waitFor(() => expect(turnCap().value).toBe("5"));

    await drop();
    const next = deferred<unknown>();
    answerOverride = () => next.promise;
    await reconnect();
    expect(turnCap().value).toBe("5");
    expect(turnCap().disabled).toBe(false);
    expect(view.queryByText("Loading…")).toBeNull();

    // The user edits while the reload is in flight; its older answer must not undo the edit.
    fireEvent.change(turnCap(), { target: { value: "9" } });
    fireEvent.blur(turnCap());
    await waitFor(() => expect(savedOverrides).toHaveLength(1));
    next.resolve(turnCapOverride(7));
    await flush();
    expect(turnCap().value).toBe("9");
  });
});

describe.each([...GAP_MODES])("edits and navigation while reconnecting (%s)", (mode) => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    harness = createConnectionHarness(mode, serverOverrides);
    savedOverrides = [];
    savedChatInstructions = [];
    failChatSave = null;
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("the chat-instructions editor is read-only while offline, and editable again after the reconnect", async () => {
    const workspaceId = `ws-offline-edit-${mode}`;
    answerInstructions = () => Promise.resolve({ files: [], totalTokens: 0 });
    answerChatInstructions = () => Promise.resolve({ content: "be brief", enabled: true });
    const view = render(<InstructionsTab workspaceId={workspaceId} />, { wrapper: Wrapper });
    const editor = (await view.findByLabelText("Chat Instructions editor")) as HTMLTextAreaElement;
    const toggle = view.getByLabelText("Enable Chat Instructions") as HTMLInputElement;
    await waitFor(() => expect(editor.value).toBe("be brief"));
    expect(editor.disabled).toBe(false);

    await drop();
    expect(editor.value).toBe("be brief");
    expect(editor.disabled).toBe(true);
    expect(toggle.disabled).toBe(true);

    await reconnect();
    await waitFor(() => expect(editor.disabled).toBe(false));
    expect(toggle.disabled).toBe(false);
    expect(savedChatInstructions).toEqual([]);
  });

  test("after a failed save, a reconnect shows what the server stored", async () => {
    const workspaceId = `ws-failed-save-${mode}`;
    answerChatInstructions = () => Promise.resolve({ content: "be brief", enabled: true });
    const view = renderHook(() => useChatInstructions(workspaceId), { wrapper: Wrapper });
    await waitFor(() => expect(view.result.current.content).toBe("be brief"));

    failChatSave = new Error("disk full");
    act(() => view.result.current.setContent("be kind"));
    await waitFor(() => expect(view.result.current.error).toBe("disk full"));

    await drop();
    await reconnect();
    await waitFor(() => expect(view.result.current.content).toBe("be brief"));
  });

  test("the goal defaults are read-only while offline, and editable again after the reconnect", async () => {
    answerOverride = () => Promise.resolve(turnCapOverride(5));
    const view = render(<GoalDefaultsSection workspaceId="ws-1" embedded />, {
      wrapper: Wrapper,
    });
    const turnCap = () =>
      view.getByLabelText("Workspace default goal turn cap") as HTMLInputElement;
    const stopOverriding = () =>
      view.getByRole("button", { name: "Stop overriding Default turn cap" }) as HTMLButtonElement;
    await waitFor(() => expect(turnCap().value).toBe("5"));
    expect(turnCap().disabled).toBe(false);

    await drop();
    expect(turnCap().value).toBe("5");
    expect(turnCap().disabled).toBe(true);
    expect(stopOverriding().disabled).toBe(true);

    await reconnect();
    await waitFor(() => expect(turnCap().disabled).toBe(false));
    expect(stopOverriding().disabled).toBe(false);
    expect(savedOverrides).toEqual([]);
  });

  test("the MCP overview never shows one project's servers under another", async () => {
    answerServers = () => Promise.resolve(servers("alpha"));
    const view = render(<ProjectMCPOverview projectPath="/projects/a" />, { wrapper: Wrapper });
    await view.findByText("alpha");

    // Project B's first list is still loading when the connection drops and cuts it off.
    answerServers = pending;
    view.rerender(<ProjectMCPOverview projectPath="/projects/b" />);
    await flush();
    expect(view.queryByText("alpha")).toBeNull();
    await drop();
    expect(view.queryByText("alpha")).toBeNull();

    answerServers = () => Promise.resolve(servers("beta"));
    await reconnect();
    await view.findByText("beta");
    expect(view.queryByText("alpha")).toBeNull();
  });
});

describe("loaded panes of another workspace", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    harness = createConnectionHarness("kept-gap", serverOverrides);
    savedOverrides = [];
    answerSet = () => Promise.resolve();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("another workspace clears the shown override while its own loads", async () => {
    answerOverride = () => Promise.resolve(turnCapOverride(5));
    const view = render(<GoalDefaultsSection workspaceId="ws-1" embedded />, {
      wrapper: Wrapper,
    });
    await waitFor(() =>
      expect(
        (view.getByLabelText("Workspace default goal turn cap") as HTMLInputElement).value
      ).toBe("5")
    );

    answerOverride = pending;
    view.rerender(<GoalDefaultsSection workspaceId="ws-2" embedded />);
    await waitFor(() => expect(view.queryByText("Loading…")).not.toBeNull());
    expect(view.queryByLabelText("Workspace default goal turn cap")).toBeNull();
  });

  // Writes run in order, and each writes the whole override. An older write that failed is
  // superseded by a newer one that succeeded: its error must not stay on screen.
  test("an older failed write leaves no error after a newer write succeeded", async () => {
    answerOverride = () => Promise.resolve(turnCapOverride(5));
    const view = render(<GoalDefaultsSection workspaceId="ws-1" embedded />, {
      wrapper: Wrapper,
    });
    const turnCap = () =>
      view.getByLabelText("Workspace default goal turn cap") as HTMLInputElement;
    await waitFor(() => expect(turnCap().value).toBe("5"));

    let failFirst: ((error: Error) => void) | null = null;
    const answers = [
      () => new Promise<void>((_resolve, reject) => (failFirst = reject)),
      () => Promise.resolve(),
    ];
    answerSet = () => answers.shift()?.() ?? Promise.resolve();
    fireEvent.change(turnCap(), { target: { value: "8" } });
    fireEvent.blur(turnCap());
    fireEvent.change(turnCap(), { target: { value: "9" } });
    fireEvent.blur(turnCap());
    await waitFor(() => expect(failFirst).not.toBeNull());

    act(() => failFirst?.(new Error("write failed")));
    await waitFor(() => expect(savedOverrides).toHaveLength(2));
    await flush();
    expect(view.queryByText("write failed") == null).toBe(true);
    expect(turnCap().value).toBe("9");
  });
});
