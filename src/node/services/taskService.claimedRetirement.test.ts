import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fsPromises from "fs/promises";
import * as path from "path";

import { configFilePath, type Config } from "@/node/config";
import { type Workspace as WorkspaceConfigEntry } from "@/node/config";
import { retiredAttemptMessage } from "@/constants/agentMessaging";
import { Ok, type Result } from "@/common/types/result";
import { writeSubagentAttemptSettlementReceipt } from "@/node/services/subagentAttemptSettlements";
import {
  getSubagentFailureArtifactsFilePath,
  upsertSubagentFailureArtifact,
} from "@/node/services/subagentFailureArtifacts";
import { upsertSubagentReportArtifact } from "@/node/services/subagentReportArtifacts";
import type { TaskService } from "@/node/services/taskService";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import {
  createTaskServiceStack,
  createTestProject,
  createWorkspaceServiceMocks,
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
  startReservedAgentTask: (...args: unknown[]) => Promise<void>;
  markTaskLaunchFailed: (...args: unknown[]) => Promise<void>;
}

/**
 * Pass-through spy on a private async step: the real method runs unchanged, and `firstCall`
 * resolves (with the promise that call returned) as soon as the step is first entered, so a test
 * awaits exactly the call it depends on instead of polling. With `hold`, the real call starts
 * only once the test resolves it.
 */
function observeFirstCall(
  svc: Internals,
  key: keyof Internals,
  hold?: Promise<void>
): { spy: ReturnType<typeof spyOn>; firstCall: Promise<{ run: Promise<void> }> } {
  const real = svc[key].bind(svc);
  const entered = Promise.withResolvers<{ run: Promise<void> }>();
  const spy = spyOn(svc, key).mockImplementation((...args: unknown[]) => {
    const run = hold ? hold.then(() => real(...args)) : real(...args);
    entered.resolve({ run });
    return run;
  });
  return { spy, firstCall: entered.promise };
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

    test("a terminal failure's artifact marks the outcome, and a damaged one proves nothing", async () => {
      const config = await setupChild("refused");
      await writeReceipt(config, midId, "refused");
      const failures = getSubagentFailureArtifactsFilePath(path.join(config.sessionsDir, midId));
      await fsPromises.writeFile(failures, "{ not json", "utf-8");
      expect(await read(otherProcess(config), "refused")).toMatchObject({
        kind: "indeterminate",
      });
      await fsPromises.rm(failures);
      await upsertSubagentFailureArtifact({
        workspaceId: midId,
        workspaceSessionDir: path.join(config.sessionsDir, midId),
        childTaskId: "refused",
        parentWorkspaceId: midId,
        ancestorWorkspaceIds: [midId, rootId],
        errorType: "model_refusal",
        errorMessage: "refused by the model",
      });
      expect(await read(otherProcess(config), "refused")).toEqual({
        kind: "terminal-no-report",
        attemptId: ATTEMPT,
        failure: { errorMessage: "refused by the model" },
      });
    });

    test("no-record needs a strict read: a missing row in a well-formed config, never a damaged one", async () => {
      const config = await setupChild("present");
      const noRecord = {
        kind: "indeterminate",
        reason: "no task record and no attempt owned by this process",
        code: "no-record",
      } as const;
      expect(await read(otherProcess(config), "absent")).toEqual(noRecord);
      await fsPromises.writeFile(configFilePath(config.rootDir), "{ not json", "utf-8");
      const damaged = await read(otherProcess(config), "absent");
      expect(damaged.kind).toBe("indeterminate");
      expect(damaged.kind === "indeterminate" && damaged.code).toBeUndefined();
      await fsPromises.rm(configFilePath(config.rootDir));
      expect(await read(otherProcess(config), "absent")).toEqual(noRecord);
    });

    test("the row's terminal-failure marker counts only for the attempt it names", async () => {
      const config = await setupChild("marked", {
        taskLaunchError: "refused by the model",
        taskTerminalFailure: { attemptId: ATTEMPT, errorType: "model_refusal" },
      });
      await writeReceipt(config, midId, "marked");
      // No failure artifact (its write failed): the marker still makes it a failure.
      expect(await read(otherProcess(config), "marked")).toEqual({
        kind: "terminal-no-report",
        attemptId: ATTEMPT,
        failure: { errorMessage: "refused by the model" },
      });

      // A marker left by an earlier attempt: the current attempt's no-report stays replaceable.
      const stale = await setupChild("stalemarker", {
        taskLaunchError: "refused by the model",
        taskTerminalFailure: { attemptId: "att_00000000000000c0", errorType: "model_refusal" },
      });
      await writeReceipt(stale, midId, "stalemarker");
      expect(await read(otherProcess(stale), "stalemarker")).toEqual({
        kind: "terminal-no-report",
        attemptId: ATTEMPT,
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
      // Held, not stubbed: the claim must be proven spent by the publishing write alone, so the
      // real launch of the replacement waits until those assertions ran; the test then releases
      // it and awaits it so it never outlives the temp root.
      const releaseLaunch = Promise.withResolvers<void>();
      const launch = observeFirstCall(
        taskService as unknown as Internals,
        "startReservedAgentTask",
        releaseLaunch.promise
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

      releaseLaunch.resolve();
      const { run: launched } = await launch.firstCall;
      await launched;
      expect(launch.spy).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Gate 4 at the TaskService/host seam: every send, resume and plugin-override sanitize the
   * replacement's launch issues is recorded in order. MCP activation for a task happens inside the
   * host's send/resume (AgentSession), so "no send or resume" here is the TaskService half of "no
   * MCP call"; prompt discovery issued by other callers is outside this seam.
   */
  describe("gate 4: replacement launch", () => {
    test.each([
      ["fails", "sanitize failed"],
      ["passes", undefined],
    ] as const)("when sanitization %s", async (_label, sanitizeResult) => {
      const config = await setupChild("retiredlaunch");
      const calls: string[] = [];
      const { workspaceService } = createWorkspaceServiceMocks({
        sendMessage: mock((id: string): Promise<Result<void>> => {
          calls.push(`send:${id}`);
          return Promise.resolve(Ok(undefined));
        }),
        resumeStream: mock((id: string): Promise<Result<{ started: boolean }>> => {
          calls.push(`resume:${id}`);
          return Promise.resolve(Ok({ started: true }));
        }),
      });
      spyOn(workspaceService, "sanitizeMaterializedTaskWorkspace").mockImplementation(
        (id: string) => {
          calls.push(`sanitize:${id}`);
          return Promise.resolve(sanitizeResult);
        }
      );
      const { taskService } = createTaskServiceStack(config, {
        historyService: fixture.historyService,
        workspaceService,
      });
      const svc = taskService as unknown as Internals;
      // Real launch and real project-dir materialization (the local runtime "forks" into the
      // project directory), observed through pass-through spies the test awaits.
      const launch = observeFirstCall(svc, "startReservedAgentTask");
      const markFailed = observeFirstCall(svc, "markTaskLaunchFailed");

      const claim = await taskService.claimRetiredAttempt("retiredlaunch", ATTEMPT, RUN);
      assert(claim.success, "claim must succeed");
      stubStableIds(config, ["replacementlaunch"]);
      const created = await taskService.createMany(
        [
          {
            parentWorkspaceId: midId,
            kind: "agent",
            agentId: "explore",
            prompt: "go",
            title: "Replacement",
            workflowTask: { runId: RUN.runId, stepId: RUN.stepId },
          },
        ],
        { retires: [{ taskId: "retiredlaunch", attemptId: ATTEMPT, nonce: claim.data.nonce }] }
      );
      expect(created.success).toBe(true);
      const { run: launched } = await launch.firstCall;
      if (sanitizeResult === undefined) {
        await launched;
      } else {
        // A reserved launch that cannot sanitize rejects; the dispatcher then marks it failed.
        const failure = await launched.then(
          () => null,
          (error: unknown) => error
        );
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(sanitizeResult);
        const { run: markingFailed } = await markFailed.firstCall;
        await markingFailed;
        // It reclaims its checkout and unpublishes the row.
        expect(findWorkspaceInConfig(config, "replacementlaunch")).toBeUndefined();
      }
      expect(launch.spy).toHaveBeenCalledTimes(1);
      expect(markFailed.spy).toHaveBeenCalledTimes(sanitizeResult === undefined ? 0 : 1);

      expect(calls).toEqual(
        sanitizeResult === undefined
          ? ["sanitize:replacementlaunch", "send:replacementlaunch"]
          : ["sanitize:replacementlaunch"]
      );
      // The retired child is never sent into, resumed or reactivated.
      expect(findWorkspaceInConfig(config, "retiredlaunch")).toMatchObject({
        taskStatus: "interrupted",
        taskAttemptId: ATTEMPT,
        taskAttemptRetiredBy: { replacementTaskId: "replacementlaunch" },
      });
    });
  });
});
