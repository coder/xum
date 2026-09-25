import * as path from "path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Config } from "@/node/config";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { WorkspaceGoalService } from "./workspaceGoalService";
import { IdleDispatcher } from "./idleDispatcher";
import { createTestHistoryService } from "./testHistoryService";
import type { HistoryService } from "./historyService";
import type { GoalRecordV1, GoalStatus } from "@/common/types/goal";
import { GOAL_BUDGET_LIMIT_KIND, GOAL_CONTINUATION_KIND } from "@/constants/goals";
import { createMuxMessage } from "@/common/types/message";
import { drainPendingDispatches, waitForCondition } from "./testDispatchHelpers";
import {
  captureGoalActivity,
  setGoalOk,
  appendUserHistoryMessage,
  PROJECT_PATH,
  goalFileExists,
  analyticsMock,
  continuationBridge,
} from "./workspaceGoalService.testHarness";

describe("WorkspaceGoalService", () => {
  let config: Config;
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;
  let extensionMetadata: ExtensionMetadataService;
  let service: WorkspaceGoalService;
  let analytics: ReturnType<typeof analyticsMock>;
  const workspaceId = "goal-parent";

  beforeEach(async () => {
    ({ config, historyService, cleanup } = await createTestHistoryService());
    await config.addWorkspace(PROJECT_PATH, {
      id: workspaceId,
      name: "parent",
      projectName: "mux-goal-service-test-project",
      projectPath: PROJECT_PATH,
      runtimeConfig: { type: "local" },
    });
    extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    analytics = analyticsMock();
    service = new WorkspaceGoalService(config, historyService, extensionMetadata, analytics);
  });

  afterEach(async () => {
    await cleanup();
  });

  // Drive one real continuation so the goal leaves its kickoff window
  // (lastContinuationFiredAtMs set + goal_continuation row in history).
  async function driveOneContinuation(): Promise<void> {
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(
      dispatcher,
      continuationBridge(async (input) => {
        await appendUserHistoryMessage(historyService, input.workspaceId, input.message, {
          timestamp: Date.now(),
          synthetic: true,
          uiVisible: true,
          kind: input.kind ?? GOAL_CONTINUATION_KIND,
        });
        return true;
      })
    );
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 10_000,
    });
    await waitForCondition(
      async () => (await service.getGoal(workspaceId))?.lastContinuationFiredAtMs != null,
      { timeoutMs: 1_000 }
    );
  }

  test("direct idle creation persists the publication stamp in a single durable write", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cDhNO): the previous re-stamp scheme wrote the
    // construction stamp first and re-wrote the publication stamp after the
    // snapshot push — a crash between the two writes durably stranded the
    // earlier stamp, so restart reconciliation misread a manual row authored
    // during validation as a post-goal intervention and paused the
    // never-driven goal. The record and its visibility stamp must commit in
    // one atomic write.
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(),
      getKickoffSendOptions: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { model: "openai:gpt-4o", agentId: "exec" };
      },
    });
    const serviceAccess = service as unknown as {
      writeGoal: (workspaceId: string, goal: GoalRecordV1) => Promise<void>;
    };
    const originalWriteGoal = serviceAccess.writeGoal.bind(service);
    const writtenStamps: number[] = [];
    spyOn(serviceAccess, "writeGoal").mockImplementation(async (id: string, goal: GoalRecordV1) => {
      writtenStamps.push(goal.createdAtMs);
      return originalWriteGoal(id, goal);
    });

    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Atomic publication stamp",
      budgetCents: 500,
    });

    // Every durable write of this goal already carries the final publication
    // stamp — no window exists where a crash leaves an earlier construction
    // stamp on disk.
    expect(writtenStamps.length).toBeGreaterThan(0);
    expect(writtenStamps).toEqual(writtenStamps.map(() => created.createdAtMs));
  });

  test("maintenance streams after a restart preserve durable user-origin wrap-up suppression", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cDhNX): a user-origin budget_limited goal
    // recovers from restart without a wrap-up candidate, but the suppressing
    // in-memory stamp is gone too. The first background wake's stream-end
    // accounting must not record a wrap-up-eligible maintenance stamp — that
    // would let the next stream-end request dispatch the autonomous wrap-up
    // the persisted budgetLimitOriginKind: "user" was meant to suppress.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "User exhausts budget then restarts",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "user",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitOriginKind: "user",
    });

    // Simulate restart: fresh service, empty in-memory stream stamps.
    const restartedService = new WorkspaceGoalService(
      config,
      historyService,
      extensionMetadata,
      analytics
    );
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    restartedService.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(execute),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    // A background wake turn ends on the restarted service.
    await restartedService.recordStreamAccounting({
      workspaceId,
      costUsd: 0.01,
      streamStartedAtMs: Date.now(),
      streamOriginKind: "other",
    });

    const stamps = (
      restartedService as unknown as {
        lastGoalStreamStamps: Map<string, { originKind: string }>;
      }
    ).lastGoalStreamStamps;
    expect(stamps.get(workspaceId)?.originKind).toBe("user");

    // Behavioral proof: a stream-end continuation request must not dispatch
    // the wrap-up that user-origin suppression blocked.
    await restartedService.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: Date.now(),
    });
    await drainPendingDispatches();

    expect(execute).not.toHaveBeenCalled();
    expect(await restartedService.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: null,
    });
  });

  test("setters that span a stream-end drain persist directly instead of queueing", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cBr9Q): a setGoal admitted while the (stale)
    // streaming flag still reads live can reach its in-lock recheck after the
    // stream-end drain already gave up watching the mutation map. It must
    // detect the drain via the generation counter and persist directly —
    // installing a queued mutation at that point would leave its projected
    // success non-durable with no remaining stream-end hook.
    await extensionMetadata.setStreaming(workspaceId, true);

    // Fire the setter first (captures the pre-drain generation), then run the
    // drain before the setter's pre-lock await resolves.
    const setterPromise = service.setGoal({ workspaceId, objective: "Late goal" });
    const drainPromise = service.applyPendingAfterStreamEnd(workspaceId);

    const [setter, drained] = await Promise.all([setterPromise, drainPromise]);
    expect(setter.success).toBe(true);
    expect(drained).toBeNull();

    // The setter must have persisted durably; nothing may sit in the mutation
    // map waiting for a stream-end drain that will not come.
    const serviceAccess = service as unknown as {
      pendingGoalMutations: Map<string, unknown>;
    };
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)).toBeUndefined();
    expect(await service.getGoal(workspaceId)).toMatchObject({ objective: "Late goal" });
  });

  test("goal setters that span a user stop are rejected", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cCH_H): if the user aborts while a setGoal is
    // still in its pre-install awaits, recordUserStoppedStream finds no
    // mutation to delete — the setter must detect the stop and reject instead
    // of installing (stale streaming flag) or persisting directly, either of
    // which would create and arm a goal from a turn the user just aborted.
    await extensionMetadata.setStreaming(workspaceId, true);

    // The setter captures the pre-stop state at entry; the stop's synchronous
    // prefix runs while the setter is inside its pre-lock streaming check.
    const setterPromise = service.setGoal({ workspaceId, objective: "Aborted turn goal" });
    const stopPromise = service.recordUserStoppedStream(workspaceId);
    const [setter] = await Promise.all([setterPromise, stopPromise]);

    expect(setter.success).toBe(false);
    if (!setter.success) {
      expect(setter.error.type).toBe("invalid_transition");
    }
    const serviceAccess = service as unknown as { pendingGoalMutations: Map<string, unknown> };
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)).toBeUndefined();
    expect(await service.getGoal(workspaceId)).toBeNull();
  });

  test("setters admitted after the drain settles persist directly", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cCH_L): a setter admitted after the drain's
    // final empty-map check captures the already-bumped generation, and the
    // streaming flag can still read stale-live — it must observe the settled
    // state and persist directly instead of installing a mutation that stays
    // non-durable until some unrelated later stream ends.
    await extensionMetadata.setStreaming(workspaceId, true);
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);
    expect(drained).toBeNull();

    // Admitted strictly after the drain returned; streaming flag still true.
    const setter = await service.setGoal({ workspaceId, objective: "Post-drain goal" });

    expect(setter.success).toBe(true);
    const serviceAccess = service as unknown as { pendingGoalMutations: Map<string, unknown> };
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)).toBeUndefined();
    expect(await service.getGoal(workspaceId)).toMatchObject({ objective: "Post-drain goal" });
  });

  test("recordStreamStarted clears the settled marker so the next stream defers mid-stream setGoal", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cClKS): every drain exit (and user stop) marks
    // the workspace settled, but production only cleared the marker on
    // terminal-error restoration. Without an explicit stream-start
    // notification, a model set_goal in the NEXT successful stream bypassed
    // deferral and wrote goal.json mid-stream.
    await extensionMetadata.setStreaming(workspaceId, true);
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);
    expect(drained).toBeNull();

    // AgentSession's stream-start handler notifies synchronously.
    service.recordStreamStarted(workspaceId);

    const setter = await service.setGoal({ workspaceId, objective: "Mid-stream goal" });
    expect(setter.success).toBe(true);
    const serviceAccess = service as unknown as { pendingGoalMutations: Map<string, unknown> };
    // Deferred again: the mutation queues for THIS stream's stream-end drain
    // instead of persisting mid-stream.
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)).toBeDefined();
    expect(await goalFileExists(config, workspaceId)).toBe(false);
  });

  test("a user stop landing while direct persistence awaits the goal lock discards the setter", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cClKV): the pre-persistence stop check is not
    // the last word — setGoalImmediately still awaits the goal file lock and
    // the durable writes. A stop landing during those awaits must discard the
    // change instead of durably creating a goal from the aborted turn.
    const serviceAccess = service as unknown as {
      fileLocks: { withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T> };
    };
    // Codex P2 (PRRT_kwDOPxxmWM6cKkGV): count lock admissions instead of
    // sleeping — on a loaded worker a fixed delay cannot guarantee the setter
    // captured the pre-stop generation and queued behind the gate before the
    // stop runs; the stop would then come first and the setter would
    // legitimately persist, failing the test despite correct behavior.
    let lockCalls = 0;
    const originalWithLock = serviceAccess.fileLocks.withLock.bind(serviceAccess.fileLocks);
    serviceAccess.fileLocks.withLock = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
      lockCalls += 1;
      return originalWithLock(key, fn);
    };
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gateTenure = serviceAccess.fileLocks.withLock(workspaceId, () => gate);

    // Direct path (no live stream): the setter passes its pre-lock stop check
    // and queues behind the gate.
    const setterPromise = service.setGoal({ workspaceId, objective: "Aborted direct goal" });
    // Deterministic admission signal: gate (1), setter's persistence tenure (2).
    await waitForCondition(() => lockCalls >= 2, { timeoutMs: 5_000 });
    // The stop bumps the stop generation synchronously; its own locked section
    // queues behind the setter's tenure.
    const stopPromise = service.recordUserStoppedStream(workspaceId);
    releaseGate();
    await gateTenure;
    const [setter] = await Promise.all([setterPromise, stopPromise]);

    expect(setter.success).toBe(false);
    if (!setter.success) {
      expect(setter.error.type).toBe("invalid_transition");
    }
    expect(await service.getGoal(workspaceId)).toBeNull();
    expect(await goalFileExists(config, workspaceId)).toBe(false);
  });

  test("a stream starting during the stream-end drain leaves the workspace unsettled", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cEl37): the provider-error path launches the
    // drain un-awaited, so an automatic retry's stream-start can land while
    // the drain is persisting. The drain's exit must not re-add the settled
    // marker the retry's recordStreamStarted just cleared — a set_goal in the
    // retry stream would then persist mid-stream, bypassing abort-time
    // discard and stream-end accounting.
    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({ workspaceId, objective: "Queued mid-error" });
    expect(queued.success).toBe(true);

    const serviceAccess = service as unknown as {
      fileLocks: { withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T> };
      pendingGoalMutations: Map<string, unknown>;
      drainSettledWorkspaces: Set<string>;
    };
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gateTenure = serviceAccess.fileLocks.withLock(workspaceId, () => gate);

    // The drain's locked claim queues behind the gate; the retry stream
    // starts while it waits.
    const drainPromise = service.applyPendingAfterStreamEnd(workspaceId);
    service.recordStreamStarted(workspaceId);
    releaseGate();
    await gateTenure;
    await drainPromise;

    expect(serviceAccess.drainSettledWorkspaces.has(workspaceId)).toBe(false);
    // Behavioral proof: a set_goal in the retry stream still defers to that
    // stream's own stream-end drain instead of persisting mid-stream.
    const setter = await service.setGoal({ workspaceId, objective: "Retry-stream goal" });
    expect(setter.success).toBe(true);
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)).toBeDefined();
  });

  test("an old stream's drain leaves a retry stream's mutation for that stream's own drain", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cJ6M-): an un-awaited provider-error drain can
    // still be looping when an automatic retry starts and installs its own
    // set_goal. Claims are stream-scoped by stream-start generation: the old
    // drain must not claim the retry's mutation — persisting it early would
    // archive/replace the goal before the retry's accounting and strip a
    // later user abort of its discard window.
    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({ workspaceId, objective: "Queued mid-error" });
    expect(queued.success).toBe(true);

    const serviceAccess = service as unknown as {
      fileLocks: { withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T> };
      pendingGoalMutations: Map<string, { objective: string }>;
    };
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gateTenure = serviceAccess.fileLocks.withLock(workspaceId, () => gate);

    // Old drain (stream 1) blocks at its locked claim; the retry stream then
    // starts and queues a replacement set_goal behind the same lock. Lock
    // ordering guarantees the retry's install lands before the old drain's
    // second claim pass (its finalization's chat-tail sync queues behind the
    // setter's tenure).
    const drainPromise = service.applyPendingAfterStreamEnd(workspaceId);
    service.recordStreamStarted(workspaceId);
    const retrySetterPromise = service.setGoal({ workspaceId, objective: "Retry-stream goal" });
    releaseGate();
    await gateTenure;
    await drainPromise;
    const retrySetter = await retrySetterPromise;
    expect(retrySetter.success).toBe(true);

    // The old drain claimed only its own stream's mutation; the retry's
    // mutation is still queued for the retry's own stream-end drain.
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)?.objective).toBe(
      "Retry-stream goal"
    );
    expect(await service.getGoal(workspaceId)).toMatchObject({ objective: "Queued mid-error" });

    // The retry stream's own drain (entry generation matches) claims it.
    const retryDrained = await service.applyPendingAfterStreamEnd(workspaceId);
    expect(retryDrained).toMatchObject({ objective: "Retry-stream goal" });
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)).toBeUndefined();
  });

  test("an old drain's exit does not force a retry stream's setter onto direct persistence", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cLA0R): the drain-generation staleness check
    // was workspace-global. A setter in retry stream B that captured the
    // generation, awaited its streaming read, and then observed the OLD
    // stream-A drain's exit bump fell through to direct persistence while B
    // was live — the replacement predated B's accounting and escaped a later
    // Stop's discard window. Drain bumps are now stream-scoped: an older
    // stream's bump leaves the setter on the deferral path, and its queued
    // mutation is claimed by B's own drain.
    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({ workspaceId, objective: "Queued mid-error" });
    expect(queued.success).toBe(true);

    const serviceAccess = service as unknown as {
      isWorkspaceStreaming: (id: string) => Promise<boolean>;
      pendingGoalMutations: Map<string, { objective: string }>;
      fileLocks: { withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T> };
    };
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gateTenure = serviceAccess.fileLocks.withLock(workspaceId, () => gate);

    // Old drain D_A (settling stream A) blocks at its locked claim; the retry
    // stream B then starts.
    const drainPromise = service.applyPendingAfterStreamEnd(workspaceId);
    service.recordStreamStarted(workspaceId);

    // Hold the setter at its pre-lock streaming read (one-shot gate) so D_A's
    // exit bump lands while the setter is in flight — Codex's interleaving.
    const realIsStreaming = serviceAccess.isWorkspaceStreaming.bind(service);
    let releaseSetterRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseSetterRead = resolve;
    });
    let pendingReadGate: Promise<void> | null = readGate;
    serviceAccess.isWorkspaceStreaming = async (id: string): Promise<boolean> => {
      const hold = pendingReadGate;
      pendingReadGate = null;
      if (hold) {
        await hold;
      }
      return realIsStreaming(id);
    };
    // Captures the pre-exit drain generation synchronously, then parks at the
    // gated streaming read.
    const setterPromise = service.setGoal({ workspaceId, objective: "Retry-stream replacement" });

    // D_A completes: claims its own stream's mutation, then exits (bumping the
    // drain generation FOR STREAM A) while the setter is still parked.
    releaseGate();
    await gateTenure;
    await drainPromise;
    expect(await service.getGoal(workspaceId)).toMatchObject({ objective: "Queued mid-error" });

    // The setter resumes, sees the bump — but it came from stream A, not B:
    // it must defer, not persist directly.
    releaseSetterRead();
    const setter = await setterPromise;
    expect(setter.success).toBe(true);
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)?.objective).toBe(
      "Retry-stream replacement"
    );
    expect(await service.getGoal(workspaceId)).toMatchObject({ objective: "Queued mid-error" });

    // B's own drain claims the deferred replacement.
    const drainedByB = await service.applyPendingAfterStreamEnd(workspaceId);
    expect(drainedByB).toMatchObject({ objective: "Retry-stream replacement" });
  });

  test("pause boundaries for a replaced goal do not reconcile the newer goal to paused", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cEl4F): a stale pause finalizer's boundary
    // append awaits history I/O after its identity check, so the row can land
    // AFTER a replacement persisted. Boundaries are goal-scoped: chat-tail
    // reconciliation must ignore one stamped for a different goal instead of
    // silently pausing the replacement.
    const goalA = await setGoalOk(service, { workspaceId, objective: "Goal A" });
    const goalB = await setGoalOk(service, { workspaceId, objective: "Goal B" });

    const staleBoundary = createMuxMessage(
      `goal-paused-stale-${crypto.randomUUID()}`,
      "user",
      "Goal paused by the user. Do not continue the goal until a later goal continuation message.",
      {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: { type: "goal-pause-boundary", goalId: goalA.goalId },
      }
    );
    const appendResult = await historyService.appendToHistory(workspaceId, staleBoundary);
    expect(appendResult.success).toBe(true);

    // Reconciliation ignores the mismatched boundary — B stays active.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goalB.goalId,
      status: "active",
    });

    // Codex P2 (PRRT_kwDOPxxmWM6cGSPK): a mismatched boundary is skipped, not
    // treated as the tail's final signal — a genuine post-goal manual row
    // beneath it must still reconcile the replacement to paused (covers a
    // crash that lost the dispatch-time auto-pause).
    await appendUserHistoryMessage(historyService, workspaceId, "Post-goal intervention", {
      timestamp: goalB.createdAtMs + 5_000,
    });
    const buriedBoundary = createMuxMessage(
      `goal-paused-buried-${crypto.randomUUID()}`,
      "user",
      "Goal paused by the user. Do not continue the goal until a later goal continuation message.",
      {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: { type: "goal-pause-boundary", goalId: goalA.goalId },
      }
    );
    expect((await historyService.appendToHistory(workspaceId, buriedBoundary)).success).toBe(true);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goalB.goalId,
      status: "paused",
    });
    // Reset for the legacy assertion below: resume B.
    await setGoalOk(service, { workspaceId, status: "active" });

    // Legacy boundaries without a goalId keep the old any-goal semantics.
    const legacyBoundary = createMuxMessage(
      `goal-paused-legacy-${crypto.randomUUID()}`,
      "user",
      "Goal paused by the user. Do not continue the goal until a later goal continuation message.",
      {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: { type: "goal-pause-boundary" },
      }
    );
    const legacyAppend = await historyService.appendToHistory(workspaceId, legacyBoundary);
    expect(legacyAppend.success).toBe(true);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goalB.goalId,
      status: "paused",
    });
  });

  test("a malformed boundary goalId does not unpause the goal it belongs to", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cNxUY): chat.jsonl metadata is unchecked
    // JSON — a corrupt non-string goalId on a pause boundary must not satisfy
    // the mismatch test (it is not another goal's boundary). Skipping it
    // would let the scan reach the goal's own older continuation row and
    // reactivate a durably paused goal. Invalid IDs degrade to legacy
    // unscoped semantics: conservative paused, not scoped.
    const created = await setGoalOk(service, { workspaceId, objective: "Corrupt boundary" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: created.goalId,
    });
    const corruptBoundary = createMuxMessage(
      `goal-paused-corrupt-${crypto.randomUUID()}`,
      "user",
      "Goal paused by the user. Do not continue the goal until a later goal continuation message.",
      {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: { type: "goal-pause-boundary", goalId: 42 as unknown as string },
      }
    );
    expect((await historyService.appendToHistory(workspaceId, corruptBoundary)).success).toBe(true);
    // Durable pause written directly (no boundary append, no in-memory pause
    // bookkeeping) — models the post-restart state where only the persisted
    // artifacts remain.
    await (
      service as unknown as { writeGoal: (id: string, goal: GoalRecordV1) => Promise<void> }
    ).writeGoal(workspaceId, { ...created, status: "paused", updatedAtMs: Date.now() });

    // Reconciliation must not treat the corrupt boundary as another goal's
    // row and reactivate off the continuation row beneath it.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });
  });

  test("a non-UUID boundary goalId degrades to a conservative unscoped pause", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cRJEC): durable goal IDs are UUIDs, so a
    // corrupt non-UUID STRING on a pause boundary is not another goal's
    // boundary either. Treating it as scoped-different would skip it, reach
    // the goal's own older continuation row, and reactivate a durably paused
    // goal after restart.
    const created = await setGoalOk(service, { workspaceId, objective: "Non-UUID boundary" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: created.goalId,
    });
    const corruptBoundary = createMuxMessage(
      `goal-paused-nonuuid-${crypto.randomUUID()}`,
      "user",
      "Goal paused by the user. Do not continue the goal until a later goal continuation message.",
      {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: { type: "goal-pause-boundary", goalId: "broken" },
      }
    );
    expect((await historyService.appendToHistory(workspaceId, corruptBoundary)).success).toBe(true);
    // Durable pause written directly (no boundary append, no in-memory pause
    // bookkeeping) — models the post-restart state where only the persisted
    // artifacts remain.
    await (
      service as unknown as { writeGoal: (id: string, goal: GoalRecordV1) => Promise<void> }
    ).writeGoal(workspaceId, { ...created, status: "paused", updatedAtMs: Date.now() });

    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });
  });

  test("a malformed continuation goalId is not legacy activity evidence", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cOHpI): legacy any-goal semantics apply only
    // when the scoping ID is genuinely absent. A present-but-malformed ID on
    // a continuation row must be skipped, not accepted as legacy-active — at
    // the tail it would otherwise reactivate a durably paused goal.
    const created = await setGoalOk(service, { workspaceId, objective: "Corrupt continuation" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: 42 as unknown as string,
    });
    // Durable pause written directly (no boundary, no in-memory bookkeeping)
    // — models the post-restart state where only persisted artifacts remain.
    await (
      service as unknown as { writeGoal: (id: string, goal: GoalRecordV1) => Promise<void> }
    ).writeGoal(workspaceId, { ...created, status: "paused", updatedAtMs: Date.now() });

    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });
  });

  test("a stop landing during post-write publication restores the prior record", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cOHpB): the post-write recheck samples the
    // stop generation, but pushSnapshot/pushLiveGoalPreviewOverlay still
    // await inside the same lock tenure. A Stop landing there left the
    // aborted turn's complete_goal durable — the veto must stay active
    // through the final awaited publication step.
    const created = await setGoalOk(service, { workspaceId, objective: "Abort mid-publication" });
    await extensionMetadata.setStreaming(workspaceId, true);

    const serviceAccess = service as unknown as {
      pushSnapshot: (id: string, goal: GoalRecordV1 | null) => Promise<unknown>;
    };
    const realPush = serviceAccess.pushSnapshot.bind(service);
    let releasePush!: () => void;
    const pushGate = new Promise<void>((resolve) => {
      releasePush = resolve;
    });
    let pushStarted = false;
    const pushSpy = spyOn(serviceAccess, "pushSnapshot").mockImplementationOnce(
      async (id: string, goal: GoalRecordV1 | null) => {
        pushStarted = true;
        await pushGate;
        return realPush(id, goal);
      }
    );

    const completePromise = service.setGoal({
      workspaceId,
      status: "complete",
      completionSummary: "Done before the user could stop it",
      initiator: "model",
    });
    await waitForCondition(() => pushStarted, { timeoutMs: 5_000 });
    // Stop lands during the publication await, after the post-write sample.
    const stopPromise = service.recordUserStoppedStream(workspaceId);
    releasePush();

    const completed = await completePromise;
    expect(completed.success).toBe(false);
    if (!completed.success) {
      expect(completed.error.type).toBe("invalid_transition");
    }
    await stopPromise;
    pushSpy.mockRestore();

    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "active",
    });
    expect(typeof (await service.getGoal(workspaceId))?.requireUserAcknowledgmentSinceMs).toBe(
      "number"
    );
  });

  test("the continuation dispatch admission probe goes stale when an explicit pause commits", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cOgXR): an explicit Pause completing while
    // the dispatched continuation's send runs its unlocked preflight must
    // refuse the captured send — otherwise its synthetic row lands after the
    // pause boundary as fresh active evidence and reactivates the goal. The
    // dispatch passes an admissionStale probe that flips when the candidate
    // is deleted or the explicit-pause generation moves.
    const dispatcher = new IdleDispatcher();
    let capturedProbe: (() => boolean) | undefined;
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        capturedProbe = input.admissionStale;
        // Model a send parked in preflight: never accept.
        return Promise.resolve(false);
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });
    await setGoalOk(service, { workspaceId, objective: "Pause races dispatch" });
    await drainPendingDispatches();
    await waitForCondition(() => capturedProbe != null, { timeoutMs: 5_000 });

    // Mid-preflight, before any pause: not stale.
    expect(capturedProbe!()).toBe(false);
    // Explicit pause commits during the preflight: deletes the candidate and
    // bumps the explicit-pause generation — the probe must flip stale.
    await setGoalOk(service, { workspaceId, status: "paused" });
    expect(capturedProbe!()).toBe(true);
  });

  test("pre-goal queue races restore suspended budget wrap-up candidates", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cPbjX): a queued manual message that predates
    // a budget_limited goal (e.g. an auto-promoted revival whose retained
    // spend exceeds its budget) suspends the armed budget_wrapup candidate;
    // the active-only restore rule would reject it and strand the owed
    // wrap-up for the rest of the process. A matching budget-limited goal
    // that still owes its wrap-up must accept the restore.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Wrap-up survives pre-goal queue race",
      budgetCents: 100,
    });
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      // Busy runtime: the armed candidate stays pending instead of firing.
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: true }),
      executeGoalContinuation: () => Promise.resolve(true),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 20_000,
    });
    const candidates = (
      service as unknown as {
        pendingContinuationCandidates: Map<string, { source: string }>;
      }
    ).pendingContinuationCandidates;
    // Stream-end arming on a budget_limited goal produces the wrap-up's
    // candidate (eligibility dispatches the wrap-up from any source).
    expect(candidates.get(workspaceId)?.source).toBe("stream_end");

    const suspended = service.takePendingContinuationCandidateForManualUserMessage(workspaceId);
    expect(suspended).not.toBeNull();
    expect(candidates.has(workspaceId)).toBe(false);
    await service.restorePendingContinuationCandidate(workspaceId, suspended!);
    expect(candidates.get(workspaceId)?.source).toBe("stream_end");

    // A suppressed wrap-up is no longer owed — the restore must refuse it.
    const suspendedAgain =
      service.takePendingContinuationCandidateForManualUserMessage(workspaceId);
    expect(suspendedAgain).not.toBeNull();
    await service.suppressBudgetWrapupForManualUserMessage(workspaceId, created.goalId);
    await service.restorePendingContinuationCandidate(workspaceId, suspendedAgain!);
    expect(candidates.has(workspaceId)).toBe(false);
  });

  test("the wrap-up dispatch admission probe goes stale when a manual message suppresses it", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cPBWX): a manual send during the wrap-up
    // send's preflight can suppress the wrap-up without making the session
    // busy; tryMarkBudgetLimitInjected refusing after acceptance is too late.
    // The wrap-up dispatch must carry an admission probe that flips on
    // candidate deletion, live-stamp ineligibility, or the suppression's
    // durable terminal-status write.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Wrap-up races manual suppression",
      budgetCents: 100,
    });
    const dispatcher = new IdleDispatcher();
    let capturedProbe: (() => boolean) | undefined;
    let capturedKind: string | undefined;
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        capturedKind = input.kind;
        capturedProbe = input.admissionStale;
        // Model a send parked in preflight: never accept.
        return Promise.resolve(false);
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: 20_000,
    });
    await drainPendingDispatches();
    await waitForCondition(() => capturedProbe != null, { timeoutMs: 5_000 });
    expect(capturedKind).toBe(GOAL_BUDGET_LIMIT_KIND);

    // Mid-preflight, before the intervention: not stale.
    expect(capturedProbe!()).toBe(false);
    // Manual suppression commits during the preflight: durable user-origin
    // write (terminal-status bump) + live stamp re-mark — probe flips stale.
    await service.suppressBudgetWrapupForManualUserMessage(workspaceId, created.goalId);
    expect(capturedProbe!()).toBe(true);
  });

  test("the continuation admission probe goes stale when the goal completes mid-preflight", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cPBWd): a same-goal completion (or an
    // accounting flip to budget_limited) during the send preflight neither
    // deletes the candidate nor bumps the explicit-pause generation — the
    // captured continuation would be admitted against a completed goal. The
    // terminal-status generation must flip the probe.
    const dispatcher = new IdleDispatcher();
    let capturedProbe: (() => boolean) | undefined;
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        capturedProbe = input.admissionStale;
        return Promise.resolve(false);
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });
    await setGoalOk(service, { workspaceId, objective: "Completion races dispatch" });
    await drainPendingDispatches();
    await waitForCondition(() => capturedProbe != null, { timeoutMs: 5_000 });

    expect(capturedProbe!()).toBe(false);
    await setGoalOk(service, {
      workspaceId,
      status: "complete",
      completionSummary: "Completed during the preflight",
    });
    expect(capturedProbe!()).toBe(true);
  });

  test("the continuation admission probe goes stale when the goal is replaced", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cPuM6): an active→active replacement bumps
    // neither the pause nor the terminal generation, and the replaced goal's
    // candidate can stay installed until the replacement's kickoff finalizer
    // arms — the captured continuation for goal A would be admitted after
    // goal B is durable and its accounting would charge B for A's work. The
    // identity generation must flip the probe.
    const dispatcher = new IdleDispatcher();
    let capturedProbe: (() => boolean) | undefined;
    let kickoffOptionsAvailable = true;
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        capturedProbe = input.admissionStale;
        return Promise.resolve(false);
      },
      getKickoffSendOptions: () =>
        Promise.resolve(
          kickoffOptionsAvailable ? { model: "openai:gpt-4o", agentId: "exec" } : null
        ),
    });
    await setGoalOk(service, { workspaceId, objective: "Goal A" });
    await drainPendingDispatches();
    await waitForCondition(() => capturedProbe != null, { timeoutMs: 5_000 });
    expect(capturedProbe!()).toBe(false);

    // Models B's kickoff finalizer not having armed yet (no send options →
    // arming skipped): the candidate reference cannot flip the probe, only
    // the identity change can.
    kickoffOptionsAvailable = false;
    const candidates = (
      service as unknown as { pendingContinuationCandidates: Map<string, { goalId: string }> }
    ).pendingContinuationCandidates;
    const candidateBefore = candidates.get(workspaceId);
    await setGoalOk(service, { workspaceId, objective: "Goal B replaces A" });
    // Precondition for the clause under test: the candidate did not change.
    expect(candidates.get(workspaceId)).toBe(candidateBefore);
    expect(capturedProbe!()).toBe(true);
  });

  test("goal redispatch admission revalidates durable state and observes later transitions", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cPuMw): a redispatched goal turn (compaction
    // follow-up) lost its original admission guards. buildGoalRedispatchAdmission
    // re-derives them: durable revalidation plus a staleness probe.
    const created = await setGoalOk(service, { workspaceId, objective: "Redispatch admission" });
    const admission = await service.buildGoalRedispatchAdmission(
      workspaceId,
      created.goalId,
      GOAL_CONTINUATION_KIND
    );
    expect(admission.admissible).toBe(true);
    if (!admission.admissible) {
      throw new Error("expected admissible");
    }
    expect(admission.admissionStale()).toBe(false);

    // An explicit pause after the build flips the probe; a rebuild refuses.
    await setGoalOk(service, { workspaceId, status: "paused" });
    expect(admission.admissionStale()).toBe(true);
    expect(
      (
        await service.buildGoalRedispatchAdmission(
          workspaceId,
          created.goalId,
          GOAL_CONTINUATION_KIND
        )
      ).admissible
    ).toBe(false);

    // Identity mismatch refuses outright.
    expect(
      (
        await service.buildGoalRedispatchAdmission(
          workspaceId,
          "other-goal",
          GOAL_CONTINUATION_KIND
        )
      ).admissible
    ).toBe(false);
  });

  test("goal redispatch admission rejects a goal transition that commits during its state read", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Pause races redispatch read",
    });
    const serviceAccess = service as unknown as {
      readGoalFile: (id: string) => Promise<GoalRecordV1 | null>;
    };
    const realReadGoalFile = serviceAccess.readGoalFile.bind(service);
    let releaseStaleRead!: () => void;
    const staleReadGate = new Promise<void>((resolve) => {
      releaseStaleRead = resolve;
    });
    let staleReadCaptured = false;
    const readSpy = spyOn(serviceAccess, "readGoalFile").mockImplementationOnce(
      async (id: string) => {
        const staleGoal = await realReadGoalFile(id);
        staleReadCaptured = true;
        await staleReadGate;
        return staleGoal;
      }
    );

    const admissionPromise = service.buildGoalRedispatchAdmission(
      workspaceId,
      created.goalId,
      GOAL_CONTINUATION_KIND
    );
    await waitForCondition(() => staleReadCaptured, { timeoutMs: 5_000 });
    await setGoalOk(service, { workspaceId, status: "paused" });
    releaseStaleRead();

    expect((await admissionPromise).admissible).toBe(false);
    readSpy.mockRestore();
  });

  test("goal redispatch admission goes stale when the goal is cleared", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Clear invalidates redispatch",
    });
    const admission = await service.buildGoalRedispatchAdmission(
      workspaceId,
      created.goalId,
      GOAL_CONTINUATION_KIND
    );
    expect(admission.admissible).toBe(true);
    if (!admission.admissible) {
      throw new Error("expected admissible");
    }

    await service.clearGoal(workspaceId);

    expect(admission.admissionStale()).toBe(true);
  });

  test("goal redispatch admission accepts a compacted wrap-up that owns its reservation", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Compacted wrap-up keeps reservation",
      budgetCents: 100,
    });
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(dispatcher, continuationBridge());
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: created.createdAtMs + 2,
    });
    await drainPendingDispatches();
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: created.goalId,
    });

    const admission = await service.buildGoalRedispatchAdmission(
      workspaceId,
      created.goalId,
      GOAL_BUDGET_LIMIT_KIND
    );

    expect(admission.admissible).toBe(true);
  });

  test("a stop landing during auto-promotion reads restores the completed goal", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cOgXV): maybeAutoPromoteOnComplete awaits
    // board/streaming/pricing reads after the caller's publication sample. A
    // Stop landing there must neither leave the aborted completion durable
    // nor promote the next upcoming goal from the aborted turn.
    const created = await setGoalOk(service, { workspaceId, objective: "Abort mid-promotion" });
    const queued = await service.addUpcomingGoal({ workspaceId, objective: "Next in queue" });

    const serviceAccess = service as unknown as {
      readBoard: (id: string) => Promise<unknown>;
    };
    const realReadBoard = serviceAccess.readBoard.bind(service);
    let releaseBoard!: () => void;
    const boardGate = new Promise<void>((resolve) => {
      releaseBoard = resolve;
    });
    let boardReadStarted = false;
    const boardSpy = spyOn(serviceAccess, "readBoard").mockImplementationOnce(
      async (id: string) => {
        boardReadStarted = true;
        await boardGate;
        return realReadBoard(id);
      }
    );

    const completePromise = service.setGoal({
      workspaceId,
      status: "complete",
      completionSummary: "Done before the user could stop it",
      initiator: "model",
    });
    await waitForCondition(() => boardReadStarted, { timeoutMs: 5_000 });
    // Stop lands during the auto-promotion's board read.
    const stopPromise = service.recordUserStoppedStream(workspaceId);
    releaseBoard();

    const completed = await completePromise;
    expect(completed.success).toBe(false);
    if (!completed.success) {
      expect(completed.error.type).toBe("invalid_transition");
    }
    await stopPromise;
    boardSpy.mockRestore();

    // The prior goal is restored (not completed, not promoted) and gated.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "active",
    });
    expect(typeof (await service.getGoal(workspaceId))?.requireUserAcknowledgmentSinceMs).toBe(
      "number"
    );
    // The upcoming goal was not consumed by the aborted promotion.
    const board = await service.getGoalBoard(workspaceId);
    const upcomingEntry = board.entries.find((e) => e.section === "upcoming");
    expect(upcomingEntry?.goal.goalId).toBe(queued.goalId);
  });

  test("a stop landing during the promotion writes rolls the promotion back", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cS8B4): the pre-write veto above cannot see a
    // Stop landing INSIDE the promotion's board/goal/snapshot writes. The
    // promotion would complete durably, and the caller deliberately skips
    // restoring once goal.json no longer holds its completion — leaving the
    // aborted completion archived and the board advanced despite the Stop.
    const created = await setGoalOk(service, { workspaceId, objective: "Abort mid-write" });
    const queued = await service.addUpcomingGoal({ workspaceId, objective: "Next in queue" });

    const serviceAccess = service as unknown as {
      writeBoard: (id: string, board: unknown) => Promise<void>;
    };
    const realWriteBoard = serviceAccess.writeBoard.bind(service);
    const boardSpy = spyOn(serviceAccess, "writeBoard").mockImplementationOnce(
      async (id: string, board: unknown) => {
        // Stop lands during the first promotion write: the generation bump is
        // synchronous even though the locked acknowledgment waits behind the
        // in-flight setter's lock tenure.
        void service.recordUserStoppedStream(id);
        return realWriteBoard(id, board);
      }
    );

    const completed = await service.setGoal({
      workspaceId,
      status: "complete",
      completionSummary: "Done before the user could stop it",
      initiator: "model",
    });
    boardSpy.mockRestore();
    expect(completed.success).toBe(false);
    if (!completed.success) {
      expect(completed.error.type).toBe("invalid_transition");
    }

    // The promotion transaction rolled back and the caller restored the
    // pre-completion record.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "active",
    });
    // The upcoming goal was not consumed by the aborted promotion.
    const board = await service.getGoalBoard(workspaceId);
    const upcomingEntry = board.entries.find((e) => e.section === "upcoming");
    expect(upcomingEntry?.goal.goalId).toBe(queued.goalId);
  });

  test("raising the budget out of budget_limited invalidates captured wrap-up admissions", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cTN_o): re-arming budget_limited→active by
    // raising the exhausted limit changes neither identity, objective, nor
    // pause state — a budget wrap-up admission captured before the raise
    // would stay fresh and charge a stale stopping turn after reactivation.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Re-armed budget",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "budget_limited" });
    const admission = await service.buildGoalRedispatchAdmission(
      workspaceId,
      created.goalId,
      GOAL_BUDGET_LIMIT_KIND
    );
    expect(admission.admissible).toBe(true);
    if (!admission.admissible) {
      throw new Error("expected admissible probe");
    }
    expect(admission.admissionStale()).toBe(false);

    // User raises the limit: applyBudgetDrivenStatus re-arms the goal active.
    await setGoalOk(service, { workspaceId, budgetCents: 1_000 });
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "active" });

    expect(admission.admissionStale()).toBe(true);
  });

  test("getGoal preserves Resume consent for previously driven goals", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cTN_r): the consent arm must apply
    // independently of the never-driven kickoff guard. A user who explicitly
    // resumes with a queued message pending has opted in — the row's
    // dispatch-time tail sync runs before manual-message goal safety, and
    // writing the resumed goal back to paused would discard the Resume with
    // no repair path (candidate restoration requires an active goal).
    await setGoalOk(service, { workspaceId, objective: "Driven then resumed" });
    await driveOneContinuation();
    // Keep the resume from arming a kickoff candidate so this exercises the
    // durable path (candidates are lost on restart/eviction anyway).
    (service as unknown as { suppressKickoffContinuation: boolean }).suppressKickoffContinuation =
      true;
    try {
      await setGoalOk(service, { workspaceId, status: "paused" });
      const authoredAtMs = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2));
      await setGoalOk(service, { workspaceId, status: "active" });
      // The queued row dispatches after the Resume; its authoring predates it.
      await appendUserHistoryMessage(historyService, workspaceId, "Queued before resume", {
        timestamp: Date.now(),
        enqueuedAtMs: authoredAtMs,
      });

      const reconciled = await service.getGoal(workspaceId);

      expect(reconciled).toMatchObject({ status: "active" });
    } finally {
      (service as unknown as { suppressKickoffContinuation: boolean }).suppressKickoffContinuation =
        false;
    }
  });

  test("a same-ID objective edit invalidates captured redispatch admissions", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cS8B1): an editInPlace rename keeps the
    // goalId, so the identity generation previously stayed put — a captured
    // continuation embedding the OLD objective could be admitted after the
    // user redirected the goal.
    const created = await setGoalOk(service, { workspaceId, objective: "Original objective" });
    const admission = await service.buildGoalRedispatchAdmission(
      workspaceId,
      created.goalId,
      GOAL_CONTINUATION_KIND
    );
    expect(admission.admissible).toBe(true);
    if (!admission.admissible) {
      throw new Error("expected admissible probe");
    }
    expect(admission.admissionStale()).toBe(false);

    await setGoalOk(service, {
      workspaceId,
      objective: "Redirected objective",
      editInPlace: true,
    });

    expect(admission.admissionStale()).toBe(true);
  });

  test("a failed preview reset publication is retried on the next usage delta", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cOgXY): the reset deleted the cached live
    // preview BEFORE publishing the durable snapshot. A failed publication
    // then left no cached preview for later deltas to observe, so the reset
    // never retried and the Goal UI kept the stale cost. Publish first;
    // clear only after success.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Preview reset retry",
      budgetCents: 500,
    });
    await service.previewStreamAccounting({
      workspaceId,
      costUsd: 0.5,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "other",
    });
    const previews = (service as unknown as { liveGoalPreviewSnapshots: Map<string, unknown> })
      .liveGoalPreviewSnapshots;
    expect(previews.has(workspaceId)).toBe(true);
    // Mid-stream pause makes the next delta ineligible.
    await setGoalOk(service, { workspaceId, status: "paused" });

    const serviceAccess = service as unknown as {
      pushSnapshot: (id: string, goal: GoalRecordV1 | null) => Promise<unknown>;
    };
    const pushSpy = spyOn(serviceAccess, "pushSnapshot").mockImplementationOnce(() =>
      Promise.reject(new Error("injected: snapshot publish lost"))
    );
    let threw = false;
    try {
      await service.previewStreamAccounting({
        workspaceId,
        costUsd: 0.6,
        streamStartedAtMs: created.createdAtMs + 1,
        streamOriginKind: "other",
      });
    } catch {
      threw = true;
    }
    pushSpy.mockRestore();
    expect(threw).toBe(true);
    // The cache survives the failed publication so a later delta retries.
    expect(previews.has(workspaceId)).toBe(true);

    // The next delta completes the reset.
    await service.previewStreamAccounting({
      workspaceId,
      costUsd: 0.7,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "other",
    });
    expect(previews.has(workspaceId)).toBe(false);
  });

  test("continuation rows for a replaced goal do not reconcile the newer goal to active", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cH3kV): goal A fired a continuation and was
    // paused, then replaced with goal B which the user pauses. When B's pause
    // finalizer cannot land its own boundary (crash / append failure), any
    // later reconciliation skips A's goal-scoped boundary and would otherwise
    // reach A's older continuation row and silently reactivate B.
    // Continuation evidence is goal-scoped.
    const goalA = await setGoalOk(service, { workspaceId, objective: "Goal A" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: goalA.goalId,
    });
    const pausedBoundary = createMuxMessage(
      `goal-paused-a-${crypto.randomUUID()}`,
      "user",
      "Goal paused by the user. Do not continue the goal until a later goal continuation message.",
      {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: { type: "goal-pause-boundary", goalId: goalA.goalId },
      }
    );
    expect((await historyService.appendToHistory(workspaceId, pausedBoundary)).success).toBe(true);

    const goalB = await setGoalOk(service, { workspaceId, objective: "Goal B" });
    // Simulate B's pause boundary append being lost (crash-equivalent): the
    // finalizer skips its post-pause chat-tail sync, leaving the tail ending
    // at goal A's rows while goal.json durably says B is paused.
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementationOnce(() =>
      Promise.resolve({ success: false, error: "injected: boundary append lost" })
    );
    await setGoalOk(service, { workspaceId, status: "paused" });
    appendSpy.mockRestore();

    // Reconciliation skips A's boundary AND A's continuation row — B stays paused.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goalB.goalId,
      status: "paused",
    });

    // Legacy continuation rows without a goalId keep the old any-goal semantics.
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goalB.goalId,
      status: "active",
    });
  });

  test("legacy unscoped continuation rows behind another goal's rows do not reactivate the current goal", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cJ6NC): mixed-version history. A pre-upgrade
    // continuation row has no goalId; once the scan crosses a row scoped to a
    // DIFFERENT goal (goal A's boundary), it is inside A's history — the
    // unscoped legacy row beneath belongs to A and must not reactivate the
    // explicitly paused replacement B.
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      // no goalId: written before goal scoping existed
    });
    const goalA = await setGoalOk(service, { workspaceId, objective: "Goal A legacy era" });
    const scopedBoundary = createMuxMessage(
      `goal-paused-a-${crypto.randomUUID()}`,
      "user",
      "Goal paused by the user. Do not continue the goal until a later goal continuation message.",
      {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: { type: "goal-pause-boundary", goalId: goalA.goalId },
      }
    );
    expect((await historyService.appendToHistory(workspaceId, scopedBoundary)).success).toBe(true);

    const goalB = await setGoalOk(service, { workspaceId, objective: "Goal B replacement" });
    // Simulate B's pause boundary append being lost (crash-equivalent), as in
    // the scoped-row regression above.
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementationOnce(() =>
      Promise.resolve({ success: false, error: "injected: boundary append lost" })
    );
    await setGoalOk(service, { workspaceId, status: "paused" });
    appendSpy.mockRestore();

    // The legacy row sits behind A's mismatched boundary — not evidence for B.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goalB.goalId,
      status: "paused",
    });
  });

  test("a manual message during budget_limited durably suppresses the wrap-up across restarts", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cJ6NM): deleting the in-memory wrap-up
    // candidate is not enough — after a restart the durable record still
    // looks wrap-up-eligible (goal-attributable origin, not yet injected) and
    // recovery re-synthesizes the autonomous wrap-up over the user's
    // intervening message.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Budget hit, then user intervened",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: null,
    });

    // Codex P2 (PRRT_kwDOPxxmWM6cLpID): suppression is scoped to the goal the
    // manual message acknowledged — a different goal's identity is a no-op.
    await service.suppressBudgetWrapupForManualUserMessage(workspaceId, "goal-someone-else");
    expect((await service.getGoal(workspaceId))?.budgetLimitOriginKind).not.toBe("user");

    // The manual-message hook persists the suppression.
    await service.suppressBudgetWrapupForManualUserMessage(workspaceId, created.goalId);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitOriginKind: "user",
    });

    // Codex P2 (PRRT_kwDOPxxmWM6cKkGL): the suppression must also neutralize
    // the LIVE eligibility state — without touching the in-memory stream
    // stamp, the manual turn's accounting preserves the goal-attributable
    // stamp and its stream-end arms a candidate that dispatches the wrap-up
    // immediately, no restart required.
    const liveDispatcher = new IdleDispatcher();
    const liveExecuted: Array<{ kind: string | undefined }> = [];
    service.registerGoalContinuationConsumer(liveDispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        liveExecuted.push({ kind: input.kind });
        return Promise.resolve(true);
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });
    // The manual turn's own accounting preserves the existing budget_limited
    // stamp rather than overwriting it; its stream-end then requests a
    // continuation.
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.01,
      streamStartedAtMs: created.createdAtMs + 2,
      streamOriginKind: "user",
    });
    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: created.createdAtMs + 3,
    });
    await drainPendingDispatches();
    expect(liveExecuted).toHaveLength(0);

    // Simulate restart: recovery must honor the durable suppression.
    const restartedService = new WorkspaceGoalService(
      config,
      historyService,
      extensionMetadata,
      analytics
    );
    const dispatcher = new IdleDispatcher();
    const executed: Array<{ kind: string | undefined }> = [];
    restartedService.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        executed.push({ kind: input.kind });
        return Promise.resolve(true);
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });
    await restartedService.recoverPendingDispatchAfterRestart(workspaceId);
    await drainPendingDispatches();

    expect(executed).toHaveLength(0);
    expect(await restartedService.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: null,
      budgetLimitOriginKind: "user",
    });
  });

  test("a failed suppression write publishes no in-memory suppression", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cLA0M): the durable origin must persist
    // BEFORE the live stamp updates. If the write fails (disk full, transient
    // fs error), no in-memory suppression may exist — otherwise this process
    // suppresses the wrap-up while goal.json stays goal-attributable, and a
    // restart re-arms the autonomous wrap-up despite the manual intervention.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Suppression write fails",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    const serviceAccess = service as unknown as {
      writeGoal: (id: string, goal: GoalRecordV1) => Promise<void>;
      lastGoalStreamStamps: Map<string, { originKind: string }>;
    };
    expect(serviceAccess.lastGoalStreamStamps.get(workspaceId)?.originKind).toBe(
      "goal_continuation"
    );

    const writeSpy = spyOn(serviceAccess, "writeGoal").mockImplementationOnce(() =>
      Promise.reject(new Error("injected: suppression write lost"))
    );
    let threw = false;
    try {
      await service.suppressBudgetWrapupForManualUserMessage(workspaceId, created.goalId);
    } catch {
      threw = true;
    }
    writeSpy.mockRestore();
    expect(threw).toBe(true);

    // Fail closed: memory never got ahead of disk.
    expect(serviceAccess.lastGoalStreamStamps.get(workspaceId)?.originKind).toBe(
      "goal_continuation"
    );
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "budget_limited" });
    expect((await service.getGoal(workspaceId))?.budgetLimitOriginKind).not.toBe("user");

    // A retry (next manual message) succeeds and completes both halves.
    await service.suppressBudgetWrapupForManualUserMessage(workspaceId, created.goalId);
    expect(serviceAccess.lastGoalStreamStamps.get(workspaceId)?.originKind).toBe("user");
    expect(await service.getGoal(workspaceId)).toMatchObject({ budgetLimitOriginKind: "user" });
  });

  test("a failed snapshot publish after the suppression write still updates the live stamp", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cMpob): once writeGoal committed, the durable
    // record says the wrap-up is suppressed. If the follow-up snapshot publish
    // fails, the method throws — but the live stamp must ALREADY be
    // user-origin, or this process's stream-end arms and dispatches the
    // wrap-up off the stale goal-attributable stamp while goal.json says
    // "user".
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Snapshot publish fails",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    const serviceAccess = service as unknown as {
      pushSnapshot: (id: string, goal: GoalRecordV1 | null) => Promise<unknown>;
      lastGoalStreamStamps: Map<string, { originKind: string }>;
    };
    expect(serviceAccess.lastGoalStreamStamps.get(workspaceId)?.originKind).toBe(
      "goal_continuation"
    );

    const snapshotSpy = spyOn(serviceAccess, "pushSnapshot").mockImplementationOnce(() =>
      Promise.reject(new Error("injected: snapshot publish lost"))
    );
    let threw = false;
    try {
      await service.suppressBudgetWrapupForManualUserMessage(workspaceId, created.goalId);
    } catch {
      threw = true;
    }
    snapshotSpy.mockRestore();
    expect(threw).toBe(true);

    // Durable and live state agree: suppression is in effect.
    expect((await service.getGoal(workspaceId))?.budgetLimitOriginKind).toBe("user");
    expect(serviceAccess.lastGoalStreamStamps.get(workspaceId)?.originKind).toBe("user");
  });

  test("the wrap-up armer honors a durable suppression that completed under a stale record", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cMpoe): armBudgetWrapupForBudgetLimitedGoal
    // awaits kickoff options and the durable read unlocked, so a manual
    // suppression can complete in that window (modeled here by passing the
    // pre-suppression record). Without the durable origin recheck it would
    // overwrite the live user-origin stamp with goal_continuation and arm a
    // fresh candidate — resurrecting the wrap-up the suppression disarmed.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Armer vs suppression",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    const stale = await service.getGoal(workspaceId);
    expect(stale).toMatchObject({ status: "budget_limited" });

    // Registered after setup so no kickoff candidate exists — the armer must
    // fall through to its durable recheck rather than an earlier guard.
    const dispatcher = new IdleDispatcher();
    const executed: Array<{ kind: string | undefined }> = [];
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        executed.push({ kind: input.kind });
        return Promise.resolve(true);
      },
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await service.suppressBudgetWrapupForManualUserMessage(workspaceId, created.goalId);

    const serviceAccess = service as unknown as {
      armBudgetWrapupForBudgetLimitedGoal: (id: string, goal: GoalRecordV1) => Promise<void>;
      lastGoalStreamStamps: Map<string, { originKind: string }>;
      pendingContinuationCandidates: Map<string, unknown>;
    };
    await serviceAccess.armBudgetWrapupForBudgetLimitedGoal(workspaceId, stale!);
    await drainPendingDispatches();

    // The live suppression survives, no candidate was armed, nothing fired.
    expect(serviceAccess.lastGoalStreamStamps.get(workspaceId)?.originKind).toBe("user");
    expect(serviceAccess.pendingContinuationCandidates.has(workspaceId)).toBe(false);
    expect(executed).toHaveLength(0);
  });

  test("a stop landing inside the goal write restores the prior record", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cLpIP): a model complete_goal takes the
    // direct mutable branch during the live stream. The final pre-write stop
    // check can pass, then the Stop lands while writeGoal is replacing
    // goal.json; the stop's locked section queues behind the setter's tenure
    // and, seeing an already-complete goal, neither discards nor gates it.
    // The setter must recheck after the write and restore the prior record
    // before releasing the lock.
    const created = await setGoalOk(service, { workspaceId, objective: "Abort mid-write" });
    await extensionMetadata.setStreaming(workspaceId, true);

    const serviceAccess = service as unknown as {
      writeGoal: (id: string, goal: GoalRecordV1) => Promise<void>;
    };
    const realWrite = serviceAccess.writeGoal.bind(service);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted = false;
    const writeSpy = spyOn(serviceAccess, "writeGoal").mockImplementationOnce(
      async (id: string, goal: GoalRecordV1) => {
        writeStarted = true;
        await writeGate;
        return realWrite(id, goal);
      }
    );

    const completePromise = service.setGoal({
      workspaceId,
      status: "complete",
      completionSummary: "Done before the user could stop it",
      initiator: "model",
    });
    await waitForCondition(() => writeStarted, { timeoutMs: 5_000 });
    // Stop lands mid-write: generation bumps synchronously, locked section queues.
    const stopPromise = service.recordUserStoppedStream(workspaceId);
    releaseWrite();

    const completed = await completePromise;
    expect(completed.success).toBe(false);
    if (!completed.success) {
      expect(completed.error.type).toBe("invalid_transition");
    }
    await stopPromise;
    writeSpy.mockRestore();

    // Prior record restored; the stop's queued section then gated it normally.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "active",
    });
    expect(typeof (await service.getGoal(workspaceId))?.requireUserAcknowledgmentSinceMs).toBe(
      "number"
    );
  });

  test("a stop landing during the drain's persistence discards the claimed mutation", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cMGn8): recordUserStoppedStream invalidates a
    // queued mutation by deleting the pending-map entry, but the stream-end
    // drain claims (removes) it before persisting. A Stop landing while the
    // drain's locked persistence awaits I/O then has nothing left to delete —
    // the drain would durably archive/write the stopped turn's goal change and
    // the Stop merely acknowledgment-gates it. The claim must carry the stop
    // generation through persistence so the write is discarded and the prior
    // record survives.
    const original = await setGoalOk(service, { workspaceId, objective: "Original goal" });
    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({ workspaceId, objective: "Replacement mid-stream" });
    expect(queued.success).toBe(true);

    const serviceAccess = service as unknown as {
      writeGoal: (id: string, goal: GoalRecordV1) => Promise<void>;
      pendingGoalMutations: Map<string, { objective: string }>;
    };
    const realWrite = serviceAccess.writeGoal.bind(service);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted = false;
    const writeSpy = spyOn(serviceAccess, "writeGoal").mockImplementationOnce(
      async (id: string, goal: GoalRecordV1) => {
        writeStarted = true;
        await writeGate;
        return realWrite(id, goal);
      }
    );

    // The drain claims the mutation and parks inside the replacement write.
    const drainPromise = service.applyPendingAfterStreamEnd(workspaceId);
    await waitForCondition(() => writeStarted, { timeoutMs: 5_000 });
    // Stop lands mid-persistence: the pending-map entry is already claimed, so
    // only the generation recheck inside the drain's tenure can discard it.
    const stopPromise = service.recordUserStoppedStream(workspaceId);
    releaseWrite();

    const drained = await drainPromise;
    expect(drained).toBeNull();
    await stopPromise;
    writeSpy.mockRestore();

    // The aborted turn's replacement never became durable; the stop's queued
    // section gated the restored original instead.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: original.goalId,
      objective: "Original goal",
      status: "active",
    });
    expect(typeof (await service.getGoal(workspaceId))?.requireUserAcknowledgmentSinceMs).toBe(
      "number"
    );
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)).toBeUndefined();
  });

  test("a stop landing during a drained rename's write restores the prior record", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cMpoV): the editInPlace branch persists via
    // its own writeGoal and, unlike the same-objective and creation branches,
    // had no post-write stop recheck. A queued rename claimed by the
    // stream-end drain would keep the renamed record durable when the Stop
    // landed inside that write.
    const original = await setGoalOk(service, { workspaceId, objective: "Original name" });
    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({
      workspaceId,
      objective: "Renamed mid-stream",
      editInPlace: true,
    });
    expect(queued.success).toBe(true);

    const serviceAccess = service as unknown as {
      writeGoal: (id: string, goal: GoalRecordV1) => Promise<void>;
    };
    const realWrite = serviceAccess.writeGoal.bind(service);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted = false;
    const writeSpy = spyOn(serviceAccess, "writeGoal").mockImplementationOnce(
      async (id: string, goal: GoalRecordV1) => {
        writeStarted = true;
        await writeGate;
        return realWrite(id, goal);
      }
    );

    const drainPromise = service.applyPendingAfterStreamEnd(workspaceId);
    await waitForCondition(() => writeStarted, { timeoutMs: 5_000 });
    const stopPromise = service.recordUserStoppedStream(workspaceId);
    releaseWrite();

    const drained = await drainPromise;
    expect(drained).toBeNull();
    await stopPromise;
    writeSpy.mockRestore();

    // The rename never survived; the stop gated the restored original.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: original.goalId,
      objective: "Original name",
      status: "active",
    });
  });

  test("an explicit Resume during pause finalization survives the stale boundary", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cLpIT): a same-goal Resume can durably set the
    // goal active while the old pause finalizer is appending its boundary.
    // The boundary matches the goalId, so the finalizer's post-append
    // chat-tail sync (and any later reconciliation) would write the goal back
    // to paused — undoing the Resume. Durable-active + own scoped boundary
    // proves the Resume postdated the pause; it must win.
    const created = await setGoalOk(service, { workspaceId, objective: "Resume during pause" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: created.goalId,
    });

    // Gate the finalizer's boundary append; Resume lands inside the window.
    const realAppend = historyService.appendToHistory.bind(historyService);
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendStarted = false;
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementationOnce(
      async (id, message) => {
        appendStarted = true;
        await appendGate;
        return realAppend(id, message);
      }
    );

    const pausePromise = service.setGoal({ workspaceId, status: "paused" });
    await waitForCondition(() => appendStarted, { timeoutMs: 5_000 });
    const resumed = await service.setGoal({ workspaceId, status: "active" });
    expect(resumed.success).toBe(true);
    releaseAppend();
    await pausePromise;
    appendSpy.mockRestore();

    // The stale boundary sits at the tail, but the Resume wins — both in the
    // finalizer's own post-append sync and in later reconciliations.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "active",
    });
  });

  test("getGoal during pause finalization does not reactivate the goal being paused", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cIyKW): between the durable pause write and
    // the finalizer appending the goal-pause-boundary, the tail still ends at
    // the goal's own continuation row. A concurrent getGoal reconciliation
    // must not flip the goal back to active — that would make the finalizer's
    // identity guard bail (status drifted) and skip the candidate delete +
    // boundary append while the Pause call reports a stale paused result.
    const created = await setGoalOk(service, { workspaceId, objective: "Pause under load" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: created.goalId,
    });

    // Gate the finalizer's boundary append so the test can observe the window
    // while the pause hold is armed.
    const realAppend = historyService.appendToHistory.bind(historyService);
    let releaseBoundaryAppend!: () => void;
    const boundaryGate = new Promise<void>((resolve) => (releaseBoundaryAppend = resolve));
    let boundaryAppendStarted = false;
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementationOnce(
      async (id, message) => {
        boundaryAppendStarted = true;
        await boundaryGate;
        return realAppend(id, message);
      }
    );

    const pausePromise = service.setGoal({ workspaceId, status: "paused" });
    await waitForCondition(() => boundaryAppendStarted, { timeoutMs: 5_000 });

    // Mid-window: durable record is paused, boundary not yet in the tail.
    // Reconciliation must hold the pause instead of trusting the stale tail.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });

    releaseBoundaryAppend();
    const pauseResult = await pausePromise;
    expect(pauseResult.success).toBe(true);
    appendSpy.mockRestore();

    // Post-finalization: the boundary landed, so the pause is durable against
    // reconciliation without the in-memory hold.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });
  });

  test("an admitted continuation firing mid-pause-finalization does not undo the pause", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cMQqq): a goal continuation already admitted
    // (dispatch accepted) calls recordContinuationFired while an explicit
    // Pause is finalizing. The tail still ends at the goal's own continuation
    // row (boundary append in flight), so the paused→active acceptance would
    // flip the goal back — and once the scoped boundary lands, the
    // Resume-wins rule preserves that automatic flip as if the user resumed.
    // The firing must honor the pause-finalization hold.
    const created = await setGoalOk(service, { workspaceId, objective: "Pause vs continuation" });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: created.goalId,
    });

    // Gate the finalizer's boundary append so the firing runs mid-window.
    const realAppend = historyService.appendToHistory.bind(historyService);
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appendStarted = false;
    const appendSpy = spyOn(historyService, "appendToHistory").mockImplementationOnce(
      async (id, message) => {
        appendStarted = true;
        await appendGate;
        return realAppend(id, message);
      }
    );

    const pausePromise = service.setGoal({ workspaceId, status: "paused" });
    await waitForCondition(() => appendStarted, { timeoutMs: 5_000 });

    // Mid-window: the admitted continuation fires. Without the hold check it
    // would flip the paused goal back to active on "tail says active" evidence.
    const serviceAccess = service as unknown as {
      recordContinuationFired: (id: string, goalId: string, firedAtMs: number) => Promise<void>;
    };
    await serviceAccess.recordContinuationFired(workspaceId, created.goalId, Date.now());

    releaseAppend();
    const pauseResult = await pausePromise;
    expect(pauseResult.success).toBe(true);
    appendSpy.mockRestore();

    // The Pause wins — durably and against later reconciliation.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });
  });

  test("a continuation fired against pre-pause tail evidence does not reactivate the goal", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cMQqq): recordContinuationFired reads the
    // chat tail outside the goal lock. An explicit Pause can fully commit
    // (durable write, scoped boundary append, hold release) between that read
    // and the locked apply — the stale "tail says active" evidence must not
    // flip the paused goal back to active, because the scoped boundary at the
    // tail would then make the Resume-wins rule preserve the flip durably.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Stale-read continuation",
    });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: created.goalId,
    });

    // One-shot: the real tail read completes first (pre-pause evidence), then
    // the full explicit Pause commits before the caller's locked section.
    const serviceAccess = service as unknown as {
      readChatTailGoalMode: (id: string, goalId?: string | null) => Promise<unknown>;
      recordContinuationFired: (id: string, goalId: string, firedAtMs: number) => Promise<void>;
    };
    const realRead = serviceAccess.readChatTailGoalMode.bind(service);
    serviceAccess.readChatTailGoalMode = async (id: string, goalId?: string | null) => {
      const evidence = await realRead(id, goalId);
      // Restore before pausing: the pause's own finalization reads the tail.
      serviceAccess.readChatTailGoalMode = realRead;
      const paused = await service.setGoal({ workspaceId, status: "paused" });
      expect(paused.success).toBe(true);
      return evidence;
    };

    await serviceAccess.recordContinuationFired(workspaceId, created.goalId, Date.now());

    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });
  });

  test("reconciliation with pre-pause tail evidence does not reactivate an explicitly paused goal", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cMQqq): syncGoalStatusToChatTail shares the
    // unlocked-tail-read shape, and its in-flight hold check cannot see a
    // Pause that fully committed between the read and the locked apply. The
    // generation stamp must refuse the stale continuation-row evidence.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Stale-read reconciliation",
    });
    await appendUserHistoryMessage(historyService, workspaceId, "Continue working on the goal.", {
      timestamp: Date.now(),
      synthetic: true,
      kind: "goal_continuation",
      goalId: created.goalId,
    });

    const serviceAccess = service as unknown as {
      readChatTailGoalMode: (id: string, goalId?: string | null) => Promise<unknown>;
    };
    const realRead = serviceAccess.readChatTailGoalMode.bind(service);
    serviceAccess.readChatTailGoalMode = async (id: string, goalId?: string | null) => {
      const evidence = await realRead(id, goalId);
      serviceAccess.readChatTailGoalMode = realRead;
      const paused = await service.setGoal({ workspaceId, status: "paused" });
      expect(paused.success).toBe(true);
      return evidence;
    };

    // A routine read (heartbeat / tool assembly) reconciles with the stale
    // evidence — the explicit Pause must win, now and on the next clean read.
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: created.goalId,
      status: "paused",
    });
  });

  test("cost previews reset when the goal becomes ineligible for accounting mid-stream", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cEl4P): a status transition during the stream
    // (pause, complete, or a budget edit flipping the goal budget_limited)
    // makes further previews ineligible. The cached live preview must be
    // cleared and the durable snapshot published — otherwise
    // pushLiveGoalPreviewOverlay keeps re-emitting cost that final accounting
    // discards, and the Goal UI snaps backward only at stream end.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Preview reset",
      budgetCents: 500,
    });
    await service.previewStreamAccounting({
      workspaceId,
      costUsd: 0.5,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "other",
    });
    const previews = (service as unknown as { liveGoalPreviewSnapshots: Map<string, unknown> })
      .liveGoalPreviewSnapshots;
    expect(previews.has(workspaceId)).toBe(true);

    // Mid-stream pause makes the next delta ineligible.
    await setGoalOk(service, { workspaceId, status: "paused" });
    const snapshots = captureGoalActivity(service);
    const returned = await service.previewStreamAccounting({
      workspaceId,
      costUsd: 0.6,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "other",
    });

    expect(previews.has(workspaceId)).toBe(false);
    // The durable record (no accounted cost) is what gets published and
    // returned — not the discarded preview cost.
    expect(returned?.costCents).toBe(0);
    expect(snapshots.at(-1)?.goal?.costCents).toBe(0);
  });

  test("restoring a suspended kickoff candidate is dropped when the goal was paused meanwhile", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cErQ7): kickoff eligibility deliberately
    // accepts paused goals (the durable kickoff window), so restoring a
    // suspended candidate after a concurrent Pause persisted would reactivate
    // the autonomous loop despite the pause. The restore must verify the goal
    // is still active under the goal file lock.
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: true }),
      executeGoalContinuation: () => Promise.resolve(true),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });
    await setGoalOk(service, { workspaceId, objective: "Fresh goal" });
    const candidates = (
      service as unknown as { pendingContinuationCandidates: Map<string, unknown> }
    ).pendingContinuationCandidates;
    expect(candidates.has(workspaceId)).toBe(true);

    const suspended = service.takePendingContinuationCandidateForManualUserMessage(workspaceId);
    expect(suspended).not.toBeNull();
    if (!suspended) {
      throw new Error("expected a suspended candidate");
    }
    // The user pauses while the manual send is being classified.
    await setGoalOk(service, { workspaceId, status: "paused" });

    await service.restorePendingContinuationCandidate(workspaceId, suspended);
    expect(candidates.has(workspaceId)).toBe(false);
  });

  test("stale pause finalization does not pause a newer replacement goal", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cECpZ): pause finalization runs outside the
    // goal file lock — a replacement queued behind the pause's persist can
    // land before the pause's finalization resumes. The stale pause must not
    // delete the newer goal's kickoff candidate or append a pause boundary
    // that chat-tail sync applies to the newer goal.
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      // Busy runtime keeps armed candidates inspectable (not consumed).
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: true }),
      executeGoalContinuation: () => Promise.resolve(true),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });
    const goalA = await setGoalOk(service, { workspaceId, objective: "Goal A" });
    const goalB = await setGoalOk(service, { workspaceId, objective: "Goal B" });

    // Replay goal A's pause finalization as if its setter resumed only after
    // B replaced A (MutexMap admitted B between A's persist and finalize).
    const internals = service as unknown as {
      finalizeGoalPersistence: (
        input: { workspaceId: string; status: GoalStatus },
        result: { success: true; data: GoalRecordV1 }
      ) => Promise<unknown>;
      pendingContinuationCandidates: Map<string, { goalId: string }>;
    };
    await internals.finalizeGoalPersistence(
      { workspaceId, status: "paused" },
      { success: true, data: { ...goalA, status: "paused" } }
    );

    expect(internals.pendingContinuationCandidates.get(workspaceId)?.goalId).toBe(goalB.goalId);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: goalB.goalId,
      status: "active",
    });
    const history = await historyService.getLastMessages(workspaceId, 20);
    expect(history.success).toBe(true);
    if (history.success) {
      const boundaryRows = history.data.filter(
        (message) => message.metadata?.muxMetadata?.type === "goal-pause-boundary"
      );
      expect(boundaryRows).toHaveLength(0);
    }
  });

  test("acknowledgeUser ignores messages authored before the acknowledgment gate", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6cECpj): a send authored before a user stop
    // set the acknowledgment gate cannot acknowledge that stop — clearing the
    // durable gate would let restart recovery re-arm the goal despite the
    // newer Stop action.
    const created = await setGoalOk(service, { workspaceId, objective: "Gated goal" });
    await service.recordUserStoppedStream(workspaceId, created.createdAtMs + 5_000);
    const gated = await service.getGoal(workspaceId);
    expect(gated?.requireUserAcknowledgmentSinceMs).not.toBeNull();

    // Authored before the stop: the gate must survive.
    const afterStale = await service.acknowledgeUser(workspaceId, {
      authoredAtMs: created.createdAtMs + 1_000,
    });
    expect(afterStale?.requireUserAcknowledgmentSinceMs).not.toBeNull();

    // Codex P1 (PRRT_kwDOPxxmWM6cHJVn): same-millisecond authoring cannot
    // prove the send was admitted after the Stop — equality keeps the gate.
    const afterEqual = await service.acknowledgeUser(workspaceId, {
      authoredAtMs: created.createdAtMs + 5_000,
    });
    expect(afterEqual?.requireUserAcknowledgmentSinceMs).not.toBeNull();

    // Authored after the stop: an informed user action clears the gate.
    const afterFresh = await service.acknowledgeUser(workspaceId, {
      authoredAtMs: created.createdAtMs + 6_000,
    });
    expect(afterFresh?.requireUserAcknowledgmentSinceMs).toBeNull();
  });

  test("a stale kickoff finalizer does not overwrite a newer goal's candidate", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cClKY): kickoff finalization runs outside the
    // goal file lock. While finalizer A awaits kickoff options, a newer setter
    // B can persist directly and arm B's kickoff; A resuming afterwards must
    // not replace B's candidate with a stale one that eligibility would drop
    // for goal-ID mismatch — that would strand durable goal B with no kickoff.
    const dispatcher = new IdleDispatcher();
    let kickoffCalls = 0;
    let releaseFirstKickoff!: () => void;
    const firstKickoffGate = new Promise<void>((resolve) => {
      releaseFirstKickoff = resolve;
    });
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      // Busy runtime keeps eligibility deferring so armed candidates stay
      // inspectable instead of being consumed by a live dispatch.
      getRuntimeState: () => ({ isRuntimeCompatible: true, isBusy: true }),
      executeGoalContinuation: () => Promise.resolve(true),
      getKickoffSendOptions: async () => {
        kickoffCalls += 1;
        if (kickoffCalls === 1) {
          await firstKickoffGate;
        }
        return { model: "openai:gpt-4o", agentId: "exec" };
      },
    });

    const setterAPromise = service.setGoal({ workspaceId, objective: "Stale finalizer goal A" });
    await waitForCondition(() => kickoffCalls === 1, { timeoutMs: 1_000 });
    // B persists and arms its kickoff while A's finalizer is still suspended.
    const goalB = await setGoalOk(service, { workspaceId, objective: "Newer goal B" });
    releaseFirstKickoff();
    const setterA = await setterAPromise;
    expect(setterA.success).toBe(true);

    const candidates = (
      service as unknown as {
        pendingContinuationCandidates: Map<string, { goalId: string }>;
      }
    ).pendingContinuationCandidates;
    expect(candidates.get(workspaceId)?.goalId).toBe(goalB.goalId);
  });

  test("stream-end drain racing publication persists the publication stamp", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6b_KgE): the stream can end while the queued
    // setter is still inside its publication await. The drain used to take the
    // mutation synchronously — outside the goal file lock — and persist the
    // pre-publication construction stamp, so a message authored during the
    // publication await was misclassified as a post-goal intervention. The
    // locked handoff must flush the setter first and drain the finalized
    // publication stamp.
    await extensionMetadata.setStreaming(workspaceId, true);
    const drainPromises: Array<Promise<GoalRecordV1 | null>> = [];
    let fireDrains = false;
    let lastActivityReadMs = 0;
    const originalGetSnapshot = extensionMetadata.getSnapshot.bind(extensionMetadata);
    spyOn(extensionMetadata, "getSnapshot").mockImplementation(async (id: string) => {
      const snapshot = await originalGetSnapshot(id);
      if (fireDrains && drainPromises.length < 8) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        lastActivityReadMs = Date.now();
        // Simulate the stream ending during this await: the stream-end drain
        // races the setter that still holds the goal file lock. The drain
        // fired during the publication read is the regression case; earlier
        // fires see an empty mutation map and no-op.
        drainPromises.push(service.applyPendingAfterStreamEnd(workspaceId));
      }
      return snapshot;
    });

    fireDrains = true;
    const queued = await service.setGoal({
      workspaceId,
      objective: "Publication stamp handoff",
    });
    fireDrains = false;
    expect(queued.success).toBe(true);
    expect(drainPromises.length).toBeGreaterThan(0);
    await Promise.all(drainPromises);

    const persisted = await service.getGoal(workspaceId);
    expect(persisted).not.toBeNull();
    // The drain must persist the post-publication stamp, not the construction
    // stamp taken before the publication activity read.
    expect(persisted?.createdAtMs ?? -1).toBeGreaterThanOrEqual(lastActivityReadMs);
  });

  test("drain loops to persist a replacement mutation installed between claim and persistence", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cAl6e): the drain's claim and its persistence
    // run in separate lock tenures, and a setter interleaving between them can
    // still see the ended stream as live (async streaming=false update) and
    // install a NEWER mutation expecting a stream-end drain that would never
    // come. The drain must loop so the replacement is persisted too — a
    // single-pass drain persists the older mutation and strands the newer one.
    await extensionMetadata.setStreaming(workspaceId, true);
    const first = await setGoalOk(service, { workspaceId, objective: "First goal" });

    const serviceAccess = service as unknown as {
      fileLocks: { withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T> };
      pendingGoalMutations: Map<string, unknown>;
    };
    // Hold the goal file lock with a gate so lock-queue order is
    // deterministic: [gate] -> drain claim -> replacement setter -> drain
    // persistence. The replacement setter therefore provably lands between
    // the drain's claim and its persistence tenure.
    //
    // Codex P2 (PRRT_kwDOPxxmWM6cGSPX): count lock admissions instead of
    // sleeping — the replacement setter's asynchronous pre-lock streaming
    // check has no time bound on a loaded worker, and releasing the gate
    // before it enqueues would let the drain settle first and fail the
    // `drained` assertion spuriously.
    let lockCalls = 0;
    const originalWithLock = serviceAccess.fileLocks.withLock.bind(serviceAccess.fileLocks);
    serviceAccess.fileLocks.withLock = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
      lockCalls += 1;
      return originalWithLock(key, fn);
    };
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gateTenure = serviceAccess.fileLocks.withLock(workspaceId, () => gate);

    // Queues the claim tenure behind the gate synchronously (the unlocked
    // fast-path check and withLock call run before the first await).
    const drainPromise = service.applyPendingAfterStreamEnd(workspaceId);
    const replacementPromise = service.setGoal({
      workspaceId,
      objective: "Replacement goal",
      forceNewGoal: true,
      // Codex P2 (PRRT_kwDOPxxmWM6cBACj): the replacement targets the goal
      // the user sees — the first mutation's projected id. Because each drain
      // pass claims AND persists in one lock tenure, that id is already
      // durable when this setter validates, and the accepted guard stays
      // coherent when the drain replays this mutation on the next pass.
      expectedGoalId: first.goalId,
    });
    // Deterministic admission signal: gate (1), drain claim (2), replacement
    // setter (3). Only then may the gate open.
    await waitForCondition(() => lockCalls >= 3, { timeoutMs: 5_000 });
    releaseGate();
    await gateTenure;

    const [drained, replacement] = await Promise.all([drainPromise, replacementPromise]);

    expect(replacement.success).toBe(true);
    expect(drained).toMatchObject({ objective: "Replacement goal" });
    // Nothing may be left stranded for a stream-end hook that will not come.
    expect(serviceAccess.pendingGoalMutations.get(workspaceId)).toBeUndefined();
  });

  test("queued mid-stream goal replacement preserves expectedGoalId at drain time", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Original" });
    await extensionMetadata.setStreaming(workspaceId, true);

    const queued = await service.setGoal({
      workspaceId,
      objective: "Queued replacement",
      expectedGoalId: created.goalId,
    });
    expect(queued.success).toBe(true);

    await extensionMetadata.setStreaming(workspaceId, false);
    await setGoalOk(service, { workspaceId, objective: "Concurrent replacement" });

    const drained = await service.applyPendingAfterStreamEnd(workspaceId);

    expect(drained).toBeNull();
    expect(await service.getGoal(workspaceId)).toMatchObject({
      objective: "Concurrent replacement",
    });
  });
});
