/**
 * The goal's cost is the workspace's cost ledger (session-usage.json, its in-flight files and
 * attributed children) minus the ledger total when the goal began (ledgerBaselineUsd). Real
 * SessionUsageService and WorkspaceGoalService on one temp Xum home.
 */
import * as path from "path";
import * as fs from "fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Config } from "@/node/config";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { WorkspaceGoalService } from "./workspaceGoalService";
import { SessionUsageService } from "./sessionUsageService";
import { createTestHistoryService } from "./testHistoryService";
import type { HistoryService } from "./historyService";
import { createMuxMessage } from "@/common/types/message";
import { setGoalOk, PROJECT_PATH, analyticsMock } from "./workspaceGoalService.testHarness";

const MODEL = "anthropic:claude-sonnet-4-5";

/** Usage that costs exactly `usd`. */
function costing(usd: number): ChatUsageDisplay {
  return {
    input: { tokens: 1_000, cost_usd: usd },
    output: { tokens: 0, cost_usd: 0 },
    cached: { tokens: 0 },
    cacheCreate: { tokens: 0 },
    reasoning: { tokens: 0 },
  };
}

describe("WorkspaceGoalService ledger cost", () => {
  let config: Config;
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;
  let usage: SessionUsageService;
  const workspaceId = "goal-ledger-parent";
  const childId = "goal-ledger-child";

  const newGoalService = () =>
    new WorkspaceGoalService(
      config,
      historyService,
      new ExtensionMetadataService(path.join(config.rootDir, "extensionMetadata.json")),
      analyticsMock(),
      { sessionUsage: usage }
    );

  beforeEach(async () => {
    ({ config, historyService, cleanup } = await createTestHistoryService());
    for (const [id, parent] of [
      [workspaceId, undefined],
      [childId, workspaceId],
    ] as const) {
      await config.addWorkspace(PROJECT_PATH, {
        id,
        name: id,
        projectName: "mux-goal-service-test-project",
        projectPath: PROJECT_PATH,
        runtimeConfig: { type: "local" },
        ...(parent ? { parentWorkspaceId: parent } : {}),
      });
    }
    usage = new SessionUsageService(config, historyService);
  });

  afterEach(async () => {
    await cleanup();
  });

  test("spend before the goal does not count; spend after it counts once", async () => {
    await usage.recordUsage(workspaceId, MODEL, costing(5));
    const service = newGoalService();
    const created = await setGoalOk(service, { workspaceId, objective: "Ship it" });
    expect(created.costCents).toBe(0);

    await usage.recordUsage(workspaceId, MODEL, costing(1.25));
    // costUsd is what the old stream-end charging added; the ledger is the source now.
    const updated = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 99,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(updated).toMatchObject({ costCents: 125, turnsUsed: 1 });
  });

  test("goal cost counts spend while paused and a turn killed by a Xum restart", async () => {
    const service = newGoalService();
    const created = await setGoalOk(service, { workspaceId, objective: "Keep counting" });
    await usage.recordUsage(workspaceId, MODEL, costing(1));
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });

    await setGoalOk(service, { workspaceId, objective: "Keep counting", status: "paused" });
    // A heartbeat turn while paused: stream-end charging used to skip it.
    await usage.recordUsage(workspaceId, MODEL, costing(2));
    const paused = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 2,
      streamStartedAtMs: created.createdAtMs + 2,
      streamOriginKind: "user",
    });
    expect(paused).toMatchObject({ status: "paused", costCents: 300, turnsUsed: 1 });

    // A turn killed by a restart leaves its finished steps in an in-flight file.
    await usage.recordInFlightUsage(workspaceId, "key-killed", "msg-killed", MODEL, costing(0.5));
    usage = new SessionUsageService(config, historyService);
    const restarted = newGoalService();
    await setGoalOk(restarted, { workspaceId, objective: "Keep counting", status: "active" });
    await usage.recordUsage(workspaceId, MODEL, costing(0.25));
    const afterRestart = await restarted.recordStreamAccounting({
      workspaceId,
      costUsd: 0.25,
      streamStartedAtMs: Date.now(),
      streamOriginKind: "goal_continuation",
    });
    expect(afterRestart).toMatchObject({ status: "active", costCents: 375 });
  });

  test("a budget is enforced on the ledger cost", async () => {
    await usage.recordUsage(workspaceId, MODEL, costing(0.1));
    const service = newGoalService();
    const created = await setGoalOk(service, {
      workspaceId,
      objective: "Stay under budget",
      budgetCents: 200,
    });
    await usage.recordUsage(workspaceId, MODEL, costing(2.5));
    const next = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 0,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(next).toMatchObject({ status: "budget_limited", costCents: 250 });
  });

  test("an attributed child counts once, before and after its roll-up into the parent", async () => {
    const service = newGoalService();
    await setGoalOk(service, { workspaceId, objective: "Delegate" });
    await usage.recordUsage(childId, MODEL, costing(3));
    const attributed = await service.attributeChildReport({
      parentWorkspaceId: workspaceId,
      childWorkspaceId: childId,
      childCostCents: 300,
    });
    expect(attributed?.goalAfter.costCents).toBe(300);

    // The child is removed: its ledger is rolled up into the parent's.
    const childUsage = await usage.getSessionUsage(childId);
    await usage.rollUpUsageIntoParent(workspaceId, childId, childUsage!.byModel);
    await fs.rm(path.join(config.sessionsDir, childId), { recursive: true, force: true });
    await usage.recordUsage(workspaceId, MODEL, costing(1));
    const after = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1,
      streamStartedAtMs: Date.now(),
      streamOriginKind: "goal_continuation",
    });
    expect(after?.costCents).toBe(400);
  });

  test("after a restart, a killed turn's spend counts before the next turn is admitted", async () => {
    await usage.recordUsage(workspaceId, MODEL, costing(0.1));
    const service = newGoalService();
    await setGoalOk(service, { workspaceId, objective: "Bounded", budgetCents: 100 });
    await usage.recordUsage(workspaceId, MODEL, costing(0.5));
    // The last turn was killed after finished steps worth $0.75.
    await usage.recordInFlightUsage(workspaceId, "key-killed", "msg-killed", MODEL, costing(0.75));
    usage = new SessionUsageService(config, historyService);
    // getGoal runs the same limit normalization the continuation dispatch runs.
    const recovered = await newGoalService().getGoal(workspaceId);
    expect(recovered).toMatchObject({ status: "budget_limited", costCents: 125 });
  });

  test("a goal created while the ledger is missing does not count earlier spend after a rebuild", async () => {
    const message = createMuxMessage("earlier-turn", "assistant", "done", {
      model: MODEL,
      usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
    });
    const appended = await historyService.appendToHistory(workspaceId, message);
    if (!appended.success) throw new Error(appended.error);
    const service = newGoalService();
    const created = await setGoalOk(service, { workspaceId, objective: "Fresh start" });

    // A read rebuilds the ledger from history: the earlier turn costs dollars.
    const rebuilt = await usage.getSessionUsage(workspaceId);
    expect(Object.keys(rebuilt?.byModel ?? {})).not.toHaveLength(0);
    await usage.recordUsage(workspaceId, MODEL, costing(1));
    const first = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(first?.costCents).toBe(100);
    await usage.recordUsage(workspaceId, MODEL, costing(0.5));
    const second = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 99,
      streamStartedAtMs: created.createdAtMs + 2,
      streamOriginKind: "goal_continuation",
    });
    expect(second?.costCents).toBe(150);
  });

  test("a goal keeps counting after its ledger is deleted and rebuilt lower", async () => {
    // Headless spend is in the ledger but not in history, so a rebuild comes back lower.
    await usage.recordUsage(workspaceId, MODEL, costing(5), { skipLastRequestUpdate: true });
    const service = newGoalService();
    const created = await setGoalOk(service, { workspaceId, objective: "Survive" });
    await fs.rm(path.join(config.sessionsDir, workspaceId, "session-usage.json"));

    // While the ledger is missing, the stream end charges as before.
    const missing = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(missing?.costCents).toBe(100);

    // The rebuilt ledger restarts below the old baseline: the goal rebases on it.
    await usage.recordUsage(workspaceId, MODEL, costing(1));
    const rebased = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1,
      streamStartedAtMs: created.createdAtMs + 2,
      streamOriginKind: "goal_continuation",
    });
    expect(rebased?.costCents).toBe(200);
    await usage.recordUsage(workspaceId, MODEL, costing(0.5));
    const later = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 99,
      streamStartedAtMs: created.createdAtMs + 3,
      streamOriginKind: "goal_continuation",
    });
    expect(later?.costCents).toBe(250);
  });

  test("an unattributed child rolled up after the goal began is not the goal's spend", async () => {
    await usage.recordUsage(workspaceId, MODEL, costing(0.1));
    // The child's spend is older than the goal.
    await usage.recordUsage(childId, MODEL, costing(4));
    const service = newGoalService();
    await setGoalOk(service, { workspaceId, objective: "Unrelated child", budgetCents: 300 });
    const childUsage = await usage.getSessionUsage(childId);
    await usage.rollUpUsageIntoParent(workspaceId, childId, childUsage!.byModel);
    await usage.recordUsage(workspaceId, MODEL, costing(1));
    const goal = await service.getGoal(workspaceId);
    expect(goal).toMatchObject({ status: "active", costCents: 100 });
  });

  test("a rebase on a lower ledger is kept when the cost itself does not change", async () => {
    await usage.recordUsage(workspaceId, MODEL, costing(5), { skipLastRequestUpdate: true });
    const service = newGoalService();
    const created = await setGoalOk(service, { workspaceId, objective: "Rebase" });
    await usage.recordUsage(workspaceId, MODEL, costing(1));
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    // The ledger is rebuilt lower ($0 here), then a read normalizes the goal.
    await fs.rm(path.join(config.sessionsDir, workspaceId, "session-usage.json"));
    await usage.recordUsage(workspaceId, MODEL, costing(0.25), { skipLastRequestUpdate: true });
    expect((await service.getGoal(workspaceId))?.costCents).toBe(100);
    // Paused-period (here: headless) spend after the rebase counts.
    await usage.recordUsage(workspaceId, MODEL, costing(0.5), { skipLastRequestUpdate: true });
    expect((await service.getGoal(workspaceId))?.costCents).toBe(150);
  });

  test("a malformed ledger does not break goal reads; the goal charges as before", async () => {
    await usage.recordUsage(workspaceId, MODEL, costing(0.1));
    const service = newGoalService();
    const created = await setGoalOk(service, { workspaceId, objective: "Robust" });
    await fs.writeFile(
      path.join(config.sessionsDir, workspaceId, "session-usage.json"),
      JSON.stringify({ byModel: { [MODEL]: null }, version: 1 })
    );
    expect((await service.getGoal(workspaceId))?.costCents).toBe(0);
    const next = await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect(next?.costCents).toBe(100);
  });

  test("a goal promoted back from upcoming does not pay for the other goal's spend", async () => {
    await usage.recordUsage(workspaceId, MODEL, costing(0.1));
    const service = newGoalService();
    const first = await setGoalOk(service, { workspaceId, objective: "First" });
    await usage.recordUsage(workspaceId, MODEL, costing(1));
    await service.recordStreamAccounting({
      workspaceId,
      costUsd: 1,
      streamStartedAtMs: first.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    const second = await service.addUpcomingGoal({ workspaceId, objective: "Second" });
    // Promoting the second goal demotes the first; the second spends $2.
    await service.promoteUpcomingGoal(workspaceId, second.goalId);
    await usage.recordUsage(workspaceId, MODEL, costing(2));
    const promotedBack = await service.promoteUpcomingGoal(workspaceId, first.goalId);
    expect(promotedBack?.costCents).toBe(100);
    expect((await service.getGoal(workspaceId))?.costCents).toBe(100);
  });

  test("a goal written before the baseline existed keeps its cost and then follows the ledger", async () => {
    await usage.recordUsage(workspaceId, MODEL, costing(10));
    const service = newGoalService();
    const created = await setGoalOk(service, { workspaceId, objective: "Legacy" });
    // An older Xum wrote this goal: no baseline, cost charged at stream end.
    const goalPath = path.join(config.sessionsDir, workspaceId, "goal.json");
    const legacy = JSON.parse(await fs.readFile(goalPath, "utf-8")) as Record<string, unknown>;
    delete legacy.ledgerBaselineUsd;
    await fs.writeFile(
      goalPath,
      JSON.stringify({ ...legacy, costCents: 70, costMicroCents: 70e6 })
    );

    await usage.recordUsage(workspaceId, MODEL, costing(0.5));
    const next = await newGoalService().recordStreamAccounting({
      workspaceId,
      costUsd: 0.5,
      streamStartedAtMs: created.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    // The first accounting still charges the stream as before and pins the baseline at that
    // cost, so the old cost carries over; later spend follows the ledger.
    expect(next?.costCents).toBe(120);
    await usage.recordUsage(workspaceId, MODEL, costing(0.5));
    const later = await newGoalService().recordStreamAccounting({
      workspaceId,
      costUsd: 99,
      streamStartedAtMs: created.createdAtMs + 2,
      streamOriginKind: "goal_continuation",
    });
    expect(later?.costCents).toBe(170);
  });
});
