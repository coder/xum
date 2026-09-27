import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "path";

import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import { Err, Ok } from "@/common/types/result";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { HistoryService } from "@/node/services/historyService";
import type { TaskService } from "@/node/services/taskService";
import {
  createTaskServiceStack,
  createTestConfig,
  createTestProject,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import {
  createDeferred,
  createMockAIService,
  createWorkspaceServiceForTest,
} from "@/node/services/workspaceService.testHarness";
import { workspaceUseLeasesFor } from "@/node/services/workspaceUseLeases";
import { getSelfIdentity } from "@/node/utils/concurrency/processLiveness";

// #4478: two backends on one Xum root (the desktop app beside a `xum server`, or
// XUM_ALLOW_MULTIPLE_INSTANCES) each run their own in-process locks, so a removal decided by one
// backend must close admission durably on the row before any destructive effect.

// Captured before the per-test spy: the child-creation test resolves agents through a real runtime.
const realCreateRuntime = runtimeFactory.createRuntime;

const rootId = "root-removal";
const taskId = "leaf-removal";
const firstAttemptId = "att_00000000000000a1";

interface Backend {
  config: Config;
  workspaceService: WorkspaceService;
  taskService: TaskService;
}

/** One backend's real service stack: its own Config, HistoryService, WorkspaceService and TaskService. */
function createBackend(config: Config, historyService: HistoryService): Backend {
  // Metadata is answered from this backend's Config, as AIService does.
  const aiService = createMockAIService({
    getWorkspaceMetadata: mock(async (workspaceId: string) => {
      const metadata = await config.getWorkspaceMetadataById(workspaceId);
      return metadata ? Ok(metadata) : Err(`Workspace metadata not found for ${workspaceId}`);
    }),
  });
  const workspaceService = createWorkspaceServiceForTest({ config, historyService, aiService });
  const { taskService } = createTaskServiceStack(config, {
    historyService,
    workspaceService: workspaceService as unknown as WorkspaceHost,
  });
  workspaceService.setAgentTaskIntegration(
    taskService as unknown as Parameters<WorkspaceService["setAgentTaskIntegration"]>[0]
  );
  return { config, workspaceService, taskService };
}

function rowOf(config: Config, id: string): WorkspaceConfigEntry | undefined {
  return findWorkspaceInConfig(config, id);
}

describe("workspace removal across two backends on one root", () => {
  let cleanupFixture: () => Promise<void>;
  let a: Backend;
  let b: Backend;
  let deleteWorkspace: ReturnType<typeof mock>;

  beforeEach(async () => {
    const fixture = await createTestHistoryService();
    cleanupFixture = fixture.cleanup;
    const projectPath = await createTestProject(fixture.tempDir, "repo", { initGit: false });
    await saveWorkspaces(
      fixture.config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId, { runtimeConfig: { type: "local" } }),
        projectWorkspace(projectPath, taskId, taskId, {
          parentWorkspaceId: rootId,
          agentType: "explore",
          agentId: "explore",
          taskStatus: "reported",
          taskModelString: "openai:gpt-5.2",
          taskAttemptId: firstAttemptId,
          // Workflow-owned: the only kind of reported leaf the automatic clean-up removes.
          workflowTask: { runId: "wfr_removal", stepId: "step" },
          runtimeConfig: {
            type: "worktree",
            srcBaseDir: path.join(fixture.tempDir, "src"),
          },
        }),
      ],
      testTaskSettings()
    );
    a = createBackend(fixture.config, fixture.historyService);
    const configB = await createTestConfig(fixture.tempDir);
    b = createBackend(configB, new HistoryService(configB));
    // The checkout deletion is the destructive effect every test watches.
    deleteWorkspace = mock(() => Promise.resolve({ success: true as const, deletedPath: "x" }));
    spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
  });

  afterEach(async () => {
    mock.restore();
    await cleanupFixture();
  });

  async function editRow(id: string, edit: (row: WorkspaceConfigEntry) => void): Promise<void> {
    await a.config.editConfig((config) => {
      edit(findWorkspaceEntry(config, id)!.workspace);
      return config;
    });
  }

  /** A marker left by a process that has exited: its owner is provably dead in this PID domain. */
  function deadOwnerMarker(): NonNullable<WorkspaceConfigEntry["pendingRemoval"]> {
    return {
      removalId: "removal-of-a-crashed-backend",
      instanceId: "instance-of-a-crashed-backend",
      pid: spawnSync(process.execPath, ["--version"]).pid,
      identity: getSelfIdentity(),
      at: new Date().toISOString(),
    };
  }

  /** Pause A's removal right after it closed admission (its first step after the marker). */
  function pauseRemovalAfterMarker(backend: Backend) {
    const reached = createDeferred<void>();
    const release = createDeferred<void>();
    const aiService = (
      backend.workspaceService as unknown as { aiService: { stopStream: () => unknown } }
    ).aiService;
    const stopStream = aiService.stopStream.bind(aiService);
    spyOn(aiService, "stopStream").mockImplementationOnce(async () => {
      reached.resolve();
      await release.promise;
      return stopStream();
    });
    return { reached: reached.promise, release: () => release.resolve() };
  }

  test("a leaf clean-up decided at one attempt refuses before the checkout once another backend reawakened it", async () => {
    const internals = a.taskService as unknown as {
      canCleanupReportedTask: (id: string, config?: unknown) => Promise<{ ok: boolean }>;
      cleanupReportedLeafTask: (id: string) => Promise<number>;
    };
    const canCleanup = internals.canCleanupReportedTask.bind(a.taskService);
    let calls = 0;
    let reawakenedAttemptId: string | undefined;
    spyOn(internals, "canCleanupReportedTask").mockImplementation(async (id, config) => {
      const result = await canCleanup(id, config);
      // The second call is remove()'s live check: A has decided, then B reawakens the task.
      if (++calls === 2) {
        const outcome = await b.taskService.reawakenInterruptedTask(taskId);
        expect(outcome.kind).toBe("reawakened");
        reawakenedAttemptId = outcome.kind === "reawakened" ? outcome.attemptId : undefined;
      }
      return result;
    });

    expect(await internals.cleanupReportedLeafTask(taskId)).toBe(0);

    expect(calls).toBe(2);
    expect(deleteWorkspace).not.toHaveBeenCalled();
    const row = rowOf(a.config, taskId);
    expect(row?.taskAttemptId).toBe(reawakenedAttemptId);
    expect(row?.pendingRemoval).toBeUndefined();
  });

  test("a model-driven removal refuses once another backend reawakened the task it checked", async () => {
    const patches = (
      a.taskService as unknown as { gitPatchArtifactService: { waitForGeneration: () => unknown } }
    ).gitPatchArtifactService;
    spyOn(patches, "waitForGeneration").mockImplementationOnce(async () => {
      // A has checked the task inactive; B reawakens it before A's removal claims the row.
      expect((await b.taskService.reawakenInterruptedTask(taskId)).kind).toBe("reawakened");
    });

    const result = await a.taskService.removeInactiveDescendantAgentTask(rootId, taskId);

    expect(result).toMatchObject({ success: true, data: { status: "error" } });
    expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(rowOf(a.config, taskId)?.taskAttemptId).not.toBe(firstAttemptId);
  });

  test("while one backend removes a task, the other refuses to admit, reawaken or remove it", async () => {
    const paused = pauseRemovalAfterMarker(a);
    const removal = a.workspaceService.remove(taskId, true);
    await paused.reached;
    expect(rowOf(b.config, taskId)?.pendingRemoval).toBeDefined();

    const reawaken = await b.taskService.reawakenInterruptedTask(taskId);
    expect(reawaken.kind === "refused" ? reawaken.message : reawaken.kind).toContain("removed");
    const admission = b.taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" });
    expect(admission).toMatchObject({ kind: "refused" });
    const otherRemoval = await b.workspaceService.remove(taskId, true);
    expect(otherRemoval.success).toBe(false);
    expect(otherRemoval.success ? "" : otherRemoval.error).toContain(`pid ${process.pid}`);
    expect(rowOf(b.config, taskId)?.taskAttemptId).toBe(firstAttemptId);
    expect(deleteWorkspace).not.toHaveBeenCalled();

    paused.release();
    expect((await removal).success).toBe(true);
    expect(deleteWorkspace).toHaveBeenCalledTimes(1);
    expect(rowOf(b.config, taskId)).toBeUndefined();
  });

  test("the other backend does not launch a queued task that is being removed", async () => {
    await editRow(taskId, (row) => {
      row.taskStatus = "queued";
      row.taskPrompt = "queued work";
      // A queued task of an inactive workflow run is interrupted instead of launched.
      delete row.workflowTask;
    });
    const launch = spyOn(
      b.taskService as unknown as { materializeReservedTaskWorkspace: () => Promise<unknown> },
      "materializeReservedTaskWorkspace"
    ).mockImplementation(() => Promise.reject(new Error("must not launch")));
    const paused = pauseRemovalAfterMarker(a);
    const removal = a.workspaceService.remove(taskId, true);
    await paused.reached;

    await b.taskService.maybeStartQueuedTasks();

    expect(launch).not.toHaveBeenCalled();
    expect(rowOf(b.config, taskId)).toMatchObject({
      taskStatus: "queued",
      taskAttemptId: firstAttemptId,
    });
    paused.release();
    expect((await removal).success).toBe(true);
  });

  test("a refused checkout deletion reopens admission for the other backend", async () => {
    deleteWorkspace.mockImplementation(() =>
      Promise.resolve({ success: false as const, error: "checkout busy" })
    );

    // Not forced: a forced removal deregisters the row even when the deletion fails.
    expect((await a.workspaceService.remove(taskId, false)).success).toBe(false);

    expect(rowOf(b.config, taskId)?.pendingRemoval).toBeUndefined();
    expect((await b.taskService.reawakenInterruptedTask(taskId)).kind).toBe("reawakened");
  });

  test("a removal marker on a root workspace refuses the other backend's sends", async () => {
    await editRow(rootId, (row) => {
      row.pendingRemoval = deadOwnerMarker();
    });

    const admission = b.taskService.admitTaskWorkspaceTurn(rootId, { acceptanceOrigin: "manual" });

    expect(admission).toMatchObject({ kind: "refused" });
  });

  // #4782 item 2: a child created under a workspace being removed would outlive its parent.
  const leafRootId = "root-without-children";

  /** A second root with no children, and a full task queue, so a child's config write is its only effect. */
  async function prepareChildlessRootWithQueuedCreation(): Promise<void> {
    await a.config.editConfig((config) => {
      const project = [...config.projects.values()][0];
      project.workspaces.push({
        ...projectWorkspace(rowOf(a.config, rootId)!.path, "root2", leafRootId, {
          runtimeConfig: { type: "local" },
        }),
        path: `${rowOf(a.config, rootId)!.path}-2`,
      });
      config.taskSettings = testTaskSettings(1);
      return config;
    });
    await editRow(taskId, (row) => {
      row.taskStatus = "running";
    });
    spyOn(runtimeFactory, "createRuntime").mockImplementation((...args) =>
      Object.assign(realCreateRuntime(...args), { deleteWorkspace })
    );
  }

  function childrenOf(config: Config, parentId: string): WorkspaceConfigEntry[] {
    return [...config.loadConfigOrDefault().projects.values()].flatMap((project) =>
      project.workspaces.filter((row) => row.parentWorkspaceId === parentId)
    );
  }

  test("the other backend cannot create a child task under a workspace being removed", async () => {
    await prepareChildlessRootWithQueuedCreation();
    const paused = pauseRemovalAfterMarker(a);
    const removal = a.workspaceService.remove(leafRootId, true);
    await paused.reached;

    const created = await b.taskService.create({
      parentWorkspaceId: leafRootId,
      kind: "agent",
      agentId: "explore",
      prompt: "child work",
      title: "child",
    });

    expect(created.success ? "created" : created.error).toContain("removed");
    expect(childrenOf(b.config, leafRootId)).toEqual([]);
    paused.release();
    expect((await removal).success).toBe(true);
  });

  test("a batch creation refuses when the other backend finished removing the parent during its checkpoint", async () => {
    await prepareChildlessRootWithQueuedCreation();

    const created = await b.taskService.createMany(
      [
        {
          parentWorkspaceId: leafRootId,
          kind: "agent",
          agentId: "explore",
          prompt: "go",
          title: "T",
        },
      ],
      {
        onTaskReserved: async () => {
          expect((await a.workspaceService.remove(leafRootId, true)).success).toBe(true);
        },
      }
    );

    expect(created.success ? "created" : created.error).toContain("removed");
    expect(childrenOf(b.config, leafRootId)).toEqual([]);
  });

  test("a batch creation under a parent that has no config row by id (legacy) still commits", async () => {
    await a.config.editConfig((config) => {
      config.taskSettings = testTaskSettings(1);
      return config;
    });
    await editRow(taskId, (row) => {
      row.taskStatus = "running";
    });
    spyOn(runtimeFactory, "createRuntime").mockImplementation((...args) =>
      Object.assign(realCreateRuntime(...args), { deleteWorkspace })
    );
    // An upgraded, id-less row resolves only through its session metadata, never by id.
    const legacyParentId = "legacy-parent";
    const aiService = (
      b.taskService as unknown as {
        aiService: { getWorkspaceMetadata: (id: string) => Promise<unknown> };
      }
    ).aiService;
    const getWorkspaceMetadata = aiService.getWorkspaceMetadata.bind(aiService);
    spyOn(aiService, "getWorkspaceMetadata").mockImplementation(async (id: string) => {
      if (id !== legacyParentId) return getWorkspaceMetadata(id);
      const root = (await b.config.getWorkspaceMetadataById(rootId))!;
      return Ok({ ...root, id: legacyParentId });
    });

    const created = await b.taskService.createMany([
      {
        parentWorkspaceId: legacyParentId,
        kind: "agent",
        agentId: "explore",
        prompt: "child work",
        title: "child",
      },
    ]);

    expect(created.success ? "created" : created.error).toBe("created");
  });

  test("a removal refuses when the other backend created a child just before it closed admission", async () => {
    const leasesA = workspaceUseLeasesFor(a.config);
    const acquireMutationGate = leasesA.acquireMutationGate.bind(leasesA);
    // The other backend's child commit lands after the removal decided to proceed.
    spyOn(leasesA, "acquireMutationGate").mockImplementationOnce(async (...args) => {
      await a.config.editConfig((config) => {
        const project = [...config.projects.values()][0];
        project.workspaces.push({
          ...projectWorkspace(rowOf(a.config, taskId)!.path, "grandchild", "grandchild-removal"),
          path: `${rowOf(a.config, taskId)!.path}-grandchild`,
          parentWorkspaceId: taskId,
          agentId: "explore",
          taskStatus: "queued",
        });
        return config;
      });
      return acquireMutationGate(...args);
    });

    const removal = await a.workspaceService.remove(taskId, true);

    expect(removal.success ? "removed" : removal.error).toContain("descendant");
    expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(rowOf(b.config, taskId)?.pendingRemoval).toBeUndefined();
  });

  test.each([
    ["not an object", () => "not a marker"],
    ["an unprobeable pid", () => ({ ...deadOwnerMarker(), pid: 0 })],
    // #4782 item 3: an empty identity field reads as an unknown PID domain that never dies.
    [
      "an empty identity field",
      () => ({ ...deadOwnerMarker(), identity: { ...getSelfIdentity(), bootId: "" } }),
    ],
  ])(
    "a malformed removal marker (%s) is dropped instead of blocking the task",
    async (_, marker) => {
      await editRow(taskId, (row) => {
        (row as Record<string, unknown>).pendingRemoval = marker();
      });

      expect((await b.taskService.reawakenInterruptedTask(taskId)).kind).toBe("reawakened");
    }
  );

  test("a marker left by a dead backend is taken over by the next removal", async () => {
    await editRow(taskId, (row) => {
      row.pendingRemoval = deadOwnerMarker();
    });

    const result = await b.workspaceService.remove(taskId, true);

    expect(result).toEqual(Ok(undefined));
    expect(deleteWorkspace).toHaveBeenCalledTimes(1);
    expect(rowOf(a.config, taskId)).toBeUndefined();
  });
});
