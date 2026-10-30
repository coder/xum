// Characterization tests for paths of TaskService's queue drain
// (maybeStartQueuedTasksFromReservations, reached through the public maybeStartQueuedTasks) that
// the other suites do not reach. Each test asserts what the drain did with every queued row:
// reserved it (a plan handed to enqueueReservedTaskLaunch), marked it failed (interrupted with a
// taskLaunchError), or left it alone, and whether it took a slot. The lease tests assert that a
// launch lease the drain holds for a task it does not launch is released: a leaked one makes the
// task's removal refuse until the process exits.
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { TaskService } from "@/node/services/taskService";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { Err } from "@/common/types/result";
import * as agentDefinitionsService from "@/node/services/agentDefinitions/agentDefinitionsService";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { workspaceUseLeasesFor } from "@/node/services/workspaceUseLeases";
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
const RESERVED_ATTEMPT_ID = "att_0123456789abcdef";

/** The fields of the drain's launch plan these tests read. */
interface LaunchPlan {
  taskId: string;
  parentMeta: WorkspaceMetadata;
  skipInitHook: boolean;
  start: { kind: "sendMessage"; sendId: string } | { kind: "resumeStream" };
  attemptId?: string;
  abortSignal?: AbortSignal;
}
interface Internals {
  enqueueReservedTaskLaunch: (plan: LaunchPlan) => Promise<void>;
  markTaskLaunchFailed: (taskId: string, ...rest: unknown[]) => Promise<void>;
  beginOwnedTaskAttempt: (
    taskId: string,
    source: string,
    identity: { attemptId: string; receiptEligible: boolean; abortSignal?: AbortSignal }
  ) => unknown;
}

function internals(taskService: TaskService): Internals {
  return taskService as unknown as Internals;
}

describe("TaskService queue drain: reservations, refusals and launch leases", () => {
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
  /** The tasks among `taskIds` on which this backend still holds a launch lease. */
  const launchLeasesHeld = (...taskIds: string[]) =>
    taskIds.filter((taskId) => workspaceUseLeasesFor(config).heldCount(taskId, "launch") > 0);

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
   * `shuttingDown` makes the host report that shutdown began.
   */
  async function setup(
    rows: WorkspaceConfigEntry[],
    options: {
      slots: number;
      streaming?: readonly string[];
      parentMetadataFails?: boolean;
      parent?: Partial<WorkspaceConfigEntry>;
      shuttingDown?: boolean;
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
    const host = createWorkspaceServiceMocks(
      options.shuttingDown === true ? { isShuttingDown: mock(() => true) } : {}
    );
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

  test("queued tasks are reserved oldest first, whatever their order in the config", async () => {
    const { drain, launched } = await setup([queued("newer", 2), queued("older", 1)], {
      slots: 1,
    });

    await drain();

    expect(launched()).toEqual(["older"]);
    expect(row("older")?.taskStatus).toBe("running");
    expect(row("newer")?.taskStatus).toBe("queued");
  });

  test("a queued task that is already streaming becomes running and takes a slot", async () => {
    // The capacity count already charges the streaming task one of the two slots.
    const { drain, launched } = await setup([queued("streaming", 1), queued("later", 2)], {
      slots: 2,
      streaming: ["streaming"],
    });

    await drain();

    // No launch for the streaming task, and it takes the free slot too: the next task stays
    // queued. That second slot is issue #7743 (the double slot): its fix makes this test fail,
    // and must change it to expect `later` to launch.
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

  test("a queued task with a secondary project the config does not list is marked failed", async () => {
    const { drain, launched, markedFailed } = await setup(
      [
        queued("multi", 1, {
          projects: [
            { projectPath, projectName: "repo" },
            { projectPath: "/elsewhere/unlisted", projectName: "unlisted" },
          ],
        }),
        queued("later", 2),
      ],
      { slots: 1 }
    );

    await drain();

    // An unlisted project counts as untrusted. The refusal takes no slot.
    expect(markedFailed()).toEqual(["multi"]);
    expect(row("multi")?.taskStatus).toBe("interrupted");
    expect(row("multi")?.taskLaunchError).toBeDefined();
    expect(launched()).toEqual(["later"]);
  });

  test.each([
    ["the project directory's name", "none", "repo"],
    ["its projects entry's name", "own", "Named project"],
    ["the project directory's name when its projects list names only others", "others", "repo"],
  ] as const)(
    "a failed parent metadata read launches with metadata from the parent row, named by %s",
    async (_label, listed, projectName) => {
      const projects = {
        none: undefined,
        own: [{ projectPath, projectName: "Named project" }],
        others: [{ projectPath: path.join(rootDir, "other"), projectName: "Other project" }],
      }[listed];
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

  test("once shutdown began the drain stops at the first launch CAS and leaves the tasks queued", async () => {
    const { drain, launched, markedFailed } = await setup(
      [queued("first", 1), queued("second", 2)],
      { slots: 2, shuttingDown: true }
    );
    const leaseHolds = spyOn(workspaceUseLeasesFor(config), "hold");

    await drain();

    // No launch lease for the second task: the drain stopped instead of trying it.
    expect(leaseHolds.mock.calls.map(([taskId]) => taskId)).toEqual(["first"]);
    // The drain released the first task's lease when it stopped.
    expect(launchLeasesHeld("first", "second")).toEqual([]);
    expect(launched()).toEqual([]);
    expect(markedFailed()).toEqual([]);
    expect(row("first")?.taskStatus).toBe("queued");
    expect(row("second")?.taskStatus).toBe("queued");
  });

  test("a launch CAS lost to another writer releases the launch lease and plans nothing", async () => {
    const { taskService, drain, plans, markedFailed } = await setup([queued("child", 1)], {
      slots: 1,
    });
    const leases = workspaceUseLeasesFor(config);
    const hold = leases.hold.bind(leases);
    spyOn(leases, "hold").mockImplementationOnce(async (workspaceId, kind) => {
      const lease = await hold(workspaceId, kind);
      // Another writer (a Stop) ends the task after the drain's lease hold, before its CAS.
      await taskService.editWorkspaceEntry(workspaceId, (workspace) => {
        workspace.taskStatus = "interrupted";
      });
      return lease;
    });

    await drain();

    expect(launchLeasesHeld("child")).toEqual([]);
    expect(plans()).toEqual([]);
    expect(markedFailed()).toEqual([]);
    expect(row("child")?.taskStatus).toBe("interrupted");
  });

  test("a config write that throws out of the loop after an earlier task's plan leaves no launch lease held", async () => {
    const { taskService, launched, markedFailed } = await setup(
      [queued("first", 1), queued("second", 2)],
      { slots: 2 }
    );
    // Every config write of the second task fails: its launch CAS throws, then the write of its
    // failure mark rethrows out of the loop. The first task's plan is collected, not launched.
    const editRow = taskService.editWorkspaceEntry.bind(taskService);
    spyOn(taskService, "editWorkspaceEntry").mockImplementation((workspaceId, ...rest) =>
      workspaceId === "second"
        ? Promise.reject(new Error("config write failed"))
        : editRow(workspaceId, ...rest)
    );

    const drainFailure = await taskService.maybeStartQueuedTasks().catch((error: unknown) => error);
    expect(drainFailure).toMatchObject({ message: "config write failed" });

    // The CAS failure released the second task's lease, and the drain's scope exit the first's.
    expect(launchLeasesHeld("first", "second")).toEqual([]);
    expect(launched()).toEqual([]);
    expect(markedFailed()).toEqual(["second"]);
  });

  test.each([
    ["owns", true],
    ["does not own", false],
  ] as const)(
    "a queued task whose reservation this process %s: the plan's attempt id and cancellation",
    async (_label, owned) => {
      const { taskService, drain, plans } = await setup(
        [queued("child", 1, { taskAttemptId: RESERVED_ATTEMPT_ID })],
        { slots: 1 }
      );
      const reservation = new AbortController();
      if (owned) {
        internals(taskService).beginOwnedTaskAttempt("child", "reservation", {
          attemptId: RESERVED_ATTEMPT_ID,
          receiptEligible: true,
          abortSignal: reservation.signal,
        });
      }

      await drain();

      // An owned reservation keeps its attempt id and its cancellation across the queue; any
      // other launch rotates the id.
      const [plan] = plans();
      expect(plan.taskId).toBe("child");
      expect(plan.attemptId === RESERVED_ATTEMPT_ID).toBe(owned);
      // A launch this process does not own begins its attempt without a cancellation signal.
      expect(plan.abortSignal).toBe(owned ? reservation.signal : undefined);
      expect(row("child")?.taskStatus).toBe("running");
    }
  );

  test("the launch CAS writes starting, the attempt id and the brief's send id before the launch", async () => {
    const { taskService, drain, plans } = await setup([queued("child", 1)], { slots: 1 });
    let rowAtLaunch: WorkspaceConfigEntry | undefined;
    // Read the row when the drain hands the plan over, then skip the launch.
    spyOn(internals(taskService), "enqueueReservedTaskLaunch").mockImplementationOnce((plan) => {
      rowAtLaunch = row(plan.taskId);
      return Promise.resolve();
    });

    await drain();

    const [plan] = plans();
    expect(plan.start.kind).toBe("sendMessage");
    expect(rowAtLaunch).toMatchObject({
      taskStatus: "starting",
      taskAttemptId: plan.attemptId,
      taskPromptSendId: plan.start.kind === "sendMessage" ? plan.start.sendId : undefined,
    });
  });

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
