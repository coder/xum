// #5958: a user Stop on an idle session discards a goal advancement that waits behind held-back
// queued work, whether a failed turn or a turn that ended normally left it. Driven through the
// real Stop entry point (WorkspaceService.interruptStream with the options the renderer's
// stopStream sends) and the session WorkspaceService.getOrCreateSession builds.
//
// The Stop goes through a real StreamManager: with no stream running, its stopStream emits a
// synthetic startup abort, and that abort is what records the user stop. The AI fake's own
// stopStream emits nothing, so a test that stops through it reports a missing fence that
// production does not have.
import * as path from "path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Config } from "@/node/config";
import { Ok } from "@/common/types/result";
import type { AgentSession } from "./agentSession";
import { createAgentSessionAIServiceFake } from "./agentSession.testHarness";
import type { AIService } from "./aiService";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { HistoryService } from "./historyService";
import type { IdleDispatcher } from "./idleDispatcher";
import { StreamManager, type TurnCompletion } from "./streamManager";
import { createTestHistoryService } from "./testHistoryService";
import { WorkspaceGoalService } from "./workspaceGoalService";
import {
  analyticsMock,
  continuationBridge,
  PROJECT_PATH,
  setGoalOk,
} from "./workspaceGoalService.testHarness";
import type { WorkspaceService } from "./workspaceService";
import { createWorkspaceServiceForTest } from "./workspaceService.testHarness";

const TEST_MODEL = "openai:gpt-4o";
/** What the renderer's stopStream sends for every user Stop (Esc, palette, barriers). */
const USER_STOP = { retireBashMonitorAttention: true, disableAutoRetry: true } as const;

type Origin = "stream_error" | "abandoned";

describe("a user Stop on an idle session with a blocked goal advancement (#5958)", () => {
  const workspaceId = "goal-stop-idle";
  let config: Config;
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;
  let service: WorkspaceService;
  let goals: WorkspaceGoalService;
  let session: AgentSession;
  let requestDispatch: ReturnType<typeof mock>;
  /** The next turn's completion; the test settles it. */
  let nextCompletion: ReturnType<typeof Promise.withResolvers<TurnCompletion>>;

  beforeEach(async () => {
    ({ config, historyService, cleanup } = await createTestHistoryService());
    await config.addWorkspace(PROJECT_PATH, {
      id: workspaceId,
      name: workspaceId,
      projectName: "mux-goal-service-test-project",
      projectPath: PROJECT_PATH,
      runtimeConfig: { type: "local" },
    });
    nextCompletion = Promise.withResolvers<TurnCompletion>();
    let streams = 0;
    const ai = createAgentSessionAIServiceFake({
      getClosingSignal: () => session.closingSignal,
      overrides: {
        streamMessage: mock(() => {
          const messageId = `assistant-${++streams}`;
          // A real stream reports its start before its handle settles.
          ai.emit("stream-start", {
            type: "stream-start",
            workspaceId,
            messageId,
            model: TEST_MODEL,
            startTime: Date.now(),
          });
          return Promise.resolve(Ok({ messageId, completion: nextCompletion.promise }));
        }),
      },
    });
    // Stream lifecycle (stopStream, isStreaming) is the real engine, whose events reach the
    // session through the AI service as they do in production.
    const streamManager = new StreamManager(historyService, undefined, undefined, (event) => {
      ai.emit(event.type, event);
    });
    service = createWorkspaceServiceForTest({
      config,
      historyService,
      aiService: ai as unknown as AIService,
      streamManager,
    });
    goals = new WorkspaceGoalService(
      config,
      historyService,
      new ExtensionMetadataService(path.join(config.rootDir, "goal-extensionMetadata.json")),
      analyticsMock(),
      { continuationCooldownMs: 0 }
    );
    service.setWorkspaceGoalService(goals);
    session = service.getOrCreateSession(workspaceId);
    // A dispatcher that only records requests: each one is a goal continuation the loop would run.
    requestDispatch = mock(() => Promise.resolve());
    goals.registerGoalContinuationConsumer(
      { registerConsumer: () => () => undefined, requestDispatch } as unknown as IdleDispatcher,
      {
        ...continuationBridge(),
        getRuntimeState: () => ({
          isRuntimeCompatible: true,
          isBusy: session.isBusy(),
          hasQueuedMessages: session.hasPendingManualFollowUp() || session.hasPendingUserInput(),
        }),
        getKickoffSendOptions: () => Promise.resolve({ model: TEST_MODEL, agentId: "exec" }),
      }
    );
  });

  afterEach(async () => {
    await session.dispose();
    await cleanup();
  });

  async function waitForRequests(after: number, timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (requestDispatch.mock.calls.length <= after && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return requestDispatch.mock.calls.length - after;
  }

  /** Queues automatic work that TaskService holds back (report-decision hold) until withdrawn. */
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

  /**
   * An active goal whose automatic turn settled while held-back work waited behind it, so the
   * session is idle and the goal's advancement waits for that work:
   * - "stream_error": the turn failed with a non-retryable error (the goal resumes after it);
   * - "abandoned": the turn ended normally and left its continuation to the queued work.
   * Returns the work's withdrawal, which unblocks the advancement.
   */
  async function idleAdvancementBlockedByHeldBackWork(
    origin: Origin
  ): Promise<{ withdraw: () => void; requestsBefore: number }> {
    await setGoalOk(goals, { workspaceId, objective: "Ship #5958" });
    // The automatic turn below takes the kickoff's place.
    goals.clearPendingContinuationForManualUserMessage(workspaceId);
    // A failed turn arms its advancement after the argument-less auto-retry preference read
    // (recordGoalAdvancementAfterStreamError); its promise is the signal that it armed.
    const internal = session as unknown as {
      loadAutoRetryEnabledPreference(...args: unknown[]): Promise<boolean>;
    };
    const load = internal.loadAutoRetryEnabledPreference.bind(session);
    const preferenceReads: Array<Promise<boolean>> = [];
    spyOn(internal, "loadAutoRetryEnabledPreference").mockImplementation((...args) => {
      const read = load(...args);
      if (args.length === 0) preferenceReads.push(read);
      return read;
    });
    const sent = await session.sendMessage(
      "Background process output",
      { model: TEST_MODEL, agentId: "exec" },
      { acceptanceOrigin: "automatic", synthetic: true, agentInitiated: true }
    );
    expect(sent.success).toBe(true);
    const work = queueHeldBackAutomaticWork();
    const requestsBefore = requestDispatch.mock.calls.length;
    // The terminal policy emits the turn's terminal event while it holds the session busy, so
    // waiting for that event and then for idle waits for the whole policy (see #5923).
    const terminalEvent = origin === "stream_error" ? "stream-error" : "stream-end";
    const settled = Promise.withResolvers<void>();
    const unsubscribe = session.onChatEvent(({ message }) => {
      if (message.type === terminalEvent) settled.resolve();
    });
    nextCompletion.resolve(
      origin === "stream_error"
        ? {
            status: "failed",
            streamError: {
              messageId: "assistant-1",
              error: "provider failure",
              errorType: "authentication",
            },
          }
        : {
            status: "completed",
            streamEnd: {
              type: "stream-end",
              workspaceId,
              parts: [{ type: "text", text: "Working on it." }],
              metadata: {
                model: TEST_MODEL,
                contextUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
                providerMetadata: {},
                finishReason: "stop",
              },
            },
          }
    );
    await settled.promise;
    unsubscribe();
    await session.waitForIdle();
    if (origin === "stream_error") {
      expect(preferenceReads.length).toBeGreaterThan(0);
      // The record's continuation after the read was queued before this await, so it has armed.
      await Promise.all(preferenceReads);
    }
    expect(session.isBusy()).toBe(false);
    // The held-back work still blocks the advancement.
    expect(requestDispatch.mock.calls.length).toBe(requestsBefore);
    return { withdraw: work.withdraw, requestsBefore };
  }

  for (const origin of ["stream_error", "abandoned"] as const) {
    test(`control (${origin}): withdrawing the held-back work hands the advancement over`, async () => {
      const { withdraw, requestsBefore } = await idleAdvancementBlockedByHeldBackWork(origin);
      withdraw();
      expect(await waitForRequests(requestsBefore, 1_000)).toBe(1);
    });

    test(`a user Stop while the advancement is blocked discards it (${origin})`, async () => {
      const { withdraw, requestsBefore } = await idleAdvancementBlockedByHeldBackWork(origin);
      expect(await service.interruptStream(workspaceId, USER_STOP)).toEqual(Ok(undefined));
      withdraw();
      // Target assertion: the Stop wins over the advancement that waited for the work.
      expect(await waitForRequests(requestsBefore, 300)).toBe(0);
      expect(
        await goals.checkGoalContinuationEligibility(workspaceId, Date.now() + 120_000)
      ).toMatchObject({ eligible: false });
    });
  }
});
