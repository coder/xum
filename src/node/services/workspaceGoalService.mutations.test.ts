import * as path from "path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import type { Config } from "@/node/config";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { WorkspaceGoalService } from "./workspaceGoalService";
import { IdleDispatcher } from "./idleDispatcher";
import { createTestHistoryService } from "./testHistoryService";
import type { HistoryService } from "./historyService";
import type { GoalRecordV1, GoalStatus } from "@/common/types/goal";
import { waitForCondition } from "./testDispatchHelpers";
import {
  captureGoalActivity,
  setGoalOk,
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

  test("replaces different objective with a new goal id and reset accounting", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "First objective" });
    await fs.writeFile(
      path.join(config.sessionsDir, workspaceId, "goal.json"),
      JSON.stringify({ ...created, costCents: 123, turnsUsed: 4 })
    );

    const replaced = await setGoalOk(service, { workspaceId, objective: "Second objective" });

    expect(replaced.goalId).not.toBe(created.goalId);
    expect(replaced.costCents).toBe(0);
    expect(replaced.turnsUsed).toBe(0);
    expect(replaced.objective).toBe("Second objective");
  });

  test("allows writes when expectedGoalId matches the current goal", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Concurrent goal" });

    const result = await service.setGoal({
      workspaceId,
      status: "paused",
      expectedGoalId: created.goalId,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`Expected matching goalId write to succeed: ${JSON.stringify(result.error)}`);
    }
    expect(result.data).toMatchObject({ goalId: created.goalId, status: "paused" });
  });

  test("returns a typed conflict when expectedGoalId explicitly expects no goal", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "existing" });

    const result = await service.setGoal({
      workspaceId,
      objective: "new",
      expectedGoalId: null,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toEqual({
        type: "goal_conflict",
        expectedGoalId: null,
        actualGoalId: created.goalId,
      });
    }
  });

  test("returns a typed conflict when expectedGoalId does not match", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Original goal" });
    const replaced = await setGoalOk(service, { workspaceId, objective: "Replacement goal" });

    const result = await service.setGoal({
      workspaceId,
      status: "paused",
      expectedGoalId: created.goalId,
    });

    expect(result).toEqual({
      success: false,
      error: {
        type: "goal_conflict",
        expectedGoalId: created.goalId,
        actualGoalId: replaced.goalId,
      },
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({
      goalId: replaced.goalId,
      status: "active",
    });
  });

  test("uses last-writer-wins when expectedGoalId is omitted", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "First goal" });

    const result = await service.setGoal({ workspaceId, objective: "Last writer goal" });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`Expected omitted goalId write to succeed: ${JSON.stringify(result.error)}`);
    }
    expect(result.data.goalId).not.toBe(created.goalId);
    expect(result.data.objective).toBe("Last writer goal");
  });

  test("resolves concurrent expectedGoalId writes with one success and one conflict", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Race origin" });

    const results = await Promise.all([
      service.setGoal({
        workspaceId,
        objective: "Race winner A",
        expectedGoalId: created.goalId,
      }),
      service.setGoal({
        workspaceId,
        objective: "Race winner B",
        expectedGoalId: created.goalId,
      }),
    ]);

    const successes = results.filter((result) => result.success);
    const conflicts = results.filter((result) => !result.success);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual({
      success: false,
      error: {
        type: "goal_conflict",
        expectedGoalId: created.goalId,
        actualGoalId: successes[0]?.success ? successes[0].data.goalId : null,
      },
    });
  });

  test("rejects child workspaces", async () => {
    const childWorkspaceId = "goal-child";
    await config.addWorkspace(PROJECT_PATH, {
      id: childWorkspaceId,
      name: "child",
      projectName: "mux-goal-service-test-project",
      projectPath: PROJECT_PATH,
      runtimeConfig: { type: "local" },
      parentWorkspaceId: workspaceId,
    });

    // setGoal now catches WorkspaceGoalChildWorkspaceError and
    // returns it as a typed Result error so the oRPC handler doesn't leak
    // it as an unhandled 500.
    const result = await service.setGoal({
      workspaceId: childWorkspaceId,
      objective: "child goal",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("child_workspace");
    }
  });

  for (const sourceStatus of [
    "active",
    "paused",
    "budget_limited",
    "complete",
  ] satisfies GoalStatus[]) {
    test(`inherits ${sourceStatus} goal into a paused fork with fresh accounting`, async () => {
      const forkWorkspaceId = `goal-fork-${sourceStatus}`;
      await config.addWorkspace(PROJECT_PATH, {
        id: forkWorkspaceId,
        name: `fork-${sourceStatus}`,
        projectName: "mux-goal-service-test-project",
        projectPath: PROJECT_PATH,
        runtimeConfig: { type: "local" },
      });

      let parent = await setGoalOk(service, {
        workspaceId,
        objective: "Ship inherited goal",
        budgetCents: 500,
        turnCap: 7,
      });
      if (sourceStatus === "paused") {
        parent = await setGoalOk(service, { workspaceId, status: "paused" });
      } else if (sourceStatus === "budget_limited") {
        parent = await setGoalOk(service, { workspaceId, status: "budget_limited" });
      } else if (sourceStatus === "complete") {
        parent = await setGoalOk(service, {
          workspaceId,
          status: "complete",
          completionSummary: "Done in the parent.",
        });
      }
      const parentWithAccounting: GoalRecordV1 = {
        ...parent,
        costCents: 123,
        turnsUsed: 4,
        attributedChildren: ["child-a"],
        budgetLimitInjectedForGoalId: parent.goalId,
        requireUserAcknowledgmentSinceMs: parent.createdAtMs + 1,
      };
      await fs.writeFile(
        path.join(config.sessionsDir, workspaceId, "goal.json"),
        `${JSON.stringify(parentWithAccounting, null, 2)}\n`
      );

      const beforeInheritMs = Date.now();
      const inherited = await service.inheritFromFork(workspaceId, forkWorkspaceId);
      const afterInheritMs = Date.now();

      expect(inherited).toMatchObject({
        objective: "Ship inherited goal",
        budgetCents: 500,
        turnCap: 7,
        status: "paused",
        costCents: 0,
        turnsUsed: 0,
        attributedChildren: [],
        budgetLimitInjectedForGoalId: null,
        requireUserAcknowledgmentSinceMs: null,
      });
      expect(inherited?.goalId).not.toBe(parent.goalId);
      expect(inherited?.completionSummary).toBeUndefined();
      expect(inherited?.createdAtMs).toBeGreaterThanOrEqual(beforeInheritMs);
      expect(inherited?.updatedAtMs).toBe(inherited?.createdAtMs);
      expect(inherited?.updatedAtMs).toBeLessThanOrEqual(afterInheritMs);
      expect(await service.getGoal(forkWorkspaceId)).toEqual(inherited);
      expect(await service.getGoal(workspaceId)).toEqual(parentWithAccounting);
      expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
        "goal_created",
        expect.objectContaining({ viaFork: true, hasBudget: true, hasTurnCap: true })
      );
    });
  }

  test("leaves a fork goal-less when the parent has no goal", async () => {
    const forkWorkspaceId = "goal-fork-empty";
    await config.addWorkspace(PROJECT_PATH, {
      id: forkWorkspaceId,
      name: "fork-empty",
      projectName: "mux-goal-service-test-project",
      projectPath: PROJECT_PATH,
      runtimeConfig: { type: "local" },
    });

    const inherited = await service.inheritFromFork(workspaceId, forkWorkspaceId);

    expect(inherited).toBeNull();
    expect(await goalFileExists(config, forkWorkspaceId)).toBe(false);
  });

  test("renames corrupt goal file and treats workspace as having no goal", async () => {
    const sessionDir = path.join(config.sessionsDir, workspaceId);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "goal.json"), "{ not json");

    expect(await service.getGoal(workspaceId)).toBeNull();

    const files = await fs.readdir(sessionDir);
    expect(files.some((file) => /^goal\.json\.corrupt-\d+$/.test(file))).toBe(true);
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({ goal: null });
  });

  test("applyPendingAfterStreamEnd swallows invalid-transition rejections instead of crashing the process", async () => {
    // the stream-abort / stream-end /
    // error listeners in WorkspaceService invoke this method via `void`. If
    // a queued mutation triggered a transition error inside
    // setGoalImmediately, it would surface as an unhandled-rejection
    // process crash under `--unhandled-rejections=throw`. The fix wraps the
    // call in try/catch and logs+returns null so the pipeline stays alive.
    const original = await setGoalOk(service, { workspaceId, objective: "Original" });
    await setGoalOk(service, { workspaceId, status: "paused" });

    // Seed a queued no-op pause against an already-paused goal. Draining this
    // throws `WorkspaceGoalTransitionError` inside
    // `validateStatusTransition("paused", "paused", null)`, which is the
    // stream-end failure mode this regression test cares about. Seeding the
    // queue directly keeps this test focused on drain behavior instead of the
    // streaming projection rules that now reject this invalid transition sooner.
    const serviceAccess = service as unknown as {
      pendingGoalMutations: Map<
        string,
        { objective: string; status: GoalStatus; projectedGoalId?: string | null }
      >;
    };
    serviceAccess.pendingGoalMutations.set(workspaceId, {
      objective: "Original",
      status: "paused",
      projectedGoalId: original.goalId,
    });

    // Without the fix, this rejection would propagate out of the async
    // function and crash. With the fix, it returns null and the goal
    // record is unchanged.
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);
    expect(drained).toBeNull();
    expect(await service.getGoal(workspaceId)).toMatchObject({
      objective: "Original",
      status: "paused",
    });
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { goalId: original.goalId, objective: "Original", status: "paused" },
    });
  });

  test("queues mid-stream objective changes and drains them after stream end", async () => {
    await extensionMetadata.setStreaming(workspaceId, true);

    const activityUpdates = captureGoalActivity(service);

    const projected = await setGoalOk(service, { workspaceId, objective: "Queued goal" });

    expect(projected.objective).toBe("Queued goal");
    // Mid-stream goals are not durable until stream accounting drains, but the
    // activity snapshot feeds the Goal panel and should update immediately.
    expect(activityUpdates.at(-1)).toMatchObject({
      goal: { goalId: projected.goalId, objective: "Queued goal", pendingPersistence: true },
    });
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({ goal: null });
    expect(await service.getGoal(workspaceId)).toBeNull();
    expect(activityUpdates.at(-1)).toMatchObject({
      goal: { goalId: projected.goalId, objective: "Queued goal", pendingPersistence: true },
    });
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({ goal: null });

    await extensionMetadata.setStreaming(workspaceId, false);
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);

    expect(drained?.objective).toBe("Queued goal");
    expect(await service.getGoal(workspaceId)).toMatchObject({ objective: "Queued goal" });
    const drainedSnapshot = await extensionMetadata.getSnapshot(workspaceId);
    expect(drainedSnapshot).toMatchObject({
      goal: { goalId: drained?.goalId, objective: "Queued goal" },
    });
    expect(drainedSnapshot?.goal?.pendingPersistence).toBeUndefined();
  });

  test("rejects follow-up mutations while a mid-stream goal snapshot is pending", async () => {
    await extensionMetadata.setStreaming(workspaceId, true);
    const activityUpdates = captureGoalActivity(service);

    const queued = await service.setGoal({ workspaceId, objective: "Queued goal" });
    expect(queued.success).toBe(true);
    expect(activityUpdates.at(-1)).toMatchObject({
      goal: { objective: "Queued goal", pendingPersistence: true },
    });

    const budgetResult = await service.setGoal({ workspaceId, budgetCents: 500 });
    expect(budgetResult.success).toBe(false);
    if (!budgetResult.success) {
      expect(budgetResult.error).toMatchObject({ type: "invalid_transition" });
    }
    expect(await service.getGoal(workspaceId)).toBeNull();
    expect(await service.previewStreamAccounting({ workspaceId, costUsd: 1 })).toMatchObject({
      objective: "Queued goal",
      pendingPersistence: true,
    });
  });

  test("previewStreamAccounting skips the durable fallback when the strict baseline read is unavailable", async () => {
    // "unavailable" (failed sidecar reconcile) must stay distinct from the
    // authoritative "no baseline": the durable pushSnapshot fallback writes
    // through the lenient load — accepting the suspect partial main the
    // strict read refused — and emits it, clearing renderer goal/status
    // state. The preview must resolve without delivering or writing.
    await setGoalOk(service, { workspaceId, objective: "Preview goal" });
    const metadataFilePath = path.join(config.rootDir, "extensionMetadata.json");
    const before = await fs.readFile(metadataFilePath, "utf-8");
    // A directory at the sidecar path yields a deterministic errno (EISDIR)
    // standing in for EACCES/EIO-class reconcile failures.
    await fs.mkdir(`${metadataFilePath}.corrupt`);
    try {
      const activityUpdates = captureGoalActivity(service);

      const preview = await service.previewStreamAccounting({ workspaceId, costUsd: 1 });

      expect(preview).toMatchObject({ objective: "Preview goal" });
      // No emit (renderer keeps last-known state) and no durable write.
      expect(activityUpdates).toHaveLength(0);
      expect(await fs.readFile(metadataFilePath, "utf-8")).toBe(before);
    } finally {
      await fs.rm(`${metadataFilePath}.corrupt`, { recursive: true });
    }
  });

  test("successful no-op queued drains clear the pending snapshot", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Existing goal" });
    await extensionMetadata.setStreaming(workspaceId, true);

    const activityUpdates = captureGoalActivity(service);
    const queued = await service.setGoal({ workspaceId, objective: "Existing goal" });
    expect(queued.success).toBe(true);
    expect(activityUpdates.at(-1)).toMatchObject({
      goal: { objective: "Existing goal", pendingPersistence: true },
    });

    await extensionMetadata.setStreaming(workspaceId, false);
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);

    expect(drained?.goalId).toBe(created.goalId);
    const snapshot = await extensionMetadata.getSnapshot(workspaceId);
    expect(snapshot).toMatchObject({
      goal: { goalId: created.goalId, objective: "Existing goal" },
    });
    expect(snapshot?.goal?.pendingPersistence).toBeUndefined();
  });

  test("user stop clears queued mid-stream goal snapshot with no persisted goal", async () => {
    await extensionMetadata.setStreaming(workspaceId, true);

    const activityUpdates = captureGoalActivity(service);
    const projected = await setGoalOk(service, { workspaceId, objective: "Dropped kickoff goal" });
    expect(activityUpdates.at(-1)).toMatchObject({
      goal: {
        goalId: projected.goalId,
        objective: "Dropped kickoff goal",
        pendingPersistence: true,
      },
    });
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({ goal: null });

    await service.recordUserStoppedStream(workspaceId, projected.createdAtMs + 5_000);

    expect(await service.applyPendingAfterStreamEnd(workspaceId)).toBeNull();
    expect(await service.getGoal(workspaceId)).toBeNull();
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({ goal: null });
  });

  test("rejects queued mid-stream budgeted goals when kickoff model has no pricing", async () => {
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(),
      getKickoffSendOptions: () =>
        Promise.resolve({ model: "custom:unpriced-model", agentId: "exec" }),
    });
    await extensionMetadata.setStreaming(workspaceId, true);

    const result = await service.setGoal({
      workspaceId,
      objective: "Queued budgeted goal",
      budgetCents: 500,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatchObject({ type: "invalid_transition" });
    }
    await extensionMetadata.setStreaming(workspaceId, false);
    expect(await service.applyPendingAfterStreamEnd(workspaceId)).toBeNull();
    expect(await service.getGoal(workspaceId)).toBeNull();
  });

  test("model set_goal prices and kicks off on the invoking turn's model, not the persisted one", async () => {
    // Regression: set_goal checked only the workspace's persisted kickoff
    // model. A turn running a priced model that differs from the persisted
    // default (one-shot model sends, delegated turns) was rejected with
    // "invalid_transition: Target model has no pricing data".
    const dispatcher = new IdleDispatcher();
    const executedModels: string[] = [];
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge((input) => {
        executedModels.push(input.options.model);
        return Promise.resolve(true);
      }),
      getKickoffSendOptions: () =>
        Promise.resolve({ model: "custom:unpriced-model", agentId: "exec" }),
    });
    await extensionMetadata.setStreaming(workspaceId, true);

    const queued = await service.setGoal({
      workspaceId,
      objective: "Model-created budgeted goal",
      status: "active",
      budgetCents: 500,
      initiator: "model",
      forceNewGoal: true,
      kickoffModel: "openai:gpt-4o",
    });
    expect(queued.success).toBe(true);

    await extensionMetadata.setStreaming(workspaceId, false);
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);
    expect(drained).toMatchObject({ objective: "Model-created budgeted goal", status: "active" });

    // The kickoff continuation must run on the turn's priced model; the
    // persisted unpriced model would be rejected by the send-time pricing gate.
    await waitForCondition(() => executedModels.length > 0, { timeoutMs: 1_000 });
    expect(executedModels).toEqual(["openai:gpt-4o"]);
  });

  test("model set_goal still rejects when the invoking turn's model is unpriced", async () => {
    const dispatcher = new IdleDispatcher();
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(),
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    const result = await service.setGoal({
      workspaceId,
      objective: "Unpriced turn goal",
      status: "active",
      budgetCents: 500,
      initiator: "model",
      forceNewGoal: true,
      kickoffModel: "custom:unpriced-model",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatchObject({ type: "invalid_transition" });
    }
    expect(await service.getGoal(workspaceId)).toBeNull();
  });

  test("mid-stream editInPlace rename returns an optimistic snapshot that preserves goalId + accounting", async () => {
    // When an editInPlace rename arrives mid-stream, the
    // projected snapshot returned to the UI is what the Goal tab reads
    // until stream end drains the queued mutation. Building it via
    // `createGoal` (the pre-fix behavior) would flash a brand-new id +
    // zero cost/turns + cleared budget for the duration of the stream,
    // even though the persisted mutation will rename in place. Mirror
    // the drain semantics here: overlay the rename onto the current
    // record.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Original objective",
      budgetCents: 500,
      turnCap: 7,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "user",
    });

    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({
      workspaceId,
      objective: "Renamed objective",
      editInPlace: true,
      expectedGoalId: created.goalId,
    });
    expect(queued.success).toBe(true);
    if (queued.success) {
      expect(queued.data.goalId).toBe(created.goalId);
      expect(queued.data.objective).toBe("Renamed objective");
      expect(queued.data.costCents).toBe(25);
      expect(queued.data.budgetCents).toBe(500);
      expect(queued.data.turnCap).toBe(7);
    }
  });

  test("mid-stream editInPlace optimistic snapshot reflects budget_limited when new budget is below accrued cost", async () => {
    // A rename that lowers `budgetCents` below the already-accrued cost
    // must publish the same budget-driven status the stream-end drain will
    // persist.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Original objective",
      budgetCents: 500,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.5, // 150¢, well above the tightening 50¢ target below
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "user",
    });

    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({
      workspaceId,
      objective: "Renamed + tighter budget",
      editInPlace: true,
      expectedGoalId: created.goalId,
      budgetCents: 50, // strictly below the 150¢ already spent
    });
    expect(queued.success).toBe(true);
    if (queued.success) {
      expect(queued.data.goalId).toBe(created.goalId);
      expect(queued.data.budgetCents).toBe(50);
      expect(queued.data.status).toBe("budget_limited");
    }
  });

  test("queued mid-stream editInPlace rename preserves goalId + accounting at drain time", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Original objective" });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "user",
    });

    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({
      workspaceId,
      objective: "Renamed objective",
      editInPlace: true,
      expectedGoalId: created.goalId,
    });
    expect(queued.success).toBe(true);

    await extensionMetadata.setStreaming(workspaceId, false);
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);

    // The drained mutation must preserve goalId continuity and accounting;
    // otherwise a deferred rename would behave like archive+replace.
    expect(drained?.goalId).toBe(created.goalId);
    expect(drained?.objective).toBe("Renamed objective");
    expect(drained?.costCents).toBe(25);
    const boardEntries = (await service.getGoalBoard(workspaceId)).entries;
    expect(boardEntries).toHaveLength(1);
    expect(boardEntries[0]).toMatchObject({
      section: "active",
      goal: { goalId: created.goalId },
    });
  });

  test("queued mid-stream goal creation preserves the projected creation time at drain time", async () => {
    // The projected goal is visible in the Goal panel the moment set_goal runs
    // mid-stream. The durable record must date from that moment — a stream-end
    // createdAtMs would misclassify a user intervention queued against the
    // visible goal as pre-goal input in the goal-safety guards.
    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({ workspaceId, objective: "Projected mid-stream" });
    expect(queued.success).toBe(true);
    const projected = queued.success ? queued.data : null;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await extensionMetadata.setStreaming(workspaceId, false);
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);

    expect(drained?.goalId).toBe(projected?.goalId ?? "missing");
    expect(drained?.createdAtMs).toBe(projected?.createdAtMs ?? -1);
  });

  test("queued mid-stream goal creation stamps creation at publication time", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6b-CH5, PRRT_kwDOPxxmWM6b-Uli): awaits between
    // goal construction and completed publication (kickoff-model pricing
    // validation, streaming re-check, and the async activity-snapshot read
    // inside publication itself) leave a window where a user can queue a
    // message after createdAtMs was stamped but before the goal is visible
    // anywhere. Creation must date from completed publication so the pre-goal
    // guard (enqueuedAtMs <= createdAtMs) covers messages typed during any of
    // those awaits.
    const dispatcher = new IdleDispatcher();
    let midValidationMs = 0;
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(),
      getKickoffSendOptions: async () => {
        // Hold the validation await so wall-clock time observably advances
        // between construction and publication.
        await new Promise((resolve) => setTimeout(resolve, 10));
        midValidationMs = Date.now();
        return { model: "openai:gpt-4o", agentId: "exec" };
      },
    });
    await extensionMetadata.setStreaming(workspaceId, true);
    // Hold every activity-snapshot read (streaming re-check + the read inside
    // publication) so the last read observably postdates any pre-publication
    // creation stamp.
    let lastActivityReadMs = 0;
    const originalGetSnapshot = extensionMetadata.getSnapshot.bind(extensionMetadata);
    spyOn(extensionMetadata, "getSnapshot").mockImplementation(async (id: string) => {
      const snapshot = await originalGetSnapshot(id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      lastActivityReadMs = Date.now();
      return snapshot;
    });

    const queued = await service.setGoal({
      workspaceId,
      objective: "Publication stamp",
      budgetCents: 500,
    });

    expect(queued.success).toBe(true);
    expect(midValidationMs).toBeGreaterThan(0);
    expect(lastActivityReadMs).toBeGreaterThan(0);
    const projected = queued.success ? queued.data : null;
    expect(projected?.createdAtMs ?? -1).toBeGreaterThanOrEqual(midValidationMs);
    // The publication path's own async read is the last pre-visibility await:
    // the creation stamp must postdate it.
    expect(projected?.createdAtMs ?? -1).toBeGreaterThanOrEqual(lastActivityReadMs);
  });

  test("user abort during pending-goal publication discards the queued mutation", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM6b-orH): recordUserStoppedStream deletes queued
    // goal mutations synchronously before taking the goal file lock. If the
    // mutation were installed only after the publication await, an abort
    // landing during publication would find nothing to delete, block on the
    // lock, and the setter would then install the mutation anyway — silently
    // applying the discarded goal at the end of the NEXT stream (AgentSession
    // deliberately skips the stream-end drain for user aborts).
    await extensionMetadata.setStreaming(workspaceId, true);
    const mutationAccess = service as unknown as { pendingGoalMutations: Map<string, unknown> };
    const stopPromises: Array<Promise<void>> = [];
    let fireStops = false;
    const originalGetSnapshot = extensionMetadata.getSnapshot.bind(extensionMetadata);
    spyOn(extensionMetadata, "getSnapshot").mockImplementation(async (id: string) => {
      const snapshot = await originalGetSnapshot(id);
      if (fireStops && mutationAccess.pendingGoalMutations.get(workspaceId) != null) {
        // Fire the abort's synchronous mutation delete during the activity
        // read inside publishPendingGoalSnapshot — the only await with the
        // mutation already installed (a stop during the pre-install awaits is
        // rejected outright; see the span-a-user-stop test). The abort then
        // queues on the goal file lock behind the setter.
        stopPromises.push(service.recordUserStoppedStream(workspaceId));
      }
      return snapshot;
    });

    fireStops = true;
    const queued = await service.setGoal({ workspaceId, objective: "Aborted goal" });
    fireStops = false;
    expect(queued.success).toBe(true);
    expect(stopPromises.length).toBeGreaterThan(0);
    await Promise.all(stopPromises);

    await extensionMetadata.setStreaming(workspaceId, false);
    // Simulate the NEXT stream's end: the drain must find nothing to apply.
    const drained = await service.applyPendingAfterStreamEnd(workspaceId);
    expect(drained).toBeNull();
    expect(await service.getGoal(workspaceId)).toBeNull();
  });

  test("skipped maintenance streams preserve the budget wrap-up stamp", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cBACb): once a goal-driven stream flips the
    // goal to budget_limited, its stamp keeps the pending budget wrap-up
    // eligible. A scheduled heartbeat ending before the wrap-up dispatches
    // must not replace that stamp with a user-origin one, or the wrap-up is
    // classified budget_wrapup_suppressed and the goal strands without its
    // final turn.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Budget-limited goal",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 2,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "budget_limited" });

    // Scheduled heartbeat stream ends while the wrap-up is still pending.
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.01,
      streamStartedAtMs: created.createdAtMs + 2,
      streamOriginKind: "user",
    });

    const stamps = (
      service as unknown as {
        lastGoalStreamStamps: Map<string, { originKind: string; goalId: string | null }>;
      }
    ).lastGoalStreamStamps;
    expect(stamps.get(workspaceId)?.originKind).toBe("goal_continuation");
  });

  test("background wakes preserve user-origin budget wrap-up suppression", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cBr9I): when a manual user stream exhausts the
    // budget, its user-origin stamp deliberately suppresses the autonomous
    // wrap-up. A later background wake ("other" origin) must not replace that
    // stamp, or the wrap-up the user's own stream blocked would dispatch.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "User-exhausted budget",
      budgetCents: 100,
    });
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 2,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "user",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "budget_limited" });

    // Background bash-monitor wake ends while the goal sits budget_limited.
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.01,
      streamStartedAtMs: created.createdAtMs + 2,
      streamOriginKind: "other",
    });

    const stamps = (
      service as unknown as {
        lastGoalStreamStamps: Map<string, { originKind: string; goalId: string | null }>;
      }
    ).lastGoalStreamStamps;
    expect(stamps.get(workspaceId)?.originKind).toBe("user");
  });

  test("direct idle goal creation stamps creation at publication time", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cBr9B): the direct (non-streaming) creation
    // path stamped createdAtMs at construction, before kickoff-model
    // validation and the write/push awaits. A message the user authored while
    // the create request was in flight postdated that stamp and was misread
    // as an intervention against a goal not yet visible. Creation must date
    // from publication here too.
    const dispatcher = new IdleDispatcher();
    let midValidationMs = 0;
    service.registerGoalContinuationConsumer(dispatcher, {
      ...continuationBridge(),
      getKickoffSendOptions: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (midValidationMs === 0) {
          // Only the FIRST call is the pre-persist kickoff-model validation;
          // kickoff arming calls this again after persistence completes.
          midValidationMs = Date.now();
        }
        return { model: "openai:gpt-4o", agentId: "exec" };
      },
    });

    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Direct publication stamp",
      budgetCents: 500,
    });

    expect(midValidationMs).toBeGreaterThan(0);
    expect(created.createdAtMs).toBeGreaterThanOrEqual(midValidationMs);
    expect(await service.getGoal(workspaceId)).toMatchObject({ createdAtMs: created.createdAtMs });
  });
});
