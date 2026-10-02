// Deterministic repros for the counterexamples TLC finds in formal/workspace-goals/
// (WorkspaceGoals.tla, check.sh). G2 and G2b are fixed: their tests fail at their "Target
// assertion" with the fix reverted. G1 is still open: its repro, through expectReproFailure,
// passes only while it fails at its target assertion. Each paired control runs the same harness
// without the racing step.
import * as path from "path";
import assert from "@/common/utils/assert";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Config } from "@/node/config";
import type { GoalRecordV1 } from "@/common/types/goal";
import {
  createMuxMessage,
  isCompactionSummaryMetadata,
  type MuxMessage,
} from "@/common/types/message";
import { Ok } from "@/common/types/result";
import {
  HEARTBEAT_CONTEXT_MODE_VALUES,
  HEARTBEAT_MIN_INTERVAL_MS,
  HEARTBEAT_QUEUE_DEDUPE_KEY,
  type HeartbeatContextMode,
} from "@/constants/heartbeat";
import type { AgentSession } from "./agentSession";
import { createAgentSessionHarness, runSessionTerminalPolicy } from "./agentSession.testHarness";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { HistoryService } from "./historyService";
import { HeartbeatService } from "./heartbeatService";
import type { IdleConsumer, IdleDispatcher } from "./idleDispatcher";
import type { TaskService } from "./taskService";
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
        // The stale check evaluates A's captured candidate against B. Its own verdict is not
        // asserted: a fix that revalidates the candidate may answer differently here.
        await staleCheck;

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

  /** Rows in the current history window that match `predicate`. */
  async function countRows(predicate: (row: MuxMessage) => boolean): Promise<number> {
    const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
    assert(history.success, "history read failed");
    return history.data.filter(predicate).length;
  }

  /** Heartbeat turns that reached history: user rows tagged as heartbeat requests. */
  function heartbeatRows(): Promise<number> {
    return countRows(
      (row) => row.role === "user" && row.metadata?.muxMetadata?.type === "heartbeat-request"
    );
  }

  /**
   * What each heartbeat contextMode's dispatch branch leaves in history: a heartbeat turn
   * (normal: dispatchHeartbeatMessage), a compaction request (compact:
   * dispatchHeartbeatCompactionRequest), or a heartbeat reset boundary (reset).
   */
  const dispatchEffects: Record<HeartbeatContextMode, () => Promise<number>> = {
    normal: heartbeatRows,
    compact: () =>
      countRows(
        (row) => row.role === "user" && row.metadata?.muxMetadata?.type === "compaction-request"
      ),
    reset: () => countRows((row) => row.metadata?.compacted === "heartbeat"),
  };

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
    const endTurn = () =>
      runSessionTerminalPolicy(session, harness.aiEmitter, {
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
    const reachDrainPoint = async () => {
      if (whenBusy === "turn-end") {
        await endTurn();
      } else {
        // The fixed code drops a heartbeat whose settings changed, so nothing may wait for the
        // tool boundary any more; then the boundary stops nothing and the turn ends normally.
        const waitsForToolEnd = session.hasQueuedMessages("tool-end");
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
        if (waitsForToolEnd) {
          await settle(() => Promise.resolve(stopStream.mock.calls.length > 0));
          // The production tool-end trigger must fire: a timed-out settle fails here.
          expect(stopStream.mock.calls.length).toBe(1);
          await runSessionTerminalPolicy(session, harness.aiEmitter, {
            type: "stream-abort",
            workspaceId,
            messageId: "assistant-1",
            abortReason: "system",
            metadata: { duration: 1 },
          });
        } else {
          expect(stopStream.mock.calls.length).toBe(0);
          await endTurn();
        }
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
          const changed = await turnOff[change]();
          expect(changed.success).toBe(true);
          await s.reachDrainPoint();
          // Target assertion: no heartbeat turn starts once the heartbeat is off (the code's
          // queued entry had no settings check and dispatched at the drain point).
          expect(await heartbeatRows()).toBe(0);
        } finally {
          await s.dispose();
        }
      });
    }

    // Another backend edits config directly: this process drops nothing from its queue, so only
    // the probe checked at the queue drain can refuse the turn. An edit that keeps the heartbeat
    // enabled still changes the settings the heartbeat fired under.
    const otherBackendEdits = {
      disables: { enabled: false },
      "changes the message of": { message: "A new check-in prompt." },
    } as const;
    for (const [edit, patch] of Object.entries(otherBackendEdits)) {
      test(`G2: a ${whenBusy} queued heartbeat does not run after another backend ${edit} it`, async () => {
        const s = await sessionWithQueuedHeartbeat(whenBusy);
        try {
          await config.editConfig((fresh) => {
            const entry = fresh.projects
              .get(PROJECT_PATH)
              ?.workspaces.find((workspace) => workspace.id === workspaceId);
            assert(entry?.heartbeat, "heartbeat settings missing");
            entry.heartbeat = { ...entry.heartbeat, ...patch };
            return fresh;
          });
          await s.reachDrainPoint();
          // Target assertion: the drained heartbeat is refused before its turn starts.
          expect(await heartbeatRows()).toBe(0);
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

  /**
   * Drives one idle heartbeat the way production does: HeartbeatService's idle consumer checks
   * eligibility and returns a dispatch payload, and the IdleDispatcher runs that payload later.
   * `between` runs in that gap. Returns the history effects of the `contextMode` dispatch branch
   * and of every branch: turning the heartbeat off can change the branch (an unset heartbeat
   * reads as the default contextMode), so "nothing happened" must check them all.
   */
  async function dispatchIdleHeartbeat(
    contextMode: HeartbeatContextMode,
    between?: () => Promise<void>
  ): Promise<{ branch: number; any: number }> {
    const configured = await workspaceService.setHeartbeatSettings(workspaceId, { contextMode });
    expect(configured.success).toBe(true);
    const effects = async () => {
      const counts = await Promise.all(
        HEARTBEAT_CONTEXT_MODE_VALUES.map((mode) => dispatchEffects[mode]())
      );
      return {
        branch: counts[HEARTBEAT_CONTEXT_MODE_VALUES.indexOf(contextMode)],
        any: counts.reduce((sum, count) => sum + count, 0),
      };
    };
    // A completed turn: heartbeats skip a workspace that never finished one.
    for (const message of [
      createMuxMessage("user-1", "user", "hello"),
      createMuxMessage("assistant-1", "assistant", "hi"),
    ]) {
      const appended = await historyService.appendToHistory(workspaceId, message);
      assert(appended.success, "history seed failed");
    }
    // A dispatcher that only captures the consumer: the test runs the payload itself.
    let consumer: IdleConsumer | undefined;
    const dispatcher = {
      registerConsumer: (registered: IdleConsumer) => {
        consumer = registered;
        return () => undefined;
      },
      requestDispatch: () => Promise.resolve(),
    } as unknown as IdleDispatcher;
    const heartbeats = new HeartbeatService(
      config,
      new ExtensionMetadataService(path.join(config.rootDir, "heartbeatExtensionMetadata.json")),
      workspaceService,
      { hasActiveDescendantAgentTasksForWorkspace: () => false } as unknown as TaskService,
      dispatcher
    );
    const { session, dispose } = await attachRealSession();
    heartbeats.start();
    try {
      expect(session.isBusy()).toBe(false);
      assert(consumer, "HeartbeatService registered no idle consumer");
      const payload = await consumer.buildPayload(workspaceId);
      expect(payload).not.toBeNull();
      await between?.();
      // A refusal may throw, which the dispatcher logs.
      await payload?.dispatch().catch(() => undefined);
      // The fixed code never sends, so poll to a deadline instead of waiting for a row.
      await settle(async () => (await effects()).any > 0, 1000);
      return await effects();
    } finally {
      heartbeats.stop();
      await dispose();
    }
  }

  test("G2b: a reset heartbeat publishes no boundary when it is turned off during the reset's own awaits", async () => {
    const effects = await dispatchIdleHeartbeat("reset", () => {
      // The reset's first await (capturing the compaction replacement) is where the
      // heartbeat is turned off: past executeHeartbeat's own re-check.
      const original = historyService.captureCompactionReplacement.bind(historyService);
      spyOn(historyService, "captureCompactionReplacement").mockImplementationOnce(
        async (...args) => {
          const changed = await turnOff.disable();
          expect(changed.success).toBe(true);
          return original(...args);
        }
      );
      return Promise.resolve();
    });
    // Target assertion: no reset boundary is published for a heartbeat turned off meanwhile.
    expect(effects.any).toBe(0);
  });

  test("G2b: a reset heartbeat's follow-up turn does not run after the heartbeat is turned off past the boundary", async () => {
    let session: AgentSession | undefined;
    const effects = await dispatchIdleHeartbeat("reset", () => {
      session = (
        workspaceService as unknown as { sessions: Map<string, AgentSession> }
      ).sessions.get(workspaceId);
      assert(session, "session missing");
      // The boundary is published with the heartbeat's follow-up turn on it; the heartbeat is
      // turned off before that follow-up dispatches (startup recovery takes the same path).
      const original = session.dispatchPendingCompactionFollowUpIfNeeded.bind(session);
      spyOn(session, "dispatchPendingCompactionFollowUpIfNeeded").mockImplementationOnce(
        async (...args) => {
          const changed = await turnOff.disable();
          expect(changed.success).toBe(true);
          return original(...args);
        }
      );
      return Promise.resolve();
    });
    expect(effects.branch).toBe(1);
    // Target assertion: the follow-up heartbeat turn never starts (the code dispatched the
    // persisted follow-up without checking the heartbeat).
    expect(await heartbeatRows()).toBe(0);
    // And the handoff is cleared, so startup recovery cannot start it later.
    const pending = await countRows(
      (row) =>
        row.metadata?.compacted === "heartbeat" &&
        isCompactionSummaryMetadata(row.metadata.muxMetadata) &&
        row.metadata.muxMetadata.pendingFollowUp != null
    );
    expect(pending).toBe(0);
  });

  for (const contextMode of ["normal", "compact", "reset"] as const) {
    for (const change of ["unset", "disable"] as const) {
      test(`G2b: a ${contextMode} heartbeat dispatch does nothing after the heartbeat was ${change === "unset" ? "unset" : "disabled"} after its eligibility check`, async () => {
        // The heartbeat is turned off after HeartbeatService's eligibility check built the
        // payload and before the dispatcher runs it.
        const effects = await dispatchIdleHeartbeat(contextMode, async () => {
          const changed = await turnOff[change]();
          expect(changed.success).toBe(true);
        });
        // Target assertion: a heartbeat that is off leaves no trace of its dispatch branch (the
        // code never re-checked the settings after the eligibility check).
        expect(effects.any).toBe(0);
      });
    }

    test(`G2b control: a ${contextMode} heartbeat dispatch runs while the heartbeat is enabled`, async () => {
      // reset also dispatches its follow-up heartbeat turn, so only the branch count is exact.
      expect((await dispatchIdleHeartbeat(contextMode)).branch).toBe(1);
    });
  }
});
