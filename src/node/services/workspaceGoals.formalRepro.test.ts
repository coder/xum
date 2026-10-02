// Deterministic repro for the G1 counterexample TLC finds in formal/workspace-goals/
// (WorkspaceGoals.tla, check.sh). G1 is fixed: its test fails at its "Target assertion" with the
// fix reverted. The paired control runs the same harness without the racing step.
import * as path from "path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Config } from "@/node/config";
import type { GoalRecordV1 } from "@/common/types/goal";
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
