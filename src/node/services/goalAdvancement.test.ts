// Goal advancement after automatic work ends or is abandoned (G4, #5461; decision in
// issuecomment-5956324581). Each regression test fails at its "Target assertion" with the fix
// reverted; the controls cover the exceptions that must win over an advancement.
import * as path from "path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Config } from "@/node/config";
import type { GoalRecordV1 } from "@/common/types/goal";
import { Ok } from "@/common/types/result";
import type { StreamErrorType } from "@/common/types/errors";
import type { StreamAbortEvent, StreamEndEvent } from "@/common/types/stream";
import { GOAL_STREAM_ERROR_RESUME_MAX_ATTEMPTS } from "@/constants/goals";
import type { AgentSession } from "./agentSession";
import {
  createAgentSessionHarness,
  createFailedTurnHandle,
  createStartedTurnHandle,
  runSessionTerminalPolicy,
} from "./agentSession.testHarness";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { HistoryService } from "./historyService";
import type { IdleDispatcher } from "./idleDispatcher";
import { createTestHistoryService } from "./testHistoryService";
import { WorkspaceGoalService } from "./workspaceGoalService";
import {
  analyticsMock,
  continuationBridge,
  PROJECT_PATH,
  setGoalOk,
} from "./workspaceGoalService.testHarness";
import type { EventEmitter } from "events";

const TEST_MODEL = "openai:gpt-4o";

async function addWorkspace(config: Config, workspaceId: string): Promise<void> {
  await config.addWorkspace(PROJECT_PATH, {
    id: workspaceId,
    name: workspaceId,
    projectName: "mux-goal-service-test-project",
    projectPath: PROJECT_PATH,
    runtimeConfig: { type: "local" },
  });
}

/** Polls without throwing: the reverted code may never reach the polled state. */
async function settle(condition: () => Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("goal advancement after automatic work ends or is abandoned (G4)", () => {
  const workspaceId = "goal-g4-advancement";
  const SEND_OPTIONS = { model: TEST_MODEL, agentId: "exec" };
  let config: Config;
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;
  let service: WorkspaceGoalService;
  let session: AgentSession;
  let aiEmitter: EventEmitter;
  let requestDispatch: ReturnType<typeof mock>;
  let providerUp: boolean;
  /** How a failing stream fails; non-retryable by default, so RetryManager leaves it alone. */
  let failureType: StreamErrorType;
  /** When set, a failing stream reports its failure only once this settles. */
  let failureGate: Promise<void> | null;
  let streamCalls: number;

  beforeEach(async () => {
    ({ config, historyService, cleanup } = await createTestHistoryService());
    await addWorkspace(config, workspaceId);
    const extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    // No cooldown: the test drives successive continuations back to back.
    service = new WorkspaceGoalService(config, historyService, extensionMetadata, analyticsMock(), {
      continuationCooldownMs: 0,
    });
    providerUp = false;
    failureType = "authentication";
    failureGate = null;
    streamCalls = 0;
    const harness = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      workspaceGoalService: service,
      aiServiceOverrides: {
        streamMessage: mock(() => {
          streamCalls += 1;
          if (providerUp) {
            // A real stream reports its start before its handle settles.
            aiEmitter.emit("stream-start", {
              type: "stream-start",
              workspaceId,
              messageId: `assistant-ok-${streamCalls}`,
              model: TEST_MODEL,
              startTime: Date.now(),
            });
          }
          if (providerUp) {
            return Promise.resolve(
              Ok(createStartedTurnHandle(session.closingSignal, `assistant-ok-${streamCalls}`))
            );
          }
          const failed = createFailedTurnHandle(`assistant-failed-${streamCalls}`, {
            error: "provider failure",
            errorType: failureType,
          });
          const gate = failureGate;
          return Promise.resolve(
            Ok(
              gate != null ? { ...failed, completion: gate.then(() => failed.completion) } : failed
            )
          );
        }),
      },
    });
    session = harness.session;
    aiEmitter = harness.aiEmitter;
    // A dispatcher that only records requests; the test runs each dispatch itself.
    requestDispatch = mock(() => Promise.resolve());
    const dispatcher = {
      registerConsumer: () => () => undefined,
      requestDispatch,
    } as unknown as IdleDispatcher;
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(async (input) => {
        const result = await session.sendMessage(input.message, input.options, {
          acceptanceOrigin: "automatic",
          synthetic: true,
          agentInitiated: true,
          goalContinuation: true,
          goalKind: input.kind,
          goalId: input.goalId,
          admissionStale: input.admissionStale,
        });
        return result.success;
      }),
      // Mirrors WorkspaceService.getGoalContinuationRuntimeState: queued or held user input
      // blocks a continuation (queued_user_input).
      getRuntimeState: () => ({
        isRuntimeCompatible: true,
        isBusy: session.isBusy(),
        hasQueuedMessages: session.hasPendingManualFollowUp() || session.hasPendingUserInput(),
      }),
      getKickoffSendOptions: () => Promise.resolve(SEND_OPTIONS),
    });
  });

  afterEach(async () => {
    await session.dispose();
    await cleanup();
  });

  /** Runs the goal loop's next dispatch at `nowMs` (the backoff is wall-clock based). */
  async function dispatchAt(nowMs: number): Promise<boolean> {
    const realNow = Date.now.bind(Date);
    const clock = spyOn(Date, "now").mockImplementation(() => Math.max(realNow(), nowMs));
    try {
      const payload = await service.buildGoalContinuationPayload(workspaceId);
      if (payload == null) return false;
      await payload.dispatch();
      return true;
    } finally {
      clock.mockRestore();
    }
  }

  /** Queues the user's own message whose task attempt closed: its dispatch refuses it into held input. */
  function queueStaleManualMessage(): void {
    session.queueMessage(
      "Do this next",
      { model: TEST_MODEL, agentId: "exec" },
      {
        acceptanceOrigin: "manual",
        turnAdmission: {
          admissionStale: () => true,
          onEnqueued: () => undefined,
          onAdmitted: () => undefined,
          onDisposed: () => undefined,
        },
      }
    );
  }

  async function eligibilityAfterBackoff() {
    return service.checkGoalContinuationEligibility(workspaceId, Date.now() + 120_000);
  }

  async function waitForRequests(after: number, timeoutMs = 1_000): Promise<number> {
    await settle(() => Promise.resolve(requestDispatch.mock.calls.length > after), timeoutMs);
    return requestDispatch.mock.calls.length - after;
  }

  describe("terminal stream error", () => {
    /** An active goal whose kickoff continuation failed with a non-retryable provider error. */
    async function failedGoalTurn(): Promise<{ goal: GoalRecordV1; resumeRequests: number }> {
      const goal = await setGoalOk(service, { workspaceId, objective: "Ship G4" });
      const requestsBefore = requestDispatch.mock.calls.length;
      expect(await dispatchAt(Date.now())).toBe(true);
      // The failed stream's terminal policy runs after the send resolves.
      return { goal, resumeRequests: await waitForRequests(requestsBefore) };
    }
    test("G4: an active goal resumes after a terminal stream error once the provider recovers", async () => {
      const { goal, resumeRequests } = await failedGoalTurn();
      expect(streamCalls).toBe(1);
      // Target assertion: the error requested a resume dispatch (the code requested none, so
      // nothing drove the goal again and it idled).
      expect(resumeRequests).toBe(1);
      expect(await service.checkGoalContinuationEligibility(workspaceId, Date.now())).toMatchObject(
        {
          eligible: false,
          reason: "error_backoff",
        }
      );

      // The provider recovers; the backoff elapses and the goal loop resumes the goal.
      providerUp = true;
      expect(await dispatchAt(Date.now() + 120_000)).toBe(true);
      expect(streamCalls).toBe(2);
      expect(await service.getGoal(workspaceId)).toMatchObject({
        goalId: goal.goalId,
        status: "active",
      });
    });

    test("G4: a failed heartbeat turn resumes the goal with the goal's options, not the heartbeat's", async () => {
      await setGoalOk(service, { workspaceId, objective: "Ship G4" });
      // The heartbeat turn runs while the kickoff candidate is gone (already consumed).
      service.clearPendingContinuationForManualUserMessage(workspaceId);
      const requestsBefore = requestDispatch.mock.calls.length;
      const sent = await session.sendMessage(
        "Heartbeat check-in",
        {
          model: "anthropic:claude-haiku-4-5",
          agentId: "exec",
          muxMetadata: { type: "heartbeat-request", source: "heartbeat" },
        },
        { acceptanceOrigin: "automatic", synthetic: true, agentInitiated: true }
      );
      expect(sent.success).toBe(true);
      // Target assertion: the resume was requested...
      expect(await waitForRequests(requestsBefore)).toBe(1);
      // ...with the goal's kickoff options, not the heartbeat's model.
      expect(await eligibilityAfterBackoff()).toMatchObject({
        eligible: true,
        candidate: { source: "stream_error", sendOptions: { model: TEST_MODEL } },
      });
    });

    test("G4: a terminal error before the kickoff fires keeps the kickoff candidate", async () => {
      await setGoalOk(service, { workspaceId, objective: "Ship G4" });
      const requestsBefore = requestDispatch.mock.calls.length;
      // A monitor wake streams before the new goal's kickoff fires, and fails.
      const sent = await session.sendMessage(
        "Background process output",
        { model: TEST_MODEL, agentId: "exec" },
        { acceptanceOrigin: "automatic", synthetic: true, agentInitiated: true }
      );
      expect(sent.success).toBe(true);
      expect(await waitForRequests(requestsBefore)).toBe(1);
      expect(await service.checkGoalContinuationEligibility(workspaceId, Date.now())).toMatchObject(
        { eligible: false, reason: "error_backoff" }
      );
      // Target assertion: the kickoff survives (a stream_error candidate would reconcile against
      // the pre-goal user row and could pause the kickoff-window goal).
      expect(await eligibilityAfterBackoff()).toMatchObject({
        eligible: true,
        candidate: { source: "kickoff" },
      });
    });

    test("G4 control: an opt-out during a kept kickoff's backoff drops it", async () => {
      await setGoalOk(service, { workspaceId, objective: "Ship G4" });
      const requestsBefore = requestDispatch.mock.calls.length;
      await session.sendMessage(
        "Background process output",
        { model: TEST_MODEL, agentId: "exec" },
        { acceptanceOrigin: "automatic", synthetic: true, agentInitiated: true }
      );
      expect(await waitForRequests(requestsBefore)).toBe(1);
      await session.setAutoRetryEnabled(false);
      // Target assertion: the kickoff carried the error's backoff, so the opt-out cancels it.
      expect(await eligibilityAfterBackoff()).toMatchObject({ reason: "no_pending_candidate" });
    });

    test("G4: a terminal error with refused manual input held waits for the input to go", async () => {
      await setGoalOk(service, { workspaceId, objective: "Ship G4" });
      service.clearPendingContinuationForManualUserMessage(workspaceId);
      let release!: () => void;
      failureGate = new Promise((resolve) => (release = resolve));
      const requestsBefore = requestDispatch.mock.calls.length;
      const sent = await session.sendMessage(
        "Background process output",
        { model: TEST_MODEL, agentId: "exec" },
        { acceptanceOrigin: "automatic", synthetic: true, agentInitiated: true }
      );
      expect(sent.success).toBe(true);
      // The user's message waits behind the failing turn. A terminal error leaves the queue for
      // the next drain, which refuses it into held input.
      queueStaleManualMessage();
      release();
      await session.waitForIdle();
      // Target assertion: the goal does not resume over the user's queued input...
      expect(await waitForRequests(requestsBefore, 200)).toBe(0);
      session.drainQueuedMessagesIfIdle();
      const [held] = session.getHeldInputs();
      expect(held).toBeDefined();
      // ...nor over the held input it becomes.
      expect(await waitForRequests(requestsBefore, 100)).toBe(0);
      expect(await eligibilityAfterBackoff()).toMatchObject({ reason: "no_pending_candidate" });
      // The user discards it: the resume is handed over.
      expect(session.discardHeldInput(held.id)).toBe("discarded");
      expect(await waitForRequests(requestsBefore)).toBe(1);
    });

    test("G4: a stream that ends normally after the error owns the continuation", async () => {
      await setGoalOk(service, { workspaceId, objective: "Ship G4" });
      service.clearPendingContinuationForManualUserMessage(workspaceId);
      const fence = service.captureGoalAdvancementFence(workspaceId);
      // The failed turn's queued successor ends normally before the error's resume request lands.
      await service.requestContinuationAfterStreamEnd({ workspaceId, sendOptions: SEND_OPTIONS });
      await service.requestContinuationAfterStreamError({
        workspaceId,
        fence,
        sendOptions: { model: "anthropic:claude-haiku-4-5", agentId: "exec" },
      });
      // Target assertion: the stale error did not replace the successor's continuation.
      expect(await eligibilityAfterBackoff()).toMatchObject({
        eligible: true,
        candidate: { source: "stream_end", sendOptions: { model: TEST_MODEL } },
      });
    });

    test("G4: a budget limit reached during a kept kickoff's backoff arms the wrap-up", async () => {
      await setGoalOk(service, { workspaceId, objective: "Ship G4", turnCap: 1 });
      const requestsBefore = requestDispatch.mock.calls.length;
      await session.sendMessage(
        "Background process output",
        { model: TEST_MODEL, agentId: "exec" },
        { acceptanceOrigin: "automatic", synthetic: true, agentInitiated: true }
      );
      expect(await waitForRequests(requestsBefore)).toBe(1);
      await service.attributeChildReport({
        parentWorkspaceId: workspaceId,
        childWorkspaceId: "child-a",
        childCostCents: 0,
      });
      expect((await service.getGoal(workspaceId))?.status).toBe("budget_limited");
      // Target assertion: the backoff-tagged kickoff yielded to the wrap-up.
      expect(await eligibilityAfterBackoff()).toMatchObject({
        eligible: true,
        candidate: { source: "budget_wrapup" },
      });
    });

    test("G4: a budget limit reached during the backoff arms the wrap-up", async () => {
      await setGoalOk(service, { workspaceId, objective: "Ship G4", turnCap: 1 });
      service.clearPendingContinuationForManualUserMessage(workspaceId);
      await service.requestContinuationAfterStreamError({
        workspaceId,
        fence: service.captureGoalAdvancementFence(workspaceId),
        sendOptions: SEND_OPTIONS,
      });
      // A child report pushes the goal over its turn cap while the resume waits.
      await service.attributeChildReport({
        parentWorkspaceId: workspaceId,
        childWorkspaceId: "child-a",
        childCostCents: 0,
      });
      expect((await service.getGoal(workspaceId))?.status).toBe("budget_limited");
      // Target assertion: the wrap-up replaced the moot resume (it was refused while the resume
      // occupied the workspace, and the resume was then dropped).
      expect(await eligibilityAfterBackoff()).toMatchObject({
        eligible: true,
        candidate: { source: "budget_wrapup" },
      });
    });

    test("G4: a repeated error resumes at most GOAL_STREAM_ERROR_RESUME_MAX_ATTEMPTS times", async () => {
      await failedGoalTurn();
      for (let attempt = 1; attempt <= GOAL_STREAM_ERROR_RESUME_MAX_ATTEMPTS; attempt++) {
        const requestsBefore = requestDispatch.mock.calls.length;
        expect(await dispatchAt(Date.now() + 120_000 * attempt)).toBe(true);
        await settle(
          () => Promise.resolve(requestDispatch.mock.calls.length > requestsBefore),
          1_000
        );
      }
      // One kickoff plus MAX resumes ran; the last failure armed nothing.
      expect(streamCalls).toBe(GOAL_STREAM_ERROR_RESUME_MAX_ATTEMPTS + 1);
      expect(await eligibilityAfterBackoff()).toMatchObject({
        eligible: false,
        reason: "no_pending_candidate",
      });
    });

    test("G4 control: a UI pause during the backoff wins", async () => {
      const { goal } = await failedGoalTurn();
      await setGoalOk(service, { workspaceId, status: "paused", expectedGoalId: goal.goalId });
      expect((await eligibilityAfterBackoff()).eligible).toBe(false);
    });

    test("G4 control: an agent completion during the backoff wins", async () => {
      const { goal } = await failedGoalTurn();
      await setGoalOk(service, {
        workspaceId,
        status: "complete",
        initiator: "model",
        completionSummary: "done",
        expectedGoalId: goal.goalId,
      });
      expect((await eligibilityAfterBackoff()).eligible).toBe(false);
    });

    test("G4 control: a user Stop during the backoff wins", async () => {
      await failedGoalTurn();
      await service.recordUserStoppedStream(workspaceId);
      expect((await eligibilityAfterBackoff()).eligible).toBe(false);
    });

    test("G4 control: an auto-retry opt-out during the backoff wins", async () => {
      await failedGoalTurn();
      await session.setAutoRetryEnabled(false);
      const after = await eligibilityAfterBackoff();
      expect(after.eligible ? after.candidate?.source : null).not.toBe("stream_error");
    });

    test("G4 control: a persisted auto-retry opt-out arms no resume", async () => {
      await session.setAutoRetryEnabled(false);
      const { resumeRequests } = await failedGoalTurn();
      expect(resumeRequests).toBe(0);
      // The failed kickoff was retired and nothing is armed.
      expect(await eligibilityAfterBackoff()).toMatchObject({ reason: "no_pending_candidate" });
    });

    test("G4 control: a manual send takes the pending resume", async () => {
      await failedGoalTurn();
      providerUp = true;
      expect((await session.sendMessage("Do this instead", SEND_OPTIONS)).success).toBe(true);
      expect(await eligibilityAfterBackoff()).toMatchObject({ eligible: false });
      // Only the manual turn streamed after the failure.
      expect(streamCalls).toBe(2);
    });

    test("G4 control: an opt-out or Stop that lands before arming arms nothing", async () => {
      const goal = await setGoalOk(service, { workspaceId, objective: "Ship G4" });
      service.clearPendingContinuationForManualUserMessage(workspaceId);
      for (const intervene of [
        () => Promise.resolve(service.cancelStreamErrorResume(workspaceId)),
        () => service.recordUserStoppedStream(workspaceId),
      ]) {
        const fence = service.captureGoalAdvancementFence(workspaceId);
        await intervene();
        await service.requestContinuationAfterStreamError({ workspaceId, fence });
        expect(await eligibilityAfterBackoff()).toMatchObject({ reason: "no_pending_candidate" });
      }
      expect(goal.status).toBe("active");
    });

    test("G4 control: a budget- or turn-limited goal is not resumed", async () => {
      await setGoalOk(service, { workspaceId, objective: "Ship G4", turnCap: 1 });
      service.clearPendingContinuationForManualUserMessage(workspaceId);
      // One accounted continuation turn reaches the cap: the goal is budget_limited.
      await service.recordStreamAccounting({
        workspaceId,
        costUsd: 0,
        streamStartedAtMs: Date.now(),
        streamOriginKind: "goal_continuation",
      });
      expect((await service.getGoal(workspaceId))?.status).toBe("budget_limited");
      await service.requestContinuationAfterStreamError({
        workspaceId,
        fence: service.captureGoalAdvancementFence(workspaceId),
        sendOptions: SEND_OPTIONS,
      });
      expect(await eligibilityAfterBackoff()).toMatchObject({ reason: "no_pending_candidate" });
    });

    test("G4 control: after a restart the active goal resumes", async () => {
      await failedGoalTurn();
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const restarted = new WorkspaceGoalService(
        config,
        historyService,
        extensionMetadata,
        analyticsMock(),
        { continuationCooldownMs: 0 }
      );
      restarted.registerGoalContinuationConsumer(
        { registerConsumer: () => () => undefined, requestDispatch } as unknown as IdleDispatcher,
        { ...continuationBridge(), getKickoffSendOptions: () => Promise.resolve(SEND_OPTIONS) }
      );
      await restarted.recoverPendingDispatchAfterRestart(workspaceId);
      expect(
        await restarted.checkGoalContinuationEligibility(workspaceId, Date.now() + 120_000)
      ).toMatchObject({ eligible: true });
    });
  });

  describe("abandoned automatic work", () => {
    function streamStart(messageId: string): void {
      aiEmitter.emit("stream-start", {
        type: "stream-start",
        workspaceId,
        messageId,
        model: TEST_MODEL,
        startTime: Date.now(),
      });
    }

    function streamEnd(messageId: string): StreamEndEvent {
      return {
        type: "stream-end",
        workspaceId,
        messageId,
        parts: [{ type: "text", text: "Working on it." }],
        metadata: {
          model: TEST_MODEL,
          contextUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          providerMetadata: {},
          finishReason: "stop",
        },
      };
    }

    function systemAbort(messageId: string): StreamAbortEvent {
      return {
        type: "stream-abort",
        workspaceId,
        messageId,
        abortReason: "system",
        metadata: { duration: 1 },
      };
    }

    /** An active goal with no candidate armed: a turn for it is running. */
    async function activeGoalWithRunningTurn(): Promise<GoalRecordV1> {
      const goal = await setGoalOk(service, { workspaceId, objective: "Ship G4" });
      // The running turn consumed the kickoff candidate.
      service.clearPendingContinuationForManualUserMessage(workspaceId);
      streamStart("assistant-running");
      return goal;
    }

    /** Queues automatic work (a heartbeat, wake or peer message) behind the running turn. */
    function queueAutomaticWork(
      internal: { admissionStale?: () => boolean; cancelSignal?: AbortSignal },
      queueDispatchMode: "turn-end" | "tool-end" = "turn-end"
    ): void {
      session.queueMessage(
        "Automatic follow-up",
        { model: TEST_MODEL, agentId: "exec", queueDispatchMode },
        { acceptanceOrigin: "automatic", synthetic: true, agentInitiated: true, ...internal }
      );
    }

    test("G4: a queued automatic turn refused at dispatch advances the goal exactly once", async () => {
      const goal = await activeGoalWithRunningTurn();
      queueAutomaticWork({ admissionStale: () => true });
      const requestsBefore = requestDispatch.mock.calls.length;
      // The running turn ends with the automatic turn queued: it leaves the goal continuation to
      // that turn, which the drain then refuses.
      await runSessionTerminalPolicy(session, aiEmitter, streamEnd("assistant-running"));
      await session.waitForIdle();
      const requests = await waitForRequests(requestsBefore);
      // Target assertion: the abandoned work's continuation was requested (the code requested
      // none, and the goal idled).
      expect(requests).toBe(1);
      expect(await service.checkGoalContinuationEligibility(workspaceId, Date.now())).toMatchObject(
        {
          eligible: true,
          goal: { goalId: goal.goalId },
        }
      );
      // Exactly once: nothing else requests it.
      expect(await waitForRequests(requestDispatch.mock.calls.length, 100)).toBe(0);
    });

    test("G4: a tool-end soft stop whose queued turn was withdrawn advances the goal once", async () => {
      const goal = await activeGoalWithRunningTurn();
      const withdraw = new AbortController();
      queueAutomaticWork({ cancelSignal: withdraw.signal }, "tool-end");
      // A provider-executed tool result soft-stops the turn for the tool-end entry...
      aiEmitter.emit("tool-call-end", {
        type: "tool-call-end",
        workspaceId,
        messageId: "assistant-running",
        toolCallId: "tool-call-1",
        toolName: "web_search",
        result: { success: true },
        providerExecuted: true,
        timestamp: Date.now(),
      });
      // ...which is withdrawn before the soft stop lands.
      withdraw.abort("withdrawn");
      const requestsBefore = requestDispatch.mock.calls.length;
      await runSessionTerminalPolicy(session, aiEmitter, systemAbort("assistant-running"));
      await session.waitForIdle();
      // Target assertion: the soft-stopped turn's continuation was requested.
      expect(await waitForRequests(requestsBefore)).toBe(1);
      expect(await service.checkGoalContinuationEligibility(workspaceId, Date.now())).toMatchObject(
        {
          eligible: true,
          goal: { goalId: goal.goalId },
        }
      );
    });

    test("G4 control: a refused manual queued message owes no advancement", async () => {
      await activeGoalWithRunningTurn();
      queueStaleManualMessage();
      const requestsBefore = requestDispatch.mock.calls.length;
      await runSessionTerminalPolicy(session, aiEmitter, streamEnd("assistant-running"));
      await session.waitForIdle();
      // The refusal kept the user's input as held input for the user to resend or discard.
      expect(session.hasPendingUserInput()).toBe(true);
      // Target assertion: the goal does not advance over the user's held input.
      expect(await waitForRequests(requestsBefore, 100)).toBe(0);
      expect(await eligibilityAfterBackoff()).toMatchObject({ reason: "no_pending_candidate" });
    });

    test("G4: a successful turn that hands off to queued work starts a new error episode", async () => {
      await activeGoalWithRunningTurn();
      const errorResume = () =>
        service.requestContinuationAfterStreamError({
          workspaceId,
          fence: service.captureGoalAdvancementFence(workspaceId),
          sendOptions: SEND_OPTIONS,
        });
      // An earlier failure episode spent every resume.
      for (let attempt = 1; attempt <= GOAL_STREAM_ERROR_RESUME_MAX_ATTEMPTS; attempt++) {
        await errorResume();
      }
      service.clearPendingContinuationForManualUserMessage(workspaceId);
      // The running turn then succeeds and hands off to queued automatic work.
      queueAutomaticWork({ admissionStale: () => true });
      const requestsBefore = requestDispatch.mock.calls.length;
      await runSessionTerminalPolicy(session, aiEmitter, streamEnd("assistant-running"));
      await session.waitForIdle();
      await waitForRequests(requestsBefore);
      service.clearPendingContinuationForManualUserMessage(workspaceId);
      await errorResume();
      // Target assertion: the next error is the first of a new episode and arms a resume.
      expect(await service.checkGoalContinuationEligibility(workspaceId, Date.now())).toMatchObject(
        { eligible: false, reason: "error_backoff" }
      );
    });

    for (const [cancelPath, cancelRetry] of [
      ["an auto-retry opt-out", () => session.setAutoRetryEnabled(false)],
      ["a context mutation", () => session.discardAutoRetryForContextMutation()],
      ["a context reset", () => session.applyContextResetSideEffects()],
    ] as const) {
      test(`G4: an owed advancement waits for a scheduled retry of the queued work (${cancelPath})`, async () => {
        await activeGoalWithRunningTurn();
        queueAutomaticWork({});
        // The queued turn fails before it streams with a retryable error: RetryManager owns it.
        failureType = "network";
        const requestsBefore = requestDispatch.mock.calls.length;
        await runSessionTerminalPolicy(session, aiEmitter, streamEnd("assistant-running"));
        await settle(() => Promise.resolve(session.hasPendingAutoRetry()), 1_000);
        expect(session.hasPendingAutoRetry()).toBe(true);
        // Target assertion: no advancement while the retry still owes the goal continuation.
        expect(await waitForRequests(requestsBefore, 200)).toBe(0);
        // The retry is cancelled: the advancement it blocked is handed over.
        await cancelRetry();
        expect(await waitForRequests(requestsBefore)).toBe(1);
        expect(await eligibilityAfterBackoff()).toMatchObject({
          eligible: true,
          candidate: { source: "stream_end" },
        });
      });
    }

    test("G4 control: a successful stream drops the earlier error's resume", async () => {
      await activeGoalWithRunningTurn();
      // An earlier failure armed a resume; this turn started before it dispatched.
      await service.requestContinuationAfterStreamError({
        workspaceId,
        fence: service.captureGoalAdvancementFence(workspaceId),
        sendOptions: SEND_OPTIONS,
      });
      // The user's message, queued during the turn, is refused into held input at its end.
      queueStaleManualMessage();
      await runSessionTerminalPolicy(session, aiEmitter, streamEnd("assistant-running"));
      await session.waitForIdle();
      expect(session.hasPendingUserInput()).toBe(true);
      // Target assertion: the stale resume cannot dispatch over the user's held input.
      expect(await eligibilityAfterBackoff()).toMatchObject({ reason: "no_pending_candidate" });
    });

    test("G4: removing the last held input wakes the blocked goal dispatch exactly once", async () => {
      for (const remove of [
        (id: string) => expect(session.discardHeldInput(id)).toBe("discarded"),
        // A held input found already accepted during its re-send.
        (id: string) => expect(session.removeHeldInput(id)).toBe(true),
      ]) {
        await activeGoalWithRunningTurn();
        queueStaleManualMessage();
        await runSessionTerminalPolicy(session, aiEmitter, streamEnd("assistant-running"));
        await session.waitForIdle();
        const [held] = session.getHeldInputs();
        expect(held).toBeDefined();
        // A continuation candidate waits; its dispatch stops on the held input.
        await service.requestContinuationAfterStreamEnd({ workspaceId, sendOptions: SEND_OPTIONS });
        expect(
          await service.checkGoalContinuationEligibility(workspaceId, Date.now())
        ).toMatchObject({ eligible: false, reason: "queued_user_input" });
        const requestsBefore = requestDispatch.mock.calls.length;
        remove(held.id);
        // Target assertion: the blocked dispatch is requested again...
        expect(await waitForRequests(requestsBefore, 200)).toBe(1);
        // ...once: a later unblocked re-evaluation (an auto-retry cancellation) does not request
        // it again.
        await session.setAutoRetryEnabled(false);
        expect(await waitForRequests(requestsBefore + 1, 100)).toBe(0);
        await session.setAutoRetryEnabled(true);
      }
    });

    test("G4 control: a queued automatic turn that streams owns the continuation", async () => {
      await activeGoalWithRunningTurn();
      providerUp = true;
      queueAutomaticWork({});
      const requestsBefore = requestDispatch.mock.calls.length;
      await runSessionTerminalPolicy(session, aiEmitter, streamEnd("assistant-running"));
      await settle(() => Promise.resolve(streamCalls === 1), 1_000);
      expect(streamCalls).toBe(1);
      // The queued turn is streaming: no advancement is requested on its behalf.
      expect(await waitForRequests(requestsBefore, 100)).toBe(0);
    });

    test("G4: a queued automatic turn that streams and ends advances the goal once", async () => {
      await activeGoalWithRunningTurn();
      providerUp = true;
      queueAutomaticWork({});
      const requestsBefore = requestDispatch.mock.calls.length;
      await runSessionTerminalPolicy(session, aiEmitter, streamEnd("assistant-running"));
      await settle(() => Promise.resolve(streamCalls === 1), 1_000);
      // The queued turn ends normally: its own stream end requests the continuation.
      await runSessionTerminalPolicy(session, aiEmitter, streamEnd("assistant-ok-1"));
      await session.waitForIdle();
      // Target assertion: the advancement the first turn left to it is not handed over as well.
      expect(await waitForRequests(requestsBefore)).toBe(1);
      expect(await waitForRequests(requestsBefore + 1, 100)).toBe(0);
    });

    test("G4 control: a UI pause before the refusal wins", async () => {
      const goal = await activeGoalWithRunningTurn();
      queueAutomaticWork({ admissionStale: () => true });
      const ended = runSessionTerminalPolicy(session, aiEmitter, streamEnd("assistant-running"));
      await setGoalOk(service, { workspaceId, status: "paused", expectedGoalId: goal.goalId });
      await ended;
      await session.waitForIdle();
      expect((await eligibilityAfterBackoff()).eligible).toBe(false);
    });

    test("G4 control: an agent completion before the refusal wins", async () => {
      const goal = await activeGoalWithRunningTurn();
      queueAutomaticWork({ admissionStale: () => true });
      await setGoalOk(service, {
        workspaceId,
        status: "complete",
        initiator: "model",
        completionSummary: "done",
        expectedGoalId: goal.goalId,
      });
      await runSessionTerminalPolicy(session, aiEmitter, streamEnd("assistant-running"));
      await session.waitForIdle();
      expect((await eligibilityAfterBackoff()).eligible).toBe(false);
    });

    test("G4 control: a user Stop discards the owed advancement", async () => {
      await activeGoalWithRunningTurn();
      queueAutomaticWork({ admissionStale: () => true });
      const requestsBefore = requestDispatch.mock.calls.length;
      await runSessionTerminalPolicy(session, aiEmitter, streamEnd("assistant-running"));
      // Simulates the Stop landing first: the session's interrupt discards what the turn owed.
      await service.recordUserStoppedStream(workspaceId);
      await session.waitForIdle();
      await waitForRequests(requestsBefore, 100);
      expect((await eligibilityAfterBackoff()).eligible).toBe(false);
    });

    test("G4 control: a turn-limited goal is not advanced", async () => {
      await setGoalOk(service, { workspaceId, objective: "Ship G4", turnCap: 1 });
      service.clearPendingContinuationForManualUserMessage(workspaceId);
      await service.recordStreamAccounting({
        workspaceId,
        costUsd: 0,
        streamStartedAtMs: Date.now(),
        streamOriginKind: "goal_continuation",
      });
      expect((await service.getGoal(workspaceId))?.status).toBe("budget_limited");
      await service.requestAdvancementAfterAbandonedAutomaticWork({
        workspaceId,
        fence: service.captureGoalAdvancementFence(workspaceId),
      });
      expect(await eligibilityAfterBackoff()).toMatchObject({ reason: "no_pending_candidate" });
    });

    test("G4 control: a manual send in flight takes the advancement", async () => {
      await activeGoalWithRunningTurn();
      queueAutomaticWork({ admissionStale: () => true });
      await runSessionTerminalPolicy(session, aiEmitter, streamEnd("assistant-running"));
      await session.waitForIdle();
      providerUp = true;
      expect((await session.sendMessage("Do this instead", SEND_OPTIONS)).success).toBe(true);
      expect((await eligibilityAfterBackoff()).eligible).toBe(false);
    });

    test("G4 control: an existing candidate is kept, not duplicated", async () => {
      const goal = await setGoalOk(service, { workspaceId, objective: "Ship G4" });
      const before = await service.checkGoalContinuationEligibility(workspaceId, Date.now());
      expect(before).toMatchObject({ eligible: true, candidate: { source: "kickoff" } });
      await service.requestAdvancementAfterAbandonedAutomaticWork({
        workspaceId,
        fence: service.captureGoalAdvancementFence(workspaceId),
      });
      expect(await service.checkGoalContinuationEligibility(workspaceId, Date.now())).toMatchObject(
        {
          eligible: true,
          goal: { goalId: goal.goalId },
          candidate: { source: "kickoff" },
        }
      );
    });
  });

  describe("one pending advancement and one wake-up path", () => {
    /** The goal's kickoff already ran; an automatic turn is about to fail (released by the caller). */
    async function gatedFailingTurn(): Promise<{ release: () => void; requestsBefore: number }> {
      await setGoalOk(service, { workspaceId, objective: "Ship G4" });
      service.clearPendingContinuationForManualUserMessage(workspaceId);
      let release!: () => void;
      failureGate = new Promise((resolve) => (release = resolve));
      const requestsBefore = requestDispatch.mock.calls.length;
      const sent = await session.sendMessage(
        "Background process output",
        { model: TEST_MODEL, agentId: "exec" },
        { acceptanceOrigin: "automatic", synthetic: true, agentInitiated: true }
      );
      expect(sent.success).toBe(true);
      return { release, requestsBefore };
    }

    /**
     * Queues automatic work that TaskService holds back (report-decision hold) and later
     * withdraws: the queue keeps it without dispatching it, then the re-run drain refuses it.
     */
    function queueHeldBackAutomaticWork(): { withdraw: () => void } {
      let decision: "hold" | { refuse: string } = "hold";
      session.queueMessage(
        "Task report wake",
        { model: TEST_MODEL, agentId: "exec" },
        {
          acceptanceOrigin: "automatic",
          synthetic: true,
          agentInitiated: true,
          turnAdmission: {
            admissionStale: () => false,
            onEnqueued: () => undefined,
            onAdmitted: () => undefined,
            onDisposed: () => undefined,
            resolveDispatch: () => decision,
          },
        }
      );
      return {
        withdraw: () => {
          decision = { refuse: "The task reported before this wake ran." };
          session.drainQueuedMessagesIfIdle();
        },
      };
    }

    /** A terminal error whose resume is blocked by held-back queued work. */
    async function errorBlockedByHeldBackWork(): Promise<{
      withdraw: () => void;
      requestsBefore: number;
    }> {
      const { release, requestsBefore } = await gatedFailingTurn();
      const work = queueHeldBackAutomaticWork();
      release();
      await session.waitForIdle();
      return { withdraw: work.withdraw, requestsBefore };
    }

    test("G4 (finding 1): an error resume blocked by held-back queued work runs once the work is withdrawn", async () => {
      const { withdraw, requestsBefore } = await errorBlockedByHeldBackWork();
      // Nothing dispatches while the queued work blocks the goal.
      expect(await waitForRequests(requestsBefore, 150)).toBe(0);
      withdraw();
      // Target assertion: the withdrawal re-evaluates the pending error advancement and hands it
      // over (the code armed a candidate that stopped on the queue and was never re-dispatched).
      expect(await waitForRequests(requestsBefore)).toBe(1);
      expect(await service.checkGoalContinuationEligibility(workspaceId, Date.now())).toMatchObject(
        { eligible: false, reason: "error_backoff" }
      );
      // Exactly once.
      expect(await waitForRequests(requestsBefore + 1, 100)).toBe(0);
    });

    test("G4 (finding 2): a failed kickoff is retired even when retries are disabled", async () => {
      await session.setAutoRetryEnabled(false);
      await setGoalOk(service, { workspaceId, objective: "Ship G4" });
      // The kickoff fires and fails; the persisted opt-out arms no resume.
      expect(await dispatchAt(Date.now())).toBe(true);
      await session.waitForIdle();
      await settle(() => Promise.resolve(false), 50);
      // Target assertion: the failed kickoff is not left installed for a later turn to re-dispatch.
      expect(await eligibilityAfterBackoff()).toMatchObject({ reason: "no_pending_candidate" });
      // A later unrelated turn that succeeds continues the goal as an ordinary stream end: a new
      // continuation of the active goal, not a re-dispatch of the failed kickoff.
      await service.requestContinuationAfterStreamEnd({ workspaceId, sendOptions: SEND_OPTIONS });
      expect(await eligibilityAfterBackoff()).toMatchObject({
        eligible: true,
        candidate: { source: "stream_end" },
      });
    });

    test("G4: with several blockers the advancement waits for the last one, then runs once", async () => {
      const { release, requestsBefore } = await gatedFailingTurn();
      const work = queueHeldBackAutomaticWork();
      // The user's message, queued behind the held-back work, is refused into held input.
      queueStaleManualMessage();
      release();
      await session.waitForIdle();
      work.withdraw();
      await settle(() => Promise.resolve(session.hasPendingUserInput()), 1_000);
      expect(session.hasPendingUserInput()).toBe(true);
      // The queue is empty, but the held input still blocks.
      expect(await waitForRequests(requestsBefore, 150)).toBe(0);
      const [held] = session.getHeldInputs();
      expect(session.discardHeldInput(held.id)).toBe("discarded");
      // Target assertion: removing the last blocker hands the error advancement over, once.
      expect(await waitForRequests(requestsBefore)).toBe(1);
      expect(await waitForRequests(requestsBefore + 1, 100)).toBe(0);
      expect(await service.checkGoalContinuationEligibility(workspaceId, Date.now())).toMatchObject(
        { reason: "error_backoff" }
      );
    });

    test("G4 control: a user Stop while blocked discards the pending advancement", async () => {
      const { withdraw, requestsBefore } = await errorBlockedByHeldBackWork();
      await session.interruptStream();
      withdraw();
      expect(await waitForRequests(requestsBefore, 150)).toBe(0);
      expect(await eligibilityAfterBackoff()).toMatchObject({ reason: "no_pending_candidate" });
    });

    test("G4 control: an auto-retry opt-out while blocked discards a pending error advancement", async () => {
      const { withdraw, requestsBefore } = await errorBlockedByHeldBackWork();
      await session.setAutoRetryEnabled(false);
      withdraw();
      // Target assertion: the opt-out wins over the blocked error resume.
      expect(await waitForRequests(requestsBefore, 150)).toBe(0);
      expect(await eligibilityAfterBackoff()).toMatchObject({ reason: "no_pending_candidate" });
    });

    test("G4 control: a goal replacement while blocked invalidates the pending advancement", async () => {
      const { withdraw } = await errorBlockedByHeldBackWork();
      const replacement = await setGoalOk(service, { workspaceId, objective: "Ship G5" });
      // The replacement's kickoff dispatch stops on the held-back queued work.
      expect(await service.checkGoalContinuationEligibility(workspaceId, Date.now())).toMatchObject(
        { eligible: false, reason: "queued_user_input" }
      );
      const requestsBefore = requestDispatch.mock.calls.length;
      withdraw();
      // Target assertion: the stale error hand-over arms nothing, yet the kickoff it blocked is
      // re-requested once.
      expect(await waitForRequests(requestsBefore)).toBe(1);
      expect(await waitForRequests(requestsBefore + 1, 100)).toBe(0);
      // The stale error resume armed nothing: the replacement's own kickoff is what waits.
      expect(await eligibilityAfterBackoff()).toMatchObject({
        eligible: true,
        goal: { goalId: replacement.goalId },
        candidate: { source: "kickoff" },
      });
    });
  });
});
