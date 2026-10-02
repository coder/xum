// Deterministic repros for the counterexamples TLC finds in formal/workspace-goals/
// (WorkspaceGoals.tla, check.sh). Each repro reproduces a bug at origin/main f30a1945a6 and,
// through expectReproFailure, passes only while it fails at its "Target assertion"; the paired
// `test` is a passing control that runs the same harness without the racing step.
import * as path from "path";
import assert from "@/common/utils/assert";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Config } from "@/node/config";
import type { GoalRecordV1 } from "@/common/types/goal";
import { Ok } from "@/common/types/result";
import { HEARTBEAT_MIN_INTERVAL_MS, HEARTBEAT_QUEUE_DEDUPE_KEY } from "@/constants/heartbeat";
import type { AgentSession } from "./agentSession";
import { createAgentSessionHarness, runSessionTerminalPolicy } from "./agentSession.testHarness";
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
import type { WorkspaceService } from "./workspaceService";
import { createWorkspaceServiceForTest } from "./workspaceService.testHarness";
import { expectReproFailure } from "@/node/utils/formalRepro.testHarness";

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

/** Polls without throwing: the fixed code may never reach the polled state. */
async function settle(condition: () => Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("workspace goals: formal-model counterexamples (WorkspaceGoalService)", () => {
  const workspaceId = "goal-formal-repro";
  let config: Config;
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;
  let extensionMetadata: ExtensionMetadataService;
  let service: WorkspaceGoalService;

  beforeEach(async () => {
    ({ config, historyService, cleanup } = await createTestHistoryService());
    await addWorkspace(config, workspaceId);
    extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    service = new WorkspaceGoalService(config, historyService, extensionMetadata, analyticsMock());
    // A dispatcher that only records requests: the test drives the eligibility checks itself,
    // standing in for the dispatcher's serialized per-workspace dispatches.
    const dispatcher = {
      registerConsumer: () => () => undefined,
      requestDispatch: mock(() => Promise.resolve()),
    } as unknown as IdleDispatcher;
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(),
      getKickoffSendOptions: () => Promise.resolve({ model: TEST_MODEL, agentId: "exec" }),
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  /** Holds the eligibility check's first await (isWorkspaceStreaming -> getSnapshot). */
  function gateNextSnapshotRead(): () => void {
    const gate = Promise.withResolvers<void>();
    const original = extensionMetadata.getSnapshot.bind(extensionMetadata);
    spyOn(extensionMetadata, "getSnapshot").mockImplementationOnce(async (...args) => {
      await gate.promise;
      return original(...args);
    });
    return () => gate.resolve();
  }

  async function replaceGoal(objective: string): Promise<GoalRecordV1> {
    // A user replacement (Goal panel): persists the new goal and, idle, arms its kickoff
    // candidate (armKickoffContinuationIfIdle) before setGoal returns.
    return setGoalOk(service, { workspaceId, objective });
  }

  test("G1: a stale eligibility check does not drop the replacement goal's kickoff candidate", async () => {
    await expectReproFailure(
      async () => {
        await setGoalOk(service, { workspaceId, objective: "Goal A" });
        // A dispatch of goal A's kickoff candidate is mid-check (awaiting isWorkspaceStreaming).
        const release = gateNextSnapshotRead();
        const staleCheck = service.checkGoalContinuationEligibility(workspaceId, Date.now());
        // The user replaces A with B; B's kickoff candidate is armed and its dispatch request
        // queues behind the in-flight dispatch.
        const goalB = await replaceGoal("Goal B");
        release();
        // The stale check evaluates A's captured candidate against B: goal_mismatch, drop.
        expect(await staleCheck).toMatchObject({ eligible: false, reason: "goal_mismatch" });

        // B's queued dispatch runs next.
        const next = await service.checkGoalContinuationEligibility(workspaceId, Date.now());
        // Target assertion: B is still eligible to kick off (the code deleted B's candidate by
        // key, so this reports no_pending_candidate and B idles with nothing to drive it).
        expect(next.eligible).toBe(true);
        expect(next).toMatchObject({ goal: { goalId: goalB.goalId } });
      },
      { matcher: "toBe", expected: "true", received: "false" }
    );
  });

  test("G1 control: a replacement that lands before the check kicks off the new goal", async () => {
    await setGoalOk(service, { workspaceId, objective: "Goal A" });
    const goalB = await replaceGoal("Goal B");
    const next = await service.checkGoalContinuationEligibility(workspaceId, Date.now());
    expect(next).toMatchObject({ eligible: true, goal: { goalId: goalB.goalId } });
  });
});

describe("workspace goals: formal-model counterexamples (heartbeats)", () => {
  const workspaceId = "heartbeat-formal-repro";
  let config: Config;
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;
  let workspaceService: WorkspaceService;

  beforeEach(async () => {
    ({ config, historyService, cleanup } = await createTestHistoryService());
    await addWorkspace(config, workspaceId);
    workspaceService = createWorkspaceServiceForTest({ config, historyService });
    const enabled = await workspaceService.setHeartbeatSettings(workspaceId, {
      enabled: true,
      intervalMs: HEARTBEAT_MIN_INTERVAL_MS,
      whenBusy: "turn-end",
    });
    expect(enabled.success).toBe(true);
  });

  afterEach(async () => {
    await cleanup();
  });

  /** Heartbeat turns that reached history: user rows tagged as heartbeat requests. */
  async function heartbeatRows(): Promise<number> {
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(history.success, "history read failed");
    return history.data.filter(
      (row) => row.role === "user" && row.metadata?.muxMetadata?.type === "heartbeat-request"
    ).length;
  }

  /**
   * A real AgentSession owned by the workspace service, as getOrCreateSession would make it.
   * Heartbeat sends go through the real WorkspaceService.sendMessage and
   * AgentSession.sendMessage, so their turn-admission gates apply.
   */
  async function attachRealSession() {
    const harness = await createAgentSessionHarness({ workspaceId, config, historyService });
    const session = harness.session;
    (workspaceService as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
      workspaceId,
      session
    );
    Object.assign(workspaceService, { getOrCreateSession: () => session });
    const dispose = async () => {
      await session.dispose();
      await harness.cleanup();
    };
    return { harness, session, dispose };
  }

  type QueueMode = "turn-end" | "tool-end";

  /**
   * A real AgentSession mid-turn with a heartbeat queued behind it through the production path:
   * executeHeartbeat sees the busy session and calls queueHeartbeatMessage -> sendMessage,
   * which enqueues the heartbeat (deduped, automatic, synthetic) in `whenBusy` mode. The queue
   * drain runs the real AgentSession.sendMessage, so its turn-admission gates apply; a heartbeat
   * turn counts once its user row reaches history. Returns that count and a driver that reaches
   * the mode's drain point: the turn's stream end (turn-end), or a provider-executed tool
   * boundary that soft-stops the stream and drains after the abort (tool-end).
   */
  async function sessionWithQueuedHeartbeat(whenBusy: QueueMode) {
    const configured = await workspaceService.setHeartbeatSettings(workspaceId, {
      enabled: true,
      intervalMs: HEARTBEAT_MIN_INTERVAL_MS,
      whenBusy,
    });
    expect(configured.success).toBe(true);
    const { harness, session, dispose: disposeSession } = await attachRealSession();
    const stopStream = spyOn(harness.aiService, "stopStream").mockResolvedValue(Ok(undefined));
    harness.aiEmitter.emit("stream-start", {
      type: "stream-start",
      workspaceId,
      messageId: "assistant-1",
      model: TEST_MODEL,
      startTime: Date.now(),
    });
    expect(session.isBusy()).toBe(true);
    // The heartbeat fires mid-turn (HeartbeatService already passed its eligibility check).
    await workspaceService.executeHeartbeat(workspaceId);
    expect(session.hasQueuedDedupeKey(HEARTBEAT_QUEUE_DEDUPE_KEY)).toBe(true);
    expect(session.hasQueuedMessages(whenBusy)).toBe(true);
    const reachDrainPoint = async () => {
      if (whenBusy === "turn-end") {
        await runSessionTerminalPolicy(session, harness.aiEmitter, {
          type: "stream-end",
          workspaceId,
          messageId: "assistant-1",
          parts: [{ type: "text", text: "turn done" }],
          metadata: {
            model: TEST_MODEL,
            contextUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
            providerMetadata: {},
            finishReason: "stop",
          },
        });
      } else {
        harness.aiEmitter.emit("tool-call-end", {
          type: "tool-call-end",
          workspaceId,
          messageId: "assistant-1",
          toolCallId: "tool-call-1",
          toolName: "web_search",
          providerExecuted: true,
          result: { success: true },
          timestamp: Date.now(),
        });
        await settle(() => Promise.resolve(stopStream.mock.calls.length > 0));
        await runSessionTerminalPolicy(session, harness.aiEmitter, {
          type: "stream-abort",
          workspaceId,
          messageId: "assistant-1",
          abortReason: "system",
          metadata: { duration: 1 },
        });
      }
      await settle(async () => !session.hasQueuedMessages() && (await heartbeatRows()) > 0, 3000);
    };
    const dispose = async () => {
      stopStream.mockRestore();
      await disposeSession();
    };
    return { reachDrainPoint, dispose };
  }

  // The model calls the heartbeat tool with action "unset" (or the user removes it in settings),
  // or the user switches it off, while the heartbeat waits for its drain point.
  const turnOff = {
    unset: () => workspaceService.unsetHeartbeatSettings(workspaceId),
    disable: () => workspaceService.setHeartbeatSettings(workspaceId, { enabled: false }),
  };

  for (const whenBusy of ["turn-end", "tool-end"] as const) {
    for (const change of ["unset", "disable"] as const) {
      test(`G2: a ${whenBusy} queued heartbeat does not run after the heartbeat is ${change === "unset" ? "unset" : "disabled"}`, async () => {
        const s = await sessionWithQueuedHeartbeat(whenBusy);
        try {
          await expectReproFailure(
            async () => {
              const changed = await turnOff[change]();
              expect(changed.success).toBe(true);
              await s.reachDrainPoint();
              // Target assertion: no heartbeat turn starts once the heartbeat is off (the queued
              // entry has no settings check and dispatches at the drain point).
              expect(await heartbeatRows()).toBe(0);
            },
            { matcher: "toBe", expected: "0", received: "1" }
          );
        } finally {
          await s.dispose();
        }
      });
    }

    test(`G2 control: a ${whenBusy} queued heartbeat runs at its drain point while enabled`, async () => {
      const s = await sessionWithQueuedHeartbeat(whenBusy);
      try {
        await s.reachDrainPoint();
        expect(await heartbeatRows()).toBe(1);
      } finally {
        await s.dispose();
      }
    });
  }

  /** Runs executeHeartbeat on an idle real session; returns the heartbeat turns it started. */
  async function executeIdleHeartbeat(): Promise<number> {
    const { session, dispose } = await attachRealSession();
    try {
      expect(session.isBusy()).toBe(false);
      // HeartbeatService already passed checkEligibility; a refusal may throw, which the
      // dispatcher logs.
      await workspaceService.executeHeartbeat(workspaceId).catch(() => undefined);
      // The fixed code never sends, so poll to a deadline instead of waiting for a row.
      await settle(async () => (await heartbeatRows()) > 0, 1000);
      return await heartbeatRows();
    } finally {
      await dispose();
    }
  }

  for (const change of ["unset", "disable"] as const) {
    test(`G2b: executeHeartbeat does not send after the heartbeat was ${change === "unset" ? "unset" : "disabled"} past eligibility`, async () => {
      await expectReproFailure(
        async () => {
          // The heartbeat is turned off between HeartbeatService's eligibility check and
          // executeHeartbeat (the dispatcher's awaits).
          const changed = await turnOff[change]();
          expect(changed.success).toBe(true);
          const sends = await executeIdleHeartbeat();
          // Target assertion: a heartbeat that is off starts no turn (executeHeartbeat never
          // re-checks the settings).
          expect(sends).toBe(0);
        },
        { matcher: "toBe", expected: "0", received: "1" }
      );
    });
  }

  test("G2b control: executeHeartbeat sends while the heartbeat is enabled", async () => {
    expect(await executeIdleHeartbeat()).toBe(1);
  });
});
