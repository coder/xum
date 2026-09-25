import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { ContextManagementService } from "./contextManagement/contextManagementService";
import { WorkspaceService } from "./workspaceService";
import type { AgentSession } from "./agentSession";
import { createStreamLifecycleMocks } from "./agentSession.testHarness";
import { Err, Ok, type Result } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import type { AIService } from "./aiService";
import type { InitStateManager } from "./initStateManager";
import type { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import type { GoalRecordV1 } from "@/common/types/goal";
import {
  hasBudgetedResumableGoal,
  modelHasPricingData,
  UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
} from "@/common/utils/goals/budgetPricing";
import type { MockWorkspaceConfig } from "./workspaceService.testHarness";
import {
  createCompactionAdmissionMocks,
  createMockAIService,
  createWorkspaceServiceForTest,
} from "./workspaceService.testHarness";

describe("WorkspaceService sendMessage AI settings persistence", () => {
  // Backend-initiated turns (peer messages, task wakes, heartbeats) carry the recipient's
  // resolved agent/model/thinking as send options. The remembered selection must survive such a
  // send unchanged while an otherwise identical user-authored send still updates it. The status
  // clearing suite above only proves the persistence hook is skipped; this reads the real config.
  test.each([true, false])(
    "persists agent and AI settings only for non-synthetic sends (synthetic=%s)",
    async (synthetic) => {
      const { config, historyService, cleanup } = await createTestHistoryService();
      try {
        const workspaceId = `settings-persistence-${synthetic ? "synthetic" : "manual"}`;
        const projectPath = "/tmp/settings-persistence-project";
        const remembered = {
          agentId: "exec",
          aiSettings: { model: "anthropic:claude-sonnet-4-5", thinkingLevel: "medium" as const },
          aiSettingsByAgent: {
            exec: { model: "anthropic:claude-sonnet-4-5", thinkingLevel: "medium" as const },
          },
        };
        await config.addWorkspace(projectPath, {
          id: workspaceId,
          name: workspaceId,
          projectName: "settings-persistence-project",
          projectPath,
          runtimeConfig: { type: "local" },
          ...remembered,
        });

        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          aiService: createMockAIService({ isStreaming: mock(() => false) }),
        });
        const fakeSession = {
          ...createCompactionAdmissionMocks(),
          isBusy: mock(() => false),
          hasQueuedMessages: mock(() => false),
          hasQueuedOrDispatchingEntry: mock(() => false),
          dropQueuedMessageWithOnlyDedupeKey: mock(() => false),
          queueMessage: mock(() => "tool-end" as const),
          sendMessage: mock(() => Promise.resolve(Ok(undefined))),
          drainQueuedMessagesIfIdle: mock(() => undefined),
        };
        (
          workspaceService as unknown as {
            getOrCreateSession: (workspaceId: string) => AgentSession;
          }
        ).getOrCreateSession = mock(() => fakeSession as unknown as AgentSession);

        const result = await workspaceService.sendMessage(
          workspaceId,
          "hello",
          { agentId: "plan", model: "openai:gpt-5.2", thinkingLevel: "high" },
          synthetic ? { synthetic: true } : undefined
        );

        expect(result.success).toBe(true);
        expect(fakeSession.sendMessage).toHaveBeenCalledTimes(1);
        const entry = config
          .loadConfigOrDefault()
          .projects.get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === workspaceId);
        expect(entry).toBeDefined();
        const persisted = {
          agentId: entry?.agentId,
          aiSettings: entry?.aiSettings,
          aiSettingsByAgent: entry?.aiSettingsByAgent,
        };
        expect(persisted).toEqual(
          synthetic
            ? remembered
            : {
                agentId: "plan",
                // The legacy root bucket is never rewritten by a send; only the per-agent
                // bucket of the selected agent changes.
                aiSettings: remembered.aiSettings,
                aiSettingsByAgent: {
                  ...remembered.aiSettingsByAgent,
                  plan: { model: "openai:gpt-5.2", thinkingLevel: "high" },
                },
              }
        );
      } finally {
        await cleanup();
      }
    }
  );
});

describe("WorkspaceService sendMessage AI selection pins", () => {
  const SONNET = "anthropic:claude-sonnet-4-5";
  const GPT = "openai:gpt-5.2";

  async function setupPinFixture(entry: {
    parentWorkspaceId?: string;
    taskAiPins?: { model?: string; thinkingLevel?: "high" | "medium" };
    busy?: boolean;
    /** The session refuses the send before acceptance (onAccepted never runs). */
    refuse?: boolean;
  }) {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "pin-child";
    const projectPath = "/tmp/pin-project";
    await config.addWorkspace(projectPath, {
      id: workspaceId,
      name: workspaceId,
      projectName: "pin-project",
      projectPath,
      runtimeConfig: { type: "local" },
    });
    await config.editConfig((cfg) => {
      const workspace = cfg.projects
        .get(projectPath)
        ?.workspaces.find((candidate) => candidate.id === workspaceId);
      if (workspace == null) throw new Error("pin fixture workspace missing");
      workspace.agentId = "exec";
      workspace.aiSettingsByAgent = { exec: { model: SONNET, thinkingLevel: "medium" } };
      if (entry.parentWorkspaceId != null) workspace.parentWorkspaceId = entry.parentWorkspaceId;
      if (entry.taskAiPins != null) workspace.taskAiPins = entry.taskAiPins;
      return cfg;
    });
    const workspaceService = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: createMockAIService({ isStreaming: mock(() => false) }),
    });
    const fakeSession = {
      ...createCompactionAdmissionMocks(),
      isBusy: mock(() => entry.busy === true),
      hasQueuedMessages: mock(() => false),
      hasQueuedOrDispatchingEntry: mock(() => false),
      dropQueuedMessageWithOnlyDedupeKey: mock(() => false),
      queueMessage: mock(() => "tool-end" as const),
      // Mirrors AgentSession: acceptance runs onAccepted; a refusal returns before it.
      sendMessage: mock(
        async (_message: string, _options: unknown, internal?: { onAccepted?: () => unknown }) => {
          if (entry.refuse === true) {
            return Err({ type: "unknown" as const, raw: "admission refused" });
          }
          await internal?.onAccepted?.();
          return Ok(undefined);
        }
      ),
      drainQueuedMessagesIfIdle: mock(() => undefined),
    };
    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = mock(() => fakeSession as unknown as AgentSession);
    const readEntry = () =>
      config
        .loadConfigOrDefault()
        .projects.get(projectPath)
        ?.workspaces.find((workspace) => workspace.id === workspaceId);
    return { config, workspaceService, fakeSession, workspaceId, readEntry, cleanup };
  }

  const CHILD = { parentWorkspaceId: "pin-parent", taskAiPins: {} };

  test("deliberate picks pin the sent values, including a same-value pick", async () => {
    const fixture = await setupPinFixture(CHILD);
    try {
      const result = await fixture.workspaceService.sendMessage(fixture.workspaceId, "hi", {
        agentId: "exec",
        model: SONNET,
        thinkingLevel: "medium",
        aiSelectionIntent: { model: true },
      });
      expect(result.success).toBe(true);
      expect(fixture.readEntry()?.taskAiPins).toEqual({ model: SONNET });

      await fixture.workspaceService.sendMessage(fixture.workspaceId, "again", {
        agentId: "exec",
        model: GPT,
        thinkingLevel: "high",
        aiSelectionIntent: { model: true, thinkingLevel: true },
      });
      expect(fixture.readEntry()?.taskAiPins).toEqual({ model: GPT, thinkingLevel: "high" });
    } finally {
      await fixture.cleanup();
    }
  });

  test("a send refused before acceptance pins nothing", async () => {
    const fixture = await setupPinFixture({ ...CHILD, refuse: true });
    try {
      const result = await fixture.workspaceService.sendMessage(fixture.workspaceId, "hi", {
        agentId: "exec",
        model: GPT,
        thinkingLevel: "high",
        aiSelectionIntent: { model: true },
      });
      expect(result.success).toBe(false);
      expect(fixture.readEntry()?.taskAiPins).toEqual({});
    } finally {
      await fixture.cleanup();
    }
  });

  test("a queued send pins when it is enqueued", async () => {
    const fixture = await setupPinFixture({ ...CHILD, busy: true });
    try {
      const result = await fixture.workspaceService.sendMessage(fixture.workspaceId, "hi", {
        agentId: "exec",
        model: GPT,
        thinkingLevel: "high",
        aiSelectionIntent: { model: true },
      });
      // The renderer consumes the pick on this success, so the pin must already be durable
      // even if the queued entry is cleared before it dispatches.
      expect(result.success).toBe(true);
      expect(fixture.fakeSession.queueMessage).toHaveBeenCalled();
      expect(fixture.readEntry()?.taskAiPins).toEqual({ model: GPT });
    } finally {
      await fixture.cleanup();
    }
  });

  test("a send without intent pins nothing even when values change", async () => {
    const fixture = await setupPinFixture(CHILD);
    try {
      await fixture.workspaceService.sendMessage(fixture.workspaceId, "hi", {
        agentId: "exec",
        model: GPT,
        thinkingLevel: "high",
      });
      expect(fixture.readEntry()?.taskAiPins).toEqual({});
      expect(fixture.readEntry()?.aiSettingsByAgent?.exec?.model).toBe(GPT);
    } finally {
      await fixture.cleanup();
    }
  });

  test.each([
    { name: "automatic", internal: { acceptanceOrigin: "automatic" as const } },
    { name: "agentInitiated", internal: { agentInitiated: true } },
    { name: "synthetic", internal: { synthetic: true } },
    { name: "skipAiSettingsPersistence", internal: undefined, skip: true },
  ])("intent is ignored for $name sends", async (row) => {
    const fixture = await setupPinFixture(CHILD);
    try {
      await fixture.workspaceService.sendMessage(
        fixture.workspaceId,
        "hi",
        {
          agentId: "exec",
          model: GPT,
          thinkingLevel: "high",
          aiSelectionIntent: { model: true },
          ...(row.skip === true ? { skipAiSettingsPersistence: true } : {}),
        },
        row.internal
      );
      expect(fixture.readEntry()?.taskAiPins).toEqual({});
    } finally {
      await fixture.cleanup();
    }
  });

  test.each([
    { name: "top-level workspaces", entry: {}, agentId: "exec", expected: undefined },
    {
      name: "legacy children",
      entry: { parentWorkspaceId: "pin-parent" },
      agentId: "exec",
      expected: undefined,
    },
    { name: "a mismatched agent", entry: CHILD, agentId: "plan", expected: {} },
  ])("intent is ignored for $name", async (row) => {
    const fixture = await setupPinFixture(row.entry);
    try {
      await fixture.workspaceService.sendMessage(fixture.workspaceId, "hi", {
        agentId: row.agentId,
        model: GPT,
        thinkingLevel: "high",
        aiSelectionIntent: { model: true },
      });
      expect(fixture.readEntry()?.taskAiPins).toEqual(row.expected);
    } finally {
      await fixture.cleanup();
    }
  });

  test("repeating the same pinned send writes nothing new", async () => {
    const fixture = await setupPinFixture(CHILD);
    try {
      const options = {
        agentId: "exec",
        model: GPT,
        thinkingLevel: "high" as const,
        aiSelectionIntent: { model: true as const },
      };
      await fixture.workspaceService.sendMessage(fixture.workspaceId, "hi", options);
      const editConfig = spyOn(fixture.config, "editConfig");
      try {
        await fixture.workspaceService.sendMessage(fixture.workspaceId, "hi again", options);
        expect(editConfig).not.toHaveBeenCalled();
      } finally {
        editConfig.mockRestore();
      }
      expect(fixture.readEntry()?.taskAiPins).toEqual({ model: GPT });
    } finally {
      await fixture.cleanup();
    }
  });

  test.each([false, true])(
    "intent is stripped before AgentSession and the queue (busy=%s)",
    async (busy) => {
      const fixture = await setupPinFixture({ ...CHILD, busy });
      try {
        await fixture.workspaceService.sendMessage(fixture.workspaceId, "hi", {
          agentId: "exec",
          model: GPT,
          thinkingLevel: "high",
          aiSelectionIntent: { model: true },
        });
        const forwarded = busy
          ? fixture.fakeSession.queueMessage.mock.calls.at(-1)
          : fixture.fakeSession.sendMessage.mock.calls.at(-1);
        expect(forwarded).toBeDefined();
        const forwardedOptions = (forwarded as unknown[] | undefined)?.[1] as Record<
          string,
          unknown
        >;
        expect(forwardedOptions.model).toBe(GPT);
        expect("aiSelectionIntent" in forwardedOptions).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    }
  );
});

describe("WorkspaceService maybePersistAISettingsFromOptions", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    const aiService: AIService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve({ success: false as const, error: "nope" })),
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const workspacePath = "/tmp/proj/ws";
    const projectPath = "/tmp/proj";
    const mockConfig: MockWorkspaceConfig = {
      srcDir: "/tmp/test",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((workspaceId: string) =>
        workspaceId === "ws" ? { projectPath, workspacePath } : null
      ),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [
                {
                  id: "ws",
                  path: workspacePath,
                  name: "ws",
                },
              ],
            },
          ],
        ]),
      })),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("refuses unpriced model persistence for budgeted active goals", async () => {
    workspaceService.setWorkspaceGoalService({
      getGoal: mock(() => Promise.resolve({ status: "active", budgetCents: 500 })),
    } as unknown as WorkspaceGoalService);

    const result = await workspaceService.updateAgentAISettings("ws", "exec", {
      model: "openai:not-priced-model",
      thinkingLevel: "off",
    });

    expect(result).toEqual({
      success: false,
      error: "Target model has no pricing data. Pick a priced model before switching.",
    });
  });

  test("allows unpriced model persistence when no budgeted goal is active", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));
    workspaceService.setWorkspaceGoalService({
      // No goal record (or one without a budget) — the gate must pass through.
      getGoal: mock(() => Promise.resolve(null)),
    } as unknown as WorkspaceGoalService);
    (
      workspaceService as unknown as {
        persistWorkspaceAISettingsForAgent: (...args: unknown[]) => unknown;
      }
    ).persistWorkspaceAISettingsForAgent = persistSpy;

    const result = await workspaceService.updateAgentAISettings("ws", "exec", {
      model: "openai:not-priced-model",
      thinkingLevel: "off",
    });

    expect(result.success).toBe(true);
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  test("persists agent AI settings for custom agent", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));

    interface WorkspaceServiceTestAccess {
      maybePersistAISettingsFromOptions: (workspaceId: string, options: unknown) => Promise<void>;
      persistWorkspaceAISettingsForAgent: (...args: unknown[]) => unknown;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.persistWorkspaceAISettingsForAgent = persistSpy;

    await svc.maybePersistAISettingsFromOptions("ws", {
      agentId: "reviewer",
      model: "openai:gpt-4o-mini",
      thinkingLevel: "off",
    });

    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  test("persists agent AI settings when agentId matches", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));

    interface WorkspaceServiceTestAccess {
      maybePersistAISettingsFromOptions: (workspaceId: string, options: unknown) => Promise<void>;
      persistWorkspaceAISettingsForAgent: (...args: unknown[]) => unknown;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.persistWorkspaceAISettingsForAgent = persistSpy;

    await svc.maybePersistAISettingsFromOptions("ws", {
      agentId: "exec",
      model: "openai:gpt-4o-mini",
      thinkingLevel: "off",
    });

    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  test("persists AI settings for sub-agent workspaces so auto-resume can use latest model", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));

    interface WorkspaceServiceTestAccess {
      maybePersistAISettingsFromOptions: (workspaceId: string, options: unknown) => Promise<void>;
      persistWorkspaceAISettingsForAgent: (...args: unknown[]) => unknown;
      config: {
        findWorkspace: (
          workspaceId: string
        ) => { projectPath: string; workspacePath: string } | null;
        loadConfigOrDefault: () => {
          projects: Map<string, { workspaces: Array<Record<string, unknown>> }>;
        };
      };
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.persistWorkspaceAISettingsForAgent = persistSpy;

    const projectPath = "/tmp/proj";
    const workspacePath = "/tmp/proj/ws";
    svc.config.findWorkspace = mock((workspaceId: string) =>
      workspaceId === "ws" ? { projectPath, workspacePath } : null
    );
    svc.config.loadConfigOrDefault = mock(() => ({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: "ws",
                path: workspacePath,
                name: "ws",
                parentWorkspaceId: "parent-ws",
              },
            ],
          },
        ],
      ]),
    }));

    await svc.maybePersistAISettingsFromOptions("ws", {
      agentId: "exec",
      model: "openai:gpt-4o-mini",
      thinkingLevel: "off",
    });

    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledWith(
      "ws",
      "exec",
      { model: "openai:gpt-4o-mini", thinkingLevel: "off" },
      { persistSelectedAgentId: true }
    );
  });
});

// ---------------------------------------------------------------------------
// assertPricedModelForBudgetedGoal — pre-stream gate that rejects unpriced
// models for budgeted resumable goals (active/paused/budget_limited).
//
// Codex P1 (PRRT_kwDOPxxmWM5_sN02) flagged that a persistence-only skip is
// not enough: the request still flows into session.sendMessage and accounting
// records 0 cost on an unpriced model, silently bypassing budget enforcement.
// These tests pin the new pre-dispatch gate so a future regression that puts
// the check back inside maybePersistAISettingsFromOptions is caught.
// ---------------------------------------------------------------------------
describe("WorkspaceService assertPricedModelForBudgetedGoal", () => {
  interface GateOptions {
    model?: string;
    skipAiSettingsPersistence?: boolean;
  }
  interface GateAccess {
    assertPricedModelForBudgetedGoal: (
      workspaceId: string,
      options: GateOptions | undefined
    ) => Promise<Result<void, SendMessageError>>;
  }
  const UNPRICED = "openai:not-priced-model";
  const PRICED = "openai:gpt-4o-mini";
  let workspaceService: WorkspaceService;
  let cleanupHistory: () => Promise<void>;

  async function makeService(): Promise<WorkspaceService> {
    const aiService = {
      ...createStreamLifecycleMocks(),
      isStreaming: mock(() => false),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
    const { historyService, cleanup } = await createTestHistoryService();
    cleanupHistory = cleanup;
    const config = {
      srcDir: "/tmp/test",
      sessionsDir: "/tmp/test/sessions",
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    } as unknown as Config;
    return new WorkspaceService(
      config,
      historyService,
      aiService,
      new ContextManagementService({ config, historyService, aiService }),
      {
        on: mock(() => undefined),
        getInitState: mock(() => undefined),
      } as unknown as InitStateManager,
      {} as ExtensionMetadataService,
      { cleanup: mock(() => Promise.resolve()) } as unknown as BackgroundProcessManager
    );
  }

  function setGoal(goal: GoalRecordV1 | null): void {
    // Mock the canonical WorkspaceGoalService.assertPricedModelForBudgetedGoal
    // by composing the same primitives the real implementation uses (model
    // pricing + hasBudgetedResumableGoal). This keeps the gate behaviour in
    // one place — the test still exercises the WS-side delegation contract.
    const fakeGoalService: Pick<
      WorkspaceGoalService,
      "getGoal" | "assertPricedModelForBudgetedGoal"
    > = {
      getGoal: mock(() => Promise.resolve(goal)),
      assertPricedModelForBudgetedGoal: mock((_workspaceId: string, model?: string) => {
        if (!model || modelHasPricingData(model)) {
          return Promise.resolve(Ok(undefined));
        }
        if (!hasBudgetedResumableGoal(goal)) {
          return Promise.resolve(Ok(undefined));
        }
        return Promise.resolve(
          Err({ type: "unknown" as const, raw: UNPRICED_TARGET_MODEL_GOAL_MESSAGE })
        );
      }),
    };
    workspaceService.setWorkspaceGoalService(fakeGoalService as unknown as WorkspaceGoalService);
  }

  function callGate(options: GateOptions | undefined): Promise<Result<void, SendMessageError>> {
    return (workspaceService as unknown as GateAccess).assertPricedModelForBudgetedGoal(
      "ws",
      options
    );
  }

  beforeEach(async () => {
    workspaceService = await makeService();
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test.each([
    ["active", { status: "active" as const, budgetCents: 500 }],
    ["paused", { status: "paused" as const, budgetCents: 500 }],
    ["budget_limited", { status: "budget_limited" as const, budgetCents: 500 }],
  ])("rejects unpriced model on %s budgeted goal", async (_label, partial) => {
    setGoal(partial as unknown as GoalRecordV1);
    const result = await callGate({ model: UNPRICED });
    expect(result.success).toBe(false);
    if (!result.success) {
      const error = result.error;
      expect(typeof error === "object" && error.type === "unknown").toBe(true);
      if (typeof error === "object" && error.type === "unknown") {
        expect(error.raw).toContain("Target model has no pricing data");
      }
    }
  });

  test("allows priced models even on budgeted active goals", async () => {
    setGoal({ status: "active", budgetCents: 500 } as unknown as GoalRecordV1);
    const result = await callGate({ model: PRICED });
    expect(result.success).toBe(true);
  });

  test("allows when no goal exists", async () => {
    setGoal(null);
    const result = await callGate({ model: UNPRICED });
    expect(result.success).toBe(true);
  });

  test("allows when goal has no budget", async () => {
    setGoal({ status: "active", budgetCents: null } as unknown as GoalRecordV1);
    const result = await callGate({ model: UNPRICED });
    expect(result.success).toBe(true);
  });

  test("allows terminal goals (complete) regardless of model", async () => {
    setGoal({ status: "complete", budgetCents: 500 } as unknown as GoalRecordV1);
    const result = await callGate({ model: UNPRICED });
    expect(result.success).toBe(true);
  });

  test("ignores client-controlled skipAiSettingsPersistence flag", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM5_sh1R): `skipAiSettingsPersistence` is part
    // of the public SendMessageOptionsSchema and forwarded verbatim by the
    // router, so a direct API caller could otherwise flip this single bool
    // to disarm the gate while running an unpriced model on a budgeted goal.
    // The gate must reject regardless of the flag.
    setGoal({ status: "active", budgetCents: 500 } as unknown as GoalRecordV1);
    const result = await callGate({ model: UNPRICED, skipAiSettingsPersistence: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      const error = result.error;
      expect(typeof error === "object" && error.type === "unknown").toBe(true);
      if (typeof error === "object" && error.type === "unknown") {
        expect(error.raw).toContain("Target model has no pricing data");
      }
    }
  });

  test("delegates to WorkspaceGoalService.assertPricedModelForBudgetedGoal", async () => {
    // Pin the WS → WorkspaceGoalService delegation contract: WS must not
    // re-implement the gate, otherwise we'd reintroduce the original bug
    // where queued messages bypassed it. See workspaceGoalService.test.ts
    // for the canonical priced-model short-circuit + rejection coverage.
    const assertPricedModelForBudgetedGoal = mock(() =>
      Promise.resolve(Ok(undefined) as Result<void, SendMessageError>)
    );
    workspaceService.setWorkspaceGoalService({
      getGoal: mock(() => Promise.resolve(null)),
      assertPricedModelForBudgetedGoal,
    } as unknown as WorkspaceGoalService);

    const result = await callGate({ model: PRICED });

    expect(result.success).toBe(true);
    expect(assertPricedModelForBudgetedGoal).toHaveBeenCalledTimes(1);
    expect(assertPricedModelForBudgetedGoal).toHaveBeenCalledWith("ws", PRICED);
  });

  test("allows when no model is provided (caller will fall back later)", async () => {
    setGoal({ status: "active", budgetCents: 500 } as unknown as GoalRecordV1);
    const result = await callGate({});
    expect(result.success).toBe(true);
  });
});
