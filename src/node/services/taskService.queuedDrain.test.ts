// Characterization tests for paths of TaskService's queue drain
// (maybeStartQueuedTasksFromReservations, reached through the public maybeStartQueuedTasks) that
// the other suites do not reach: they pin today's behavior before that method is split into
// steps. Each test asserts what the drain did with every queued row: reserved it (a plan handed
// to enqueueReservedTaskLaunch), marked it failed (interrupted with a taskLaunchError), or left
// it alone, and whether it took a slot.
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { TaskService } from "@/node/services/taskService";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { Err } from "@/common/types/result";
import * as agentDefinitionsService from "@/node/services/agentDefinitions/agentDefinitionsService";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import {
  createAIServiceMocks,
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  saveWorkspaces,
  testTaskSettings,
  writeCustomAgentDefinition,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

const PARENT_ID = "parent";
const RUN_ID = "wfr_queued_drain";

/** The fields of the drain's launch plan these tests read. */
interface LaunchPlan {
  taskId: string;
  parentMeta: WorkspaceMetadata;
  skipInitHook: boolean;
}
interface Internals {
  enqueueReservedTaskLaunch: (plan: LaunchPlan) => Promise<void>;
  markTaskLaunchFailed: (taskId: string, ...rest: unknown[]) => Promise<void>;
}

function internals(taskService: TaskService): Internals {
  return taskService as unknown as Internals;
}

describe("TaskService queue drain paths before the split", () => {
  let rootDir: string;
  let config: Config;
  let projectPath: string;
  // Background inits of launches. The host mock's registerExternalBackgroundInit is a no-op, so
  // nothing else waits for them: a running init would race the root's removal.
  let backgroundInits: Array<Promise<void>>;
  // One settle per setup. Teardown runs them too, so a test that fails before its own settle
  // still awaits the drains and launches it started before the root is removed.
  let settles: Array<() => Promise<void>>;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    config = await createTestConfig(rootDir);
    projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    backgroundInits = [];
    settles = [];
  });
  afterEach(async () => {
    // allSettled: a failed drain must not hide the test's own failure.
    await Promise.allSettled(settles.splice(0).map((settle) => settle()));
    mock.restore();
    await removeTaskServiceTestRoot(rootDir);
  });

  const row = (id: string) => findWorkspaceInConfig(config, id);

  /** A local workspace row in the project directory; tasks sort by `minute` (createdAt). */
  function workspace(id: string, minute: number, overrides: Partial<WorkspaceConfigEntry> = {}) {
    return {
      path: projectPath,
      id,
      name: id,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
      runtimeConfig: { type: "local" as const },
      ...overrides,
    } satisfies WorkspaceConfigEntry;
  }

  /** A queued explore task under PARENT_ID. */
  function queued(id: string, minute: number, overrides: Partial<WorkspaceConfigEntry> = {}) {
    return workspace(id, minute, {
      parentWorkspaceId: PARENT_ID,
      agentId: "explore",
      agentType: "explore",
      taskStatus: "queued",
      taskPrompt: `work for ${id}`,
      taskModelString: "openai:gpt-5.2",
      ...overrides,
    });
  }

  /**
   * Saves PARENT_ID (with the `parent` fields) plus `rows` with `slots` as maxParallelAgentTasks,
   * then builds a TaskService on a fake host. `streaming` names the tasks the AI service reports
   * as streaming. `parentMetadataFails` makes every metadata read of PARENT_ID return Err.
   */
  async function setup(
    rows: WorkspaceConfigEntry[],
    options: {
      slots: number;
      streaming?: readonly string[];
      parentMetadataFails?: boolean;
      parent?: Partial<WorkspaceConfigEntry>;
    }
  ) {
    await saveWorkspaces(
      config,
      projectPath,
      [workspace(PARENT_ID, 0, options.parent), ...rows],
      testTaskSettings(options.slots)
    );
    const { aiService } = createAIServiceMocks(config, {
      isStreaming: mock((id: string) => options.streaming?.includes(id) ?? false),
    });
    if (options.parentMetadataFails === true) {
      const readMetadata = aiService.getWorkspaceMetadata.bind(aiService);
      spyOn(aiService, "getWorkspaceMetadata").mockImplementation((workspaceId, ...rest) =>
        workspaceId === PARENT_ID
          ? Promise.resolve(Err("metadata unavailable"))
          : readMetadata(workspaceId, ...rest)
      );
    }
    const host = createWorkspaceServiceMocks();
    spyOn(host.workspaceService, "registerExternalBackgroundInit").mockImplementation(
      (_workspaceId: string, _controller: AbortController, settlement: Promise<void>) => {
        backgroundInits.push(settlement);
      }
    );
    const { taskService, workspaceTurnManager } = createTaskServiceHarness(config, {
      aiService,
      workspaceService: host.workspaceService,
    });
    const tracked = trackBackgroundWork(taskService);
    settles.push(tracked.settle);
    return {
      taskService,
      workspaceTurnManager,
      ...tracked,
      drain: async () => {
        await taskService.maybeStartQueuedTasks();
        await tracked.settle();
      },
    };
  }

  /**
   * A drain launches its plans after it releases the mutex, and a failed launch (or a launch
   * failure mark) schedules another drain without awaiting it. Spies (call-through) on each
   * starter. `settle` awaits every recorded run, the in-flight drain and the background inits
   * until no new one appears.
   */
  function trackBackgroundWork(taskService: TaskService) {
    const drains = spyOn(taskService, "maybeStartQueuedTasks");
    const launches = spyOn(internals(taskService), "enqueueReservedTaskLaunch");
    const launchFailures = spyOn(internals(taskService), "markTaskLaunchFailed");
    const pending = () => [
      ...[...drains.mock.results, ...launches.mock.results, ...launchFailures.mock.results].map(
        (result) => result.value
      ),
      ...backgroundInits,
    ];
    return {
      /** Plans the drains handed to the launch, in order. */
      plans: () => launches.mock.calls.map(([plan]) => plan),
      launched: () => launches.mock.calls.map(([plan]) => plan.taskId),
      markedFailed: () => launchFailures.mock.calls.map(([taskId]) => taskId),
      settle: async () => {
        let settled = -1;
        while (settled !== pending().length) {
          settled = pending().length;
          await Promise.allSettled(pending());
          await taskService.queueDrainSettled();
        }
      },
    };
  }

  test("with one free slot only the first queued task is reserved", async () => {
    const { drain, launched } = await setup([queued("first", 1), queued("second", 2)], {
      slots: 1,
    });

    await drain();

    expect(launched()).toEqual(["first"]);
    expect(row("first")?.taskStatus).toBe("running");
    expect(row("second")?.taskStatus).toBe("queued");
  });

  test("a queued task that is already streaming becomes running and takes a slot", async () => {
    // The capacity count already charges the streaming task one of the two slots.
    const { drain, launched } = await setup([queued("streaming", 1), queued("later", 2)], {
      slots: 2,
      streaming: ["streaming"],
    });

    await drain();

    // No launch for the streaming task, and it takes the free slot too: the next task stays
    // queued.
    expect(launched()).toEqual([]);
    expect(row("streaming")?.taskStatus).toBe("running");
    expect(row("later")?.taskStatus).toBe("queued");
  });

  test.each([
    ["no parentWorkspaceId", { parentWorkspaceId: " " }],
    ["a parent without a workspace name", { parentWorkspaceId: "nameless-parent" }],
    ["no workspace name", { name: " " }],
  ] as const)(
    "a queued task with %s is marked failed and the next one still launches",
    async (_label, overrides) => {
      const { drain, launched, markedFailed } = await setup(
        [
          // A second parent whose name is blank: only the second case points a task at it.
          workspace("nameless-parent", 0, { name: " " }),
          queued("broken", 1, overrides),
          queued("later", 2),
        ],
        { slots: 1 }
      );

      await drain();

      // The refusal takes no slot: the one slot goes to the next task.
      expect(markedFailed()).toEqual(["broken"]);
      expect(row("broken")?.taskStatus).toBe("interrupted");
      expect(row("broken")?.taskLaunchError).toBeDefined();
      expect(launched()).toEqual(["later"]);
      expect(row("later")?.taskStatus).toBe("running");
    }
  );

  test.each([
    ["the project directory's name", undefined, "repo"],
    ["its projects entry's name", "Named project", "Named project"],
  ] as const)(
    "a failed parent metadata read launches with metadata from the parent row, named by %s",
    async (_label, listedName, projectName) => {
      const projects = listedName == null ? undefined : [{ projectPath, projectName: listedName }];
      const { drain, plans } = await setup([queued("child", 1)], {
        slots: 1,
        parentMetadataFails: true,
        parent: { projects },
      });

      await drain();

      expect(plans().map((plan) => [plan.taskId, plan.parentMeta])).toEqual([
        [
          "child",
          {
            id: PARENT_ID,
            name: PARENT_ID,
            projectPath,
            projectName,
            runtimeConfig: { type: "local" },
            projects,
          },
        ],
      ]);
      expect(row("child")?.taskStatus).toBe("running");
    }
  );

  test.each([
    ["reads skip_init_hook: true", false, true],
    ["throws", true, false],
  ] as const)(
    "the plan's skipInitHook when the drain's agent definition read %s",
    async (_label, readThrows, expected) => {
      await writeCustomAgentDefinition(projectPath, ["  skip_init_hook: true"]);
      if (readThrows) {
        // Only the drain's read fails; the launch reads the definition again.
        spyOn(agentDefinitionsService, "resolveAgentFrontmatter").mockRejectedValueOnce(
          new Error("unreadable agent definition")
        );
      }
      const { drain, plans } = await setup(
        [queued("child", 1, { agentId: "custom", agentType: "custom" })],
        { slots: 1 }
      );

      await drain();

      expect(plans().map((plan) => [plan.taskId, plan.skipInitHook])).toEqual([
        ["child", expected],
      ]);
      expect(row("child")?.taskStatus).toBe("running");
    }
  );

  test("a workflow-owned task whose run ends after the prepass is interrupted in the loop", async () => {
    const { drain, launched, markedFailed, workspaceTurnManager } = await setup(
      [
        queued("workflow-child", 1, { workflowTask: { runId: RUN_ID, stepId: "step" } }),
        queued("later", 2),
      ],
      { slots: 1 }
    );
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, PARENT_ID),
    });
    await runStore.createRun({
      id: RUN_ID,
      workspaceId: PARENT_ID,
      workflow: { name: "wf", description: "Workflow", scope: "built-in", executable: true },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-01-01T00:00:00.000Z",
    });
    // The run ends while the drain counts active turns: after the prepass found it active and
    // before the per-task loop checks it again.
    const countTurns =
      workspaceTurnManager.countActiveWorkspaceTurnsInGlobalScan.bind(workspaceTurnManager);
    spyOn(workspaceTurnManager, "countActiveWorkspaceTurnsInGlobalScan").mockImplementationOnce(
      async () => {
        const counted = await countTurns();
        await runStore.appendStatus(RUN_ID, "interrupted", "2026-01-01T00:00:01.000Z");
        return counted;
      }
    );

    await drain();

    // Interrupted, not failed, and its slot goes to the next task.
    expect(row("workflow-child")?.taskStatus).toBe("interrupted");
    expect(row("workflow-child")?.taskLaunchError).toBeUndefined();
    expect(markedFailed()).toEqual([]);
    expect(launched()).toEqual(["later"]);
    expect(row("later")?.taskStatus).toBe("running");
  });
});
