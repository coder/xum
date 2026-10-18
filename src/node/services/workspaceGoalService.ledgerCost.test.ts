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
