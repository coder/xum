import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test";
import type { WorkspaceService } from "./workspaceService";
import type { AgentSession } from "./agentSession";
import { Err, Ok, type Result } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import { createTestHistoryService } from "./testHistoryService";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import type { GoalRecordV1 } from "@/common/types/goal";
import {
  hasBudgetedResumableGoal,
  modelHasPricingData,
  UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
} from "@/common/utils/goals/budgetPricing";
import {
  createCompactionAdmissionMocks,
  createMockAIService,
  createWorkspaceServiceForTest,
  createWorkspaceServiceHarness,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";
import { saveWorkspaces } from "./taskService.testHarness";

describe("WorkspaceService sendMessage AI settings persistence", () => {
  // Backend-initiated turns (peer messages, task wakes, heartbeats) carry the recipient's
  // resolved agent/model/thinking as send options. The remembered selection must survive such a
  // send unchanged while an otherwise identical user-authored send still updates it. The status
  // clearing suite above only proves the persistence hook is skipped; this reads the real config.
  // agentId: a different built-in, a custom agent, and the already-selected agent.
  test.each([
    [true, "plan"],
    [false, "plan"],
    [false, "reviewer"],
    [false, "exec"],
  ] as const)(
    "persists agent and AI settings only for non-synthetic sends (synthetic=%s, agentId=%s)",
    async (synthetic, agentId) => {
      const { config, historyService, cleanup } = await createTestHistoryService();
      try {
        const workspaceId = `settings-persistence-${synthetic ? "synthetic" : "manual"}-${agentId}`;
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
          // Persisted settings are published to the registered session.
          emitMetadata: mock(() => undefined),
          // registerSession subscribes to both streams.
          onChatEvent: mock(() => () => undefined),
          onMetadataEvent: mock(() => () => undefined),
        };
        // The production injection point for an externally created session (`mux run`).
        workspaceService.registerSession(workspaceId, fakeSession as unknown as AgentSession);

        const result = await workspaceService.sendMessage(
          workspaceId,
          "hello",
          { agentId, model: "openai:gpt-5.2", thinkingLevel: "high" },
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
                agentId,
                // The legacy root bucket is never rewritten by a send; only the per-agent
                // bucket of the selected agent changes.
                aiSettings: remembered.aiSettings,
                aiSettingsByAgent: {
                  ...remembered.aiSettingsByAgent,
                  [agentId]: { model: "openai:gpt-5.2", thinkingLevel: "high" },
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
      // Persisted settings are published to the registered session.
      emitMetadata: mock(() => undefined),
      // registerSession subscribes to both streams.
      onChatEvent: mock(() => () => undefined),
      onMetadataEvent: mock(() => () => undefined),
    };
    // The production injection point for an externally created session (`mux run`).
    workspaceService.registerSession(workspaceId, fakeSession as unknown as AgentSession);
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
  const projectPath = "/tmp/proj";
  const workspacePath = "/tmp/proj/ws";
  let workspaceService: WorkspaceService;
  let harness: WorkspaceServiceHarness;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness({
      aiService: createMockAIService({ isStreaming: mock(() => false) }),
    });
    workspaceService = harness.service;
    await saveWorkspaces(harness.config, projectPath, [
      { id: "ws", path: workspacePath, name: "ws" },
    ]);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const readEntry = () =>
    harness.config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((workspace) => workspace.id === "ws");

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
    workspaceService.setWorkspaceGoalService({
      // No goal record (or one without a budget) — the gate must pass through.
      getGoal: mock(() => Promise.resolve(null)),
    } as unknown as WorkspaceGoalService);

    const result = await workspaceService.updateAgentAISettings("ws", "exec", {
      model: "openai:not-priced-model",
      thinkingLevel: "off",
    });

    expect(result.success).toBe(true);
    expect(readEntry()?.aiSettingsByAgent?.exec).toEqual({
      model: "openai:not-priced-model",
      thinkingLevel: "off",
    });
  });

  test("persists AI settings for sub-agent workspaces so auto-resume can use latest model", async () => {
    interface WorkspaceServiceTestAccess {
      maybePersistAISettingsFromOptions: (workspaceId: string, options: unknown) => Promise<void>;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;

    await saveWorkspaces(harness.config, projectPath, [
      { id: "ws", path: workspacePath, name: "ws", parentWorkspaceId: "parent-ws" },
    ]);

    await svc.maybePersistAISettingsFromOptions("ws", {
      agentId: "exec",
      model: "openai:gpt-4o-mini",
      thinkingLevel: "off",
    });

    const entry = readEntry();
    expect(entry?.parentWorkspaceId).toBe("parent-ws");
    expect(entry?.agentId).toBe("exec");
    expect(entry?.aiSettingsByAgent?.exec).toEqual({
      model: "openai:gpt-4o-mini",
      thinkingLevel: "off",
    });
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
  let harness: WorkspaceServiceHarness;

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
    harness = await createWorkspaceServiceHarness({
      aiService: createMockAIService({ isStreaming: mock(() => false) }),
    });
    workspaceService = harness.service;
  });

  afterEach(async () => {
    await harness.cleanup();
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
