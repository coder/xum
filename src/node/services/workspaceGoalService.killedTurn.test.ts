import * as path from "path";
import * as fs from "fs/promises";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Config } from "@/node/config";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { SessionUsageService } from "./sessionUsageService";
import { WorkspaceGoalService } from "./workspaceGoalService";
import { createTestHistoryService } from "./testHistoryService";
import type { HistoryService } from "./historyService";
import { setGoalOk, PROJECT_PATH, analyticsMock } from "./workspaceGoalService.testHarness";

const MODEL = "anthropic:claude-sonnet-4-5";

/** $0.20: 20 goal cents. */
function usage(): ChatUsageDisplay {
  return {
    input: { tokens: 100, cost_usd: 0.1 },
    output: { tokens: 10, cost_usd: 0.1 },
    cached: { tokens: 0 },
    cacheCreate: { tokens: 0 },
    reasoning: { tokens: 0 },
  };
}

describe("WorkspaceGoalService: a turn killed by a Xum restart", () => {
  let config: Config;
  let historyService: HistoryService;
  let cleanup: () => Promise<void>;
  let goals: WorkspaceGoalService;
  const workspaceId = "goal-killed-turn";

  beforeEach(async () => {
    ({ config, historyService, cleanup } = await createTestHistoryService());
    await config.addWorkspace(PROJECT_PATH, {
      id: workspaceId,
      name: "killed-turn",
      projectName: "mux-goal-service-test-project",
      projectPath: PROJECT_PATH,
      runtimeConfig: { type: "local" },
    });
    goals = new WorkspaceGoalService(
      config,
      historyService,
      new ExtensionMetadataService(path.join(config.rootDir, "extensionMetadata.json")),
      analyticsMock()
    );
  });

  afterEach(async () => {
    await cleanup();
  });

  /** The SessionUsageService a (re)started Xum has, wired to the goal as in CoreWiringLive. */
  function startXum(): SessionUsageService {
    const sessionUsage = new SessionUsageService(config, historyService);
    sessionUsage.setKilledStreamUsageListener((event) => goals.chargeKilledStreamUsage(event));
    return sessionUsage;
  }

  test("a killed turn folded after a restart is charged to the goal once", async () => {
    await setGoalOk(goals, { workspaceId, objective: "Survive restarts" });
    await startXum().recordInFlightUsage(workspaceId, "key-a", "msg-a", MODEL, usage());

    const restarted = startXum();
    await restarted.getSessionUsage(workspaceId);
    expect(await goals.getGoal(workspaceId)).toMatchObject({ costCents: 20, turnsUsed: 0 });

    // Later reads, and another restart, find nothing left to fold.
    await restarted.getSessionUsage(workspaceId);
    await startXum().getSessionUsage(workspaceId);
    expect(await goals.getGoal(workspaceId)).toMatchObject({ costCents: 20 });
  });

  test("a fold repeated after a crash before the file delete is not charged twice", async () => {
    await setGoalOk(goals, { workspaceId, objective: "Crash mid-fold" });
    await startXum().recordInFlightUsage(workspaceId, "key-a", "msg-a", MODEL, usage());

    // The fold's ledger write lands, its file delete does not: what a crash leaves.
    const rm = spyOn(fs, "rm").mockRejectedValue(new Error("EIO"));
    try {
      await startXum().getSessionUsage(workspaceId);
    } finally {
      rm.mockRestore();
    }
    expect(
      await fs.readdir(path.join(config.sessionsDir, workspaceId, "session-usage.in-flight"))
    ).toEqual(["key-a.json"]);

    await startXum().getSessionUsage(workspaceId);
    expect(await goals.getGoal(workspaceId)).toMatchObject({ costCents: 20 });
  });

  test("this process's own leftover is not charged: its stream end already charged the goal", async () => {
    await setGoalOk(goals, { workspaceId, objective: "Own leftover" });
    const xum = startXum();
    await xum.recordInFlightUsage(workspaceId, "key-a", "msg-a", MODEL, usage());
    // The stream ended but its final ledger write failed: the key is no longer live.
    xum.releaseInFlightUsage(workspaceId, "key-a");

    await xum.getSessionUsage(workspaceId);
    expect(await goals.getGoal(workspaceId)).toMatchObject({ costCents: 0 });
  });

  test("a killed turn that finished before the goal existed is not the goal's spend", async () => {
    await startXum().recordInFlightUsage(workspaceId, "key-a", "msg-a", MODEL, usage());
    // Its last step finished a minute before the goal was set.
    const filePath = path.join(
      config.sessionsDir,
      workspaceId,
      "session-usage.in-flight",
      "key-a.json"
    );
    const file = JSON.parse(await fs.readFile(filePath, "utf-8")) as { updatedAt: number };
    await fs.writeFile(filePath, JSON.stringify({ ...file, updatedAt: Date.now() - 60_000 }));
    await setGoalOk(goals, { workspaceId, objective: "Created after the kill" });

    await startXum().getSessionUsage(workspaceId);
    expect(await goals.getGoal(workspaceId)).toMatchObject({ costCents: 0 });
  });
});
