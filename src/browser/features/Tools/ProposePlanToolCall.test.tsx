import type { ComponentProps, ReactNode } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";

import { APIContext, APIProvider, type APIClient } from "@/browser/contexts/API";
import { PolicyProvider } from "@/browser/contexts/PolicyContext";
import { getProvidersConfigStore } from "@/browser/stores/ProvidersConfigStore";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import * as UseOpenInEditorModule from "@/browser/hooks/useOpenInEditor";
import * as UseReviewsModule from "@/browser/hooks/useReviews";
import * as UseStartHereModule from "@/browser/hooks/useStartHere";
import * as DiffRendererModule from "@/browser/features/Shared/DiffRenderer";
import * as ReviewTypesModule from "@/common/types/review";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { AgentProvider } from "@/browser/contexts/AgentContext";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import {
  AGENT_AI_DEFAULTS_KEY,
  getAgentIdKey,
  getAutoModelRoutingKey,
  getAutoThinkingLevelKey,
  getModelKey,
  getPlanContentKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
} from "@/common/constants/storage";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { createTestApiClient, createTestConfig, type TestClientConfig } from "@/browser/testUtils";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";

import { ProposePlanToolCall } from "./ProposePlanToolCall";

type SendMessageArgs = Parameters<APIClient["workspace"]["sendMessage"]>[0];

type GetPlanContentResult =
  | { success: true; data: { content: string; path: string } }
  | { success: false; error: string };

type ResultVoid = { success: true; data: undefined } | { success: false; error: string };

type GetConfigResult = TestClientConfig;

interface MockApi {
  config: {
    getConfig: () => Promise<GetConfigResult>;
  };
  workspace: {
    getPlanContent: () => Promise<GetPlanContentResult>;
    replaceChatHistory: (args: {
      workspaceId: string;
      summaryMessage: unknown;
      mode?: "destructive" | "append-compaction-boundary" | null;
      deletePlanFile?: boolean;
    }) => Promise<ResultVoid>;
    sendMessage: (args: SendMessageArgs) => ReturnType<APIClient["workspace"]["sendMessage"]>;
  };
  policy?: { get: () => ReturnType<APIClient["policy"]["get"]> };
}

let mockApi: MockApi | null = null;

let startHereCalls: Array<{
  workspaceId: string | undefined;
  content: string;
  isCompacted: boolean;
  options: { deletePlanFile?: boolean; sourceAgentId?: string } | undefined;
}> = [];

let selectableDiffRendererCalls: Array<{ filePath?: string }> = [];

const useStartHereMock = mock(
  (
    workspaceId: string | undefined,
    content: string,
    isCompacted: boolean,
    options?: { deletePlanFile?: boolean; sourceAgentId?: string }
  ) => {
    startHereCalls.push({ workspaceId, content, isCompacted, options });
    return {
      openModal: () => undefined,
      isStartingHere: false,
      buttonLabel: "Start Here",
      buttonEmoji: "",
      disabled: false,
      modal: null,
    };
  }
);

const actualUseStartHereModule = { ...UseStartHereModule };
const actualUseOpenInEditorModule = { ...UseOpenInEditorModule };
const actualWorkspaceContextModule = { ...WorkspaceContextModule };
const actualUseReviewsModule = { ...UseReviewsModule };
const actualDiffRendererModule = { ...DiffRendererModule };
const actualReviewTypesModule = { ...ReviewTypesModule };

async function installProposePlanModuleMocks() {
  await mock.module("@/browser/hooks/useStartHere", () => ({
    ...actualUseStartHereModule,
    useStartHere: useStartHereMock,
  }));
  await mock.module("@/browser/hooks/useOpenInEditor", () => ({
    ...actualUseOpenInEditorModule,
    useOpenInEditor: () => () => Promise.resolve({ success: true } as const),
  }));
  await mock.module("@/browser/contexts/WorkspaceContext", () => ({
    ...actualWorkspaceContextModule,
    useWorkspaceContext: () => ({
      workspaceMetadata: new Map<string, { runtimeConfig?: unknown }>(),
    }),
  }));
  await mock.module("@/browser/hooks/useReviews", () => ({
    ...actualUseReviewsModule,
    useReviews: () => ({
      reviews: [],
      pendingCount: 0,
      attachedCount: 0,
      checkedCount: 0,
      attachedReviews: [],
      addReview: (data: unknown) => ({
        id: "test-review",
        data,
        status: "attached" as const,
        createdAt: Date.now(),
      }),
      attachReview: () => undefined,
      detachReview: () => undefined,
      attachAllPending: () => undefined,
      detachAllAttached: () => undefined,
      checkReview: () => undefined,
      uncheckReview: () => undefined,
      removeReview: () => undefined,
      updateReviewNote: () => undefined,
      clearChecked: () => undefined,
      clearAll: () => undefined,
      getReview: () => undefined,
    }),
  }));
  await mock.module("@/browser/features/Shared/DiffRenderer", () => ({
    ...actualDiffRendererModule,
    SelectableDiffRenderer: (props: { filePath?: string }) => {
      selectableDiffRendererCalls.push({ filePath: props.filePath });
      return <div data-testid="selectable-diff-renderer" data-filepath={props.filePath ?? ""} />;
    },
  }));
  await mock.module("@/common/types/review", () => ({
    ...actualReviewTypesModule,
    isPlanFilePath: (filePath: string) => /[/\\]plans[/\\]/.test(filePath),
    normalizePlanFilePath: (filePath: string) => {
      const normalizedPath = filePath.replace(/\\/g, "/");
      const tildeMuxMatch = /^~\/\.mux\/plans\/(.+)$/.exec(normalizedPath);
      if (tildeMuxMatch?.[1]) {
        return `.mux/plans/${tildeMuxMatch[1]}`;
      }

      return normalizedPath;
    },
  }));
}

async function restoreProposePlanModuleMocks() {
  // Bun's mock.module() has no disposer, and mock.restore() does not undo module mocks.
  // Restore real exports so this test's renderer stubs do not leak into review suites.
  await mock.module("@/browser/hooks/useStartHere", () => actualUseStartHereModule);
  await mock.module("@/browser/hooks/useOpenInEditor", () => actualUseOpenInEditorModule);
  await mock.module("@/browser/contexts/WorkspaceContext", () => actualWorkspaceContextModule);
  await mock.module("@/browser/hooks/useReviews", () => actualUseReviewsModule);
  await mock.module("@/browser/features/Shared/DiffRenderer", () => actualDiffRendererModule);
  await mock.module("@/common/types/review", () => actualReviewTypesModule);
}

const WORKSPACE_ID = "ws-123";
const PLAN_PATH = "~/.mux/plans/demo/ws-123.md";
const PLAN_CONTENT = "# My Plan\n\nDo the thing.";

const DEFAULT_CONFIG: GetConfigResult = createTestConfig({
  taskSettings: { ...DEFAULT_TASK_SETTINGS, maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
});

function createTestAgent(
  id: string,
  name: string,
  model: string,
  thinkingLevel: NonNullable<AgentDefinitionDescriptor["aiDefaults"]>["thinkingLevel"]
): AgentDefinitionDescriptor {
  return {
    id,
    name,
    scope: "built-in",
    uiSelectable: true,
    subagentRunnable: true,
    aiDefaults: { model, thinkingLevel },
  };
}

const TEST_AGENTS = [
  createTestAgent("exec", "Exec", "openai:gpt-5.2", "low"),
  createTestAgent("plan", "Plan", "anthropic:claude-sonnet-4-5", "high"),
];

const noop = () => {
  // intentional noop for tests
};

function wrapToolCall(content: JSX.Element, agentId = "plan") {
  return (
    <AgentProvider
      value={{
        agentId,
        setAgentId: noop,
        currentAgent: TEST_AGENTS.find((entry) => entry.id === agentId),
        agents: TEST_AGENTS,
        loaded: true,
        loadFailed: false,
        refresh: () => Promise.resolve(),
        refreshing: false,
        disableWorkspaceAgents: false,
        setDisableWorkspaceAgents: noop,
      }}
    >
      <TooltipProvider>{content}</TooltipProvider>
    </AgentProvider>
  );
}

// Inject the client through the real provider: a module mock of contexts/API is process-wide
// and leaks into later-evaluated suites. The wrapper reads mockApi at render time (tests assign
// it after beforeEach) and view.rerender() keeps it. A null mockApi means no backend client.
// PolicyProvider answers "no policy" unless the mock supplies policy.get.
function ApiWrapper(props: { children: ReactNode }) {
  if (mockApi === null) {
    return (
      <APIContext.Provider
        value={{
          status: "connecting",
          api: null,
          error: null,
          authenticate: () => undefined,
          retry: () => undefined,
        }}
      >
        <PolicyProvider>{props.children}</PolicyProvider>
      </APIContext.Provider>
    );
  }
  return (
    <APIProvider client={createTestApiClient(mockApi)}>
      <PolicyProvider>{props.children}</PolicyProvider>
    </APIProvider>
  );
}

function renderToolCall(content: JSX.Element, agentId = "plan") {
  return render(wrapToolCall(content, agentId), { wrapper: ApiWrapper });
}

type ProposePlanProps = ComponentProps<typeof ProposePlanToolCall>;

function createMockApi(
  overrides: {
    config?: GetConfigResult;
    getPlanContent?: MockApi["workspace"]["getPlanContent"];
    replaceChatHistory?: MockApi["workspace"]["replaceChatHistory"];
    sendMessage?: MockApi["workspace"]["sendMessage"];
  } = {}
): MockApi {
  return {
    config: { getConfig: () => Promise.resolve(overrides.config ?? DEFAULT_CONFIG) },
    workspace: {
      getPlanContent:
        overrides.getPlanContent ??
        (() =>
          Promise.resolve({
            success: true,
            data: { content: PLAN_CONTENT, path: PLAN_PATH },
          })),
      replaceChatHistory:
        overrides.replaceChatHistory ?? (() => Promise.resolve({ success: true, data: undefined })),
      sendMessage: overrides.sendMessage ?? (() => Promise.resolve({ success: true, data: {} })),
    },
  };
}

function renderPlanToolCall(props: Partial<ProposePlanProps> = {}, agentId?: string) {
  return renderToolCall(
    <ProposePlanToolCall args={{}} workspaceId={WORKSPACE_ID} isLatest={false} {...props} />,
    agentId
  );
}

function renderCompletedPlan(props: Partial<ProposePlanProps> = {}) {
  return renderPlanToolCall({
    status: "completed",
    result: { success: true, planPath: PLAN_PATH, planContent: PLAN_CONTENT },
    isLatest: true,
    ...props,
  });
}

function startInPlanMode(workspaceId = WORKSPACE_ID, model?: string, thinkingLevel?: string) {
  window.localStorage.setItem(getAgentIdKey(workspaceId), JSON.stringify("plan"));
  if (model) updatePersistedState(getModelKey(workspaceId), model);
  if (thinkingLevel) updatePersistedState(getThinkingLevelKey(workspaceId), thinkingLevel);
}

function recordSendMessage(calls: SendMessageArgs[]): MockApi["workspace"]["sendMessage"] {
  return (args) => {
    calls.push(args);
    return Promise.resolve({ success: true, data: {} });
  };
}

function expectSingleQuoteRoot(view: { container: HTMLElement }, text: string) {
  const quoteRoots = Array.from(
    view.container.querySelectorAll<HTMLElement>("[data-transcript-quote-root]")
  );
  expect(quoteRoots).toHaveLength(1);
  expect(
    quoteRoots.find((element) => element.getAttribute("data-transcript-quote-text") === text)
  ).toBeDefined();
}

describe("ProposePlanToolCall", () => {
  let cleanupDom: (() => void) | null = null;
  // Plan sends go through the transcript mutation barrier, which reads the singleton store's
  // caught-up flag through the exported `workspaceStore` wrapper. Pin it open by default;
  // barrier tests flip it through this spy. (Spying on the wrapper, not the raw instance,
  // survives sibling suites that overlay `useWorkspaceStoreRaw` with a Proxy.)
  let transcriptCaughtUp = true;
  let barrierSpy: { mockRestore: () => void } | null = null;

  afterAll(async () => {
    await restoreProposePlanModuleMocks();
  });

  beforeEach(async () => {
    startHereCalls = [];
    selectableDiffRendererCalls = [];
    mockApi = null;
    transcriptCaughtUp = true;
    barrierSpy = spyOn(workspaceStore, "isWorkspaceTranscriptCaughtUp").mockImplementation(
      () => transcriptCaughtUp
    );
    cleanupDom = installDom();
    await installProposePlanModuleMocks();
  });

  afterEach(async () => {
    cleanup();
    await restoreProposePlanModuleMocks();
    barrierSpy?.mockRestore();
    barrierSpy = null;
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("does not claim plan is in chat when Start Here content is a placeholder", () => {
    renderPlanToolCall({ result: { success: true, planPath: PLAN_PATH } });

    // PolicyProvider's first answer re-renders the card; check the latest render's input.
    const startHere = startHereCalls.at(-1);
    expect(startHere?.content).toContain("*Plan saved to");
    expect(startHere?.content).not.toContain("Note: This chat already contains the full plan");
    expect(startHere?.content).toContain("Read the plan file below");
  });
  test("keeps plan file on disk and includes plan path note in Start Here content", () => {
    renderPlanToolCall({
      // Old-format chat history may include planContent; this is the easiest path to
      // ensure the rendered Start Here message includes the full plan + the path note.
      result: { success: true, planPath: PLAN_PATH, planContent: PLAN_CONTENT },
    });

    const startHere = startHereCalls.at(-1);
    expect(startHere?.options).toEqual({ sourceAgentId: "plan" });
    expect(startHere?.isCompacted).toBe(false);

    // The Start Here message should explicitly tell the user the plan file remains on disk.
    expect(startHere?.content).toContain("*Plan file preserved at:*");
    expect(startHere?.content).toContain("Note: This chat already contains the full plan");
    expect(startHere?.content).toContain(PLAN_PATH);
  });

  test.each([
    ["shows", true],
    ["hides", false],
  ])("%s Annotate button based on latest completed plan state", (verb, isLatest) => {
    const view = renderCompletedPlan({ isLatest });
    const button = view.queryByRole("button", { name: "Annotate" });

    if (verb === "shows") expect(button).not.toBeNull();
    else expect(button).toBeNull();
  });

  test("hides Annotate button while latest plan call is still executing", async () => {
    let getPlanContentCalls = 0;

    mockApi = createMockApi({
      getPlanContent: () => {
        getPlanContentCalls += 1;
        return Promise.resolve({
          success: true,
          data: { content: PLAN_CONTENT, path: PLAN_PATH },
        });
      },
    });

    const view = renderPlanToolCall({ status: "executing", isLatest: true });

    await waitFor(() => expect(getPlanContentCalls).toBe(1));
    expect(view.queryByRole("button", { name: "Annotate" })).toBeNull();
  });

  test("passes normalized plan path to annotation view", () => {
    const view = renderCompletedPlan();

    fireEvent.click(view.getByRole("button", { name: "Annotate" }));

    const renderer = view.getByTestId("selectable-diff-renderer");
    expect(renderer.getAttribute("data-filepath")).toBe(".mux/plans/demo/ws-123.md");
    expect(selectableDiffRendererCalls[selectableDiffRendererCalls.length - 1]?.filePath).toBe(
      ".mux/plans/demo/ws-123.md"
    );
  });

  test("hides Annotate button when completed propose_plan result is an error", () => {
    updatePersistedState(getPlanContentKey(WORKSPACE_ID), {
      content: "# Cached Plan\n\nDo the thing.",
      path: PLAN_PATH,
    });

    const view = renderPlanToolCall({
      status: "completed",
      result: { success: false, error: "failed to generate plan" },
      isLatest: true,
    });

    expect(view.queryByRole("button", { name: "Annotate" })).toBeNull();
  });

  test("annotate mode and raw mode are mutually exclusive", () => {
    const view = renderCompletedPlan();

    fireEvent.click(view.getByRole("button", { name: "Annotate" }));
    expect(view.getByRole("button", { name: "Exit Annotate" })).toBeDefined();
    expect(view.getByTestId("plan-annotation-view")).toBeDefined();

    fireEvent.click(view.getByRole("button", { name: "Show Text" }));
    expect(view.queryByTestId("plan-annotation-view")).toBeNull();
    expect(view.container.querySelector("pre")).not.toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Annotate" }));
    expect(view.getByRole("button", { name: "Exit Annotate" })).toBeDefined();
    expect(view.getByTestId("plan-annotation-view")).toBeDefined();
    expect(view.container.querySelector("pre")).toBeNull();
  });

  test("exposes the plan body as an explicit transcript quote root", () => {
    expectSingleQuoteRoot(renderCompletedPlan(), PLAN_CONTENT);
  });

  test("keeps the plan transcript quote root in ephemeral previews", () => {
    const planContent = "# Preview Plan\n\nShip it.";
    const view = renderToolCall(
      <ProposePlanToolCall
        args={{}}
        status="completed"
        content={planContent}
        path={PLAN_PATH}
        workspaceId={WORKSPACE_ID}
        isEphemeralPreview={true}
      />
    );

    expectSingleQuoteRoot(view, planContent);
  });

  test("does not toggle annotate mode with Shift+A in ephemeral previews", () => {
    const view = renderToolCall(
      <>
        <ProposePlanToolCall
          args={{}}
          status="completed"
          content="# My Plan\n\nDo the thing."
          path={PLAN_PATH}
          workspaceId={WORKSPACE_ID}
          isEphemeralPreview={true}
        />
        <ProposePlanToolCall
          args={{}}
          status="completed"
          content="# Another Plan\n\nDo the other thing."
          path={PLAN_PATH}
          workspaceId={WORKSPACE_ID}
          isEphemeralPreview={true}
        />
      </>
    );

    expect(view.getAllByRole("button", { name: "Annotate" }).length).toBe(2);

    fireEvent.keyDown(document, { key: "a", shiftKey: true });

    expect(view.queryByRole("button", { name: "Exit Annotate" })).toBeNull();
    expect(view.getAllByRole("button", { name: "Annotate" }).length).toBe(2);
  });

  test("switches to exec and sends a message when clicking Implement", async () => {
    const execModel = "openai:gpt-5.2";
    const execThinking = "low";

    startInPlanMode(WORKSPACE_ID, "anthropic:claude-sonnet-4-5", "high");
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {
      exec: { modelString: execModel, thinkingLevel: execThinking },
    });

    const sendMessageCalls: SendMessageArgs[] = [];
    mockApi = createMockApi({ sendMessage: recordSendMessage(sendMessageCalls) });

    const view = renderCompletedPlan();

    fireEvent.click(view.getByRole("button", { name: "Implement" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(sendMessageCalls[0]?.message).toBe("Implement the plan");
    expect(sendMessageCalls[0]?.options.agentId).toBe("exec");
    expect(sendMessageCalls[0]?.options.model).toBe(execModel);
    expect(sendMessageCalls[0]?.options.thinkingLevel).toBe(execThinking);
    // Both explicit choices opt out of composer Auto, per dimension.
    expect(sendMessageCalls[0]?.options.autoModelRouting).toBe(false);
    expect(sendMessageCalls[0]?.options.autoThinkingLevel).toBe(false);

    // Clicking Implement should switch the workspace agent to exec.
    //
    // Note: some tests in this repo mock the `usePersistedState` module globally. In that case,
    // `updatePersistedState` won't actually write to localStorage here, so we assert the call.
    const agentKey = getAgentIdKey(WORKSPACE_ID);
    const modelKey = getModelKey(WORKSPACE_ID);
    const thinkingKey = getThinkingLevelKey(WORKSPACE_ID);
    const updatePersistedStateMaybeMock = updatePersistedState as unknown as {
      mock?: { calls: unknown[][] };
    };
    if (updatePersistedStateMaybeMock.mock) {
      expect(updatePersistedState).toHaveBeenCalledWith(agentKey, "exec");
      expect(updatePersistedState).toHaveBeenCalledWith(modelKey, execModel);
      expect(updatePersistedState).toHaveBeenCalledWith(thinkingKey, execThinking);
    } else {
      expect(JSON.parse(window.localStorage.getItem(agentKey)!)).toBe("exec");
      expect(JSON.parse(window.localStorage.getItem(modelKey)!)).toBe(execModel);
      expect(JSON.parse(window.localStorage.getItem(thinkingKey)!)).toBe(execThinking);
    }
  });

  test("Implement keeps the exec model when the composer has Auto routing selected", async () => {
    // Same model in plan and exec: the agent switch persists nothing, so only the send can
    // drop the Auto flag.
    const execModel = "openai:gpt-5.2";
    startInPlanMode(WORKSPACE_ID, execModel, "high");
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, { exec: { modelString: execModel } });
    updatePersistedState(getExperimentKey(EXPERIMENT_IDS.AUTO_MODEL_ROUTING), true);
    updatePersistedState(getAutoModelRoutingKey(WORKSPACE_ID), true);

    const sendMessageCalls: SendMessageArgs[] = [];
    mockApi = createMockApi({ sendMessage: recordSendMessage(sendMessageCalls) });

    const view = renderCompletedPlan();
    fireEvent.click(view.getByRole("button", { name: "Implement" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(sendMessageCalls[0]?.options.model).toBe(execModel);
    expect(sendMessageCalls[0]?.options.autoModelRouting).not.toBe(true);
  });

  test("Implement sends unrouted, then leaves the composer on exec's Auto default", async () => {
    const execModel = "openai:gpt-5.2";
    startInPlanMode(WORKSPACE_ID, "anthropic:claude-sonnet-4-5", "high");
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {
      exec: { modelString: execModel, autoModelRouting: true, autoThinkingLevel: true },
    });
    updatePersistedState(getExperimentKey(EXPERIMENT_IDS.AUTO_MODEL_ROUTING), true);

    const sendMessageCalls: SendMessageArgs[] = [];
    mockApi = createMockApi({ sendMessage: recordSendMessage(sendMessageCalls) });

    const view = renderCompletedPlan();
    fireEvent.click(view.getByRole("button", { name: "Implement" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(sendMessageCalls[0]?.options.model).toBe(execModel);
    expect(sendMessageCalls[0]?.options.autoModelRouting).toBe(false);
    expect(sendMessageCalls[0]?.options.autoThinkingLevel).toBe(false);
    expect(readPersistedState(getAutoModelRoutingKey(WORKSPACE_ID), false)).toBe(true);
    expect(readPersistedState(getAutoThinkingLevelKey(WORKSPACE_ID), false)).toBe(true);
  });

  test("uses workspace-by-agent override for Implement when exec defaults inherit", async () => {
    const execWorkspaceModel = "openai:gpt-5.2-pro";
    const execWorkspaceThinking = "medium";

    startInPlanMode(WORKSPACE_ID, "anthropic:claude-sonnet-4-5", "high");
    updatePersistedState(AGENT_AI_DEFAULTS_KEY, {});
    updatePersistedState(getWorkspaceAISettingsByAgentKey(WORKSPACE_ID), {
      exec: { model: execWorkspaceModel, thinkingLevel: execWorkspaceThinking },
    });

    const sendMessageCalls: SendMessageArgs[] = [];
    mockApi = createMockApi({ sendMessage: recordSendMessage(sendMessageCalls) });

    const view = renderCompletedPlan();

    fireEvent.click(view.getByRole("button", { name: "Implement" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(sendMessageCalls[0]?.options.agentId).toBe("exec");
    expect(sendMessageCalls[0]?.options.model).toBe(execWorkspaceModel);
    expect(sendMessageCalls[0]?.options.thinkingLevel).toBe(execWorkspaceThinking);
  });

  test("replaces chat history before implementing when setting enabled", async () => {
    startInPlanMode();

    const calls: Array<"replaceChatHistory" | "sendMessage"> = [];
    const replaceChatHistoryCalls: Array<
      Parameters<MockApi["workspace"]["replaceChatHistory"]>[0]
    > = [];
    const sendMessageCalls: SendMessageArgs[] = [];

    mockApi = createMockApi({
      config: {
        ...DEFAULT_CONFIG,
        taskSettings: {
          ...DEFAULT_CONFIG.taskSettings,
          proposePlanImplementReplacesChatHistory: true,
        },
      },
      replaceChatHistory: (args) => {
        calls.push("replaceChatHistory");
        replaceChatHistoryCalls.push(args);
        return Promise.resolve({ success: true, data: undefined });
      },
      sendMessage: (args) => {
        calls.push("sendMessage");
        sendMessageCalls.push(args);
        return Promise.resolve({ success: true, data: {} });
      },
    });

    const view = renderCompletedPlan();

    fireEvent.click(view.getByRole("button", { name: "Implement" }));

    await waitFor(() => expect(sendMessageCalls.length).toBe(1));
    expect(replaceChatHistoryCalls.length).toBe(1);
    expect(calls).toEqual(["replaceChatHistory", "sendMessage"]);

    const replaceArgs = replaceChatHistoryCalls[0];
    expect(replaceArgs?.deletePlanFile).toBe(false);
    expect(replaceArgs?.mode).toBe("append-compaction-boundary");

    const summaryMessage = replaceArgs?.summaryMessage as {
      role?: string;
      metadata?: { agentId?: string };
      parts?: Array<{ type?: string; text?: string }>;
    };

    expect(summaryMessage.role).toBe("assistant");
    expect(summaryMessage.parts?.[0]?.text).toContain(
      "Note: This chat already contains the full plan"
    );
    expect(summaryMessage.metadata?.agentId).toBe("plan");
    expect(summaryMessage.parts?.[0]?.text).toContain("*Plan file preserved at:*");
    expect(summaryMessage.parts?.[0]?.text).toContain(PLAN_PATH);
  });

  test("disables Implement while the transcript is not caught up", async () => {
    startInPlanMode();
    transcriptCaughtUp = false;
    const sendMessageCalls: SendMessageArgs[] = [];
    mockApi = createMockApi({ sendMessage: recordSendMessage(sendMessageCalls) });

    const view = renderCompletedPlan();

    const implement = view.getByRole("button", { name: "Implement" }) as HTMLButtonElement;
    expect(implement.disabled).toBe(true);
    fireEvent.click(implement);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendMessageCalls).toHaveLength(0);
  });

  test("refuses Implement when the barrier closes before dispatch", async () => {
    startInPlanMode();
    const sendMessageCalls: SendMessageArgs[] = [];
    let configReads = 0;
    let closeBarrierOnConfigRead = true;
    mockApi = createMockApi({
      sendMessage: recordSendMessage(sendMessageCalls),
    });
    // The click passes the render-time gate; the transcript stops being current during the
    // config read that precedes the send, so the dispatch-time re-check must refuse.
    mockApi.config.getConfig = () => {
      configReads += 1;
      if (closeBarrierOnConfigRead) {
        transcriptCaughtUp = false;
      }
      return Promise.resolve(DEFAULT_CONFIG);
    };

    const planElement = (
      <ProposePlanToolCall
        args={{}}
        workspaceId={WORKSPACE_ID}
        status="completed"
        result={{ success: true, planPath: PLAN_PATH, planContent: PLAN_CONTENT }}
        isLatest
      />
    );
    const view = renderToolCall(planElement);
    const implement = view.getByRole("button", { name: "Implement" }) as HTMLButtonElement;
    expect(implement.disabled).toBe(false);
    fireEvent.click(implement);

    await waitFor(() => expect(configReads).toBe(1));
    // Let the handler's remaining microtasks settle before asserting nothing was sent.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendMessageCalls).toHaveLength(0);

    // Control: with the barrier open again the same click path dispatches. The spy flip does
    // not notify the store, so re-render to re-read the render-time gate.
    transcriptCaughtUp = true;
    closeBarrierOnConfigRead = false;
    view.rerender(wrapToolCall(planElement));
    const implementAgain = view.getByRole("button", { name: "Implement" }) as HTMLButtonElement;
    expect(implementAgain.disabled).toBe(false);
    fireEvent.click(implementAgain);
    await waitFor(() => expect(sendMessageCalls).toHaveLength(1));
    expect(sendMessageCalls[0]?.message).toBe("Implement the plan");
  });

  describe("admin policy excludes the target agent's model (#4980)", () => {
    const EXEC_MODEL = "openai:gpt-5.2";
    const PLAN_MODEL = "anthropic:claude-sonnet-4-5";
    const ONLY_ANTHROPIC_POLICY = {
      source: "governor" as const,
      status: { state: "enforced" as const },
      policy: {
        policyFormatVersion: "0.1" as const,
        providerAccess: [{ id: "anthropic" as const, allowedModels: null }],
        mcp: { allowUserDefined: { stdio: true, remote: true } },
        runtimes: null,
      },
    };

    const PROVIDERS_CONFIG = {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
      anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    // Both providers have credentials and routing is loaded (default priority), so the exec
    // model routes directly to openai.
    function withProvidersConfig() {
      spyOn(getProvidersConfigStore(), "getConfig").mockReturnValue(PROVIDERS_CONFIG);
      spyOn(getAppConfigStore(), "getSnapshot").mockReturnValue({});
    }

    async function renderWithEnforcedPolicy(sendMessageCalls: SendMessageArgs[]) {
      startInPlanMode(WORKSPACE_ID, PLAN_MODEL, "high");
      updatePersistedState(AGENT_AI_DEFAULTS_KEY, { exec: { modelString: EXEC_MODEL } });
      let policyAnswer: Promise<typeof ONLY_ANTHROPIC_POLICY> | null = null;
      mockApi = createMockApi({ sendMessage: recordSendMessage(sendMessageCalls) });
      mockApi.policy = {
        get: () => {
          policyAnswer = Promise.resolve(ONLY_ANTHROPIC_POLICY);
          return policyAnswer;
        },
      };
      const view = renderCompletedPlan();
      await waitFor(() => expect(policyAnswer).not.toBeNull());
      // Flush PolicyProvider's state update for the answer before the click reads it.
      await act(async () => {
        await policyAnswer;
      });
      return view;
    }

    test("refuses Implement before switching agents and says why", async () => {
      withProvidersConfig();
      const sendMessageCalls: SendMessageArgs[] = [];
      const view = await renderWithEnforcedPolicy(sendMessageCalls);

      fireEvent.click(view.getByRole("button", { name: "Implement" }));

      await waitFor(() => expect(view.getByRole("alert").textContent).toContain(EXEC_MODEL));
      expect(sendMessageCalls).toHaveLength(0);
      // Nothing was switched: the composer stays on the plan agent and its model.
      expect(readPersistedState(getAgentIdKey(WORKSPACE_ID), "")).toBe("plan");
      expect(readPersistedState(getModelKey(WORKSPACE_ID), "")).toBe(PLAN_MODEL);
      expect((view.getByRole("button", { name: "Implement" }) as HTMLButtonElement).disabled).toBe(
        false
      );
    });

    // Without the providers config or the routing config, the active route is unknown (a
    // gateway route may be allowed).
    test.each([
      ["providers", null, {}],
      ["routing", PROVIDERS_CONFIG, null],
    ] as const)(
      "leaves the decision to the backend until the %s config is known",
      async (_name, providersConfig, appConfig) => {
        spyOn(getProvidersConfigStore(), "getConfig").mockReturnValue(providersConfig);
        spyOn(getAppConfigStore(), "getSnapshot").mockReturnValue(appConfig);
        const sendMessageCalls: SendMessageArgs[] = [];
        const view = await renderWithEnforcedPolicy(sendMessageCalls);

        fireEvent.click(view.getByRole("button", { name: "Implement" }));

        await waitFor(() => expect(sendMessageCalls).toHaveLength(1));
        expect(sendMessageCalls[0]?.options.model).toBe(EXEC_MODEL);
        expect(view.queryByRole("alert")).toBeNull();
      }
    );
  });

  test("shows a rejected Implement send in the card", async () => {
    startInPlanMode();
    let sends = 0;
    mockApi = createMockApi({
      sendMessage: () => {
        sends += 1;
        return Promise.resolve({
          success: false,
          error: { type: "policy_denied", message: "Model openai:gpt-5.2 is not allowed" },
        });
      },
    });

    const view = renderCompletedPlan();
    fireEvent.click(view.getByRole("button", { name: "Implement" }));

    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain("Model openai:gpt-5.2 is not allowed")
    );
    expect(sends).toBe(1);
  });

  test("shows a failed Continue in Auto send in the card and clears it on retry", async () => {
    startInPlanMode();
    let failNext = true;
    const sendMessageCalls: SendMessageArgs[] = [];
    mockApi = createMockApi({
      sendMessage: (args) => {
        sendMessageCalls.push(args);
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("connection lost"));
        }
        return Promise.resolve({ success: true, data: {} });
      },
    });

    const view = renderToolCall(
      <ProposePlanToolCall
        args={{}}
        workspaceId={WORKSPACE_ID}
        status="completed"
        result={{ success: true, planPath: PLAN_PATH, planContent: PLAN_CONTENT }}
        isLatest
      />,
      "auto"
    );
    fireEvent.click(view.getByRole("button", { name: "Continue in Auto" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("connection lost"));

    fireEvent.click(view.getByRole("button", { name: "Continue in Auto" }));
    await waitFor(() => expect(sendMessageCalls).toHaveLength(2));
    await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
  });

  test("renders a plan table of contents derived from the plan's markdown headings", () => {
    // Note: we deliberately don't assert against rendered <h1>/<h2> elements here
    // because some sibling test files mock MarkdownCore at file scope (file-scope
    // module mocks persist across files in this runner). The TOC's source of truth
    // is the markdown TEXT, not the rendered DOM, so this assertion stays robust.
    const planContent = [
      "# Title",
      "",
      "intro paragraph",
      "",
      "## Section A",
      "",
      "body",
      "",
      "## Section B",
      "",
      "more",
    ].join("\n");

    const view = renderCompletedPlan({
      result: { success: true, planPath: PLAN_PATH, planContent },
    });

    const toc = view.getByTestId("plan-toc");
    expect(toc.textContent).toContain("Title");
    expect(toc.textContent).toContain("Section A");
    expect(toc.textContent).toContain("Section B");

    // Each entry is a real <button>, so the user can drive navigation with the
    // keyboard. The dedicated PlanTableOfContents.test.tsx verifies the
    // scrollIntoView wiring directly.
    expect(view.getByRole("button", { name: "Section A" })).toBeDefined();
    expect(view.getByRole("button", { name: "Section B" })).toBeDefined();
  });

  test("does not render a plan TOC for plans with fewer than two visible headings", () => {
    // PLAN_CONTENT only has one heading ("# My Plan"), so the TOC should not appear.
    const view = renderCompletedPlan();
    expect(view.queryByTestId("plan-toc")).toBeNull();
  });

  test("does not render a plan TOC while annotate mode is active", () => {
    // Need at least two h2+ entries; h1 is reserved for the TOC's heading
    // (the plan title) and never shows up as a list item.
    const planContent = "# A\n\nbody\n\n## B\n\nmore\n\n## C\n\nmore";
    const view = renderCompletedPlan({
      result: { success: true, planPath: PLAN_PATH, planContent },
    });

    // Sanity: TOC is visible before annotate mode.
    expect(view.queryByTestId("plan-toc")).not.toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Annotate" }));

    expect(view.queryByTestId("plan-toc")).toBeNull();
  });
});
