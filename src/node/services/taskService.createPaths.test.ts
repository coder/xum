/* eslint-disable @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see */
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import assert from "node:assert";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { TaskService } from "@/node/services/taskService";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { Ok, Err } from "@/common/types/result";
import * as agentDefinitionsService from "@/node/services/agentDefinitions/agentDefinitionsService";
import * as resolveNodeAgentAiSettingsModule from "@/node/services/agentDefinitions/resolveNodeAgentAiSettings";
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
}

function internals(taskService: TaskService): Internals {
  return taskService as unknown as Internals;
}

function workspaceIds(config: Config): string[] {
  return Array.from(config.loadConfigOrDefault().projects.values()).flatMap((project) =>
    project.workspaces.map((workspace) => workspace.id ?? "")
  );
}

describe("TaskService.create paths", () => {
  let rootDir: string;
  let config: Config;
  // The background inits that launches started. The host mocks' registerExternalBackgroundInit
  // is a no-op, so nothing else waits for them: an init still running its shell probes under
  // rootDir would race the root's removal or a later test.
  let backgroundInits: Array<Promise<void>>;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    config = await createTestConfig(rootDir);
    stubStableIds(config, [TASK_ID], "bbbbbbbbbb");
    backgroundInits = [];
  });
  afterEach(async () => {
    await settleBackgroundInits();
    mock.restore();
    await removeTaskServiceTestRoot(rootDir);
  });

  /** Records every background init the host is asked to register. */
  function captureBackgroundInits(host: ReturnType<typeof createWorkspaceServiceMocks>) {
    spyOn(host.workspaceService, "registerExternalBackgroundInit").mockImplementation(
      (_workspaceId: string, _controller: AbortController, settlement: Promise<void>) => {
        backgroundInits.push(settlement);
      }
    );
  }

  /** Waits until every background init started so far has settled. */
  async function settleBackgroundInits() {
    await Promise.all(backgroundInits.splice(0));
  }

  /** A local parent plus a TaskService whose host records sends. */
  async function setup(
    options: NonNullable<Parameters<typeof saveLocalParentWorkspace>[2]> & {
      workspaceService?: ReturnType<typeof createWorkspaceServiceMocks>;
    } = {}
  ) {
    const parent = await saveLocalParentWorkspace(config, rootDir, options);
    const host = options.workspaceService ?? createWorkspaceServiceMocks();
    captureBackgroundInits(host);
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
    captureBackgroundInits(host);
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

  /**
   * Another writer edits the parent's AI settings while each of the first `count` spawn
   * preparations resolves the child's settings, as when the user picks another model meanwhile.
   * Returns the number of preparations so far.
   */
  function editParentDuringPreparations(parentId: string, count: number) {
    let preparations = 0;
    const load = resolveNodeAgentAiSettingsModule.loadAgentDefinitionAiLayers;
    spyOn(resolveNodeAgentAiSettingsModule, "loadAgentDefinitionAiLayers").mockImplementation(
      async (...args) => {
        preparations += 1;
        if (preparations <= count) {
          const thinkingLevel = preparations % 2 === 1 ? "low" : "medium";
          await editRow(parentId, (row) => {
            row.aiSettings = { model: "openai:gpt-5.2", thinkingLevel };
          });
        }
        return load(...args);
      }
    );
    return () => preparations;
  }

  test("a parent edited while the spawn prepares is prepared again instead of refused", async () => {
    const { parentId, taskService } = await setup();
    editParentDuringPreparations(parentId, 1);
    const created = await createAgentTask(taskService, parentId, "go");
    assert(created.success, `the spawn must be reserved: ${created.success ? "" : created.error}`);
    // The second preparation read the edit.
    expect(created.data.modelString).toBe("openai:gpt-5.2");
  });

  test("a parent edited during every preparation refuses the spawn after a bounded retry", async () => {
    const { parentId, host, taskService } = await setup();
    const preparations = editParentDuringPreparations(parentId, Number.POSITIVE_INFINITY);
    const created = await createAgentTask(taskService, parentId, "go");
    expect(created.success).toBe(false);
    if (created.success) return;
    expect(created.error).toContain("changed during preparation");
    expect(preparations()).toBeGreaterThan(1);
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

  test("a task whose parent names no workspace is refused before anything is written", async () => {
    const { parentId, taskService } = await setupRowlessParent({ queue: true, parentName: "" });
    const created = await createAgentTask(taskService, parentId, "go");
    expect(created).toEqual(Err("Task.create: parent workspace name missing"));
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

  test("a launched task whose project row was removed meanwhile recreates it", async () => {
    const { parentId, projectPath, host, taskService } = await setupRowlessParent();
    removeProjectBeforeNextWrite(projectPath);
    const created = await createAgentTask(taskService, parentId, "go");
    expect(created.success && created.data.status).toBe("starting");
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
    expect(created.success).toBe(true);
    expect(findWorkspaceInConfig(config, TASK_ID)).toMatchObject({ taskStatus: "starting" });
    expect(findWorkspaceInConfig(config, TASK_ID)?.taskLaunchError).toBeUndefined();
    expect(
      internals(taskService).attemptLedger.attemptSettlementByTaskId.get(TASK_ID)?.phase
    ).not.toBe("settled");
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
    expect(created.success).toBe(true);
    expect(host.sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, TASK_ID)).toMatchObject({
      taskStatus: "interrupted",
      taskLaunchError: "Task launch refused: the task record is no longer an agent task",
    });
    expect(svc.attemptLedger.attemptSettlementByTaskId.get(TASK_ID)?.phase).toBe("settled");
  });

  // The built-in explore agent's definition sets subagent.skip_init_hook: true; exec's does not.
  test.each([
    ["explore", false],
    ["exec", true],
  ] as const)(
    "a launched %s task runs the project's init hook: %p",
    async (agentType, runsHook) => {
      // The project-automation kill switch skips every hook, so clear it (and its legacy alias)
      // for this test: only skip_init_hook may decide whether the hook runs.
      const killSwitchNames = ["XUM_DISABLE_PROJECT_AUTOMATION", "MUX_DISABLE_PROJECT_AUTOMATION"];
      const savedKillSwitch = killSwitchNames.map((name) => [name, process.env[name]] as const);
      for (const name of killSwitchNames) delete process.env[name];
      try {
        const { parentId, projectPath, taskService } = await setup();
        const marker = path.join(rootDir, "init-hook-ran");
        await fs.mkdir(path.join(projectPath, ".xum"), { recursive: true });
        const hookPath = path.join(projectPath, ".xum", "init");
        await fs.writeFile(hookPath, `#!/usr/bin/env bash\necho ran > ${JSON.stringify(marker)}\n`);
        await fs.chmod(hookPath, 0o755);
        const created = await createAgentTask(taskService, parentId, "go", { agentType });
        expect(created.success && created.data.status).toBe("starting");
        expect(backgroundInits).toHaveLength(1);
        await settleBackgroundInits();
        expect(existsSync(marker)).toBe(runsHook);
      } finally {
        for (const [name, value] of savedKillSwitch) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }
  );
});
