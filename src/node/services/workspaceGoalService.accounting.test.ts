import * as path from "path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "fs/promises";
import type { Config } from "@/node/config";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { WorkspaceGoalService } from "./workspaceGoalService";
import { IdleDispatcher } from "./idleDispatcher";
import { createTestHistoryService } from "./testHistoryService";
import type { HistoryService } from "./historyService";
import type { GoalRecordV1 } from "@/common/types/goal";
import { GOAL_BUDGET_LIMIT_KIND } from "@/constants/goals";
import { drainPendingDispatches, waitForCondition } from "./testDispatchHelpers";
import {
  captureGoalActivity,
  setGoalOk,
  PROJECT_PATH,
  analyticsMock,
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

  test("increments accounting for non-compaction stream completions", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Account for stream" });

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.235,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });

    expect(updated).toMatchObject({ costCents: 124, turnsUsed: 1 });
    expect(await service.getGoal(workspaceId)).toMatchObject({ costCents: 124, turnsUsed: 1 });
  });

  test("accumulates sub-cent stream costs across goal turns", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Accumulate tiny costs",
      budgetCents: 1,
    });

    const first = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.004,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    const second = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.004,
      streamStartedAtMs: created.createdAtMs + 2,
      streamOriginKind: "goal_continuation",
    });
    const third = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.002,
      streamStartedAtMs: created.createdAtMs + 3,
      streamOriginKind: "goal_continuation",
    });

    expect(first).toMatchObject({ costCents: 0, costMicroCents: 400_000, status: "active" });
    expect(second).toMatchObject({ costCents: 1, costMicroCents: 800_000, status: "active" });
    expect(third).toMatchObject({
      costCents: 1,
      costMicroCents: 1_000_000,
      status: "budget_limited",
    });
  });

  test("paused goals ignore later stream accounting", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "User clarification mid-goal",
      turnCap: 3,
    });
    await setGoalOk(service, {
      workspaceId,
      objective: created.objective,
      status: "paused",
    });

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.42,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "user",
    });

    expect(updated).toMatchObject({ costCents: 0, turnsUsed: 0, status: "paused" });
  });

  test("paused goals ignore maintenance stream accounting (heartbeats / wake turns)", async () => {
    // Regression: paused goals were charged turns/cost (and updatedAtMs bumped)
    // by every background wake turn ("other") and scheduled heartbeat, making
    // maintenance turns look like they had just touched the paused goal.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Paused during maintenance",
      turnCap: 3,
    });
    await setGoalOk(service, {
      workspaceId,
      objective: created.objective,
      status: "paused",
    });

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.42,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "other",
    });

    expect(updated).toMatchObject({ costCents: 0, turnsUsed: 0, status: "paused" });
  });

  test("budget-limited goals ignore maintenance stream accounting", async () => {
    // Background wakes/heartbeats running while the budget wrap-up is pending
    // must not inflate the recorded overshoot; only goal-driven streams
    // (continuation / wrap-up) may still charge a budget_limited goal.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Budget exhausted",
      budgetCents: 100,
    });
    const limited = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(limited).toMatchObject({ status: "budget_limited", costCents: 125, turnsUsed: 1 });

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.42,
      streamStartedAtMs: created.createdAtMs + 2,
      streamOriginKind: "other",
    });

    expect(updated).toMatchObject({ status: "budget_limited", costCents: 125, turnsUsed: 1 });
  });

  test("budget-limited goals ignore maintenance stream cost previews", async () => {
    // Live previews must agree with final accounting: a heartbeat/wake stream
    // on a budget_limited goal is discarded at stream end, so previewing its
    // cost would show a climbing number that snaps back when the turn ends.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Budget exhausted preview",
      budgetCents: 100,
    });
    const limited = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(limited).toMatchObject({ status: "budget_limited", costCents: 125 });

    const preview = await service.previewStreamAccounting({
      workspaceId,
      costUsd: 0.42,
      streamStartedAtMs: created.createdAtMs + 2,
      streamOriginKind: "other",
    });

    expect(preview).toMatchObject({ status: "budget_limited", costCents: 125 });
  });

  test("completed goals ignore later stream accounting", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Already complete",
      budgetCents: 100,
    });
    await setGoalOk(service, {
      workspaceId,
      objective: created.objective,
      status: "complete",
      completionSummary: "Done.",
    });

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "user",
    });

    expect(updated).toMatchObject({ costCents: 0, turnsUsed: 0, status: "complete" });
  });

  test("completed goals count the completing goal-attributable stream", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Complete during continuation",
      budgetCents: 200,
    });
    await setGoalOk(service, {
      workspaceId,
      objective: created.objective,
      status: "complete",
      completionSummary: "Done.",
    });

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });

    expect(updated).toMatchObject({ costCents: 125, turnsUsed: 1, status: "complete" });
  });

  test("attributes child report cost once and persists the per-goal ledger", async () => {
    await setGoalOk(service, { workspaceId, objective: "Account for child reports" });
    await fs.writeFile(
      path.join(config.sessionsDir, workspaceId, "session-usage.json"),
      JSON.stringify({ version: 1, byModel: {}, rolledUpFrom: { "child-a": true } }, null, 2)
    );

    const first = await service.attributeChildReport({
      parentWorkspaceId: workspaceId,
      childWorkspaceId: "child-a",
      childCostCents: 37,
    });
    const second = await service.attributeChildReport({
      parentWorkspaceId: workspaceId,
      childWorkspaceId: "child-a",
      childCostCents: 37,
    });

    expect(first?.attributed).toBe(true);
    expect(first?.goalAfter).toMatchObject({
      costCents: 37,
      turnsUsed: 1,
      attributedChildren: ["child-a"],
    });
    expect(second?.attributed).toBe(false);
    expect(second?.goalAfter).toMatchObject({
      costCents: 37,
      turnsUsed: 1,
      attributedChildren: ["child-a"],
    });

    const goalOnDisk = JSON.parse(
      await fs.readFile(path.join(config.sessionsDir, workspaceId, "goal.json"), "utf-8")
    ) as GoalRecordV1;
    expect(goalOnDisk.attributedChildren).toEqual(["child-a"]);

    const sessionUsageOnDisk = JSON.parse(
      await fs.readFile(path.join(config.sessionsDir, workspaceId, "session-usage.json"), "utf-8")
    ) as { rolledUpFrom?: Record<string, unknown> };
    expect(sessionUsageOnDisk.rolledUpFrom).toEqual({ "child-a": true });
  });

  test("child attribution under budget re-requests a deferred parent continuation", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Continue after child completes",
      budgetCents: 500,
    });
    let hasActiveDescendantTasks = true;
    const dispatcher = new IdleDispatcher();
    const execute = mock(() => Promise.resolve(true));
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => hasActiveDescendantTasks,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: execute,
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    await service.requestContinuationAfterStreamEnd({
      workspaceId,
      sendOptions: { model: "openai:gpt-4o", agentId: "exec" },
      streamEndedAtMs: created.createdAtMs + 1,
    });
    await drainPendingDispatches();
    expect(execute).not.toHaveBeenCalled();

    hasActiveDescendantTasks = false;
    await service.attributeChildReport({
      parentWorkspaceId: workspaceId,
      childWorkspaceId: "child-under-budget",
      childCostCents: 25,
    });
    await waitForCondition(() => execute.mock.calls.length > 0, { timeoutMs: 1_000 });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("child attribution that flips to budget_limited arms a wrap-up dispatch", async () => {
    // when child attribution drives the
    // goal into budget_limited, the wrap-up must fire. Previously the goal
    // would sit stuck because attribution never produced a stream-end
    // candidate/stamp that `checkGoalContinuationEligibility` could reserve.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Drive into budget_limited via child attribution",
      budgetCents: 100,
    });
    const dispatcher = new IdleDispatcher();
    const executed: Array<{ kind: string | undefined }> = [];
    service.registerGoalContinuationConsumer(dispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: (input) => {
        executed.push({ kind: input.kind });
        return Promise.resolve(true);
      },
      // Recovery / attribution paths synthesize a candidate from scratch and
      // need a kickoff send-options provider to know how to dispatch.
      getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
    });

    const result = await service.attributeChildReport({
      parentWorkspaceId: workspaceId,
      childWorkspaceId: "child-wrapper",
      childCostCents: 200,
    });

    expect(result?.causedBudgetLimit).toBe(true);
    expect(result?.goalAfter).toMatchObject({
      goalId: created.goalId,
      status: "budget_limited",
      budgetLimitInjectedForGoalId: null,
    });
    await waitForCondition(() => executed.length > 0, { timeoutMs: 1_000 });
    expect(executed[0]?.kind).toBe(GOAL_BUDGET_LIMIT_KIND);
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "budget_limited",
      budgetLimitInjectedForGoalId: created.goalId,
    });
  });

  test("child report attribution flips active goals to budget-limited once", async () => {
    await setGoalOk(service, {
      workspaceId,
      objective: "Child blows budget",
      budgetCents: 100,
    });

    const first = await service.attributeChildReport({
      parentWorkspaceId: workspaceId,
      childWorkspaceId: "child-a",
      childCostCents: 125,
    });
    const second = await service.attributeChildReport({
      parentWorkspaceId: workspaceId,
      childWorkspaceId: "child-a",
      childCostCents: 125,
    });
    const third = await service.attributeChildReport({
      parentWorkspaceId: workspaceId,
      childWorkspaceId: "child-b",
      childCostCents: 10,
    });

    expect(first).toMatchObject({ attributed: true, causedBudgetLimit: true });
    expect(first?.goalBefore).toMatchObject({ status: "active", costCents: 0 });
    expect(first?.goalAfter).toMatchObject({ status: "budget_limited", costCents: 125 });
    expect(second).toMatchObject({ attributed: false, causedBudgetLimit: false });
    expect(third).toMatchObject({ attributed: true, causedBudgetLimit: false });
    expect(third?.goalAfter).toMatchObject({
      status: "budget_limited",
      costCents: 135,
      turnsUsed: 2,
      attributedChildren: ["child-a", "child-b"],
    });
    const lifecycleCalls = analytics.recordGoalLifecycleEvent.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >;
    const budgetLimitedCalls = lifecycleCalls.filter(([event]) => event === "goal_budget_limited");
    expect(budgetLimitedCalls).toHaveLength(1);
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_budget_limited",
      expect.objectContaining({ "caused-by-child": true, "cost-overshoot": "1-99" })
    );
  });

  test("skips accounting for compaction stream completions", async () => {
    await setGoalOk(service, { workspaceId, objective: "Ignore compaction" });

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 2,
      isCompaction: true,
    });

    expect(updated).toBeNull();
    expect(await service.getGoal(workspaceId)).toMatchObject({ costCents: 0, turnsUsed: 0 });
  });

  test("counts aborted streams and one turn per counted stream", async () => {
    await setGoalOk(service, { workspaceId, objective: "Count aborts" });

    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.1,
      streamOriginKind: "goal_continuation",
    });
    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0.2,
      streamOriginKind: "goal_continuation",
    });

    expect(updated).toMatchObject({ costCents: 30, turnsUsed: 2 });
  });

  test("ignores streams that started before the goal existed", async () => {
    // Pin the stream timestamp explicitly to avoid racing the wall clock for
    // ordering (the goal's createdAtMs uses Date.now() at write time).
    await setGoalOk(service, { workspaceId, objective: "Ignore pre-goal stream" });
    const goalAtCreation = await service.getGoal(workspaceId);
    const streamStartedAtMs = (goalAtCreation?.createdAtMs ?? Date.now()) - 100;

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 5,
      streamStartedAtMs,
    });

    expect(updated).toBeNull();
    expect(await service.getGoal(workspaceId)).toMatchObject({ costCents: 0, turnsUsed: 0 });
  });

  test("previews live stream cost without double-counting final accounting", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Preview live cost",
      budgetCents: 1_000,
    });
    // Capture activity events so we can assert that previews reach
    // subscribers (the renderer's WorkspaceStore) via the transient
    // activity emit. When a baseline activity snapshot exists,
    // `previewStreamAccounting` does NOT write to extensionMetadata.json
    // or goal.json. The durable record is updated only by
    // `recordStreamAccounting` at stream end.
    const activityUpdates = captureGoalActivity(service);

    const firstPreview = await service.previewStreamAccounting({
      workspaceId,
      costUsd: 0.5,
      streamStartedAtMs: created.createdAtMs + 1,
    });
    const secondPreview = await service.previewStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
    });

    expect(firstPreview).toMatchObject({ costCents: 50, budgetCents: 1_000 });
    expect(secondPreview).toMatchObject({ costCents: 125, budgetCents: 1_000 });
    // Transient activity snapshots reflect the latest preview so the UI
    // updates without waiting on a disk write round-trip.
    expect(activityUpdates.at(-1)).toMatchObject({
      transientGoalOnly: true,
      goal: { costCents: 125, budgetCents: 1_000 },
    });
    // Neither extensionMetadata.json nor goal.json should carry the
    // preview cost — both stay at the durable pre-stream value.
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { costCents: 0, budgetCents: 1_000 },
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({ costCents: 0, budgetCents: 1_000 });

    const editedDuringStream = await setGoalOk(service, { workspaceId, budgetCents: 2_000 });
    const previewAfterEdit = await service.previewStreamAccounting({
      workspaceId,
      costUsd: 1.5,
      streamStartedAtMs: created.createdAtMs + 1,
    });
    expect(editedDuringStream).toMatchObject({ budgetCents: 2_000 });
    expect(previewAfterEdit).toMatchObject({ costCents: 150, budgetCents: 2_000 });

    const final = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });

    expect(final).toMatchObject({ costCents: 125, turnsUsed: 1, status: "active" });

    const previewAfterFinal = await service.previewStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
    });
    expect(previewAfterFinal).toBeNull();
    // Final accounting persists to both goal.json and extensionMetadata.
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { costCents: 125, budgetCents: 2_000 },
    });
  });

  test("previewStreamAccounting falls back when no activity snapshot exists", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Preview without metadata",
      budgetCents: 1_000,
    });
    // Clear the snapshot by rewriting the file directly: deleteWorkspace now
    // write-tombstones removed workspaces for the rest of the process, which
    // would (correctly) block the preview persistence below. This test
    // simulates a LIVE workspace that merely has no activity snapshot yet.
    await fs.writeFile(
      path.join(config.rootDir, "extensionMetadata.json"),
      JSON.stringify({ version: 1, workspaces: {} })
    );
    const activityUpdates = captureGoalActivity(service);

    const preview = await service.previewStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
    });

    expect(preview).toMatchObject({ costCents: 125, budgetCents: 1_000 });
    expect(activityUpdates.at(-1)).toMatchObject({
      goal: { costCents: 125, budgetCents: 1_000 },
    });
    expect(activityUpdates.at(-1)?.transientGoalOnly).toBeUndefined();
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { costCents: 125, budgetCents: 1_000 },
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({ costCents: 0, budgetCents: 1_000 });
  });

  test("budget edits preserve live preview activity while durable accounting stays pre-stream", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Budget edit keeps live used amount",
      budgetCents: 1_000,
    });
    const activityUpdates = captureGoalActivity(service);

    await service.previewStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
    });
    const updated = await setGoalOk(service, { workspaceId, budgetCents: 2_000 });

    expect(updated).toMatchObject({ costCents: 0, budgetCents: 2_000 });
    // Updating only the limit writes the durable pre-stream accounting to
    // goal.json, then emits a transient overlay so the Goals UI does not
    // reset "used" from the live Stats cost back to $0.00 mid-stream.
    expect(activityUpdates.at(-1)).toMatchObject({
      transientGoalOnly: true,
      goal: { costCents: 125, budgetCents: 2_000 },
    });
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { costCents: 0, budgetCents: 2_000 },
    });

    const final = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(final).toMatchObject({ costCents: 125, budgetCents: 2_000 });
  });

  test("previewStreamAccounting preserves queued replacement snapshots", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Old goal" });
    await extensionMetadata.setStreaming(workspaceId, true);
    const queued = await service.setGoal({
      workspaceId,
      objective: "Queued replacement goal",
      expectedGoalId: created.goalId,
    });
    expect(queued.success).toBe(true);

    const preview = await service.previewStreamAccounting({
      workspaceId,
      costUsd: 1.25,
      streamStartedAtMs: created.createdAtMs + 1,
    });

    expect(preview).toMatchObject({
      objective: "Queued replacement goal",
      pendingPersistence: true,
    });
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { goalId: created.goalId, objective: "Old goal" },
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({ objective: "Old goal" });
  });

  test("previewStreamAccounting skips paused goals, compactions, and stale streams", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Preview guard coverage",
      budgetCents: 1_000,
    });

    expect(
      await service.previewStreamAccounting({
        workspaceId,
        costUsd: 5,
        isCompaction: true,
        streamStartedAtMs: created.createdAtMs + 1,
      })
    ).toBeNull();
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { costCents: 0 },
    });

    expect(
      await service.previewStreamAccounting({
        workspaceId,
        costUsd: 5,
        streamStartedAtMs: created.createdAtMs - 1,
      })
    ).toBeNull();

    await setGoalOk(service, { workspaceId, status: "paused" });
    expect(
      await service.previewStreamAccounting({
        workspaceId,
        costUsd: 5,
        streamStartedAtMs: created.createdAtMs + 1,
      })
    ).toMatchObject({ costCents: 0, status: "paused" });
  });

  test("flips active goals to budget-limited when stream cost reaches the budget", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Hit cost budget",
      budgetCents: 124,
    });

    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1.24,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });

    expect(updated).toMatchObject({ costCents: 124, turnsUsed: 1, status: "budget_limited" });
    expect(await service.getGoal(workspaceId)).toMatchObject({ status: "budget_limited" });
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_budget_limited",
      expect.objectContaining({ "cost-overshoot": "0" })
    );
  });

  test("emits budget telemetry when setGoal touches budget or turn caps", async () => {
    await setGoalOk(service, {
      workspaceId,
      objective: "Telemetry goal",
      budgetCents: 500,
      turnCap: 25,
    });

    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_budget_changed",
      expect.objectContaining({
        "budget-delta-sign": "positive",
        "budget-raised-vs-lowered": "raised",
        "turn-cap-delta-sign": "positive",
        "turn-cap-raised-vs-lowered": "raised",
      })
    );
  });

  test("allows user lifecycle transitions and persists completion summaries", async () => {
    const created = await setGoalOk(service, { workspaceId, objective: "Lifecycle goal" });

    const paused = await setGoalOk(service, { workspaceId, status: "paused" });
    expect(paused).toMatchObject({ goalId: created.goalId, status: "paused" });

    const resumed = await setGoalOk(service, { workspaceId, status: "active" });
    expect(resumed).toMatchObject({ goalId: created.goalId, status: "active" });

    const completed = await setGoalOk(service, {
      workspaceId,
      status: "complete",
      completionSummary: "Verified the goal manually.",
    });
    expect(completed).toMatchObject({
      goalId: created.goalId,
      status: "complete",
      completionSummary: "Verified the goal manually.",
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "complete",
      completionSummary: "Verified the goal manually.",
    });
    expect(await extensionMetadata.getSnapshot(workspaceId)).toMatchObject({
      goal: { status: "complete", completionSummary: "Verified the goal manually." },
    });
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_paused",
      expect.objectContaining({ initiator: "user" })
    );
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_resumed",
      expect.objectContaining({ initiator: "user" })
    );
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_completed",
      expect.objectContaining({ initiator: "user", summaryLengthBucket: "10-49" })
    );
  });

  test("allows budget-limited goals to be completed manually", async () => {
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Wrap up over-budget goal",
      status: "budget_limited",
    });

    const completed = await setGoalOk(service, {
      workspaceId,
      status: "complete",
      completionSummary: "Stopped after hitting the budget.",
    });

    expect(completed).toMatchObject({
      goalId: created.goalId,
      status: "complete",
      completionSummary: "Stopped after hitting the budget.",
    });
  });

  test("auto initiator pause emits telemetry", async () => {
    await setGoalOk(service, { workspaceId, objective: "Pause automatically" });

    const paused = await setGoalOk(service, {
      workspaceId,
      status: "paused",
      initiator: "auto",
    });

    expect(paused.status).toBe("paused");
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_paused",
      expect.objectContaining({ initiator: "auto" })
    );
  });

  test("clears a pending user acknowledgment without changing status", async () => {
    await setGoalOk(service, { workspaceId, objective: "Await user acknowledgment" });
    await service.requireUserAcknowledgment(workspaceId, 12_345);

    const acknowledged = await service.acknowledgeUser(workspaceId);

    expect(acknowledged).toMatchObject({
      status: "active",
      requireUserAcknowledgmentSinceMs: null,
    });
    expect(await service.getGoal(workspaceId)).toMatchObject({
      status: "active",
      requireUserAcknowledgmentSinceMs: null,
    });
  });

  test("crash-recovery acknowledgment gate only touches goal-bearing workspaces", async () => {
    await setGoalOk(service, { workspaceId, objective: "Review crash recovery" });

    const gated = await service.requireUserAcknowledgmentForCrashRecovery(workspaceId, 44_000);
    const missing = await service.requireUserAcknowledgmentForCrashRecovery("missing-goal", 45_000);

    expect(gated).toMatchObject({ requireUserAcknowledgmentSinceMs: 44_000 });
    expect(missing).toBeNull();
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_crash_gate_set",
      expect.objectContaining({ workspaceIdLengthBucket: "10-49" })
    );
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledTimes(2);
  });

  test("rejects illegal user lifecycle transitions with typed errors", async () => {
    // setGoal now catches WorkspaceGoalTransitionError and returns
    // it as a typed `invalid_transition` Result error so the oRPC handler
    // doesn't leak it as an unhandled 500.
    async function expectSetGoalError(
      input: Parameters<WorkspaceGoalService["setGoal"]>[0],
      message: string
    ) {
      const result = await service.setGoal(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.type).toBe("invalid_transition");
        if (result.error.type === "invalid_transition") {
          expect(result.error.message).toBe(message);
        }
      }
    }

    await expectSetGoalError(
      { workspaceId, status: "paused" },
      "Cannot pause a goal because no goal is set."
    );

    await setGoalOk(service, { workspaceId, objective: "Illegal transitions" });
    await expectSetGoalError(
      { workspaceId, status: "active" },
      "Cannot resume a goal that is not paused."
    );
    await expectSetGoalError(
      { workspaceId, status: "complete" },
      "Completion summary is required."
    );

    await setGoalOk(service, { workspaceId, status: "paused" });
    await expectSetGoalError(
      {
        workspaceId,
        status: "complete",
        completionSummary: "Cannot complete from pause.",
      },
      "Cannot complete a goal that is not active or budget-limited."
    );

    await setGoalOk(service, { workspaceId, status: "active" });
    await setGoalOk(service, {
      workspaceId,
      status: "complete",
      completionSummary: "Done for good.",
    });
    // User-initiated resume / pause out of `complete` is intentionally
    // allowed: the user can revive a goal the agent marked complete too
    // eagerly. Model/auto initiators are still blocked below.
    await expectSetGoalError(
      { workspaceId, status: "paused", initiator: "model" },
      "Cannot pause a completed goal. Clear it before starting another."
    );
    await expectSetGoalError(
      { workspaceId, status: "active", initiator: "model" },
      "Cannot resume a completed goal. Clear it before starting another."
    );
  });

  test("user can resume a completed goal (revive after agent marked complete)", async () => {
    // The agent marks the goal complete via the `complete_goal` tool
    // (initiator: "model"), then a human in the GoalTab clicks "Resume"
    // because the goal was not actually done. The backend must allow the
    // transition out of `complete` for user-initiated callers, and emit
    // `goal_resumed` so the lifecycle funnel sees the revive symmetrically
    // with a paused→active resume.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Revive completed goal",
    });
    await setGoalOk(service, {
      workspaceId,
      status: "complete",
      completionSummary: "Agent thought it was done.",
      initiator: "model",
    });

    const revived = await setGoalOk(service, {
      workspaceId,
      status: "active",
      initiator: "user",
    });
    expect(revived).toMatchObject({ goalId: created.goalId, status: "active" });
    // Completion summary is cleared by `completionSummaryPatch` whenever
    // status moves out of `complete` — keeps the visible "Completion
    // summary" panel from lingering on a resumed goal.
    expect(revived.completionSummary).toBeUndefined();
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_resumed",
      expect.objectContaining({ initiator: "user" })
    );
  });

  test("user can pause a completed goal without resuming first", async () => {
    // Symmetry with resume-from-complete: a user who wants to revive a
    // completed goal but not immediately re-arm continuations can land it
    // in `paused` directly.
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Pause completed goal",
    });
    await setGoalOk(service, {
      workspaceId,
      status: "complete",
      completionSummary: "Wrap-up first pass.",
    });

    const paused = await setGoalOk(service, {
      workspaceId,
      status: "paused",
      initiator: "user",
    });
    expect(paused).toMatchObject({ goalId: created.goalId, status: "paused" });
    expect(paused.completionSummary).toBeUndefined();
  });

  test("budget-only mutation against a missing goal returns invalid_transition (no plain Error 500)", async () => {
    // simulates the race where the user
    // clicks "Update budget" in the RightSidebar / GoalTab, another window
    // clears the goal concurrently, and `setGoalWithConflictRetry` then
    // calls `setGoal({ workspaceId, budgetCents: N })` against a now-empty
    // goal slot. With no objective, no status, and no current goal, this
    // path used to throw a plain `Error("Goal objective is required.")`
    // that escaped the wrapper as an unhandled 500. Now it throws
    // `WorkspaceGoalTransitionError` so the wrapper turns it into a typed
    // `invalid_transition` Result.
    const result = await service.setGoal({ workspaceId, budgetCents: 500 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.type).toBe("invalid_transition");
    }
  });
});
