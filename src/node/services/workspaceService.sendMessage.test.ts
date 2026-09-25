import type { TurnCompletion } from "./streamManager";
import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test";
import type { WorkspaceService } from "./workspaceService";
import type { IdleCompactionOutcome } from "./idleCompactionService";
import type { AgentSession } from "./agentSession";
import { createAgentSessionHarness, createStartedTurnHandle } from "./agentSession.testHarness";
import { askUserQuestionManager } from "./askUserQuestionManager";
import { EventEmitter } from "events";
import { Err, Ok, type Result } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import type { AIService } from "./aiService";
import {
  ExtensionMetadataService,
  type ExtensionMetadataStreamingUpdate,
} from "./ExtensionMetadataService";
import path from "path";
import type {
  FrontendWorkspaceMetadata,
  WorkspaceActivitySnapshot,
} from "@/common/types/workspace";
import {
  FAKE_REAWAKENED_ATTEMPT_ID,
  makeAgentTaskIntegrationFake,
} from "./taskWorkspaceSeam.testUtils";
import { createMuxMessage } from "@/common/types/message";
import * as todoStorageModule from "@/node/services/todos/todoStorage";
import type { WorkspaceGoalService } from "./workspaceGoalService";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import { drainPendingDispatches, waitForCondition } from "./testDispatchHelpers";
import {
  createCompactionAdmissionMocks,
  withTempMuxRoot,
  writePlanFile,
  createDeferred,
  createMockAIService,
  createWorkspaceServiceForTest,
  createWorkspaceServiceHarness,
  createTestBackgroundProcessManager,
  type WorkspaceServiceHarness,
} from "./workspaceService.testHarness";
import { saveWorkspaces } from "./taskService.testHarness";

describe("WorkspaceService sendMessage status clearing", () => {
  let workspaceService: WorkspaceService;
  let harness: WorkspaceServiceHarness;
  let fakeSession: {
    isBusy: ReturnType<typeof mock>;
    hasQueuedMessages: ReturnType<typeof mock>;
    hasQueuedOrDispatchingEntry: ReturnType<typeof mock>;
    dropQueuedMessageWithOnlyDedupeKey: ReturnType<typeof mock>;
    queueMessage: ReturnType<typeof mock>;
    sendMessage: ReturnType<typeof mock>;
    resumeStream: ReturnType<typeof mock>;
    drainQueuedMessagesIfIdle: ReturnType<typeof mock>;
    onChatEvent: ReturnType<typeof mock>;
    onMetadataEvent: ReturnType<typeof mock>;
  };
  let persistSettings: ReturnType<typeof mock>;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness({
      aiService: createMockAIService({ isStreaming: mock(() => false) }),
    });
    workspaceService = harness.service;
    await saveWorkspaces(harness.config, "/tmp/test/project", [
      { id: "test-workspace", path: "/tmp/test/workspace", name: "workspace" },
    ]);
    // sendMessage fires its recency write without awaiting it. These tests assert admission
    // and queueing, not recency, so keep that write off disk instead of racing cleanup.
    spyOn(harness.extensionMetadata, "updateRecency").mockImplementation((_workspaceId, recency) =>
      Promise.resolve({
        recency: recency ?? Date.now(),
        streaming: false,
        lastModel: null,
        lastThinkingLevel: null,
      })
    );

    fakeSession = {
      ...createCompactionAdmissionMocks(),
      isBusy: mock(() => true),
      hasQueuedMessages: mock(() => false),
      hasQueuedOrDispatchingEntry: mock(() => false),
      dropQueuedMessageWithOnlyDedupeKey: mock(() => false),
      queueMessage: mock(() => "tool-end" as const),
      sendMessage: mock(() => Promise.resolve(Ok(undefined))),
      resumeStream: mock(() => Promise.resolve(Ok({ started: true }))),
      drainQueuedMessagesIfIdle: mock(() => undefined),
      // registerSession subscribes to both streams.
      onChatEvent: mock(() => () => undefined),
      onMetadataEvent: mock(() => () => undefined),
    };

    spyOn(workspaceService, "getOrCreateSession").mockReturnValue(
      fakeSession as unknown as AgentSession
    );

    // Private preflight await: the queue-ordering tests below hold it to park a send
    // mid-preflight, which no public entry point can do deterministically.
    persistSettings = spyOn(
      workspaceService as unknown as {
        maybePersistAISettingsFromOptions: (workspaceId: string, options: unknown) => Promise<void>;
      },
      "maybePersistAISettingsFromOptions"
    ).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test.each(["send", "synthetic", "resume"] as const)(
    "only a user message updates remembered settings (%s)",
    async (kind) => {
      // Real persistence: the remembered settings are what the config file holds afterwards.
      persistSettings.mockRestore();
      const options = { model: "openai:gpt-5.2", agentId: "plan", thinkingLevel: "high" as const };
      const result =
        kind === "resume"
          ? await workspaceService.resumeStream("test-workspace", options)
          : await workspaceService.sendMessage("test-workspace", "hello", options, {
              synthetic: kind === "synthetic",
            });
      expect(result.success).toBe(true);
      const remembered = harness.config
        .loadConfigOrDefault()
        .projects.get("/tmp/test/project")
        ?.workspaces.find((workspace) => workspace.id === "test-workspace")?.aiSettingsByAgent;
      expect(remembered?.plan).toEqual(
        kind === "send" ? { model: options.model, thinkingLevel: options.thinkingLevel } : undefined
      );
    }
  );

  test("leaves budgeted-goal pricing rejections to AgentSession instead of rejecting early", async () => {
    // The session is a fake, so this only proves the forward. Input preservation is owned by
    // agentSession.budgetGate.test.ts "manual rejected send preserves the user message + emits a stream-error event".
    fakeSession.isBusy.mockReturnValue(false);
    const pricingError: SendMessageError = { type: "unknown", raw: "unpriced model" };
    workspaceService.setWorkspaceGoalService({
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Err(pricingError))),
      getPendingGoalSnapshot: mock(() => null),
    } as unknown as WorkspaceGoalService);
    fakeSession.sendMessage.mockResolvedValue(Err(pricingError));

    const result = await workspaceService.sendMessage("test-workspace", "please stop", {
      model: "custom:unpriced-model",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    expect(fakeSession.sendMessage).toHaveBeenCalledTimes(1);
    expect(fakeSession.sendMessage).toHaveBeenCalledWith(
      "please stop",
      expect.objectContaining({ model: "custom:unpriced-model", agentId: "exec" }),
      expect.objectContaining({ synthetic: undefined })
    );
  });

  test("a send arriving during an earlier send's preflight queues instead of starting a second turn", async () => {
    // The session only reports busy once AgentSession.sendMessage claims PREPARING. A
    // later send admitted against the idle snapshot would start a competing stream that
    // StreamManager resolves by aborting the earlier turn. Both sends sit in preflight
    // awaits here, so arrival order (not who checks first) must decide who yields.
    fakeSession.isBusy.mockReturnValue(false);
    const firstSend = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementationOnce(() => firstSend.promise);

    const firstResult = workspaceService.sendMessage("test-workspace", "first", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });
    const secondResult = workspaceService.sendMessage("test-workspace", "second", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });
    expect((await secondResult).success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalledTimes(1);
    expect(fakeSession.queueMessage.mock.calls[0]?.[0]).toBe("second");
    expect(fakeSession.sendMessage).toHaveBeenCalledTimes(1);
    expect(fakeSession.sendMessage.mock.calls[0]?.[0]).toBe("first");

    firstSend.resolve(Ok(undefined));
    expect((await firstResult).success).toBe(true);
  });

  test("entries queued behind a preflight send drain only once that send settles without a turn", async () => {
    // Nothing else will drain them: the failed send never claimed PREPARING, so no stream
    // end fires. Draining while the earlier send is still in preflight would let the queued
    // entry jump ahead of it.
    fakeSession.isBusy.mockReturnValue(false);
    workspaceService.registerSession("test-workspace", fakeSession as unknown as AgentSession);
    const firstSend = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementationOnce(() => firstSend.promise);

    const firstResult = workspaceService.sendMessage("test-workspace", "first", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });
    await waitForCondition(() => fakeSession.sendMessage.mock.calls.length === 1);
    await workspaceService.sendMessage("test-workspace", "second", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });
    expect(fakeSession.queueMessage).toHaveBeenCalledTimes(1);
    expect(fakeSession.drainQueuedMessagesIfIdle).not.toHaveBeenCalled();

    firstSend.resolve(Err({ type: "unknown", raw: "rejected before the turn was accepted" }));
    expect((await firstResult).success).toBe(false);
    expect(fakeSession.drainQueuedMessagesIfIdle).toHaveBeenCalledTimes(1);
  });

  test("the oldest preflight failing drains the entries queued behind it while a younger preflight is live", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6eaerl): waiting for every preflight to settle would let the
    // younger send pass shouldQueue with no earlier ticket left and start ahead of the entry
    // queued behind the failed one. Draining as soon as the head of the line settles makes
    // the younger send observe the dispatched (busy) session instead.
    fakeSession.isBusy.mockReturnValue(false);
    workspaceService.registerSession("test-workspace", fakeSession as unknown as AgentSession);
    const firstSend = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementationOnce(() => firstSend.promise);
    const sendOptions = { model: "openai:gpt-4o-mini", agentId: "exec" };

    const firstResult = workspaceService.sendMessage("test-workspace", "first", sendOptions);
    await waitForCondition(() => fakeSession.sendMessage.mock.calls.length === 1);
    await workspaceService.sendMessage("test-workspace", "second", sendOptions);
    expect(fakeSession.queueMessage).toHaveBeenCalledTimes(1);

    const thirdPreflight = createDeferred<void>();
    persistSettings.mockImplementationOnce(() => thirdPreflight.promise);
    const thirdResult = workspaceService.sendMessage("test-workspace", "third", sendOptions);
    await waitForCondition(() => persistSettings.mock.calls.length === 3);
    expect(fakeSession.drainQueuedMessagesIfIdle).not.toHaveBeenCalled();

    firstSend.resolve(Err({ type: "unknown", raw: "rejected before the turn was accepted" }));
    expect((await firstResult).success).toBe(false);
    expect(fakeSession.drainQueuedMessagesIfIdle).toHaveBeenCalledTimes(1);

    thirdPreflight.resolve();
    expect((await thirdResult).success).toBe(true);
  });

  test("manual input is not queued behind a requireIdle send in preflight, which yields to it", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6eaerm): a heartbeat's ticket is older, but queueing the
    // user's message behind it would let the heartbeat take the turn first. The maintenance
    // send is supersedable: the manual send goes direct and the heartbeat's own
    // preflight-count skip refuses it.
    fakeSession.isBusy.mockReturnValue(false);
    const pricingGate = mock(() => Promise.resolve(Ok(undefined)));
    workspaceService.setWorkspaceGoalService({
      assertPricedModelForBudgetedGoal: pricingGate,
      getPendingGoalSnapshot: mock(() => null),
    } as unknown as WorkspaceGoalService);
    const heartbeatPreflight = createDeferred<void>();
    pricingGate.mockImplementationOnce(() => heartbeatPreflight.promise.then(() => Ok(undefined)));
    const sendOptions = { model: "openai:gpt-4o-mini", agentId: "exec" };

    const heartbeatResult = workspaceService.sendMessage(
      "test-workspace",
      "check in",
      sendOptions,
      {
        synthetic: true,
        agentInitiated: true,
        requireIdle: true,
      }
    );
    await waitForCondition(() => pricingGate.mock.calls.length === 1);

    const manualSend = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementationOnce(() => manualSend.promise);
    const manualResult = workspaceService.sendMessage("test-workspace", "manual", sendOptions);
    await waitForCondition(() => fakeSession.sendMessage.mock.calls.length === 1);
    expect(fakeSession.sendMessage.mock.calls[0]?.[0]).toBe("manual");
    expect(fakeSession.queueMessage).not.toHaveBeenCalled();

    heartbeatPreflight.resolve();
    expect((await heartbeatResult).success).toBe(false);
    // The heartbeat never reached the session; only the manual send did.
    expect(fakeSession.sendMessage).toHaveBeenCalledTimes(1);

    manualSend.resolve(Ok(undefined));
    expect((await manualResult).success).toBe(true);
  });

  test("a failed send drains the entries queued behind it even when a supersedable preflight is older", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6ebIHT): the requireIdle send is physically oldest but nobody
    // queues behind it, so it must not decide who drains. Otherwise the entry queued behind
    // the failed manual send waits until the maintenance preflight settles.
    fakeSession.isBusy.mockReturnValue(false);
    workspaceService.registerSession("test-workspace", fakeSession as unknown as AgentSession);
    const pricingGate = mock(() => Promise.resolve(Ok(undefined)));
    workspaceService.setWorkspaceGoalService({
      assertPricedModelForBudgetedGoal: pricingGate,
      getPendingGoalSnapshot: mock(() => null),
    } as unknown as WorkspaceGoalService);
    const sendOptions = { model: "openai:gpt-4o-mini", agentId: "exec" };
    const maintenancePreflight = createDeferred<void>();
    pricingGate.mockImplementationOnce(() =>
      maintenancePreflight.promise.then(() => Ok(undefined))
    );
    const maintenanceResult = workspaceService.sendMessage(
      "test-workspace",
      "check in",
      sendOptions,
      { synthetic: true, agentInitiated: true, requireIdle: true }
    );
    await waitForCondition(() => pricingGate.mock.calls.length === 1);

    const firstManual = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementationOnce(() => firstManual.promise);
    const firstManualResult = workspaceService.sendMessage("test-workspace", "first", sendOptions);
    await waitForCondition(() => fakeSession.sendMessage.mock.calls.length === 1);
    await workspaceService.sendMessage("test-workspace", "second", sendOptions);
    expect(fakeSession.queueMessage).toHaveBeenCalledTimes(1);
    expect(fakeSession.drainQueuedMessagesIfIdle).not.toHaveBeenCalled();

    // Codex P1 (PRRT_kwDOPxxmWM6ebqSE): the maintenance send settling first (it yields to the
    // manual send in preflight) must not drain either: "second" is queued behind "first",
    // which is still live, and dispatching it now would start it ahead of "first".
    maintenancePreflight.resolve();
    expect((await maintenanceResult).success).toBe(false);
    expect(fakeSession.drainQueuedMessagesIfIdle).not.toHaveBeenCalled();

    firstManual.resolve(Err({ type: "unknown", raw: "rejected before the turn was accepted" }));
    expect((await firstManualResult).success).toBe(false);
    expect(fakeSession.drainQueuedMessagesIfIdle).toHaveBeenCalledTimes(1);
  });

  test("sends reach the queue in arrival order even when a later one finishes preflight first", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6ebqSR): with "first" in preflight, "third" can finish its
    // pricing/settings awaits before "second"; enqueueing on completion order would make the
    // user's third prompt dispatch before the second.
    fakeSession.isBusy.mockReturnValue(false);
    const sendOptions = { model: "openai:gpt-4o-mini", agentId: "exec" };
    const firstSend = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementationOnce(() => firstSend.promise);
    const firstResult = workspaceService.sendMessage("test-workspace", "first", sendOptions);
    await waitForCondition(() => fakeSession.sendMessage.mock.calls.length === 1);

    const secondPreflight = createDeferred<void>();
    persistSettings.mockImplementationOnce(() => secondPreflight.promise);
    const secondResult = workspaceService.sendMessage("test-workspace", "second", sendOptions);
    await waitForCondition(() => persistSettings.mock.calls.length === 2);
    const thirdResult = workspaceService.sendMessage("test-workspace", "third", sendOptions);
    await waitForCondition(() => persistSettings.mock.calls.length === 3);
    await drainPendingDispatches();
    // "third" finished its awaits but must wait for "second" to decide.
    expect(fakeSession.queueMessage).not.toHaveBeenCalled();

    secondPreflight.resolve();
    expect((await secondResult).success).toBe(true);
    expect((await thirdResult).success).toBe(true);
    expect((fakeSession.queueMessage.mock.calls as unknown[][]).map((call) => call[0])).toEqual([
      "second",
      "third",
    ]);

    firstSend.resolve(Ok(undefined));
    expect((await firstResult).success).toBe(true);
  });

  test("a queue-mode heartbeat in preflight yields quietly to manual input instead of racing it", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6ebIHa): queue-mode heartbeats set yieldToQueuedMessages, not
    // requireIdle. The manual send must not queue behind the heartbeat, and the heartbeat
    // must not start once that input is in preflight; its next slot fires anyway.
    fakeSession.isBusy.mockReturnValue(false);
    const pricingGate = mock(() => Promise.resolve(Ok(undefined)));
    workspaceService.setWorkspaceGoalService({
      assertPricedModelForBudgetedGoal: pricingGate,
      getPendingGoalSnapshot: mock(() => null),
    } as unknown as WorkspaceGoalService);
    const heartbeatPreflight = createDeferred<void>();
    pricingGate.mockImplementationOnce(() => heartbeatPreflight.promise.then(() => Ok(undefined)));
    const sendOptions = { model: "openai:gpt-4o-mini", agentId: "exec" };

    const heartbeatResult = workspaceService.sendMessage(
      "test-workspace",
      "check in",
      { ...sendOptions, queueDispatchMode: "turn-end" },
      {
        synthetic: true,
        agentInitiated: true,
        skipAutoResumeReset: true,
        queueDedupeKey: "heartbeat",
        yieldToQueuedMessages: true,
      }
    );
    await waitForCondition(() => pricingGate.mock.calls.length === 1);

    const manualSend = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementationOnce(() => manualSend.promise);
    const manualResult = workspaceService.sendMessage("test-workspace", "manual", sendOptions);
    await waitForCondition(() => fakeSession.sendMessage.mock.calls.length === 1);
    expect(fakeSession.sendMessage.mock.calls[0]?.[0]).toBe("manual");
    expect(fakeSession.queueMessage).not.toHaveBeenCalled();

    heartbeatPreflight.resolve();
    // Superseded heartbeats report success so the scheduler does not record a failure.
    expect((await heartbeatResult).success).toBe(true);
    expect(fakeSession.sendMessage).toHaveBeenCalledTimes(1);

    manualSend.resolve(Ok(undefined));
    expect((await manualResult).success).toBe(true);
  });

  test("the follow-up idle probe excludes the originating send after its session handoff", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cRi_J): preflightSendCounts stays positive
    // until the outer service call returns, so a probe reading it would let a
    // continuation's on-send compaction completion veto the continuation's
    // OWN saved follow-up. The probe must see unrelated preflights (round-37
    // semantics) but release the originating send at its session handoff.
    fakeSession.isBusy.mockReturnValue(false);
    const realSession = (
      workspaceService as unknown as { createSession: (workspaceId: string) => AgentSession }
    ).createSession("test-workspace");
    const probe = (realSession as unknown as { hasExternalSendPreflight?: () => boolean })
      .hasExternalSendPreflight;
    expect(probe).toBeDefined();
    try {
      expect(probe!()).toBe(false);

      // A send stalled in its pricing preflight is visible to the probe.
      let releasePricing!: () => void;
      const pricingGate = new Promise<void>((resolve) => {
        releasePricing = resolve;
      });
      let pricingStarted = false;
      workspaceService.setWorkspaceGoalService({
        assertPricedModelForBudgetedGoal: mock(async () => {
          pricingStarted = true;
          await pricingGate;
          return Ok(undefined);
        }),
        getPendingGoalSnapshot: mock(() => null),
      } as unknown as WorkspaceGoalService);
      // Ref objects: closure assignments to a `let` are invisible to TS
      // control-flow narrowing at the later assertion sites.
      const probeBeforeAdmission: { value: boolean | null } = { value: null };
      const probeAfterAdmission: { value: boolean | null } = { value: null };
      fakeSession.sendMessage.mockImplementationOnce(
        (
          _message: unknown,
          _options: unknown,
          internal?: { onTurnAdmissionCommitted?: () => void }
        ) => {
          // Codex P2 (PRRT_kwDOPxxmWM6cSRkH): the reservation must survive the
          // session's admission awaits (the idle gap before the busy claim)...
          probeBeforeAdmission.value = probe!();
          internal?.onTurnAdmissionCommitted?.();
          // ...and release the moment the turn synchronously claims PREPARING,
          // so a follow-up redispatched from within this very turn (on-send
          // compaction completion) does not veto itself.
          probeAfterAdmission.value = probe!();
          return Promise.resolve(Ok(undefined));
        }
      );

      const sendPromise = workspaceService.sendMessage("test-workspace", "manual message", {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
      });
      await waitForCondition(() => pricingStarted);
      expect(probe!()).toBe(true);

      releasePricing();
      const result = await sendPromise;
      expect(result.success).toBe(true);
      expect(probeBeforeAdmission.value).toBe(true);
      expect(probeAfterAdmission.value).toBe(false);
      // Fully settled: no residual reservation leaks.
      expect(probe!()).toBe(false);
    } finally {
      await realSession.dispose();
    }
  });

  test("holds the preflight reservation through resumeStream session admission", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cSREO): AgentSession.resumeStream runs its own
    // async admission (a second pricing gate) during which the session still
    // reports idle. Releasing the reservation before that await let follow-up
    // recovery admit a recovered synthetic turn that then ran concurrently
    // with the resumed stream — the reservation must survive until the session
    // call settles.
    fakeSession.isBusy.mockReturnValue(false);
    const realSession = (
      workspaceService as unknown as { createSession: (workspaceId: string) => AgentSession }
    ).createSession("test-workspace");
    const probe = (realSession as unknown as { hasExternalSendPreflight?: () => boolean })
      .hasExternalSendPreflight;
    expect(probe).toBeDefined();
    try {
      workspaceService.setWorkspaceGoalService({
        assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Ok(undefined))),
        getPendingGoalSnapshot: mock(() => null),
      } as unknown as WorkspaceGoalService);
      const probeDuringResume: { value: boolean | null } = { value: null };
      fakeSession.resumeStream.mockImplementationOnce(() => {
        probeDuringResume.value = probe!();
        return Promise.resolve(Ok({ started: true }));
      });

      const result = await workspaceService.resumeStream("test-workspace", {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
      });
      expect(result.success).toBe(true);
      expect(probeDuringResume.value).toBe(true);
      // Fully settled: no residual reservation leaks.
      expect(probe!()).toBe(false);
    } finally {
      await realSession.dispose();
    }
  });

  test("holds the preflight reservation through the rejected-send fallback", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cSCjs): a manual send rejected by the pricing
    // gate delegates into AgentSession to persist the user row and apply goal
    // safety, but it never streams and cannot produce its own compaction
    // follow-up. Releasing the reservation before that fallback let a
    // completing goal-scoped follow-up be admitted ahead of the user's
    // intervention; the reservation must survive until the fallback settles.
    fakeSession.isBusy.mockReturnValue(false);
    const realSession = (
      workspaceService as unknown as { createSession: (workspaceId: string) => AgentSession }
    ).createSession("test-workspace");
    const probe = (realSession as unknown as { hasExternalSendPreflight?: () => boolean })
      .hasExternalSendPreflight;
    expect(probe).toBeDefined();
    try {
      const pricingError: SendMessageError = { type: "unknown", raw: "unpriced model" };
      workspaceService.setWorkspaceGoalService({
        assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Err(pricingError))),
        getPendingGoalSnapshot: mock(() => null),
      } as unknown as WorkspaceGoalService);
      const probeDuringFallback: { value: boolean | null } = { value: null };
      fakeSession.sendMessage.mockImplementationOnce(() => {
        probeDuringFallback.value = probe!();
        return Promise.resolve(Err(pricingError));
      });

      const result = await workspaceService.sendMessage("test-workspace", "please stop", {
        model: "custom:unpriced-model",
        agentId: "exec",
      });
      expect(result.success).toBe(false);
      // The fallback persists the rejected row and applies goal safety while
      // other dispatchers may probe idleness — it must still see this send.
      expect(probeDuringFallback.value).toBe(true);
      // Fully settled: no residual reservation leaks.
      expect(probe!()).toBe(false);
    } finally {
      await realSession.dispose();
    }
  });

  test.each(["sendMessage", "resumeStream"] as const)(
    "%s refuses the stream when desktop task admission fails",
    async (operation) => {
      fakeSession.isBusy.mockReturnValue(false);
      const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
      workspaceService.setAgentTaskIntegration(
        makeAgentTaskIntegrationFake({
          markInterruptedTaskRunning: mock(() =>
            Promise.reject(new Error("Desktop is controlled by another child"))
          ),
          restoreInterruptedTaskAfterResumeFailure,
        })
      );
      const options = { model: "openai:gpt-4o-mini", agentId: "exec" };
      const result =
        operation === "sendMessage"
          ? await workspaceService.sendMessage("test-workspace", "hello", options)
          : await workspaceService.resumeStream("test-workspace", options);
      expect(result.success).toBe(false);
      expect(fakeSession.sendMessage).not.toHaveBeenCalled();
      expect(fakeSession.resumeStream).not.toHaveBeenCalled();
      expect(restoreInterruptedTaskAfterResumeFailure).not.toHaveBeenCalled();
    }
  );

  // Send outcome drives interrupted-task rollback: a successful send keeps the
  // restored running status; a failed or thrown send rolls it back.
  test.each([
    ["sendMessage restores interrupted task status before successful send", "ok", true],
    ["sendMessage restores interrupted status when resumed send fails", "err", false],
    ["sendMessage restores interrupted status when resumed send throws", "throw", false],
  ] as const)("%s", async (_name, sendOutcome, expectSuccess) => {
    fakeSession.isBusy.mockReturnValue(false);
    if (sendOutcome === "err") {
      fakeSession.sendMessage.mockResolvedValue(
        Err({ type: "unknown" as const, raw: "runtime startup failed after user turn persisted" })
      );
    } else if (sendOutcome === "throw") {
      fakeSession.sendMessage.mockRejectedValue(new Error("send explode"));
    }

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        markInterruptedTaskRunning,
        restoreInterruptedTaskAfterResumeFailure,
      })
    );

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(expectSuccess);
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");
    if (expectSuccess) {
      expect(restoreInterruptedTaskAfterResumeFailure).not.toHaveBeenCalled();
    } else {
      expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledWith(
        "test-workspace",
        undefined,
        // The rollback is bound to the attempt the resume's own reawaken won.
        FAKE_REAWAKENED_ATTEMPT_ID
      );
    }
  });

  test.each([false, true])(
    "task rescue follows the dispatched continuation correlation (downgraded: %s)",
    async (downgraded) => {
      fakeSession.isBusy.mockReturnValue(false);
      fakeSession.hasQueuedOrDispatchingEntry.mockReturnValue(downgraded);
      fakeSession.sendMessage.mockResolvedValue(
        Err({ type: "unknown" as const, raw: "admission refused" })
      );
      const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
      const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
      workspaceService.setAgentTaskIntegration(
        makeAgentTaskIntegrationFake({
          markInterruptedTaskRunning,
          restoreInterruptedTaskAfterResumeFailure,
        })
      );
      const muxMetadata = {
        type: "workspace-turn-task" as const,
        taskHandleId: "wst_reactivation",
        ownerWorkspaceId: "parent-workspace",
        turnId: "reactivation-turn",
      };
      const result = await workspaceService.sendMessage(
        "test-workspace",
        "Continue",
        { model: "openai:gpt-4o-mini", agentId: "exec", muxMetadata },
        { workspaceTurnContinuation: true }
      );
      expect(result.success).toBe(false);
      expect(fakeSession.sendMessage).toHaveBeenCalledWith(
        "Continue",
        downgraded
          ? expect.not.objectContaining({ muxMetadata })
          : expect.objectContaining({ muxMetadata }),
        expect.anything()
      );
      expect(markInterruptedTaskRunning).toHaveBeenCalledTimes(downgraded ? 1 : 0);
      expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledTimes(downgraded ? 1 : 0);
    }
  );

  test("sendMessage restores interrupted status when accepted edit startup fails later", async () => {
    fakeSession.isBusy.mockReturnValue(false);

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        markInterruptedTaskRunning,
        restoreInterruptedTaskAfterResumeFailure,
      })
    );

    const startupFailureHandled = createDeferred<void>();
    fakeSession.sendMessage.mockImplementation(
      (
        _message: string,
        _options: unknown,
        internal?: {
          onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
        }
      ) => {
        void Promise.resolve().then(async () => {
          await internal?.onAcceptedPreStreamFailure?.({
            type: "runtime_start_failed",
            message: "Runtime is starting",
          });
          startupFailureHandled.resolve();
        });
        return Promise.resolve(Ok(undefined));
      }
    );

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
      editMessageId: "user-123",
    });

    expect(result.success).toBe(true);
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");

    await startupFailureHandled.promise;
    expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledWith(
      "test-workspace",
      undefined,
      // The rollback is bound to the attempt the resume's own reawaken won.
      FAKE_REAWAKENED_ATTEMPT_ID
    );
  });

  // Resume outcome drives interrupted-task rollback: only a resume that actually
  // starts a stream keeps the restored running status.
  test.each([
    ["resumeStream restores interrupted task status before successful resume", "started", true],
    ["resumeStream keeps interrupted task status when no stream starts", "not-started", true],
    ["resumeStream restores interrupted status when resumed stream throws", "throw", false],
  ] as const)("%s", async (_name, resumeOutcome, expectSuccess) => {
    if (resumeOutcome === "not-started") {
      fakeSession.resumeStream.mockResolvedValue(Ok({ started: false }));
    } else if (resumeOutcome === "throw") {
      fakeSession.resumeStream.mockRejectedValue(new Error("resume explode"));
    }

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        markInterruptedTaskRunning,
        restoreInterruptedTaskAfterResumeFailure,
      })
    );

    const result = await workspaceService.resumeStream("test-workspace", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(expectSuccess);
    if (resumeOutcome === "not-started" && result.success) {
      expect(result.data.started).toBe(false);
    }
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");
    if (resumeOutcome === "started") {
      expect(restoreInterruptedTaskAfterResumeFailure).not.toHaveBeenCalled();
    } else {
      expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledWith(
        "test-workspace",
        undefined,
        // The rollback is bound to the attempt the resume's own reawaken won.
        FAKE_REAWAKENED_ATTEMPT_ID
      );
    }
  });

  // Winding-down gate: an interrupted task that has not finished stopping
  // refuses new work on both entry points without touching the session.
  test.each([
    ["resumeStream does not start interrupted tasks while still busy", "resumeStream"],
    ["sendMessage does not queue interrupted tasks while still busy", "sendMessage"],
  ] as const)("%s", async (_name, entryPoint) => {
    const getAgentTaskStatus = mock(() => "interrupted" as const);
    const markInterruptedTaskRunning = mock(() => Promise.resolve(false));
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({ getAgentTaskStatus, markInterruptedTaskRunning })
    );

    const options = { model: "openai:gpt-4o-mini", agentId: "exec" };
    const result =
      entryPoint === "resumeStream"
        ? await workspaceService.resumeStream("test-workspace", options)
        : await workspaceService.sendMessage("test-workspace", "hello", options);

    expect(result.success).toBe(false);
    if (!result.success && result.error.type === "unknown") {
      expect(result.error.raw).toContain("Interrupted task is still winding down");
    }
    expect(getAgentTaskStatus).toHaveBeenCalledWith("test-workspace");
    expect(markInterruptedTaskRunning).not.toHaveBeenCalled();
    expect(fakeSession.resumeStream).not.toHaveBeenCalled();
    expect(fakeSession.queueMessage).not.toHaveBeenCalled();
  });

  // Queued sends reset the auto-resume counter unless the send is a synthetic
  // auto-resume continuation that opted out.
  test.each([
    ["queued user messages reset auto-resume state", undefined, true],
    [
      "synthetic queued auto-resume messages preserve auto-resume state",
      { skipAutoResumeReset: true, synthetic: true, agentInitiated: true },
      false,
    ],
  ] as const)("%s", async (_name, internal, expectReset) => {
    fakeSession.isBusy.mockReturnValue(true);

    const resetAutoResumeCount = mock(() => undefined);
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({ resetAutoResumeCount })
    );

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "hello",
      { model: "openai:gpt-4o-mini", agentId: "exec" },
      internal
    );

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalled();
    if (expectReset) {
      expect(resetAutoResumeCount).toHaveBeenCalledWith("test-workspace");
    } else {
      expect(resetAutoResumeCount).not.toHaveBeenCalled();
    }
  });

  test("refuses to queue a send whose cancel signal already fired", async () => {
    fakeSession.isBusy.mockReturnValue(true);
    const controller = new AbortController();
    controller.abort("monitor withdrawn");
    const onCanceled = mock(() => undefined);
    const cancelState = { canceledBeforeAcceptance: false };

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "wake",
      { model: "openai:gpt-4o-mini", agentId: "exec" },
      {
        synthetic: true,
        agentInitiated: true,
        cancelSignal: controller.signal,
        cancelState,
        onCanceled,
        queueDedupeKey: "bash-monitor-wake:test-workspace:1",
        removableQueueDedupeKey: true,
      }
    );

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).not.toHaveBeenCalled();
    expect(onCanceled).toHaveBeenCalledTimes(1);
    expect(onCanceled).toHaveBeenCalledWith("monitor withdrawn");
    expect(cancelState.canceledBeforeAcceptance).toBe(true);
  });

  test("strips stale workspace-turn correlation behind an earlier queued entry", async () => {
    fakeSession.hasQueuedOrDispatchingEntry.mockReturnValue(true);
    const onCanceled = mock(() => undefined);
    const onAcceptedPreStreamFailure = mock(() => undefined);
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_stale_progress",
      ownerWorkspaceId: "owner-workspace",
      turnId: "turn-stale-progress",
    };

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "nested progress",
      { model: "openai:gpt-4o-mini", agentId: "exec", muxMetadata },
      {
        synthetic: true,
        agentInitiated: true,
        workspaceTurnContinuation: true,
        onCanceled,
        onAcceptedPreStreamFailure,
      }
    );

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalledWith(
      "nested progress",
      expect.not.objectContaining({ muxMetadata }),
      expect.objectContaining({
        onCanceled: undefined,
        onAcceptedPreStreamFailure: undefined,
      })
    );
  });

  test("judges a promoted progress report's correlation against the entries it stays behind", async () => {
    fakeSession.hasQueuedOrDispatchingEntry.mockReturnValue(false);
    const onCanceled = mock(() => undefined);
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_promoted_progress",
      ownerWorkspaceId: "owner-workspace",
      turnId: "turn-promoted-progress",
    };

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "nested progress",
      { model: "openai:gpt-4o-mini", agentId: "exec", muxMetadata },
      {
        synthetic: true,
        agentInitiated: true,
        workspaceTurnContinuation: true,
        queueDedupeKey: "agent-report:child:call-1",
        removableQueueDedupeKey: true,
        promoteAheadOfHiddenTurnEnd: true,
        onCanceled,
      }
    );

    expect(result.success).toBe(true);
    // The session excludes the hidden turn-end entries the promotion will overtake (e.g. a
    // queued heartbeat) when deciding whether a predecessor supersedes this continuation.
    expect(fakeSession.hasQueuedOrDispatchingEntry).toHaveBeenCalledWith(muxMetadata, {
      promoteAheadOfHiddenTurnEnd: true,
    });
    expect(fakeSession.queueMessage).toHaveBeenCalledWith(
      "nested progress",
      expect.objectContaining({ muxMetadata }),
      expect.objectContaining({ onCanceled, promoteAheadOfHiddenTurnEnd: true })
    );
  });

  test("keeps workspace-turn correlation for the next queued continuation", async () => {
    fakeSession.hasQueuedOrDispatchingEntry.mockReturnValue(false);
    const onCanceled = mock(() => undefined);
    const onAcceptedPreStreamFailure = mock(() => undefined);
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_next_progress",
      ownerWorkspaceId: "owner-workspace",
      turnId: "turn-next-progress",
    };

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "nested progress",
      { model: "openai:gpt-4o-mini", agentId: "exec", muxMetadata },
      {
        synthetic: true,
        agentInitiated: true,
        workspaceTurnContinuation: true,
        onCanceled,
        onAcceptedPreStreamFailure,
      }
    );

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalledWith(
      "nested progress",
      expect.objectContaining({ muxMetadata }),
      expect.objectContaining({ onCanceled, onAcceptedPreStreamFailure })
    );
  });

  test("synthetic queued sends leave a pending interactive question intact", async () => {
    fakeSession.isBusy.mockReturnValue(true);

    const questionPromise = askUserQuestionManager.registerPending("test-workspace", "tool-q1", [
      {
        question: "Proceed?",
        header: "Next",
        options: [
          { label: "Yes", description: "Continue" },
          { label: "No", description: "Stop" },
        ],
        multiSelect: false,
      },
    ]);
    // Attach handler before cleanup cancel so Bun does not flag an unhandled rejection.
    const settled = questionPromise.catch((error: unknown) => error);

    try {
      const result = await workspaceService.sendMessage(
        "test-workspace",
        "[Heartbeat] scheduled check-in",
        { model: "openai:gpt-4o-mini", agentId: "exec", queueDispatchMode: "turn-end" },
        { synthetic: true, skipAutoResumeReset: true }
      );

      expect(result.success).toBe(true);
      expect(fakeSession.queueMessage).toHaveBeenCalled();
      // A backend-initiated maintenance send is not a user response: the prompt survives.
      expect(askUserQuestionManager.getLatestPending("test-workspace")?.toolCallId).toBe("tool-q1");
    } finally {
      askUserQuestionManager.cancel("test-workspace", "tool-q1", "test cleanup");
      await settled;
    }
  });

  // The heartbeat caller's queue-emptiness check happens before sendMessage's internal
  // awaits (pricing gate, settings persistence), so a user send can queue in that window.
  // yieldToQueuedMessages re-checks at the enqueue point: queued messages own the slot.
  test("yieldToQueuedMessages drops the send when messages queued during preparation", async () => {
    fakeSession.isBusy.mockReturnValue(true);
    fakeSession.hasQueuedMessages.mockReturnValue(true);

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "[Heartbeat] scheduled check-in",
      { model: "openai:gpt-4o-mini", agentId: "exec", queueDispatchMode: "turn-end" },
      { synthetic: true, skipAutoResumeReset: true, yieldToQueuedMessages: true }
    );

    // Quiet success: the slot is consumed, but nothing is enqueued over the user's message.
    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).not.toHaveBeenCalled();
  });

  // The reverse race: a heartbeat queued first must not absorb a later real message —
  // MessageQueue batches texts under the first entry's muxMetadata, so input queued behind
  // a heartbeat would dispatch tagged as a heartbeat. New input supersedes the heartbeat.
  test("queued sends supersede a pending queued heartbeat before enqueueing", async () => {
    fakeSession.isBusy.mockReturnValue(true);
    fakeSession.dropQueuedMessageWithOnlyDedupeKey.mockReturnValue(true);

    const result = await workspaceService.sendMessage("test-workspace", "real user input", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(fakeSession.dropQueuedMessageWithOnlyDedupeKey).toHaveBeenCalledWith(
      "heartbeat-request"
    );
    // The user message still queues normally after the heartbeat is dropped.
    expect(fakeSession.queueMessage).toHaveBeenCalled();
  });

  test("a queued heartbeat send does not supersede itself", async () => {
    fakeSession.isBusy.mockReturnValue(true);

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "[Heartbeat] scheduled check-in",
      { model: "openai:gpt-4o-mini", agentId: "exec", queueDispatchMode: "turn-end" },
      {
        synthetic: true,
        skipAutoResumeReset: true,
        queueDedupeKey: "heartbeat-request",
        yieldToQueuedMessages: true,
      }
    );

    expect(result.success).toBe(true);
    expect(fakeSession.dropQueuedMessageWithOnlyDedupeKey).not.toHaveBeenCalled();
  });

  test("yieldToQueuedMessages still queues into an empty queue", async () => {
    fakeSession.isBusy.mockReturnValue(true);
    fakeSession.hasQueuedMessages.mockReturnValue(false);

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "[Heartbeat] scheduled check-in",
      { model: "openai:gpt-4o-mini", agentId: "exec", queueDispatchMode: "turn-end" },
      { synthetic: true, skipAutoResumeReset: true, yieldToQueuedMessages: true }
    );

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalled();
  });

  test("non-synthetic queued sends cancel a pending interactive question", async () => {
    fakeSession.isBusy.mockReturnValue(true);

    const questionPromise = askUserQuestionManager.registerPending("test-workspace", "tool-q1", [
      {
        question: "Proceed?",
        header: "Next",
        options: [
          { label: "Yes", description: "Continue" },
          { label: "No", description: "Stop" },
        ],
        multiSelect: false,
      },
    ]);
    // Attach handler before the send cancels the question, avoiding an unhandled rejection.
    const settled = questionPromise.catch((error: unknown) => error);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalled();
    // A real user message supersedes the question: it is canceled before queueing.
    expect(askUserQuestionManager.getLatestPending("test-workspace")).toBeNull();
    expect(await settled).toBeInstanceOf(Error);
  });

  // The sticky case: incoming mode is turn-end but the queue's effective mode is
  // tool-end from a prior enqueue, so the wait still backgrounds.
  test.each([
    [
      "backgrounds foreground task waits when queuing a tool-end message",
      "tool-end",
      "hello",
      undefined,
      true,
    ],
    [
      "does not background foreground task waits when queuing a turn-end message",
      "turn-end",
      "hello",
      "turn-end",
      false,
    ],
    [
      "does not background foreground task waits when queueMessage enqueues nothing",
      null,
      "   ",
      undefined,
      false,
    ],
    [
      "backgrounds foreground task waits when effective queue mode is tool-end despite incoming turn-end",
      "tool-end",
      "hello",
      "turn-end",
      true,
    ],
  ] as const)(
    "%s",
    async (_name, effectiveQueueMode, message, queueDispatchMode, expectBackgrounded) => {
      fakeSession.isBusy.mockReturnValue(true);
      fakeSession.queueMessage.mockReturnValue(effectiveQueueMode);

      const backgroundForegroundWaitsForWorkspace = mock(() => 0);
      workspaceService.setAgentTaskIntegration(
        makeAgentTaskIntegrationFake({ backgroundForegroundWaitsForWorkspace })
      );

      const result = await workspaceService.sendMessage("test-workspace", message, {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
        queueDispatchMode,
      });

      expect(result.success).toBe(true);
      if (expectBackgrounded) {
        expect(backgroundForegroundWaitsForWorkspace).toHaveBeenCalledWith("test-workspace");
      } else {
        expect(backgroundForegroundWaitsForWorkspace).not.toHaveBeenCalled();
      }
    }
  );

  test("registerSession clears persisted agent status for accepted user chat events", () => {
    const updateAgentStatus = spyOn(workspaceService, "updateAgentStatus").mockResolvedValue(
      undefined
    );

    const workspaceId = "listener-workspace";
    const sessionEmitter = new EventEmitter();
    const listenerSession = {
      onChatEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("chat-event", listener);
        return () => sessionEmitter.off("chat-event", listener);
      },
      onMetadataEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("metadata-event", listener);
        return () => sessionEmitter.off("metadata-event", listener);
      },
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      dispose: () => {},
    } as unknown as AgentSession;

    workspaceService.registerSession(workspaceId, listenerSession);

    sessionEmitter.emit("chat-event", {
      workspaceId,
      message: {
        type: "message",
        ...createMuxMessage("user-accepted", "user", "hello"),
      },
    });

    expect(updateAgentStatus).toHaveBeenCalledWith(workspaceId, null);
  });

  test("registerSession does not clear persisted agent status for synthetic user chat events", () => {
    const updateAgentStatus = spyOn(workspaceService, "updateAgentStatus").mockResolvedValue(
      undefined
    );

    const workspaceId = "synthetic-listener-workspace";
    const sessionEmitter = new EventEmitter();
    const listenerSession = {
      onChatEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("chat-event", listener);
        return () => sessionEmitter.off("chat-event", listener);
      },
      onMetadataEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("metadata-event", listener);
        return () => sessionEmitter.off("metadata-event", listener);
      },
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      dispose: () => {},
    } as unknown as AgentSession;

    workspaceService.registerSession(workspaceId, listenerSession);

    sessionEmitter.emit("chat-event", {
      workspaceId,
      message: {
        type: "message",
        ...createMuxMessage("user-synthetic", "user", "hello", { synthetic: true }),
      },
    });

    expect(updateAgentStatus).not.toHaveBeenCalled();
  });
});

describe("WorkspaceService idle compaction dispatch", () => {
  let workspaceService: WorkspaceService;
  let harness: WorkspaceServiceHarness;
  let aiEvents: EventEmitter;

  beforeEach(async () => {
    aiEvents = new EventEmitter();
    const aiService = createMockAIService({
      isStreaming: mock(() => false),
      on: ((event: string, listener: (...args: unknown[]) => void) => {
        aiEvents.on(event, listener);
        return aiService;
      }) as AIService["on"],
    });
    harness = await createWorkspaceServiceHarness({ aiService });
    workspaceService = harness.service;
  });

  /** Emit a provider stream error and collect the idle-compaction outcomes it reports. */
  async function reportedOutcomesOnStreamError(workspaceId: string) {
    const outcomes: Array<{ workspaceId: string; outcome: IdleCompactionOutcome }> = [];
    workspaceService.setIdleCompactionOutcomeListener((id, outcome) =>
      outcomes.push({ workspaceId: id, outcome })
    );
    // The error also stops streaming status; wait for that write so it cannot outlive cleanup.
    const stopped = createDeferred<void>();
    spyOn(harness.extensionMetadata, "setStreaming").mockImplementation((_id, streaming) => {
      stopped.resolve();
      return Promise.resolve({ recency: 0, streaming, lastModel: null, lastThinkingLevel: null });
    });
    aiEvents.emit("error", {
      workspaceId,
      error: "provider rejected",
      errorType: "model_not_found",
    });
    await stopped.promise;
    return outcomes;
  }

  afterEach(async () => {
    await harness.cleanup();
  });

  test("marks idle compaction send as synthetic when stream stays active", async () => {
    const workspaceId = "idle-ws";
    const sendMessage = mock(() => Promise.resolve(Ok(undefined)));

    let busyChecks = 0;
    const session = {
      isBusy: mock(() => {
        busyChecks += 1;
        return busyChecks >= 2;
      }),
    } as unknown as AgentSession;

    spyOn(workspaceService, "sendMessage").mockImplementation(sendMessage);
    spyOn(workspaceService, "getOrCreateSession").mockReturnValue(session);

    await workspaceService.executeIdleCompaction(workspaceId);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      workspaceId,
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        skipAutoResumeReset: true,
        synthetic: true,
        requireIdle: true,
      })
    );

    // The marker's observable consumer: a stream error reports an outcome only for idle compaction.
    expect(await reportedOutcomesOnStreamError(workspaceId)).toEqual([
      { workspaceId, outcome: { success: false, modelNotFound: true } },
    ]);
  });

  test("does not mark idle compaction when send succeeds without active stream", async () => {
    const workspaceId = "idle-no-stream-ws";
    const sendMessage = mock(() => Promise.resolve(Ok(undefined)));

    const session = {
      isBusy: mock(() => false),
    } as unknown as AgentSession;

    spyOn(workspaceService, "sendMessage").mockImplementation(sendMessage);
    spyOn(workspaceService, "getOrCreateSession").mockReturnValue(session);

    await workspaceService.executeIdleCompaction(workspaceId);

    // The marker's observable consumer: a stream error reports an outcome only for idle compaction.
    expect(await reportedOutcomesOnStreamError(workspaceId)).toEqual([]);
  });

  test("propagates busy-skip errors", async () => {
    const workspaceId = "idle-busy-ws";
    const sendMessage = mock(() =>
      Promise.resolve(
        Err({
          type: "unknown" as const,
          raw: "Workspace is busy; idle-only send was skipped.",
        })
      )
    );

    spyOn(workspaceService, "sendMessage").mockImplementation(sendMessage);

    // The busy-skip is an expected race, so it must not be reported as a failure
    // (otherwise two normal user-interaction races would suppress idle compaction).
    const outcomes: Array<{ workspaceId: string; outcome: IdleCompactionOutcome }> = [];
    workspaceService.setIdleCompactionOutcomeListener((id, outcome) =>
      outcomes.push({ workspaceId: id, outcome })
    );

    let executionError: unknown;
    try {
      await workspaceService.executeIdleCompaction(workspaceId);
    } catch (error) {
      executionError = error;
    }

    expect(executionError).toBeInstanceOf(Error);
    if (!(executionError instanceof Error)) {
      throw new Error("Expected idle compaction to throw when workspace is busy");
    }
    expect(executionError.message).toContain("idle-only send was skipped");
    expect(outcomes).toEqual([]);
  });

  test("reports a model_not_found outcome when the compaction model is invalid", async () => {
    const workspaceId = "idle-model-not-found-ws";
    const sendMessage = mock(() =>
      Promise.resolve(
        Err({
          type: "invalid_model_string" as const,
          message: "Invalid model string: openai:does-not-exist",
        })
      )
    );
    const session = { isBusy: mock(() => false) } as unknown as AgentSession;

    spyOn(workspaceService, "sendMessage").mockImplementation(sendMessage);
    spyOn(workspaceService, "getOrCreateSession").mockReturnValue(session);

    const outcomes: Array<{ workspaceId: string; outcome: IdleCompactionOutcome }> = [];
    workspaceService.setIdleCompactionOutcomeListener((id, outcome) =>
      outcomes.push({ workspaceId: id, outcome })
    );

    let threw = false;
    try {
      await workspaceService.executeIdleCompaction(workspaceId);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(outcomes).toEqual([{ workspaceId, outcome: { success: false, modelNotFound: true } }]);
  });

  test("reports a non-model_not_found outcome for generic pre-stream failures", async () => {
    const workspaceId = "idle-generic-failure-ws";
    const sendMessage = mock(() => Promise.resolve(Err({ type: "unknown" as const, raw: "boom" })));
    const session = { isBusy: mock(() => false) } as unknown as AgentSession;

    spyOn(workspaceService, "sendMessage").mockImplementation(sendMessage);
    spyOn(workspaceService, "getOrCreateSession").mockReturnValue(session);

    const outcomes: Array<{ workspaceId: string; outcome: IdleCompactionOutcome }> = [];
    workspaceService.setIdleCompactionOutcomeListener((id, outcome) =>
      outcomes.push({ workspaceId: id, outcome })
    );

    let threw = false;
    try {
      await workspaceService.executeIdleCompaction(workspaceId);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(outcomes).toEqual([{ workspaceId, outcome: { success: false, modelNotFound: false } }]);
  });

  test("prefers global compact thinking default over exec and activity fallbacks", async () => {
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/project/ws";

    const sendMessage = spyOn(workspaceService, "sendMessage").mockResolvedValue(Ok(undefined));
    spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      isBusy: () => false,
    } as unknown as AgentSession);

    await saveWorkspaces(
      harness.config,
      projectPath,
      [
        {
          id: "ws",
          path: workspacePath,
          name: "ws",
          aiSettingsByAgent: {
            exec: { model: "openai:gpt-4o-mini", thinkingLevel: "low" },
          },
        },
      ],
      { agentAiDefaults: { compact: { thinkingLevel: "high" } } }
    );
    // Activity fallback: the last stream ran with thinking off.
    await harness.extensionMetadata.setStreaming("ws", false, { thinkingLevel: "off" });

    await workspaceService.executeIdleCompaction("ws");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const options = sendMessage.mock.calls[0][2];
    expect(options.thinkingLevel).toBe(enforceThinkingPolicy(options.model, "high"));
  });

  test("does not tag streaming=true snapshots as idle compaction", async () => {
    const workspaceId = "idle-streaming-true-no-tag";
    const snapshot = {
      recency: Date.now(),
      streaming: true,
      lastModel: "claude-sonnet-4",
      lastThinkingLevel: null,
    };

    const setStreaming = spyOn(harness.extensionMetadata, "setStreaming").mockResolvedValue(
      snapshot
    );
    const emitWorkspaceActivity = spyOn(workspaceService, "emitWorkspaceActivity");

    const internals = workspaceService as unknown as {
      idleCompactingWorkspaces: Set<string>;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    internals.idleCompactingWorkspaces.add(workspaceId);

    await internals.updateStreamingStatus(workspaceId, true);

    expect(setStreaming).toHaveBeenCalledWith(workspaceId, true, {});
    expect(emitWorkspaceActivity).toHaveBeenCalledTimes(1);
    expect(emitWorkspaceActivity).toHaveBeenCalledWith(workspaceId, snapshot);
    expect(internals.idleCompactingWorkspaces.has(workspaceId)).toBe(true);
  });

  test("passes through stream-start thinkingLevel without re-deriving it from config", async () => {
    const workspaceId = "streaming-thinking-level";
    const snapshot = {
      recency: Date.now(),
      streaming: true,
      lastModel: "claude-sonnet-4",
      lastThinkingLevel: "high" as const,
    };

    const setStreaming = spyOn(harness.extensionMetadata, "setStreaming").mockResolvedValue(
      snapshot
    );
    const emitWorkspaceActivity = spyOn(workspaceService, "emitWorkspaceActivity");

    aiEvents.emit("stream-start", {
      type: "stream-start",
      workspaceId,
      messageId: "assistant-1",
      model: "claude-sonnet-4",
      thinkingLevel: "high",
      startTime: Date.now(),
    });
    await waitForCondition(() => emitWorkspaceActivity.mock.calls.length === 1);

    expect(setStreaming).toHaveBeenCalledWith(workspaceId, true, {
      model: "claude-sonnet-4",
      thinkingLevel: "high",
      generation: 1,
    });
    expect(emitWorkspaceActivity).toHaveBeenCalledWith(workspaceId, snapshot);
  });

  test("clears idle marker when streaming=false metadata update fails", async () => {
    const workspaceId = "idle-streaming-false-failure";

    const setStreaming = spyOn(harness.extensionMetadata, "setStreaming").mockRejectedValue(
      new Error("setStreaming failed")
    );

    const internals = workspaceService as unknown as {
      idleCompactingWorkspaces: Set<string>;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    internals.idleCompactingWorkspaces.add(workspaceId);

    await internals.updateStreamingStatus(workspaceId, false);

    expect(internals.idleCompactingWorkspaces.has(workspaceId)).toBe(false);
    // todoStatus is intentionally NOT passed when there are no todos —
    // passing null would delete an AgentStatusService-written AI summary
    // from the same slot. Explicit clears happen via setTodoStatus.
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, false, {
      hasTodos: false,
    });
  });

  test("stream-stop with no todos does NOT clear todoStatus (preserves AI summary)", async () => {
    // Codex: AgentStatusService writes its AI-generated summary into the
    // same `todoStatus` slot that `setTodoStatus` uses. The stream-stop
    // path used to read an empty todo list and pass `todoStatus: null`,
    // which deleted the slot — wiping a summary that was just generated
    // during the stream. Free-form chats (no todos) hit this every turn.
    const workspaceId = "stream-stop-preserves-ai-status";
    const snapshot = {
      recency: Date.now(),
      streaming: false,
      lastModel: "claude-sonnet-4",
      lastThinkingLevel: null,
    };
    const setStreaming = spyOn(harness.extensionMetadata, "setStreaming").mockResolvedValue(
      snapshot
    );

    aiEvents.emit("stream-abort", { type: "stream-abort", workspaceId, messageId: "assistant-1" });
    await waitForCondition(() => setStreaming.mock.calls.length > 0);

    // The setStreaming call must omit `todoStatus` entirely. If it included
    // `todoStatus: null`, ExtensionMetadataService.setStreaming would delete
    // the slot (see the `update.todoStatus !== undefined` branch there).
    expect(setStreaming).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, false, {
      generation: 0,
      hasTodos: false,
    });
    // Defensive double-check that the assertion is strict — toHaveBeenCalledWith
    // with an object literal in some matchers tolerates extra fields. Use
    // `not` against an explicit `todoStatus: null` payload to lock the
    // contract.
    expect(setStreaming).not.toHaveBeenCalledWith(workspaceId, false, {
      generation: 0,
      hasTodos: false,
      todoStatus: null,
    });
  });
});

describe("WorkspaceService streaming generation guard", () => {
  let workspaceService: WorkspaceService;
  let harness: WorkspaceServiceHarness;
  let readTodosSpy:
    | ReturnType<typeof spyOn<typeof todoStorageModule, "readTodosForSessionDir">>
    | undefined;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness({
      aiService: createMockAIService({ isStreaming: mock(() => false) }),
    });
    workspaceService = harness.service;
  });

  afterEach(async () => {
    readTodosSpy?.mockRestore();
    await harness.cleanup();
  });

  /** Drive the real listener WorkspaceService registered on the (mock) AI service. */
  function emitAiEvent(event: string, data: Record<string, unknown>): void {
    const onCalls = (harness.aiService.on as unknown as ReturnType<typeof mock>).mock.calls;
    const listener = onCalls.find((call) => call[0] === event)?.[1] as
      | ((data: unknown) => void)
      | undefined;
    if (!listener) throw new Error(`Expected a ${event} listener`);
    listener({ type: event, ...data });
  }

  function spyRecency() {
    return spyOn(harness.extensionMetadata, "updateRecency").mockImplementation((_id, recency) =>
      Promise.resolve({
        recency: recency ?? 0,
        streaming: false,
        lastModel: null,
        lastThinkingLevel: null,
      })
    );
  }

  test("stop-side metadata write is skipped when a newer stream has started", async () => {
    const workspaceId = "ws-generation-guard";
    const todoReadDeferred =
      createDeferred<Awaited<ReturnType<typeof todoStorageModule.readTodosForSessionDir>>>();
    let todoReadCalls = 0;
    const setStreaming = mock(
      (_workspaceId: string, streaming: boolean, update: ExtensionMetadataStreamingUpdate = {}) =>
        Promise.resolve({
          recency: Date.now(),
          streaming,
          lastModel: update.model ?? null,
          lastThinkingLevel: update.thinkingLevel ?? null,
          hasTodos: update.hasTodos,
          agentStatus: null,
        })
    );

    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockImplementation(() => {
      todoReadCalls += 1;
      if (todoReadCalls === 1) {
        return todoReadDeferred.promise;
      }
      return Promise.resolve([]);
    });

    spyOn(harness.extensionMetadata, "setStreaming").mockImplementation(setStreaming);

    const internals = workspaceService as unknown as {
      streamingGenerations: Map<string, number>;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    internals.streamingGenerations.set(workspaceId, 1);
    const staleStopPromise = internals.updateStreamingStatus(workspaceId, false, {
      generation: 1,
    });

    internals.streamingGenerations.set(workspaceId, 2);
    await internals.updateStreamingStatus(workspaceId, true, { model: "openai:gpt-4o" });

    todoReadDeferred.resolve([]);
    await staleStopPromise;

    expect(setStreaming).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, true, { model: "openai:gpt-4o" });
  });

  test("todo snapshot refreshes run in call order for consecutive updates", async () => {
    const workspaceId = "ws-todo-refresh-order";
    const firstWriteDeferred = createDeferred<WorkspaceActivitySnapshot>();
    const setTodoStatus = mock(
      (
        _workspaceId: string,
        todoStatus: { emoji: string; message: string } | null,
        hasTodos: boolean
      ) => {
        if (todoStatus?.message === "First task") {
          return firstWriteDeferred.promise;
        }
        return Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          todoStatus,
          hasTodos,
        });
      }
    );

    let readCount = 0;
    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockImplementation(() => {
      readCount += 1;
      if (readCount === 1) {
        return Promise.resolve([{ content: "First task", status: "in_progress" }]);
      }
      return Promise.resolve([{ content: "Second task", status: "in_progress" }]);
    });

    spyOn(harness.extensionMetadata, "setTodoStatus").mockImplementation(setTodoStatus);

    const internals = workspaceService as unknown as {
      updateTodoStatusFromStorage: (workspaceId: string) => Promise<void>;
    };

    const firstRefresh = internals.updateTodoStatusFromStorage(workspaceId);
    const secondRefresh = internals.updateTodoStatusFromStorage(workspaceId);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setTodoStatus).toHaveBeenCalledTimes(1);
    expect(readCount).toBe(1);

    firstWriteDeferred.resolve({
      recency: Date.now(),
      streaming: false,
      lastModel: null,
      lastThinkingLevel: null,
      todoStatus: { emoji: "🔄", message: "First task" },
      hasTodos: true,
    });

    await Promise.all([firstRefresh, secondRefresh]);

    expect(setTodoStatus).toHaveBeenCalledTimes(2);
    expect(setTodoStatus.mock.calls[0]).toEqual([
      workspaceId,
      { emoji: "🔄", message: "First task" },
      true,
    ]);
    expect(setTodoStatus.mock.calls[1]).toEqual([
      workspaceId,
      { emoji: "🔄", message: "Second task" },
      true,
    ]);
  });

  test("handleStreamCompletion captures generation before awaiting recency updates", async () => {
    const workspaceId = "ws-stream-completion-generation";
    const recencyDeferred = createDeferred<void>();
    const setStreaming = mock(
      (_workspaceId: string, streaming: boolean, update: ExtensionMetadataStreamingUpdate = {}) =>
        Promise.resolve({
          recency: Date.now(),
          streaming,
          lastModel: update.model ?? null,
          lastThinkingLevel: update.thinkingLevel ?? null,
          hasTodos: update.hasTodos,
          agentStatus: null,
        })
    );

    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockResolvedValue([]);

    const internals = workspaceService as unknown as {
      streamingGenerations: Map<string, number>;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
      updateRecencyTimestamp: (workspaceId: string, timestamp?: number) => Promise<void>;
      handleStreamCompletion: (workspaceId: string) => Promise<void>;
    };

    spyOn(harness.extensionMetadata, "setStreaming").mockImplementation(setStreaming);
    internals.updateRecencyTimestamp = mock(() => recencyDeferred.promise);

    internals.streamingGenerations.set(workspaceId, 1);
    const completionPromise = internals.handleStreamCompletion(workspaceId);

    internals.streamingGenerations.set(workspaceId, 2);
    await internals.updateStreamingStatus(workspaceId, true, { model: "openai:gpt-4o-mini" });

    recencyDeferred.resolve();
    await completionPromise;

    expect(internals.updateRecencyTimestamp).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, true, { model: "openai:gpt-4o-mini" });
  });
  test("tags matching compaction stop snapshots and clears the generation marker", async () => {
    const workspaceId = "ws-compaction-stream-stop";
    const setStreaming = mock(
      (_workspaceId: string, streaming: boolean, update: ExtensionMetadataStreamingUpdate = {}) =>
        Promise.resolve({
          recency: Date.now(),
          streaming,
          lastModel: update.model ?? null,
          lastThinkingLevel: update.thinkingLevel ?? null,
          hasTodos: update.hasTodos,
          agentStatus: null,
        })
    );
    const emitWorkspaceActivity = spyOn(workspaceService, "emitWorkspaceActivity");

    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockResolvedValue([]);

    const internals = workspaceService as unknown as {
      streamingGenerations: Map<string, number>;
      compactionStreamGenerations: Map<string, number>;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    spyOn(harness.extensionMetadata, "setStreaming").mockImplementation(setStreaming);
    internals.streamingGenerations.set(workspaceId, 3);
    internals.compactionStreamGenerations.set(workspaceId, 3);

    await internals.updateStreamingStatus(workspaceId, false, { generation: 3 });

    expect(emitWorkspaceActivity).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({ streaming: false, isCompaction: true })
    );
    expect(internals.compactionStreamGenerations.has(workspaceId)).toBe(false);
  });

  test("handleStreamCompletion skips recency updates for idle compaction", async () => {
    const workspaceId = "ws-idle-stream-completion";
    const stopped = createDeferred<void>();
    const setStreaming = mock(
      (_workspaceId: string, streaming: boolean, update: ExtensionMetadataStreamingUpdate = {}) => {
        if (!streaming) stopped.resolve();
        return Promise.resolve({
          recency: Date.now(),
          streaming,
          lastModel: update.model ?? null,
          lastThinkingLevel: update.thinkingLevel ?? null,
          hasTodos: update.hasTodos,
          agentStatus: null,
        });
      }
    );

    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockResolvedValue([]);
    spyOn(harness.extensionMetadata, "setStreaming").mockImplementation(setStreaming);
    const updateRecency = spyRecency();

    // Mark the workspace through the real idle-compaction dispatch: idle before the send,
    // streaming after it.
    spyOn(workspaceService, "sendMessage").mockResolvedValue(Ok(undefined));
    let busyChecks = 0;
    spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      isBusy: () => ++busyChecks >= 2,
    } as unknown as AgentSession);
    await workspaceService.executeIdleCompaction(workspaceId);

    emitAiEvent("stream-start", { workspaceId, messageId: "compact-1", model: "openai:gpt-4o" });
    emitAiEvent("stream-end", { workspaceId, messageId: "compact-1", parts: [], metadata: {} });
    await stopped.promise;

    expect(updateRecency).not.toHaveBeenCalled();
    expect(setStreaming).toHaveBeenCalledTimes(2);
    expect(setStreaming).toHaveBeenLastCalledWith(
      workspaceId,
      false,
      expect.objectContaining({ generation: 1, hasTodos: false })
    );
  });

  test.each([true, false])(
    "stream-end recency follows the hidden token-budget flush flag (flush=%s)",
    async (flush) => {
      const workspaceId = "ws-flush-stream-completion";
      const stopped = createDeferred<void>();
      const setStreaming = mock(
        (
          _workspaceId: string,
          streaming: boolean,
          update: ExtensionMetadataStreamingUpdate = {}
        ) => {
          if (!streaming) stopped.resolve();
          return Promise.resolve({
            recency: Date.now(),
            streaming,
            lastModel: update.model ?? null,
            lastThinkingLevel: update.thinkingLevel ?? null,
            hasTodos: update.hasTodos,
            agentStatus: null,
          });
        }
      );

      readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockResolvedValue([]);

      spyOn(harness.extensionMetadata, "setStreaming").mockImplementation(setStreaming);
      const updateRecency = spyRecency();

      emitAiEvent("stream-start", {
        workspaceId,
        messageId: "flush-answer",
        model: "anthropic:claude-opus-5",
      });
      emitAiEvent("stream-end", {
        workspaceId,
        messageId: "flush-answer",
        parts: [],
        metadata: {
          model: "anthropic:claude-opus-5",
          muxMetadata: flush ? { type: "normal", contextBudgetFlush: true } : { type: "normal" },
        },
      });
      await stopped.promise;

      // A hidden flush is maintenance: streaming still stops, but recency (which drives
      // unread state and background completion notifications) must not advance.
      expect(updateRecency).toHaveBeenCalledTimes(flush ? 0 : 1);
      expect(setStreaming).toHaveBeenCalledWith(
        workspaceId,
        false,
        expect.objectContaining({ generation: 1 })
      );
    }
  );
});

describe("WorkspaceService post-compaction metadata refresh", () => {
  let workspaceService: WorkspaceService;
  let harness: WorkspaceServiceHarness;

  beforeEach(async () => {
    harness = await createWorkspaceServiceHarness();
    workspaceService = harness.service;
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("returns expanded plan path for local runtimes", async () => {
    await withTempMuxRoot(async (muxRoot) => {
      const workspaceId = "ws-plan-path";
      const workspaceName = "plan-workspace";
      const projectName = "cmux";
      const planFile = await writePlanFile(muxRoot, projectName, workspaceName);

      const fakeMetadata: FrontendWorkspaceMetadata = {
        id: workspaceId,
        name: workspaceName,
        projectName,
        projectPath: "/tmp/proj",
        namedWorkspacePath: "/tmp/proj/plan-workspace",
        runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      };

      spyOn(workspaceService, "getInfo").mockResolvedValue(fakeMetadata);

      const result = await workspaceService.getPostCompactionState(workspaceId);

      expect(result.planPath).toBe(planFile);
      expect(result.planPath?.startsWith("~")).toBe(false);
    });
  });

  test("debounces multiple refresh requests into a single metadata emit", async () => {
    const workspaceId = "ws-post-compaction";

    const emitMetadata = mock(() => undefined);

    workspaceService.registerSession(workspaceId, {
      emitMetadata,
      onChatEvent: () => () => undefined,
      onMetadataEvent: () => () => undefined,
    } as unknown as AgentSession);

    const fakeMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: "/tmp/proj",
      namedWorkspacePath: "/tmp/proj/ws",
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
    };

    const getInfoMock = spyOn(workspaceService, "getInfo").mockResolvedValue(fakeMetadata);

    const postCompactionState = {
      planPath: "~/.mux/plans/cmux/plan.md",
      trackedFilePaths: ["/tmp/proj/file.ts"],
      excludedItems: [],
    };

    const getPostCompactionStateMock = spyOn(
      workspaceService,
      "getPostCompactionState"
    ).mockResolvedValue(postCompactionState);

    // Only the session's onCompactionComplete callback schedules this refresh; calling it
    // directly is the cheap way to issue a burst without a real compaction.
    const svc = workspaceService as unknown as {
      schedulePostCompactionMetadataRefresh: (workspaceId: string) => void;
    };
    svc.schedulePostCompactionMetadataRefresh(workspaceId);
    svc.schedulePostCompactionMetadataRefresh(workspaceId);
    svc.schedulePostCompactionMetadataRefresh(workspaceId);

    // Debounce is short, but use a safe buffer.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(getInfoMock).toHaveBeenCalledTimes(1);
    expect(getPostCompactionStateMock).toHaveBeenCalledTimes(1);
    expect(emitMetadata).toHaveBeenCalledTimes(1);

    const enriched = (emitMetadata as ReturnType<typeof mock>).mock.calls[0][0] as {
      postCompaction?: { planPath: string | null };
    };
    expect(enriched.postCompaction?.planPath).toBe(postCompactionState.planPath);
  });
});

describe("WorkspaceService interruptStream", () => {
  test("soft Send Now dispatches without requiring a hard Stop receipt", async () => {
    const workspaceId = "soft-send-now-receipt";
    const h = await createAgentSessionHarness({
      workspaceId,
      backgroundProcessManager: createTestBackgroundProcessManager(),
    });
    const service = createWorkspaceServiceForTest({
      config: h.config,
      historyService: h.historyService,
      aiService: h.aiService as AIService,
      initStateManager: h.initStateManager,
      extensionMetadata: new ExtensionMetadataService(
        path.join(h.config.rootDir, "extensionMetadata.json")
      ),
      backgroundProcessManager: h.backgroundProcessManager,
    });
    spyOn(service, "getOrCreateSession").mockReturnValue(h.session);
    const accepted = Promise.withResolvers<void>();
    try {
      h.session.queueMessage(
        "soft queued input",
        { model: "openai:gpt-4o", agentId: "exec" },
        { onAccepted: () => accepted.resolve() }
      );
      expect(
        await service.interruptStream(workspaceId, { soft: true, sendQueuedImmediately: true })
      ).toEqual(Ok(undefined));
      await accepted.promise;
      const history = await h.historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success && history.data.some((row) => row.role === "user")).toBe(true);
      expect(
        await h.historyService.getCompactionCancellationStorage(workspaceId).read()
      ).toBeNull();
    } finally {
      await h.session.dispose();
      await h.cleanup();
    }
  });

  test("sendQueuedImmediately waits for interrupted accounting and terminal publication", async () => {
    const workspaceId = "ws-interrupt-policy-barrier";
    const completion = Promise.withResolvers<TurnCompletion>();
    const accountingEntered = Promise.withResolvers<void>();
    const releaseAccounting = Promise.withResolvers<void>();
    const replacementStarted = Promise.withResolvers<void>();
    const emitter = new EventEmitter();
    const terminalOrder: string[] = [];
    let streamCount = 0;
    const h = await createAgentSessionHarness({
      workspaceId,
      aiEmitter: emitter,
      captureEvents: true,
      backgroundProcessManager: createTestBackgroundProcessManager(),
      aiServiceOverrides: {
        streamMessage: mock(() => {
          const messageId = `assistant-${++streamCount}`;
          emitter.emit("stream-start", {
            type: "stream-start",
            workspaceId,
            messageId,
            model: "openai:gpt-4o",
            startTime: Date.now(),
          });
          if (streamCount === 2) replacementStarted.resolve();
          return Promise.resolve(
            Ok({
              messageId,
              completion:
                streamCount === 1
                  ? completion.promise
                  : createStartedTurnHandle(h.session.closingSignal).completion,
            })
          );
        }),
        stopStream: mock(() => {
          const streamAbort = {
            type: "stream-abort" as const,
            workspaceId,
            messageId: "assistant-1",
            abortReason: "user" as const,
          };
          emitter.emit("stream-abort", streamAbort);
          completion.resolve({ status: "aborted", abortReason: "user", streamAbort });
          return Promise.resolve(Ok(undefined));
        }),
      },
    });
    const extensionMetadata = new ExtensionMetadataService(
      path.join(h.config.rootDir, "extensionMetadata.json")
    );
    // Stream start/abort activity writes are fire-and-forget and this test asserts chat-event
    // order, not activity; keep them off disk so a late write cannot race h.cleanup().
    spyOn(extensionMetadata, "setStreaming").mockImplementation((_id, streaming) =>
      Promise.resolve({ recency: Date.now(), streaming, lastModel: null, lastThinkingLevel: null })
    );
    const workspaceService = createWorkspaceServiceForTest({
      config: h.config,
      historyService: h.historyService,
      aiService: h.aiService as AIService,
      initStateManager: h.initStateManager,
      extensionMetadata,
      backgroundProcessManager: h.backgroundProcessManager,
    });
    spyOn(workspaceService, "getOrCreateSession").mockReturnValue(h.session);
    const policy = h.session as unknown as {
      recordGoalAccountingFromUsage(input: unknown): Promise<void>;
    };
    spyOn(policy, "recordGoalAccountingFromUsage").mockImplementation(async () => {
      accountingEntered.resolve();
      await releaseAccounting.promise;
    });
    const dispatch = spyOn(h.session, "sendNextUserQueuedMessage");
    h.session.onChatEvent(({ message }) => {
      if (message.type === "stream-start" || message.type === "stream-abort")
        terminalOrder.push(`${message.type}:${message.messageId}`);
    });
    let interrupt: Promise<unknown> | undefined;
    try {
      await h.session.sendMessage("source", { model: "openai:gpt-4o", agentId: "exec" });
      h.session.queueMessage("queued replacement", { model: "openai:gpt-4o", agentId: "exec" });
      interrupt = workspaceService.interruptStream(workspaceId, { sendQueuedImmediately: true });
      await accountingEntered.promise;
      // Drain the facade's Promise-only bookkeeping while terminal accounting is
      // held by the explicit barrier; no elapsed-time assumption or timer is needed.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(dispatch).not.toHaveBeenCalled();
      releaseAccounting.resolve();
      await interrupt;
      await replacementStarted.promise;
      expect(terminalOrder).toEqual([
        "stream-start:assistant-1",
        "stream-abort:assistant-1",
        "stream-start:assistant-2",
      ]);
      expect(h.session.isBusy()).toBe(true);
    } finally {
      releaseAccounting.resolve();
      await interrupt;
      await h.session.dispose();
      await h.cleanup();
    }
  });

  test("sendQueuedImmediately clears hard-interrupt suppression before queued resend", async () => {
    const workspaceId = "ws-interrupt-queue-111";

    const harness = await createWorkspaceServiceHarness({
      aiService: createMockAIService({ isStreaming: mock(() => false) }),
    });
    const workspaceService = harness.service;

    const resetAutoResumeCount = mock(() => undefined);
    const markParentWorkspaceInterrupted = mock(() => undefined);
    const terminateAllDescendantAgentTasks = mock(() => Promise.resolve([] as string[]));
    workspaceService.setAgentTaskIntegration(
      makeAgentTaskIntegrationFake({
        resetAutoResumeCount,
        markParentWorkspaceInterrupted,
        terminateAllDescendantAgentTasks,
      })
    );

    const sendNextUserQueuedMessage = mock(() => true);
    const restoreQueueToInput = mock(() => undefined);
    const interruptStream = mock(() => Promise.resolve(Ok(undefined)));
    const fakeSession = {
      ...createCompactionAdmissionMocks(),
      interruptStream,
      sendNextUserQueuedMessage,
      restoreQueueToInput,
    };
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue(
      fakeSession as unknown as AgentSession
    );

    try {
      const result = await workspaceService.interruptStream(workspaceId, {
        sendQueuedImmediately: true,
      });

      expect(result.success).toBe(true);
      expect(markParentWorkspaceInterrupted).toHaveBeenCalledWith(workspaceId);
      expect(terminateAllDescendantAgentTasks).toHaveBeenCalledWith(workspaceId);
      expect(resetAutoResumeCount).toHaveBeenCalledTimes(2);
      expect(sendNextUserQueuedMessage).toHaveBeenCalledTimes(1);
      expect(restoreQueueToInput).not.toHaveBeenCalled();
    } finally {
      getOrCreateSessionSpy.mockRestore();
      await harness.cleanup();
    }
  });
});
