// Deterministic repros for the G1, G2 and G2b counterexamples TLC finds in
// formal/workspace-goals/ (WorkspaceGoals.tla, check.sh). All are fixed: each test fails at its
// "Target assertion" with its fix reverted. Each paired control runs the same harness without the
// racing step.
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
import { NOOP_TIMELINE_RECORDER, type TimelineRecorder } from "./timelineRecorder";
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

async function addWorkspace(config: Config, workspaceId: string): Promise<void> {
  await config.addWorkspace(PROJECT_PATH, {
    id: workspaceId,
    name: workspaceId,
    projectName: "mux-goal-service-test-project",
    projectPath: PROJECT_PATH,
    runtimeConfig: { type: "local" },
  });
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
    // Target assertion: B is still eligible to kick off. A delete by key in the stale check
    // drops B's candidate, so this reports no_pending_candidate and B idles.
    expect(next.eligible).toBe(true);
    expect(next).toMatchObject({ goal: { goalId: goalB.goalId } });
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
  /** WorkspaceService's own extension metadata: its heartbeat request preflight reads it. */
  let workspaceExtensionMetadata: ExtensionMetadataService;
  let timeline: TimelineRecorder;
  /** Heartbeat timeline records, in order, interleaved with markers a test adds. */
  let heartbeatEvents: string[];
  /** The reason of each heartbeat.skipped record, in order. */
  let skipReasons: Array<string | undefined>;
  /** Resolves on the first heartbeat timeline record (dispatched or skipped). */
  let firstHeartbeatRecord: ReturnType<typeof Promise.withResolvers<void>>;

  beforeEach(async () => {
    ({ config, historyService, cleanup } = await createTestHistoryService());
    await addWorkspace(config, workspaceId);
    workspaceExtensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    workspaceService = createWorkspaceServiceForTest({
      config,
      historyService,
      extensionMetadata: workspaceExtensionMetadata,
    });
    heartbeatEvents = [];
    skipReasons = [];
    firstHeartbeatRecord = Promise.withResolvers<void>();
    // One recorder for both services, as production wires them.
    timeline = {
      ...NOOP_TIMELINE_RECORDER,
      record: (_id, draft) => {
        if (draft.kind === "heartbeat.dispatched" || draft.kind === "heartbeat.skipped") {
          heartbeatEvents.push(draft.kind);
          if (draft.kind === "heartbeat.skipped") skipReasons.push(draft.data?.reason);
          firstHeartbeatRecord.resolve();
        }
      },
    };
    workspaceService.setTimelineRecorder(timeline);
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

  function recorded(kind: "heartbeat.dispatched" | "heartbeat.skipped") {
    return heartbeatEvents.filter((event) => event === kind);
  }

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

  /** Reset boundaries that still carry their follow-up heartbeat turn. */
  function pendingHeartbeatHandoffs(): Promise<number> {
    return countRows(
      (row) =>
        row.metadata?.compacted === "heartbeat" &&
        isCompactionSummaryMetadata(row.metadata.muxMetadata) &&
        row.metadata.muxMetadata.pendingFollowUp != null
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
  async function attachRealSession(workspaceGoalService?: WorkspaceGoalService) {
    const harness = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      workspaceGoalService,
    });
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

  /**
   * The goal service's two stream-end hooks, stubbed: the turn's own stream-end continuation and
   * the advancement owed by queued automatic work that never streamed (G4). Either one advances
   * an active goal; the count says how many times the session asked.
   */
  function goalAdvancementRequests() {
    const goals = new WorkspaceGoalService(
      config,
      historyService,
      new ExtensionMetadataService(path.join(config.rootDir, "goalExtensionMetadata.json")),
      analyticsMock()
    );
    const requested = Promise.withResolvers<void>();
    const request = () => {
      requested.resolve();
      return Promise.resolve();
    };
    const afterStreamEnd = spyOn(goals, "requestContinuationAfterStreamEnd").mockImplementation(
      request
    );
    const afterAbandoned = spyOn(
      goals,
      "requestAdvancementAfterAbandonedAutomaticWork"
    ).mockImplementation(request);
    return {
      goals,
      requested: requested.promise,
      count: () => afterStreamEnd.mock.calls.length + afterAbandoned.mock.calls.length,
    };
  }

  type QueueMode = "turn-end" | "tool-end";

  /**
   * A real AgentSession mid-turn with a heartbeat queued behind it through the production path.
   * `via` "busy": executeHeartbeat sees the busy session and calls queueHeartbeatMessage.
   * `via` "busy-race": the session looked idle at executeHeartbeat's check and went busy before
   * the send, so dispatchHeartbeatMessage queues it. Either way the heartbeat sits in the session
   * queue (deduped, automatic, synthetic) in `whenBusy` mode, and the drain runs the real
   * AgentSession.sendMessage. Returns a driver that reaches the mode's drain point: the turn's
   * stream end (turn-end), or a provider-executed tool boundary that soft-stops the stream and
   * drains after the abort (tool-end).
   */
  async function sessionWithQueuedHeartbeat(
    whenBusy: QueueMode,
    options: { via?: "busy" | "busy-race"; goals?: WorkspaceGoalService } = {}
  ) {
    const configured = await workspaceService.setHeartbeatSettings(workspaceId, {
      enabled: true,
      intervalMs: HEARTBEAT_MIN_INTERVAL_MS,
      whenBusy,
    });
    expect(configured.success).toBe(true);
    const { harness, session, dispose: disposeSession } = await attachRealSession(options.goals);
    const stopRequested = Promise.withResolvers<void>();
    const stopStream = spyOn(harness.aiService, "stopStream").mockImplementation(() => {
      stopRequested.resolve();
      return Promise.resolve(Ok(undefined));
    });
    harness.aiEmitter.emit("stream-start", {
      type: "stream-start",
      workspaceId,
      messageId: "assistant-1",
      model: TEST_MODEL,
      startTime: Date.now(),
    });
    expect(session.isBusy()).toBe(true);
    if (options.via === "busy-race") {
      // executeHeartbeat's busy check is the first isBusy read of this firing.
      spyOn(session, "isBusy").mockReturnValueOnce(false);
    }
    // The heartbeat fires mid-turn (HeartbeatService already passed its eligibility check).
    await workspaceService.executeHeartbeat(workspaceId);
    expect(session.hasQueuedDedupeKey(HEARTBEAT_QUEUE_DEDUPE_KEY)).toBe(true);
    // Queued, not accepted yet: the timeline records the dispatch when the drain accepts it.
    expect(recorded("heartbeat.dispatched")).toHaveLength(0);
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
    /** Returns whether a tool-end heartbeat soft-stopped the running turn. */
    const reachDrainPoint = async (): Promise<boolean> => {
      let stoppedTurn = false;
      if (whenBusy === "turn-end") {
        await endTurn();
      } else {
        // The fixed code drops or skips a heartbeat that was turned off, so nothing may wait for
        // the tool boundary any more; then the boundary stops nothing and the turn ends normally.
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
          // The production tool-end trigger must fire (the test times out otherwise).
          await stopRequested.promise;
          expect(stopStream.mock.calls.length).toBe(1);
          stoppedTurn = true;
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
      // The firing is settled once the timeline records it: dispatched when the drain accepts
      // it, skipped when it was dropped or refused (the test times out otherwise).
      await firstHeartbeatRecord.promise;
      return stoppedTurn;
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
    // Another backend edits config directly: this process drops nothing from its queue, so only
    // the probe checked at the queue drain can refuse the turn.
    "disable from another backend": async () => {
      await config.editConfig((fresh) => {
        const entry = fresh.projects
          .get(PROJECT_PATH)
          ?.workspaces.find((workspace) => workspace.id === workspaceId);
        assert(entry?.heartbeat, "heartbeat settings missing");
        entry.heartbeat = { ...entry.heartbeat, enabled: false };
        return fresh;
      });
      return Ok(undefined);
    },
  } as const;
  type TurnOff = keyof typeof turnOff;
  const turnOffChanges = Object.keys(turnOff) as TurnOff[];

  for (const whenBusy of ["turn-end", "tool-end"] as const) {
    for (const via of ["busy", "busy-race"] as const) {
      for (const change of turnOffChanges) {
        test(`G2: a ${whenBusy} heartbeat queued while ${via} does not run after ${change}, and the goal still advances`, async () => {
          const advancement = goalAdvancementRequests();
          const s = await sessionWithQueuedHeartbeat(whenBusy, { via, goals: advancement.goals });
          try {
            const changed = await turnOff[change]();
            expect(changed.success).toBe(true);
            const stoppedTurn = await s.reachDrainPoint();
            // Target assertion: no heartbeat turn starts once the heartbeat is off (the code's
            // queued entry had no settings check and dispatched at the drain point).
            expect(await heartbeatRows()).toBe(0);
            // Turned off in this process, the queued heartbeat is dropped at once, so a tool-end
            // heartbeat does not soft-stop the running turn only to be refused. Another backend's
            // change is seen only at the drain, after the soft stop.
            expect(stoppedTurn).toBe(
              whenBusy === "tool-end" && change === "disable from another backend"
            );
            expect(recorded("heartbeat.dispatched")).toHaveLength(0);
            expect(skipReasons).toEqual(["heartbeat_disabled"]);
            // The heartbeat held the goal's stream-end slot; with it gone the goal advances once:
            // through the turn's own stream end when the heartbeat was dropped before it, or the
            // G4 wake path when the drain refused it (the test times out otherwise).
            await advancement.requested;
            expect(advancement.count()).toBe(1);
          } finally {
            await s.dispose();
          }
        });
      }

      test(`G2: a second ${whenBusy} firing while a heartbeat is queued (${via}) is recorded as skipped`, async () => {
        const s = await sessionWithQueuedHeartbeat(whenBusy, { via });
        try {
          // The pending heartbeat owns the next turn: the new firing consumes its slot quietly.
          await workspaceService.executeHeartbeat(workspaceId);
          // Target assertion: the quiet skip is on the record, not silently lost.
          expect(heartbeatEvents).toEqual(["heartbeat.skipped"]);
          expect(skipReasons).toEqual(["queued_messages"]);
        } finally {
          await s.dispose();
        }
      });

      test(`G2 control: a ${whenBusy} heartbeat queued while ${via} runs at its drain point while enabled`, async () => {
        const s = await sessionWithQueuedHeartbeat(whenBusy, { via });
        try {
          await s.reachDrainPoint();
          expect(await heartbeatRows()).toBe(1);
          expect(recorded("heartbeat.dispatched")).toHaveLength(1);
        } finally {
          await s.dispose();
        }
      });
    }
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
    between?: (session: AgentSession) => Promise<void>
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
    heartbeats.setTimelineRecorder(timeline);
    heartbeats.start();
    try {
      expect(session.isBusy()).toBe(false);
      assert(consumer, "HeartbeatService registered no idle consumer");
      const payload = await consumer.buildPayload(workspaceId);
      expect(payload).not.toBeNull();
      await between?.(session);
      // A refusal may throw, which the dispatcher logs. Every branch's effect (a heartbeat row, a
      // compaction request, a reset boundary and its follow-up) is persisted before the dispatch
      // resolves, so nothing is left to wait for.
      await payload?.dispatch().catch(() => undefined);
      return await effects();
    } finally {
      heartbeats.stop();
      await dispose();
    }
  }

  /** Turns the heartbeat off inside the reset's first await, past executeHeartbeat's checks. */
  function turnOffDuringResetAppend(): Promise<void> {
    const original = historyService.captureCompactionReplacement.bind(historyService);
    spyOn(historyService, "captureCompactionReplacement").mockImplementationOnce(
      async (...args) => {
        const changed = await turnOff.disable();
        expect(changed.success).toBe(true);
        return original(...args);
      }
    );
    return Promise.resolve();
  }

  test("G2b: a reset heartbeat publishes no boundary when it is turned off during the reset's own awaits", async () => {
    const effects = await dispatchIdleHeartbeat("reset", turnOffDuringResetAppend);
    // Target assertion: no reset boundary is published for a heartbeat turned off meanwhile.
    expect(effects.any).toBe(0);
  });

  test("G2b: a reset heartbeat's follow-up turn does not run after the heartbeat is turned off past the boundary", async () => {
    const effects = await dispatchIdleHeartbeat("reset", (session) => {
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
    expect(await pendingHeartbeatHandoffs()).toBe(0);
  });

  test("G2b: a reset heartbeat's follow-up survives an unreadable config", async () => {
    await dispatchIdleHeartbeat("reset", (session) => {
      // Config becomes unreadable while the boundary's follow-up dispatches: strict reads throw,
      // lenient reads see the empty default.
      const dispatchFollowUp = session.dispatchPendingCompactionFollowUpIfNeeded.bind(session);
      spyOn(session, "dispatchPendingCompactionFollowUpIfNeeded").mockImplementationOnce(
        async (...args) => {
          const loadConfig = config.loadConfigOrDefault.bind(config);
          const unreadable = spyOn(config, "loadConfigOrDefault").mockImplementation((options) => {
            if (options?.throwOnError === true) throw new Error("EIO: config unreadable");
            // A lenient read of an unreadable config falls back to the empty default.
            return { ...loadConfig(options), projects: new Map() };
          });
          try {
            return await dispatchFollowUp(...args);
          } finally {
            unreadable.mockRestore();
          }
        }
      );
      return Promise.resolve();
    });
    // No heartbeat turn started while the config could not be read.
    expect(await heartbeatRows()).toBe(0);
    // Target assertion: the handoff is kept for startup recovery to retry (a lenient read saw
    // no workspace, treated the heartbeat as off and cleared it).
    expect(await pendingHeartbeatHandoffs()).toBe(1);
  });

  for (const contextMode of ["normal", "compact"] as const) {
    test(`G2b: a ${contextMode} heartbeat turned off during its send's own awaits starts nothing`, async () => {
      const effects = await dispatchIdleHeartbeat(contextMode, () => {
        // Past executeHeartbeat's own checks: the send's admission gates must refuse it.
        const original = workspaceService.sendMessage.bind(workspaceService);
        spyOn(workspaceService, "sendMessage").mockImplementationOnce(async (...args) => {
          const changed = await turnOff.disable();
          expect(changed.success).toBe(true);
          return original(...args);
        });
        return Promise.resolve();
      });
      // Target assertion: neither the heartbeat turn nor its compaction starts.
      expect(effects.any).toBe(0);
    });
  }

  test("G2b: a reset heartbeat's follow-up turned off during its send's own awaits is refused and cleared", async () => {
    const effects = await dispatchIdleHeartbeat("reset", (session) => {
      // Past the follow-up's pre-send check: only its send's admission gates can refuse it.
      const original = session.sendMessage.bind(session);
      spyOn(session, "sendMessage").mockImplementationOnce(async (...args) => {
        const changed = await turnOff.disable();
        expect(changed.success).toBe(true);
        return original(...args);
      });
      return Promise.resolve();
    });
    expect(effects.branch).toBe(1);
    // Target assertion: the follow-up heartbeat turn never starts.
    expect(await heartbeatRows()).toBe(0);
    expect(await pendingHeartbeatHandoffs()).toBe(0);
  });

  /**
   * Runs one normal heartbeat directly (as the dispatcher would after an eligibility check) and
   * returns its error, if any. `send` replaces the heartbeat's WorkspaceService.sendMessage.
   */
  async function executeNormalHeartbeatWith(
    send: (original: WorkspaceService["sendMessage"]) => WorkspaceService["sendMessage"],
    executeOptions?: Parameters<WorkspaceService["executeHeartbeat"]>[1]
  ): Promise<unknown> {
    const configured = await workspaceService.setHeartbeatSettings(workspaceId, {
      contextMode: "normal",
    });
    expect(configured.success).toBe(true);
    const { dispose } = await attachRealSession();
    const original = workspaceService.sendMessage.bind(workspaceService);
    spyOn(workspaceService, "sendMessage").mockImplementationOnce(send(original));
    try {
      await workspaceService.executeHeartbeat(workspaceId, executeOptions);
      return undefined;
    } catch (error) {
      return error;
    } finally {
      await dispose();
    }
  }

  test("G2b: a heartbeat failure after its turn started still propagates when the heartbeat was turned off meanwhile", async () => {
    const error = await executeNormalHeartbeatWith((original) => async (...args) => {
      // The send is accepted (its turn starts), then the user turns the heartbeat off, and the
      // stream fails afterwards.
      await original(...args);
      const changed = await turnOff.disable();
      expect(changed.success).toBe(true);
      return { success: false, error: { type: "unknown", raw: "provider failed mid-stream" } };
    });
    // Target assertion: the failure is not reported as a skipped heartbeat.
    expect(error).toBeInstanceOf(Error);
    expect(heartbeatEvents).toEqual(["heartbeat.dispatched"]);
  });

  test("G2b: a heartbeat failure the off probe did not cause still propagates", async () => {
    const error = await executeNormalHeartbeatWith(() => async () => {
      // Turned off, but the send fails for another reason before any admission gate runs.
      const changed = await turnOff.disable();
      expect(changed.success).toBe(true);
      return { success: false, error: { type: "unknown", raw: "runtime unavailable" } };
    });
    // Target assertion: the failure still propagates, and the timeline records a failed delivery,
    // not a refusal by the off probe and not a dispatch (#5552).
    expect(error).toBeInstanceOf(Error);
    expect(heartbeatEvents).toEqual(["heartbeat.skipped"]);
    expect(skipReasons).toEqual(["delivery_failed"]);
  });

  test("#5552: a heartbeat whose request cannot be built is recorded as a failed delivery", async () => {
    spyOn(workspaceExtensionMetadata, "getSnapshot").mockRejectedValueOnce(
      new Error("activity snapshot unreadable")
    );
    const error = await workspaceService.executeHeartbeat(workspaceId).then(
      () => undefined,
      (failure: unknown) => failure
    );
    expect(error).toBeInstanceOf(Error);
    expect(heartbeatEvents).toEqual(["heartbeat.skipped"]);
    expect(skipReasons).toEqual(["delivery_failed"]);
  });

  test("#5519: a slot whose schedule changed before acceptance starts nothing", async () => {
    let slotStale = false;
    const error = await executeNormalHeartbeatWith((original) => async (...args) => {
      // A cadence edit lands during the send's awaits, before acceptance.
      slotStale = true;
      return original(...args);
    }, { slotStale: () => slotStale });
    // Target assertion: the send's admission gates refuse the stale slot, and the timeline says why.
    expect(error).toBeUndefined();
    expect(await heartbeatRows()).toBe(0);
    expect(heartbeatEvents).toEqual(["heartbeat.skipped"]);
    expect(skipReasons).toEqual(["schedule_changed"]);
  });

  /**
   * Another backend changes this workspace's config entry while the heartbeat stays enabled:
   * "replacement" removes the workspace and creates a different one (another ID) at the same
   * path; "legacy" leaves the same workspace as an entry without a stable ID (pre-ID config). The
   * config's workspace index still resolves this ID to its old location, as a read taken just
   * before the change does.
   */
  async function reassignEntryAtSamePath(identity: "replacement" | "legacy"): Promise<void> {
    const location = config.findWorkspace(workspaceId);
    assert(location, "workspace location missing");
    await config.editConfig((fresh) => {
      const entry = fresh.projects
        .get(PROJECT_PATH)
        ?.workspaces.find((workspace) => workspace.id === workspaceId);
      assert(entry?.heartbeat?.enabled === true, "heartbeat must stay enabled");
      if (identity === "replacement") entry.id = `${workspaceId}-replacement`;
      else delete entry.id;
      return fresh;
    });
    const findWorkspace = config.findWorkspace.bind(config);
    spyOn(config, "findWorkspace").mockImplementation((id, options) =>
      id === workspaceId ? location : findWorkspace(id, options)
    );
  }

  for (const identity of ["replacement", "legacy"] as const) {
    test(`G2b: the heartbeat settings lookup ${identity === "replacement" ? "does not match a replacement workspace at the same path" : "still resolves a legacy entry without an ID"}`, async () => {
      await reassignEntryAtSamePath(identity);
      // Target assertion: only this workspace's own entry (or its legacy id-less entry) counts.
      expect(workspaceService.getHeartbeatSettings(workspaceId)?.enabled === true).toBe(
        identity === "legacy"
      );
    });

    test(`G2b: a reset heartbeat's follow-up ${identity === "replacement" ? "is dropped when a replacement workspace took its path" : "still runs for a legacy entry without an ID"}`, async () => {
      const effects = await dispatchIdleHeartbeat("reset", (session) => {
        const original = session.dispatchPendingCompactionFollowUpIfNeeded.bind(session);
        spyOn(session, "dispatchPendingCompactionFollowUpIfNeeded").mockImplementationOnce(
          async (...args) => {
            await reassignEntryAtSamePath(identity);
            return original(...args);
          }
        );
        return Promise.resolve();
      });
      expect(effects.branch).toBe(1);
      // Target assertion: the replacement's enabled heartbeat does not admit this workspace's
      // follow-up turn; the legacy entry is this workspace, so its follow-up runs.
      expect(await heartbeatRows()).toBe(identity === "legacy" ? 1 : 0);
      // A dropped follow-up is cleared, so startup recovery cannot start it later.
      if (identity === "replacement") expect(await pendingHeartbeatHandoffs()).toBe(0);
    });
  }

  const lateTurnOffs = {
    "after its eligibility check": () => turnOff.disable().then(() => undefined),
    "during the reset's own awaits": turnOffDuringResetAppend,
  } as const;
  for (const [when, between] of Object.entries(lateTurnOffs)) {
    test(`G2b: a heartbeat turned off ${when} is recorded as skipped, not dispatched`, async () => {
      const effects = await dispatchIdleHeartbeat("reset", between);
      expect(effects.any).toBe(0);
      expect(recorded("heartbeat.skipped")).toHaveLength(1);
      // Target assertion: the timeline never says a refused heartbeat was dispatched.
      expect(recorded("heartbeat.dispatched")).toHaveLength(0);
    });
  }

  for (const contextMode of ["normal", "compact", "reset"] as const) {
    for (const change of ["unset", "disable"] as const) {
      test(`G2b: a ${contextMode} heartbeat dispatch does nothing after the heartbeat was ${change === "unset" ? "unset" : "disabled"} after its eligibility check`, async () => {
        // The heartbeat is turned off after HeartbeatService's eligibility check built the
        // payload and before the dispatcher runs it.
        let preflightReads: { mock: { calls: unknown[] } } | undefined;
        const effects = await dispatchIdleHeartbeat(contextMode, async () => {
          const changed = await turnOff[change]();
          expect(changed.success).toBe(true);
          preflightReads = spyOn(workspaceExtensionMetadata, "getSnapshot");
        });
        // Target assertion: a heartbeat that is off leaves no trace of its dispatch branch (the
        // code never re-checked the settings after the eligibility check).
        expect(effects.any).toBe(0);
        // Already off when it runs: the request preflight (which can fail) is skipped too.
        expect(preflightReads?.mock.calls).toHaveLength(0);
      });
    }

    test(`G2b control: a ${contextMode} heartbeat dispatch runs while the heartbeat is enabled`, async () => {
      // reset also dispatches its follow-up heartbeat turn, so only the branch count is exact.
      // The heartbeat's foreground send resolves only after its turn's stream completes.
      const original = workspaceService.sendMessage.bind(workspaceService);
      spyOn(workspaceService, "sendMessage").mockImplementation(async (...args) => {
        const result = await original(...args);
        heartbeatEvents.push("send resolved");
        return result;
      });
      expect((await dispatchIdleHeartbeat(contextMode)).branch).toBe(1);
      // Recorded once, when the send was accepted, not after its turn ended (the reset branch
      // records its published boundary and starts its follow-up without this send).
      expect(heartbeatEvents).toEqual(
        contextMode === "reset"
          ? ["heartbeat.dispatched"]
          : ["heartbeat.dispatched", "send resolved"]
      );
    });
  }
});
