/* eslint-disable @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see */
// Characterization tests for paths of TaskService.create (createUnderTaskTreeLifecycleLock) that
// the other suites do not reach: they pin today's behavior before that method is split into steps.
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import assert from "node:assert";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { TaskService } from "@/node/services/taskService";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import type { TurnAdmissionToken } from "@/node/services/taskWorkspaceSeam";
import { Ok, Err } from "@/common/types/result";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import * as agentDefinitionsService from "@/node/services/agentDefinitions/agentDefinitionsService";
import * as resolveNodeAgentAiSettingsModule from "@/node/services/agentDefinitions/resolveNodeAgentAiSettings";
import * as forkOrchestrator from "@/node/services/utils/forkOrchestrator";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  saveLocalParentWorkspace,
  stubStableIds,
} from "@/node/services/taskService.testHarness";
import {
  createAgentTask,
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

const TASK_ID = "aaaaaaaaaa";

interface Internals {
  attemptLedger: {
    attemptSettlementByTaskId: Map<string, { phase: "closing" | "settled"; source: string }>;
  };
  emitWorkspaceMetadata: (workspaceId: string) => Promise<void>;
  rollbackFailedTaskCreate: (...args: unknown[]) => Promise<{ checkoutRemoved: boolean }>;
}

function internals(taskService: TaskService): Internals {
  return taskService as unknown as Internals;
}

function workspaceIds(config: Config): string[] {
  return Array.from(config.loadConfigOrDefault().projects.values()).flatMap((project) =>
    project.workspaces.map((workspace) => workspace.id ?? "")
  );
}

describe("TaskService.create paths before the split", () => {
  let rootDir: string;
  let config: Config;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    config = await createTestConfig(rootDir);
    stubStableIds(config, [TASK_ID], "bbbbbbbbbb");
  });
  afterEach(async () => {
    mock.restore();
    await removeTaskServiceTestRoot(rootDir);
  });

  /** A local parent plus a TaskService whose host records sends. */
  async function setup(
    options: NonNullable<Parameters<typeof saveLocalParentWorkspace>[2]> & {
      workspaceService?: ReturnType<typeof createWorkspaceServiceMocks>;
    } = {}
  ) {
    const parent = await saveLocalParentWorkspace(config, rootDir, options);
    const host = options.workspaceService ?? createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: host.workspaceService,
    });
    return { ...parent, host, taskService };
  }

  /**
   * A parent known only through its session metadata (no config row, no legacy row), so the
   * persist edit does not require one. Optionally a running sibling fills the only parallel slot.
   */
  async function setupRowlessParent(options: { queue?: boolean; parentName?: string } = {}) {
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const savedMeta = await config.getWorkspaceMetadataById(parentId);
    assert(savedMeta != null, "the parent's metadata must exist before its row is dropped");
    const parentMeta = { ...savedMeta, name: options.parentName ?? savedMeta.name };
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project != null, "the parent's project must exist");
      project.workspaces = options.queue
        ? [
            {
              path: projectPath,
              id: "sibling111",
              name: "agent_explore_sibling111",
              parentWorkspaceId: parentId,
              agentType: "explore",
              taskStatus: "running",
            },
          ]
        : [];
      if (options.queue) cfg.taskSettings = { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 };
      return cfg;
    });
    const { aiService } = createAIServiceMocks(config, {
      getWorkspaceMetadata: mock(async (id: string) => {
        if (id === parentId) return Ok(parentMeta);
        const found = await config.getWorkspaceMetadataById(id);
        return found ? Ok(found) : Err("not found");
      }),
    });
    const host = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService: host.workspaceService,
    });
    return { parentId, projectPath, host, taskService };
  }

  /** Another writer's edit of one workspace row. */
  async function editRow(workspaceId: string, change: (row: WorkspaceConfigEntry) => unknown) {
    await config.editConfig((cfg) => {
      const row = findWorkspaceEntry(cfg, workspaceId)?.workspace;
      assert(row != null, `row ${workspaceId} must exist`);
      change(row);
      return cfg;
    });
  }

  /** The next config write runs after another writer removed the project's row. */
  function removeProjectBeforeNextWrite(projectPath: string) {
    const edit = config.editConfig.bind(config);
    spyOn(config, "editConfig").mockImplementationOnce((fn) =>
      edit((cfg) => {
        cfg.projects.delete(projectPath);
        return fn(cfg);
      })
    );
  }

  test.each([
    ["an unsupported kind", { kind: "workflow" as unknown as "agent" }, "unsupported kind"],
    ["a blank prompt", { prompt: "   " }, "prompt is required"],
    ["a missing agentId", { agentType: undefined, agentId: "" }, "agentId is required"],
    ["a malformed agentId", { agentId: "not an id!" }, "invalid agentId"],
    ["a blank bestOf groupId", { bestOf: { groupId: " ", index: 0, total: 2 } }, "groupId"],
    ["a negative bestOf index", { bestOf: { groupId: "g", index: -1, total: 2 } }, "index"],
    ["a fractional bestOf total", { bestOf: { groupId: "g", index: 0, total: 2.5 } }, "total"],
    ["a bestOf total below 2", { bestOf: { groupId: "g", index: 0, total: 1 } }, "total"],
    ["a bestOf index past total", { bestOf: { groupId: "g", index: 2, total: 2 } }, "less than"],
  ])("%s is refused before anything is written", async (_label, args, reason) => {
    const { parentId, host, taskService } = await setup();
    const created = await createAgentTask(taskService, parentId, "go", args);
    expect(created.success).toBe(false);
    if (created.success) return;
    expect(created.error).toContain(reason);
    expect(workspaceIds(config)).toEqual([parentId]);
    expect(host.sendMessage).not.toHaveBeenCalled();
  });

  test.each([
    ["an unknown parent", "missing-parent", undefined, "parent workspace not found"],
    ["an untrusted project", undefined, { trusted: false }, "must be trusted"],
    ["a parent that already reported", undefined, { taskStatus: "reported" }, "agent_report"],
  ] as const)("%s refuses the spawn", async (_label, parentOverride, change, reason) => {
    const { parentId, projectPath, host, taskService } = await setup();
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project != null, "the parent's project must exist");
      if (change != null && "trusted" in change) project.trusted = change.trusted;
      if (change != null && "taskStatus" in change) project.workspaces[0].taskStatus = "reported";
      return cfg;
    });
    const created = await createAgentTask(taskService, parentOverride ?? parentId, "go");
    expect(created.success).toBe(false);
    if (created.success) return;
    expect(created.error).toContain(reason);
    expect(workspaceIds(config)).toEqual([parentId]);
    expect(host.sendMessage).not.toHaveBeenCalled();
  });

  test("a disabled agent is refused with a hint that skips agents whose definition cannot be read", async () => {
    const { parentId, taskService } = await setup({
      agentAiDefaults: { explore: { enabled: false } },
    });
    spyOn(agentDefinitionsService, "discoverAgentDefinitions").mockResolvedValue([
      { id: "ghost", scope: "project", name: "Ghost", uiSelectable: false, subagentRunnable: true },
    ]);
    const created = await createAgentTask(taskService, parentId, "go");
    expect(created).toEqual(
      Err("Task.create: agentId is disabled (explore). No runnable agents available")
    );
    expect(workspaceIds(config)).toEqual([parentId]);
  });

  test("an unknown agent is refused even when the hint's discovery fails", async () => {
    const { parentId, taskService } = await setup();
    spyOn(agentDefinitionsService, "discoverAgentDefinitions").mockRejectedValue(
      new Error("agents dir unreadable")
    );
    const created = await createAgentTask(taskService, parentId, "go", {
      agentType: "nosuchagent",
    });
    expect(created).toEqual(
      Err("Task.create: unknown agentId (nosuchagent). Could not discover available agents")
    );
    expect(workspaceIds(config)).toEqual([parentId]);
  });

  test("an invalid explicit model is refused instead of falling back", async () => {
    const { parentId, host, taskService } = await setup();
    const created = await createAgentTask(taskService, parentId, "go", { modelString: "nomodel" });
    expect(created.success).toBe(false);
    if (created.success) return;
    expect(created.error).toContain("nomodel");
    expect(workspaceIds(config)).toEqual([parentId]);
    expect(host.sendMessage).not.toHaveBeenCalled();
  });

  test("an unexpected AI-settings failure propagates and releases the create lock", async () => {
    const { parentId, taskService } = await setup();
    const read = spyOn(resolveNodeAgentAiSettingsModule, "loadAgentDefinitionAiLayers");
    read.mockRejectedValueOnce(new Error("definition chain corrupt"));
    await expect(createAgentTask(taskService, parentId, "go")).rejects.toThrow(
      "definition chain corrupt"
    );
    // The next create acquires the same global mutex: a leaked hold would hang it.
    const next = await createAgentTask(taskService, parentId, "go again");
    expect(next.success).toBe(true);
  });

  test("a queued task needs the parent's branch", async () => {
    // A parent whose metadata names no workspace: on a local runtime its branch is unknown.
    const { parentId, taskService } = await setupRowlessParent({ queue: true, parentName: "" });
    const created = await createAgentTask(taskService, parentId, "go");
    expect(created).toEqual(Err("Task.create: parent workspace name missing (cannot queue task)"));
    expect(workspaceIds(config)).toEqual(["sibling111"]);
  });

  test("a queued task whose project row was removed meanwhile recreates it", async () => {
    const { parentId, projectPath, taskService } = await setupRowlessParent({ queue: true });
    removeProjectBeforeNextWrite(projectPath);
    const created = await createAgentTask(taskService, parentId, "go");
    expect(created.success && created.data.status).toBe("queued");
    expect(config.loadConfigOrDefault().projects.get(projectPath)?.workspaces).toEqual([
      expect.objectContaining({ id: TASK_ID, taskStatus: "queued", parentWorkspaceId: parentId }),
    ]);
    // The removed project took the sibling that forced the queue, so the create's queue drain
    // finds a free slot and starts. Let it settle here: its config writes must not run into
    // afterEach's cleanup or a later test.
    await taskService.queueDrainSettled();
  });

  test("a queued task whose persist fails returns the error and announces nothing", async () => {
    const { parentId, taskService } = await setupRowlessParent({ queue: true });
    spyOn(config, "editConfig").mockRejectedValueOnce(new Error("config disk full"));
    const emit = spyOn(internals(taskService), "emitWorkspaceMetadata");
    const created = await createAgentTask(taskService, parentId, "go");
    expect(created).toEqual(Err("config disk full"));
    expect(workspaceIds(config)).toEqual(["sibling111"]);
    expect(emit).not.toHaveBeenCalledWith(TASK_ID);
  });

  test("a failed fork returns its error and persists nothing", async () => {
    const { parentId, host, taskService } = await setup();
    spyOn(forkOrchestrator, "orchestrateFork").mockResolvedValue(Err("no space left"));
    const rollback = spyOn(internals(taskService), "rollbackFailedTaskCreate");
    const created = await createAgentTask(taskService, parentId, "go");
    expect(created).toEqual(Err("Task fork failed: no space left"));
    expect(workspaceIds(config)).toEqual([parentId]);
    expect(rollback).not.toHaveBeenCalled();
    expect(host.sendMessage).not.toHaveBeenCalled();
  });

  test("a fork that updates a parent row the persist cannot find rolls the checkout back", async () => {
    const { parentId, projectPath, host, taskService } = await setupRowlessParent();
    spyOn(forkOrchestrator, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: projectPath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime: createRuntime({ type: "local" }, { projectPath }),
        forkedFromSource: true,
        sourceRuntimeConfigUpdate: { type: "local" },
        sourceRuntimeConfigUpdated: true,
      })
    );
    const rollback = spyOn(internals(taskService), "rollbackFailedTaskCreate");
    const created = await createAgentTask(taskService, parentId, "go");
    expect(created).toEqual(Err(`Workspace ${parentId} not found in config`));
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(workspaceIds(config)).toEqual([]);
    expect(host.sendMessage).not.toHaveBeenCalled();
  });

  test("a launched task whose project row was removed meanwhile recreates it", async () => {
    const { parentId, projectPath, host, taskService } = await setupRowlessParent();
    removeProjectBeforeNextWrite(projectPath);
    const created = await createAgentTask(taskService, parentId, "go");
    expect(created.success && created.data.status).toBe("running");
    expect(config.loadConfigOrDefault().projects.get(projectPath)?.workspaces).toEqual([
      expect.objectContaining({ id: TASK_ID, taskStatus: "running", parentWorkspaceId: parentId }),
    ]);
    expect(host.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("a launch failure whose marker write fails leaves the row and the attempt unsettled", async () => {
    let sendFailed = false;
    const host = createWorkspaceServiceMocks({
      sendMessage: mock(() => {
        sendFailed = true;
        return Promise.resolve(Err("provider unavailable"));
      }),
    });
    const { taskService } = await setup({ workspaceService: host });
    const edit = taskService.editWorkspaceEntry.bind(taskService);
    spyOn(taskService, "editWorkspaceEntry").mockImplementation((...args) =>
      args[0] === TASK_ID && sendFailed ? Promise.reject(new Error("config locked")) : edit(...args)
    );
    const created = await createAgentTask(taskService, "1111111111", "go");
    expect(created).toEqual(Err("provider unavailable"));
    // Fail closed: no durable marker, no stop, and no settlement against a row of unknown state.
    expect(findWorkspaceInConfig(config, TASK_ID)).toMatchObject({ taskStatus: "running" });
    expect(findWorkspaceInConfig(config, TASK_ID)?.taskLaunchError).toBeUndefined();
    expect(
      internals(taskService).attemptLedger.attemptSettlementByTaskId.get(TASK_ID)
    ).toMatchObject({ phase: "closing", source: "launch-failed" });
  });

  test("a row that stopped being an agent task before the launch send fails the launch unsent", async () => {
    const { parentId, host, taskService } = await setup();
    const svc = internals(taskService);
    const emit = svc.emitWorkspaceMetadata.bind(taskService);
    spyOn(svc, "emitWorkspaceMetadata").mockImplementation(async (id) => {
      if (id === TASK_ID) {
        await editRow(TASK_ID, (row) => delete row.parentWorkspaceId);
      }
      return emit(id);
    });
    const created = await createAgentTask(taskService, parentId, "go");
    expect(created.success).toBe(false);
    if (created.success) return;
    expect(host.sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, TASK_ID)).toMatchObject({
      taskStatus: "interrupted",
      taskLaunchError: created.error,
    });
    expect(svc.attemptLedger.attemptSettlementByTaskId.get(TASK_ID)?.phase).toBe("settled");
  });

  test("a superseded launch failure settles its attempt when its admitted send's turn is no longer live", async () => {
    let racingToken: TurnAdmissionToken | undefined;
    const host = createWorkspaceServiceMocks({
      sendMessage: mock(async (workspaceId: string) => {
        // A user send admitted under this launch's attempt, whose turn already ended...
        const admission = taskService.admitTaskWorkspaceTurn(workspaceId, {
          acceptanceOrigin: "manual",
        });
        assert(admission.kind === "admitted", "the racing send must be admitted");
        racingToken = admission.token;
        racingToken.onAdmitted(Symbol("ended-turn"));
        // ...and another writer re-admitted the row under its own attempt.
        await editRow(workspaceId, (row) => (row.taskAttemptId = "att_00000000000000b2"));
        return Err("provider unavailable");
      }),
      getActiveTurnGeneration: mock(() => undefined),
    });
    const { taskService } = await setup({ workspaceService: host });
    const created = await createAgentTask(taskService, "1111111111", "go");
    expect(created).toEqual(Err("provider unavailable"));
    expect(racingToken).toBeDefined();
    // The other writer's row is untouched, and nothing runs under this attempt: settled.
    expect(findWorkspaceInConfig(config, TASK_ID)).toMatchObject({
      taskStatus: "running",
      taskAttemptId: "att_00000000000000b2",
    });
    expect(
      internals(taskService).attemptLedger.attemptSettlementByTaskId.get(TASK_ID)
    ).toMatchObject({ phase: "settled", source: "launch-failed" });
  });
});
