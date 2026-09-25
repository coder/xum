import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "fs/promises";
import * as path from "path";

import type { Config } from "@/node/config";
import { type Workspace as WorkspaceConfigEntry } from "@/node/config";
import { retiredAttemptMessage } from "@/constants/agentMessaging";
import { writeSubagentAttemptSettlementReceipt } from "@/node/services/subagentAttemptSettlements";
import { upsertSubagentReportArtifact } from "@/node/services/subagentReportArtifacts";
import type { TaskService } from "@/node/services/taskService";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import {
  createTaskServiceStack,
  createTestProject,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";

/**
 * G2 PR B (TaskService side): the cross-process classifier branch, the workflow claim that
 * retires an attempt, and single-use publication of its replacement. Tree: root → mid → child;
 * the child's parent (the receipt copy that counts) is mid.
 */
const rootId = "root-retire";
const midId = "mid-retire";
const ATTEMPT = "att_00000000000000c1";
const RUN = { runId: "wfr_retire", stepId: "summarize", inputHash: "hash-1" };

interface Internals {
  startReservedAgentTask: (plan: unknown) => Promise<void>;
}

describe("TaskService claimed retirement (G2 PR B)", () => {
  let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;

  beforeEach(async () => {
    fixture = await createTestHistoryService();
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  async function setupChild(id: string, overrides: Partial<WorkspaceConfigEntry> = {}) {
    const config = fixture.config;
    await fsPromises.mkdir(config.srcDir, { recursive: true });
    const projectPath = await createTestProject(fixture.tempDir, "repo", { initGit: false });
    const task = (taskId: string, parent: string, extra: Partial<WorkspaceConfigEntry>) =>
      projectWorkspace(projectPath, taskId, taskId, {
        parentWorkspaceId: parent,
        agentType: "explore",
        agentId: "explore",
        taskModelString: "openai:gpt-5.2",
        runtimeConfig: { type: "local" },
        ...extra,
      });
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId, { runtimeConfig: { type: "local" } }),
        task(midId, rootId, { taskStatus: "running" }),
        task(id, midId, {
          taskStatus: "interrupted",
          taskAttemptId: ATTEMPT,
          workflowTask: { runId: RUN.runId, stepId: RUN.stepId },
          ...overrides,
        }),
      ],
      testTaskSettings(4, 3)
    );
    return config;
  }

  /** A second backend (fresh process): owns no attempt, sees only durable state. */
  function otherProcess(config: Config): TaskService {
    return createTaskServiceStack(config, { historyService: fixture.historyService }).taskService;
  }

  async function writeReceipt(
    config: Config,
    ownerId: string,
    taskId: string,
    attemptId = ATTEMPT
  ) {
    const written = await writeSubagentAttemptSettlementReceipt({
      ownerWorkspaceSessionDirs: [path.join(config.sessionsDir, ownerId)],
      receipt: {
        taskId,
        attemptId,
        parentWorkspaceId: midId,
        source: "idle-settled",
        settledAt: "2026-09-25T00:00:00.000Z",
      },
    });
    expect(written.success).toBe(true);
  }

  const read = (taskService: TaskService, taskId: string) =>
    taskService.readAttemptOutcome(taskId, { requestingWorkspaceId: midId });

  describe("classifier", () => {
    test("another process reads the parent's receipt for the row's current attempt as terminal-no-report", async () => {
      const config = await setupChild("proven");
      await writeReceipt(config, midId, "proven");
      expect(await read(otherProcess(config), "proven")).toEqual({
        kind: "terminal-no-report",
        attemptId: ATTEMPT,
      });
    });

    test("a report outranks a receipt", async () => {
      const config = await setupChild("reportedtoo");
      await writeReceipt(config, midId, "reportedtoo");
      await upsertSubagentReportArtifact({
        workspaceId: midId,
        workspaceSessionDir: path.join(config.sessionsDir, midId),
        childTaskId: "reportedtoo",
        parentWorkspaceId: midId,
        ancestorWorkspaceIds: [midId, rootId],
        reportMarkdown: "done after all",
      });
      expect(await read(otherProcess(config), "reportedtoo")).toMatchObject({
        kind: "reported",
        report: { reportMarkdown: "done after all" },
      });
    });

    test.each([
      ["only an ancestor holds the receipt", {}, rootId, ATTEMPT],
      ["the receipt names an older attempt", {}, midId, "att_00000000000000c0"],
      ["the lineage is marked unproven", { taskAttemptUnproven: true as const }, midId, ATTEMPT],
      ["the row is not interrupted", { taskStatus: "queued" as const }, midId, ATTEMPT],
    ])("no proof when %s", async (_label, overrides, owner, receiptAttempt) => {
      const config = await setupChild("unproven", overrides);
      await writeReceipt(config, owner, "unproven", receiptAttempt);
      expect((await read(otherProcess(config), "unproven")).kind).toBe("indeterminate");
    });
  });

  describe("claim", () => {
    test("grants a nonce-stamped claim once, re-stamps it for the same step, and refuses others", async () => {
      const config = await setupChild("claimed");
      const taskService = otherProcess(config);
      const first = await taskService.claimRetiredAttempt("claimed", ATTEMPT, RUN);
      expect(first.success).toBe(true);
      const firstNonce = first.success ? first.data.nonce : "";
      expect(findWorkspaceInConfig(config, "claimed")?.taskAttemptRetiredBy).toMatchObject({
        ...RUN,
        childTaskId: "claimed",
        attemptId: ATTEMPT,
        mode: "no-report",
        nonce: firstNonce,
      });
      // Every admission of the retired attempt refuses.
      expect(await taskService.markInterruptedTaskRunning("claimed")).toBe(false);
      expect(taskService.admitTaskWorkspaceTurn("claimed", { acceptanceOrigin: "manual" })).toEqual(
        { kind: "refused", message: retiredAttemptMessage(RUN) }
      );
      // A crashed runner's retry of the same step re-stamps: the old nonce can no longer publish.
      const again = await taskService.claimRetiredAttempt("claimed", ATTEMPT, RUN);
      expect(again.success && again.data.nonce !== firstNonce).toBe(true);
      expect(
        (await taskService.claimRetiredAttempt("claimed", ATTEMPT, { ...RUN, stepId: "other" }))
          .success
      ).toBe(false);
      expect(
        (await taskService.claimRetiredAttempt("claimed", "att_00000000000000c9", RUN)).success
      ).toBe(false);
    });

    test("refuses a running attempt and a missing task", async () => {
      const config = await setupChild("running", { taskStatus: "running" });
      const taskService = otherProcess(config);
      expect(await taskService.claimRetiredAttempt("running", ATTEMPT, RUN)).toMatchObject({
        success: false,
      });
      expect(await taskService.claimRetiredAttempt("gone", ATTEMPT, RUN)).toMatchObject({
        success: false,
      });
      expect(findWorkspaceInConfig(config, "running")?.taskAttemptRetiredBy).toBeUndefined();
    });
  });

  describe("single-use publication", () => {
    const spawn = {
      parentWorkspaceId: midId,
      kind: "agent",
      agentId: "explore",
      prompt: "go",
      title: "Replacement",
      workflowTask: { runId: RUN.runId, stepId: RUN.stepId },
    } as const;

    test("the replacement consumes the claim in its publishing write; a stale or reused claim publishes nothing", async () => {
      const config = await setupChild("retired");
      const { taskService } = createTaskServiceStack(config, {
        historyService: fixture.historyService,
      });
      spyOn(taskService as unknown as Internals, "startReservedAgentTask").mockImplementation(() =>
        Promise.resolve()
      );
      const stale = await taskService.claimRetiredAttempt("retired", ATTEMPT, RUN);
      const claim = await taskService.claimRetiredAttempt("retired", ATTEMPT, RUN);
      expect(stale.success && claim.success).toBe(true);
      if (!stale.success || !claim.success) return;

      // A runner holding the re-stamped (stale) nonce: the whole reservation fails.
      stubStableIds(config, ["replacementstale"]);
      const staleCreate = await taskService.createMany([spawn], {
        retires: [{ taskId: "retired", attemptId: ATTEMPT, nonce: stale.data.nonce }],
      });
      expect(staleCreate.success).toBe(false);
      expect(findWorkspaceInConfig(config, "replacementstale")).toBeUndefined();
      expect(
        findWorkspaceInConfig(config, "retired")?.taskAttemptRetiredBy?.replacementTaskId
      ).toBeUndefined();

      stubStableIds(config, ["replacementone"]);
      const created = await taskService.createMany([spawn], {
        retires: [{ taskId: "retired", attemptId: ATTEMPT, nonce: claim.data.nonce }],
      });
      expect(created.success).toBe(true);
      expect(findWorkspaceInConfig(config, "replacementone")).toBeDefined();
      expect(findWorkspaceInConfig(config, "retired")?.taskAttemptRetiredBy).toMatchObject({
        nonce: claim.data.nonce,
        replacementTaskId: "replacementone",
      });

      // The claim is spent: a second replacement with it, or a new claim, is refused.
      stubStableIds(config, ["replacementtwo"]);
      const second = await taskService.createMany([spawn], {
        retires: [{ taskId: "retired", attemptId: ATTEMPT, nonce: claim.data.nonce }],
      });
      expect(second.success).toBe(false);
      expect(findWorkspaceInConfig(config, "replacementtwo")).toBeUndefined();
      expect((await taskService.claimRetiredAttempt("retired", ATTEMPT, RUN)).success).toBe(false);
    });
  });
});
