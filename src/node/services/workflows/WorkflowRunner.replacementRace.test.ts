/* eslint-disable @typescript-eslint/require-await */
/**
 * G2: two live runners race to replace ONE retired attempt, on real stores and real TaskServices
 * (two Config instances on one Xum root, i.e. two backends). Whatever the crash cut, exactly one
 * replacement is published and the workflow journal names it. Also: a replacement whose launch
 * fails is recovered once, by retry-from-checkpoint.
 *
 * Runner A is stalled (its lease renewals hang) at a cut; runner B runs on a clock 60 s ahead, so
 * A's lease reads as stale to B without real waits. Launch is stubbed (startReservedAgentTask);
 * reservation, claim and the single-use publishing commit are the real TaskService code.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Ok, type Result } from "@/common/types/result";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import { Config } from "@/node/config";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { writeSubagentAttemptSettlementReceipt } from "@/node/services/subagentAttemptSettlements";
import type { TaskService } from "@/node/services/taskService";
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
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { WorkflowRunStore } from "./WorkflowRunStore";
import { WorkflowPriorAttemptUnresolvedError, WorkflowRunner } from "./WorkflowRunner";
import {
  WorkflowTaskServiceAdapter,
  type WorkflowTaskServiceAdapterOptions,
} from "./WorkflowTaskServiceAdapter";
import { hashWorkflowStepInput } from "./workflowReplayKey";

type TaskServiceLike = WorkflowTaskServiceAdapterOptions["taskService"];

const RUN_ID = "wfr_replacement_race";
const PARENT_ID = "parentrace01";
const PRIOR = "priorchild01";
const PRIOR_ATTEMPT = "att_00000000000000f7";
const STEP_ID = "summarize";
const STALE_LEASE_MS = 100;
const OWNER_A = `workflow-runner:${PARENT_ID}:${RUN_ID}:aaaaaaaaaaaaaaaa`;
const OWNER_B = `workflow-runner:${PARENT_ID}:${RUN_ID}:bbbbbbbbbbbbbbbb`;
const SOURCE = `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "${STEP_ID}" });
  return { reportMarkdown: "Final: " + summary };
}
`;
const stepSpec = { id: STEP_ID, prompt: "Summarize durable workflows", markdownOnly: true };
/** Several real runners, stores and TaskServices per test: generous under a loaded CI host. */
const RACE_TEST_TIMEOUT_MS = 30_000;

interface LaunchInternals {
  materializeReservedTaskWorkspace: (...args: unknown[]) => Promise<unknown>;
  cleanupMaterializedTaskWorkspace: (...args: unknown[]) => Promise<void>;
}

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function settle(promise: Promise<unknown>) {
  try {
    return { kind: "resolved" as const, value: await promise };
  } catch (error) {
    return { kind: "rejected" as const, error };
  }
}

/** Store whose lease renewals can be stalled: the holder is alive but cannot renew. */
class StallableRenewalStore extends WorkflowRunStore {
  private renewalStall: Promise<void> | null = null;
  private readonly releaseStall = createDeferred();

  stallRenewals(): void {
    this.renewalStall = this.releaseStall.promise;
  }

  unstallRenewals(): void {
    this.releaseStall.resolve();
  }

  override async renewLease(runId: string, ownerId: string, nowMs?: number): Promise<boolean> {
    if (this.renewalStall != null) {
      await this.renewalStall;
      return false;
    }
    return await super.renewLease(runId, ownerId, nowMs);
  }
}

describe("replacing one retired attempt across runners (G2)", () => {
  let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;

  beforeEach(async () => {
    fixture = await createTestHistoryService();
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  /** The prior child ended without a report in an earlier process: row + parent receipt. */
  async function setup() {
    const config = fixture.config;
    await fs.mkdir(config.srcDir, { recursive: true });
    const projectPath = await createTestProject(fixture.tempDir, "repo", { initGit: false });
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", PARENT_ID, { runtimeConfig: { type: "local" } }),
        projectWorkspace(projectPath, PRIOR, PRIOR, {
          parentWorkspaceId: PARENT_ID,
          agentType: "exec",
          agentId: "exec",
          taskStatus: "interrupted",
          taskAttemptId: PRIOR_ATTEMPT,
          taskModelString: "openai:gpt-5.2",
          runtimeConfig: { type: "local" },
          workflowTask: { runId: RUN_ID, stepId: STEP_ID },
        }),
      ],
      testTaskSettings(4, 3)
    );
    const receipt = await writeSubagentAttemptSettlementReceipt({
      ownerWorkspaceSessionDirs: [path.join(config.sessionsDir, PARENT_ID)],
      receipt: {
        taskId: PRIOR,
        attemptId: PRIOR_ATTEMPT,
        parentWorkspaceId: PARENT_ID,
        source: "execution-settled",
        settledAt: "2026-09-25T00:00:00.000Z",
      },
    });
    expect(receipt.success).toBe(true);
    const sessionDir = path.join(config.sessionsDir, PARENT_ID);
    const storeA = new StallableRenewalStore({ sessionDir, staleLeaseMs: STALE_LEASE_MS });
    const storeB = new WorkflowRunStore({ sessionDir, staleLeaseMs: STALE_LEASE_MS });
    await storeA.createRun({
      id: RUN_ID,
      workspaceId: PARENT_ID,
      workflow: {
        name: "deep-research",
        description: "Research a topic",
        scope: "built-in",
        executable: true,
      },
      source: SOURCE,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    // Crash replay: the step's checkpoint names the prior child.
    await storeA.appendStatus(RUN_ID, "running", "2026-05-29T00:00:00.100Z");
    await storeA.recordStepStarted(RUN_ID, {
      stepId: STEP_ID,
      inputHash: hashWorkflowStepInput(STEP_ID, stepSpec),
      taskId: PRIOR,
      startedAt: "2026-05-29T00:00:00.500Z",
    });
    return { config, storeA, storeB };
  }

  /**
   * One backend: a real TaskService on its own Config (launch stubbed), exposed through the task
   * service surface the workflow adapter uses; reports are answered by a gate.
   */
  function backend(config: Config, replacementId: string) {
    stubStableIds(config, [replacementId]);
    const { taskService } = createTaskServiceStack(config, {
      historyService: fixture.historyService,
    });
    spyOn(
      taskService as unknown as { startReservedAgentTask: () => Promise<void> },
      "startReservedAgentTask"
    ).mockImplementation(() => Promise.resolve());
    const hooks: {
      afterClaim?: () => Promise<void>;
      afterCheckpoint?: () => Promise<void>;
    } = {};
    let createManyCalls = 0;
    const service: TaskServiceLike = {
      create: async () => {
        throw new Error("a replacement must be reserved through createMany");
      },
      createMany: async (args, options) => {
        createManyCalls += 1;
        return await taskService.createMany(args as Parameters<TaskService["createMany"]>[0], {
          ...options,
          onTaskReserved: async (index, result) => {
            await options?.onTaskReserved?.(index, result);
            await hooks.afterCheckpoint?.();
          },
        });
      },
      readAttemptOutcome: (taskId, options) => taskService.readAttemptOutcome(taskId, options),
      claimRetiredAttempt: async (taskId, attemptId, claimant) => {
        const claimed = await taskService.claimRetiredAttempt(taskId, attemptId, claimant);
        await hooks.afterClaim?.();
        return claimed;
      },
      waitForAgentReport: async (taskId) => ({ reportMarkdown: `report from ${taskId}` }),
    };
    return { service, hooks, createManyCalls: () => createManyCalls };
  }

  function runner(
    store: WorkflowRunStore,
    service: TaskServiceLike,
    ownerId: string,
    offsetMs = 0
  ) {
    return new WorkflowRunner({
      runStore: store,
      runtimeFactory: new QuickJSRuntimeFactory(),
      taskAdapter: new WorkflowTaskServiceAdapter({
        taskService: service,
        parentWorkspaceId: PARENT_ID,
        workflowRunId: RUN_ID,
        defaultAgentId: "exec",
      }),
      runnerId: ownerId,
      clock: {
        nowIso: () => new Date(Date.now() + offsetMs).toISOString(),
        nowMs: () => Date.now() + offsetMs,
      },
    });
  }

  /** Published children of the step (rows the config holds for it), besides the prior one. */
  function publishedReplacements(config: Config): string[] {
    const ids: string[] = [];
    for (const project of config.loadConfigOrDefault().projects.values()) {
      for (const ws of project.workspaces) {
        if (ws.workflowTask?.stepId === STEP_ID && ws.id != null && ws.id !== PRIOR)
          ids.push(ws.id);
      }
    }
    return ids.sort();
  }

  const journalChild = (run: WorkflowRunRecord) =>
    run.steps.filter((step) => step.stepId === STEP_ID).at(-1)?.taskId;

  // A classified the prior child (journal: step failed), claimed it, and stalled before reserving.
  // B's resume re-runs that FAILED checkpoint with a fresh reservation (today's failed-checkpoint
  // behavior). In this window the LEASE, not the claim, is the fence: A, having lost it, can no
  // longer checkpoint or reserve, so exactly one child is published and the journal names it.
  // Interim gap until G2 PR B2 (failed-checkpoint consultation) closes the ordering: B's
  // reservation neither re-claims the prior attempt nor consumes a claim, so A's claim stays live.
  test(
    "cut after A's claim: B re-runs the failed checkpoint and publishes; A publishes nothing",
    async () => {
      const { config, storeA, storeB } = await setup();
      const a = backend(config, "replacementa");
      const b = backend(new Config(config.rootDir), "replacementb");
      const aClaimed = createDeferred();
      const resumeA = createDeferred();
      a.hooks.afterClaim = async () => {
        aClaimed.resolve();
        await resumeA.promise;
      };
      storeA.stallRenewals();
      const runA = settle(runner(storeA, a.service, OWNER_A).run(RUN_ID));
      await aClaimed.promise;

      const runB = await settle(runner(storeB, b.service, OWNER_B, 60_000).run(RUN_ID));
      expect(runB).toEqual({
        kind: "resolved",
        value: { reportMarkdown: "Final: report from replacementb" },
      });
      resumeA.resolve();
      storeA.unstallRenewals();
      await runA;

      // Exactly one published child, and the journal names it; A never reached a reservation.
      expect(publishedReplacements(config)).toEqual(["replacementb"]);
      expect(journalChild(await storeB.getRun(RUN_ID))).toBe("replacementb");
      expect(a.createManyCalls()).toBe(0);
      expect(b.createManyCalls()).toBe(1);
      // B2 flips this: B's re-run will claim the prior attempt again and consume that claim.
      expect(findWorkspaceInConfig(config, PRIOR)?.taskAttemptRetiredBy).toMatchObject({
        attemptId: PRIOR_ATTEMPT,
      });
      expect(
        findWorkspaceInConfig(config, PRIOR)?.taskAttemptRetiredBy?.replacementTaskId
      ).toBeUndefined();
    },
    RACE_TEST_TIMEOUT_MS
  );

  test(
    "cut after A's checkpoint, before its commit: B finds an unpublished child and stays out",
    async () => {
      const { config, storeA, storeB } = await setup();
      const a = backend(config, "replacementa");
      const b = backend(new Config(config.rootDir), "replacementb");
      const aCheckpointed = createDeferred();
      const resumeA = createDeferred();
      a.hooks.afterCheckpoint = async () => {
        aCheckpointed.resolve();
        await resumeA.promise;
      };
      storeA.stallRenewals();
      const runA = settle(runner(storeA, a.service, OWNER_A).run(RUN_ID));
      await aCheckpointed.promise;

      const runB = await settle(runner(storeB, b.service, OWNER_B, 60_000).run(RUN_ID));
      expect(runB.kind === "rejected" && runB.error).toBeInstanceOf(
        WorkflowPriorAttemptUnresolvedError
      );
      expect(b.createManyCalls()).toBe(0);
      resumeA.resolve();
      storeA.unstallRenewals();
      await runA;

      expect(publishedReplacements(config)).toEqual(["replacementa"]);
      expect(journalChild(await storeB.getRun(RUN_ID))).toBe("replacementa");
      expect(findWorkspaceInConfig(config, PRIOR)?.taskAttemptRetiredBy).toMatchObject({
        replacementTaskId: "replacementa",
      });
    },
    RACE_TEST_TIMEOUT_MS
  );

  /**
   * One backend whose reserved launch fails sanitization (real startReservedAgentTask; only the
   * checkout materialization and the host are stubbed). Sends are recorded; a sent child
   * "reports" at once, anything else waits on the real TaskService.
   */
  function launchingBackend(config: Config, replacementId: string, sanitizeError?: string) {
    stubStableIds(config, [replacementId]);
    const sent = new Set<string>();
    const { workspaceService } = createWorkspaceServiceMocks({
      sendMessage: mock((id: string): Promise<Result<void>> => {
        sent.add(id);
        return Promise.resolve(Ok(undefined));
      }),
    });
    spyOn(workspaceService, "sanitizeMaterializedTaskWorkspace").mockImplementation(() =>
      Promise.resolve(sanitizeError)
    );
    const { taskService } = createTaskServiceStack(config, {
      historyService: fixture.historyService,
      workspaceService,
    });
    const internals = taskService as unknown as LaunchInternals;
    spyOn(internals, "cleanupMaterializedTaskWorkspace").mockImplementation(() =>
      Promise.resolve()
    );
    spyOn(internals, "materializeReservedTaskWorkspace").mockImplementation(() =>
      Promise.resolve({
        workspacePath: config.srcDir,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        runtimeForTaskWorkspace: {
          deleteWorkspace: mock(() => Promise.resolve(Ok(undefined))),
          getWorkspacePath: () => config.srcDir,
        },
        inheritedProjects: undefined,
      })
    );
    const service: TaskServiceLike = {
      create: async () => {
        throw new Error("a replacement must be reserved through createMany");
      },
      createMany: (args, options) =>
        taskService.createMany(args as Parameters<TaskService["createMany"]>[0], options),
      readAttemptOutcome: (taskId, options) => taskService.readAttemptOutcome(taskId, options),
      claimRetiredAttempt: (taskId, attemptId, claimant) =>
        taskService.claimRetiredAttempt(taskId, attemptId, claimant),
      waitForAgentReport: async (taskId, options) => {
        const abort = new AbortController();
        const real = taskService
          .waitForAgentReport(taskId, { ...options, abortSignal: abort.signal })
          .then(
            (report) => ({ report }),
            (error: unknown) => ({ error })
          );
        for (let i = 0; i < 2000; i++) {
          if (sent.has(taskId)) {
            abort.abort();
            await real;
            return { reportMarkdown: `report from ${taskId}` };
          }
          const settled = await Promise.race([
            real,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 5)),
          ]);
          if (settled != null) {
            if ("error" in settled) throw settled.error;
            return settled.report;
          }
        }
        throw new Error(`no send or settlement for ${taskId}`);
      },
    };
    return service;
  }

  // A replacement whose launch fails sanitization loses its row, but the prior row keeps the
  // spent claim (replacementTaskId names the removed row). That dangling id is never re-claimed:
  // the replacement's checkpoint precedes its publishing commit, so the journal already names
  // the replacement, and recovery is retry-from-checkpoint's fresh reservation.
  test(
    "a replacement that fails sanitization is recovered by retry-from-checkpoint, exactly once",
    async () => {
      const { config, storeA, storeB } = await setup();
      const first = await settle(
        runner(storeA, launchingBackend(config, "replacement1", "sanitize failed"), OWNER_A).run(
          RUN_ID
        )
      );
      expect(first.kind).toBe("rejected");
      const failedRun = await storeA.getRun(RUN_ID);
      expect(failedRun.status).toBe("failed");
      expect(journalChild(failedRun)).toBe("replacement1");
      expect(publishedReplacements(config)).toEqual([]);
      expect(findWorkspaceInConfig(config, PRIOR)?.taskAttemptRetiredBy).toMatchObject({
        replacementTaskId: "replacement1",
      });

      // A fresh process: a plain resume refuses the failed run; retry-from-checkpoint recovers it.
      const restarted = new Config(config.rootDir);
      const second = launchingBackend(restarted, "replacement2");
      expect((await settle(runner(storeB, second, OWNER_B).run(RUN_ID))).kind).toBe("rejected");
      expect(
        await runner(storeB, second, OWNER_B).run(RUN_ID, { allowRetryFromFailedCheckpoint: true })
      ).toEqual({ reportMarkdown: "Final: report from replacement2" });
      expect(publishedReplacements(restarted)).toEqual(["replacement2"]);
      const recovered = await storeB.getRun(RUN_ID);
      expect(recovered.status).toBe("completed");
      expect(journalChild(recovered)).toBe("replacement2");
      // The dangling claim was not re-claimed (the retry reserved fresh).
      expect(findWorkspaceInConfig(restarted, PRIOR)?.taskAttemptRetiredBy).toMatchObject({
        replacementTaskId: "replacement1",
      });
    },
    RACE_TEST_TIMEOUT_MS
  );
});
