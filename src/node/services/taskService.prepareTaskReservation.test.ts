/* eslint-disable @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see */
// Characterization tests for paths of TaskService.createMany's read-only preparation
// (prepareTaskReservation) that the other suites do not reach: they pin today's behavior before
// that method is split into steps. Every refusal here happens before the global mutex, so none
// of them may write a workspace row.
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import assert from "node:assert";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Config, ProjectConfig } from "@/node/config";
import type { TaskService } from "@/node/services/taskService";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { RuntimeError } from "@/node/runtime/Runtime";
import * as agentDefinitionsService from "@/node/services/agentDefinitions/agentDefinitionsService";
import {
  createTestConfig,
  createWorkspaceServiceMocks,
  saveLocalParentWorkspace,
  stubStableIds,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

const TASK_ID = "aaaaaaaaaa";

type CreateManyArgs = Parameters<TaskService["createMany"]>[0][number];

interface Internals {
  resolveTaskAISettings: (...args: unknown[]) => Promise<unknown>;
  enqueueReservedTaskLaunch: (...args: unknown[]) => Promise<void>;
  markTaskLaunchFailed: (...args: unknown[]) => Promise<void>;
}

function internals(taskService: TaskService): Internals {
  return taskService as unknown as Internals;
}

function workspaceIds(config: Config): string[] {
  return Array.from(config.loadConfigOrDefault().projects.values()).flatMap((project) =>
    project.workspaces.map((workspace) => workspace.id ?? "")
  );
}

describe("TaskService.createMany preparation paths before the split", () => {
  let rootDir: string;
  let config: Config;
  // Background inits of launches. The host mock's registerExternalBackgroundInit is a no-op, so
  // nothing else waits for them: a running init would race the root's removal.
  let backgroundInits: Array<Promise<void>>;
  // One launch wait per setup. Teardown runs them too, so a test that fails before its own wait
  // (or never expected a launch) still settles its launches before the root is removed.
  let launchWaits: Array<() => Promise<number>>;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    config = await createTestConfig(rootDir);
    stubStableIds(config, [TASK_ID], "bbbbbbbbbb");
    backgroundInits = [];
    launchWaits = [];
  });
  afterEach(async () => {
    // allSettled: a failed launch must not hide the test's own failure.
    await Promise.allSettled(launchWaits.splice(0).map((wait) => wait()));
    await Promise.all(backgroundInits.splice(0));
    mock.restore();
    await removeTaskServiceTestRoot(rootDir);
  });

  /** A local parent plus a TaskService whose host records sends and background inits. */
  async function setup(options: NonNullable<Parameters<typeof saveLocalParentWorkspace>[2]> = {}) {
    const parent = await saveLocalParentWorkspace(config, rootDir, options);
    const host = createWorkspaceServiceMocks();
    spyOn(host.workspaceService, "registerExternalBackgroundInit").mockImplementation(
      (_workspaceId: string, _controller: AbortController, settlement: Promise<void>) => {
        backgroundInits.push(settlement);
      }
    );
    const { taskService, aiService } = createTaskServiceHarness(config, {
      workspaceService: host.workspaceService,
    });
    const launchesSettled = trackLaunches(taskService);
    launchWaits.push(launchesSettled);
    const createOne = (overrides: Partial<CreateManyArgs> = {}) =>
      taskService.createMany([
        {
          parentWorkspaceId: parent.parentId,
          kind: "agent",
          agentId: "explore",
          prompt: "go",
          title: "Test task",
          ...overrides,
        },
      ]);
    return { ...parent, host, taskService, aiService, createOne, launchesSettled };
  }

  /**
   * Tracks the launches that createMany schedules (it does not await them) and the failure
   * handler that scheduleReservedTaskLaunch starts, without awaiting, when a launch rejects. The
   * returned function waits until no new launch or failure handler appears, then for the
   * background inits, and returns how many inits there were.
   */
  function trackLaunches(taskService: TaskService): () => Promise<number> {
    const launch = spyOn(internals(taskService), "enqueueReservedTaskLaunch");
    const markFailed = spyOn(internals(taskService), "markTaskLaunchFailed");
    const pending = () => [...launch.mock.results, ...markFailed.mock.results];
    return async () => {
      let settled = -1;
      while (settled !== pending().length) {
        settled = pending().length;
        await Promise.allSettled(pending().map((result) => result.value));
      }
      const inits = backgroundInits.splice(0);
      await Promise.all(inits);
      return inits.length;
    };
  }

  /** Another writer's edit of the parent's project and row. */
  async function editParent(projectPath: string, change: (project: ProjectConfig) => void) {
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project != null, "the parent's project must exist");
      change(project);
      return cfg;
    });
  }

  test.each([
    ["a malformed agentId", { agentId: "Bad Id!" }, "invalid agentId (bad id!)"],
    ["a blank bestOf groupId", { bestOf: { groupId: " ", index: 0, total: 2 } }, "groupId"],
    ["a negative bestOf index", { bestOf: { groupId: "g", index: -1, total: 2 } }, "index must"],
    ["a fractional bestOf index", { bestOf: { groupId: "g", index: 0.5, total: 2 } }, "index must"],
    ["a fractional bestOf total", { bestOf: { groupId: "g", index: 0, total: 2.5 } }, "total must"],
    ["a bestOf total below 2", { bestOf: { groupId: "g", index: 0, total: 1 } }, "total must"],
    ["a bestOf index past total", { bestOf: { groupId: "g", index: 2, total: 2 } }, "less than"],
  ])("%s is refused before the parent is read", async (_label, overrides, reason) => {
    const { parentId, host, aiService, createOne } = await setup();
    const metadata = spyOn(aiService, "getWorkspaceMetadata");
    const created = await createOne(overrides);
    expect(created.success).toBe(false);
    if (created.success) return;
    expect(created.error).toContain(reason);
    expect(metadata).not.toHaveBeenCalled();
    expect(workspaceIds(config)).toEqual([parentId]);
    expect(host.sendMessage).not.toHaveBeenCalled();
  });

  test("a valid bestOf is persisted on the task row", async () => {
    const { parentId, taskService, createOne, launchesSettled } = await setup();
    const created = await createOne({ bestOf: { groupId: "group", index: 1, total: 3 } });
    expect(created.success).toBe(true);
    const row = findWorkspaceEntry(config.loadConfigOrDefault(), TASK_ID)?.workspace;
    expect(row?.parentWorkspaceId).toBe(parentId);
    expect(row?.bestOf).toEqual({ groupId: "group", index: 1, total: 3 });
    // The create schedules a queue drain and a direct launch: let both settle inside the test.
    await taskService.queueDrainSettled();
    await launchesSettled();
  });

  test.each([
    ["an unknown parent", "parent workspace not found"],
    ["an untrusted project", "must be trusted"],
    ["a parent that already reported", "agent_report"],
    ["a parent too deep for maxTaskNestingDepth", "requestedDepth=2, max=1"],
  ] as const)("%s refuses the spawn", async (label, reason) => {
    const { parentId, projectPath, host, createOne } = await setup();
    await editParent(projectPath, (project) => {
      if (label === "an untrusted project") project.trusted = false;
      if (label === "a parent that already reported") project.workspaces[0].taskStatus = "reported";
      if (label === "a parent too deep for maxTaskNestingDepth") {
        // The parent is itself a task (depth 1), so its child would be at depth 2.
        project.workspaces[0].parentWorkspaceId = "rootroot00";
      }
    });
    if (label === "a parent too deep for maxTaskNestingDepth") {
      await config.editConfig((cfg) => ({
        ...cfg,
        taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 1 },
      }));
    }
    const created = await createOne(
      label === "an unknown parent" ? { parentWorkspaceId: "missing-parent" } : {}
    );
    expect(created.success).toBe(false);
    if (created.success) return;
    expect(created.error).toContain(reason);
    expect(workspaceIds(config)).toEqual([parentId]);
    expect(host.sendMessage).not.toHaveBeenCalled();
  });

  test("a child exactly at maxTaskNestingDepth is created, and its own child is refused", async () => {
    const { parentId, taskService, createOne, launchesSettled } = await setup();
    await config.editConfig((cfg) => ({
      ...cfg,
      taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 1 },
    }));
    // The parent is a root (depth 0), so its child sits exactly at the limit.
    const child = await createOne();
    expect(child.success).toBe(true);
    expect(findWorkspaceEntry(config.loadConfigOrDefault(), TASK_ID)?.workspace).toMatchObject({
      parentWorkspaceId: parentId,
    });
    // One level deeper than the limit: refused before any row is written.
    const grandchild = await createOne({ parentWorkspaceId: TASK_ID });
    expect(grandchild.success).toBe(false);
    if (grandchild.success) return;
    expect(grandchild.error).toContain("requestedDepth=2, max=1");
    expect(workspaceIds(config).sort()).toEqual([parentId, TASK_ID].sort());
    await taskService.queueDrainSettled();
    await launchesSettled();
  });

  test('isolation "none" on a local parent, which cannot share its checkout, forks instead', async () => {
    const { parentId, taskService, createOne, launchesSettled } = await setup();
    const created = await createOne({ isolation: "none" });
    expect(created.success).toBe(true);
    const row = findWorkspaceEntry(config.loadConfigOrDefault(), TASK_ID)?.workspace;
    expect(row?.parentWorkspaceId).toBe(parentId);
    // A shared checkout would persist taskIsolation "none" on the row.
    expect(row?.taskIsolation).toBeUndefined();
    await taskService.queueDrainSettled();
    await launchesSettled();
  });

  // The built-in explore agent's definition sets subagent.skip_init_hook: true; exec's does not.
  test.each([
    ["explore", false],
    ["exec", true],
  ] as const)(
    "a createMany %s task runs the project's init hook: %p",
    async (agentId, runsHook) => {
      // The project-automation kill switch skips every hook, so clear it (and its legacy alias)
      // for this test: only skip_init_hook may decide whether the hook runs.
      const killSwitchNames = ["XUM_DISABLE_PROJECT_AUTOMATION", "MUX_DISABLE_PROJECT_AUTOMATION"];
      const savedKillSwitch = killSwitchNames.map((name) => [name, process.env[name]] as const);
      for (const name of killSwitchNames) delete process.env[name];
      try {
        const { projectPath, taskService, createOne, launchesSettled } = await setup();
        const marker = path.join(rootDir, "init-hook-ran");
        await fs.mkdir(path.join(projectPath, ".xum"), { recursive: true });
        const hookPath = path.join(projectPath, ".xum", "init");
        await fs.writeFile(hookPath, `#!/usr/bin/env bash\necho ran > ${JSON.stringify(marker)}\n`);
        await fs.chmod(hookPath, 0o755);
        const created = await createOne({ agentId });
        expect(created.success).toBe(true);
        await taskService.queueDrainSettled();
        expect(await launchesSettled()).toBe(1);
        expect(existsSync(marker)).toBe(runsHook);
      } finally {
        for (const [name, value] of savedKillSwitch) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }
  );

  test("a disabled agent is refused with a hint that lists only runnable, readable agents", async () => {
    const { parentId, createOne } = await setup({
      agentAiDefaults: { explore: { enabled: false } },
    });
    spyOn(agentDefinitionsService, "discoverAgentDefinitions").mockResolvedValue([
      { id: "ghost", scope: "project", name: "Ghost", uiSelectable: false, subagentRunnable: true },
      { id: "exec", scope: "built-in", name: "Exec", uiSelectable: true, subagentRunnable: true },
    ]);
    const created = await createOne();
    expect(created.success).toBe(false);
    if (created.success) return;
    expect(created.error).toContain("disabled (explore)");
    // "ghost" has no definition to read, so the hint drops it; "exec" is runnable and enabled.
    expect(created.error).toContain("exec");
    expect(created.error).not.toContain("ghost");
    expect(workspaceIds(config)).toEqual([parentId]);
  });

  test("an unknown agent is refused even when the hint's discovery fails", async () => {
    const { parentId, createOne } = await setup();
    const discover = spyOn(agentDefinitionsService, "discoverAgentDefinitions");
    discover.mockRejectedValue(new Error("agents dir unreadable"));
    const created = await createOne({ agentId: "nosuchagent" });
    expect(created.success).toBe(false);
    if (created.success) return;
    expect(created.error).toContain("unknown agentId (nosuchagent)");
    expect(discover).toHaveBeenCalledTimes(1);
    expect(workspaceIds(config)).toEqual([parentId]);
  });

  test("an unreachable host while reading the definition is retryable, not an unknown agent", async () => {
    const { parentId, createOne } = await setup();
    spyOn(agentDefinitionsService, "resolveAgentDefinition").mockRejectedValue(
      new RuntimeError("ssh: connection reset", "network")
    );
    const discover = spyOn(agentDefinitionsService, "discoverAgentDefinitions");
    const created = await createOne();
    expect(created.success).toBe(false);
    if (created.success) return;
    expect(created.error).toContain("(explore)");
    expect(created.error).toContain("ssh: connection reset");
    // The unknown-agent branch builds a hint by discovering agents: this branch must not.
    expect(discover).not.toHaveBeenCalled();
    expect(workspaceIds(config)).toEqual([parentId]);
  });

  test("an invalid explicit model is refused instead of falling back", async () => {
    const { parentId, host, createOne } = await setup();
    const created = await createOne({ modelString: "nomodel" });
    expect(created.success).toBe(false);
    if (created.success) return;
    expect(created.error).toContain("nomodel");
    expect(workspaceIds(config)).toEqual([parentId]);
    expect(host.sendMessage).not.toHaveBeenCalled();
  });

  test("an unreachable host while reading AI defaults is refused, not thrown", async () => {
    const { parentId, taskService, createOne } = await setup();
    spyOn(internals(taskService), "resolveTaskAISettings").mockRejectedValueOnce(
      new RuntimeError("ssh: connection reset", "network")
    );
    const created = await createOne();
    expect(created.success).toBe(false);
    if (created.success) return;
    expect(created.error).toContain("ssh: connection reset");
    expect(workspaceIds(config)).toEqual([parentId]);
  });

  test("an unexpected AI-settings failure propagates and releases the parent's tree lock", async () => {
    const { parentId, taskService, createOne } = await setup();
    spyOn(internals(taskService), "resolveTaskAISettings").mockRejectedValueOnce(
      new Error("definition chain corrupt")
    );
    await expect(createOne()).rejects.toThrow("definition chain corrupt");
    expect(workspaceIds(config)).toEqual([parentId]);
    // The next createMany takes the same parent tree lock: a leaked hold would hang it.
    const next = await createOne({ agentId: "Bad Id!" });
    expect(next.success).toBe(false);
  });
});
