// Characterization tests for TaskService.createManyUnderTaskTreeLifecycleLocks, the body of
// createMany under the parents' tree locks: they pin today's behavior before that method is split
// into steps. Every collaborator below is a call-through spy that records one event (with
// "+mutex" while the global mutex is held), so each test can assert the exact order of reads,
// refusals, lock scopes and writes. Launches and queue drains are recorded, not run.
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import type { Config, WorkspaceMetadataOptions } from "@/node/config";
import type { TaskService } from "@/node/services/taskService";
import type { AgentDefinitionPackage } from "@/common/types/agentDefinition";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { Ok, Err, type Result } from "@/common/types/result";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { workspaceUseLeasesFor } from "@/node/services/workspaceUseLeases";
import * as agentDefinitionsService from "@/node/services/agentDefinitions/agentDefinitionsService";
import {
  createAIServiceMocks,
  createTestConfig,
  saveLocalParentWorkspace,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

const PARENT_ID = "1111111111";
const TASK_ID = "aaaaaaaaaa";
const SECOND_ID = "cccccccccc";
const realResolveAgentDefinition = agentDefinitionsService.resolveAgentDefinition;

type CreateManyArgs = Parameters<TaskService["createMany"]>[0][number];
interface LaunchPlan {
  taskId: string;
  launchLease?: { release(): Promise<void> };
}
type Gate = (reservations: unknown, reserve: () => Promise<unknown>) => Promise<unknown>;
interface Internals {
  mutex: { readonly isLocked: boolean; acquire(): Promise<AsyncDisposable> };
  withTaskTreeLifecycleLocks(ids: readonly string[], run: () => Promise<unknown>): Promise<unknown>;
  desktopInputCoordinator: { withReservations: Gate };
  createManyUnderTaskTreeLifecycleLocks(...args: unknown[]): Promise<unknown>;
  beginOwnedTaskAttempt(taskId: string, source: string, identity: unknown): unknown;
  scheduleReservedTaskLaunch(plan: LaunchPlan): void;
  startReservedAgentTask(plan: LaunchPlan): Promise<void>;
  resolveTaskAISettings(...args: unknown[]): Promise<unknown>;
}

function internals(taskService: TaskService): Internals {
  return taskService as unknown as Internals;
}

function workspaceIds(config: Config): string[] {
  return Array.from(config.loadConfigOrDefault().projects.values()).flatMap((project) =>
    project.workspaces.map((workspace) => workspace.id ?? "")
  );
}

/** Test-controlled behavior of the recorded collaborators (see setup). */
interface Hooks {
  /** Workspace ids the config mints, in order. */
  ids: string[];
  /** Rewrites the Nth (1-based) parent metadata read. */
  reviseMetadata?: (
    call: number,
    read: Result<WorkspaceMetadata>
  ) => Result<WorkspaceMetadata> | Promise<Result<WorkspaceMetadata>>;
  /** Rewrites (or, by throwing, rejects) the Nth (1-based) agent definition read. */
  reviseDefinition?: (call: number, read: AgentDefinitionPackage) => AgentDefinitionPackage;
  /** Runs inside the active workspace-turn count, before it resolves. */
  duringTurnCount?: () => void;
  /** The next launch lease hold rejects. */
  refuseLease?: boolean;
}

describe("TaskService.createManyUnderTaskTreeLifecycleLocks before the split", () => {
  let rootDir: string;
  let config: Config;
  // Plans handed to the recorded launch. Each keeps the launch lease createMany gave it, as a
  // real launch would; teardown releases them, so a test that fails early leaks no lease.
  let launched: LaunchPlan[];
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    config = await createTestConfig(rootDir);
    launched = [];
  });
  afterEach(async () => {
    await Promise.allSettled(
      launched.splice(0).flatMap((plan) => plan.launchLease?.release() ?? [])
    );
    mock.restore();
    // Settles any migration persist a config read queued before the root is removed.
    await config.editConfig((cfg) => cfg);
    await removeTaskServiceTestRoot(rootDir);
  });

  /** A local parent and a TaskService whose collaborators record events (see the file header). */
  async function setup(options: { maxParallelAgentTasks?: number } = {}) {
    await saveLocalParentWorkspace(config, rootDir);
    if (options.maxParallelAgentTasks != null) {
      const maxParallelAgentTasks = options.maxParallelAgentTasks;
      await config.editConfig((cfg) => ({
        ...cfg,
        taskSettings: { maxParallelAgentTasks, maxTaskNestingDepth: 3 },
      }));
    }
    const hooks: Hooks = { ids: [TASK_ID, SECOND_ID] };
    const events: string[] = [];
    let metadataCalls = 0;
    let definitionCalls = 0;
    const { aiService } = createAIServiceMocks(config, {
      getWorkspaceMetadata: mock(
        async (id: string, opts?: Pick<WorkspaceMetadataOptions, "persistMigrations">) => {
          event("meta");
          const call = ++metadataCalls;
          const found = await config.getWorkspaceMetadataById(id, opts);
          const read: Result<WorkspaceMetadata> = found ? Ok(found) : Err("not found");
          return (await hooks.reviseMetadata?.(call, read)) ?? read;
        }
      ),
    });
    const { taskService, workspaceTurnManager } = createTaskServiceHarness(config, { aiService });
    const target = internals(taskService);
    function event(name: string) {
      events.push(target.mutex.isLocked ? `${name} +mutex` : name);
    }

    const body = spyOn(target, "createManyUnderTaskTreeLifecycleLocks");
    /** The reservation's current (once it returned: final) stage (TaskReservationProgress). */
    const stage = () =>
      (body.mock.calls[0]?.[2] as { stage: string } | undefined)?.stage ?? "not started";
    const realTree = target.withTaskTreeLifecycleLocks.bind(taskService);
    spyOn(target, "withTaskTreeLifecycleLocks").mockImplementation((ids, run) =>
      realTree(ids, async () => {
        event("tree-enter");
        try {
          return await run();
        } finally {
          event("tree-exit");
        }
      })
    );
    spyOn(agentDefinitionsService, "resolveAgentDefinition").mockImplementation(async (...args) => {
      event("definition");
      const call = ++definitionCalls;
      const read = await realResolveAgentDefinition(...args);
      return hooks.reviseDefinition?.(call, read) ?? read;
    });
    const realCount = workspaceTurnManager.countActiveWorkspaceTurns.bind(workspaceTurnManager);
    spyOn(workspaceTurnManager, "countActiveWorkspaceTurns").mockImplementation(() => {
      event("turns");
      hooks.duringTurnCount?.();
      return realCount();
    });
    spyOn(config, "generateStableId").mockImplementation(() => {
      const id = hooks.ids.shift() ?? "fffffffff0";
      event(`mint ${id}`);
      return id;
    });
    const leases = workspaceUseLeasesFor(config);
    const realHold = leases.hold.bind(leases);
    spyOn(leases, "hold").mockImplementation(async (id, kind) => {
      event(`lease-hold ${id}`);
      if (hooks.refuseLease === true) throw new Error("lease held elsewhere");
      const lease = await realHold(id, kind);
      return {
        release: () => {
          event(`lease-release ${id}`);
          return lease.release();
        },
      };
    });
    const coordinator = target.desktopInputCoordinator;
    const realGate = coordinator.withReservations.bind(coordinator);
    spyOn(coordinator, "withReservations").mockImplementation(async (reservations, reserve) => {
      event(`gate-enter ${JSON.stringify(reservations)} @${stage()}`);
      try {
        return await realGate(reservations, reserve);
      } finally {
        event("gate-exit");
      }
    });
    const realBegin = target.beginOwnedTaskAttempt.bind(taskService);
    spyOn(target, "beginOwnedTaskAttempt").mockImplementation((taskId, source, identity) => {
      event(`own ${taskId} ${source}`);
      return realBegin(taskId, source, identity);
    });
    const realEdit = config.editConfig.bind(config);
    spyOn(config, "editConfig").mockImplementation(async (fn, editOptions) => {
      event(`config-edit-enter @${stage()}`);
      try {
        return await realEdit(fn, editOptions);
      } finally {
        event("config-edit-exit");
      }
    });
    const realEmit = taskService.emitWorkspaceMetadata.bind(taskService);
    spyOn(taskService, "emitWorkspaceMetadata").mockImplementation(async (id) => {
      event(`emit ${id}`);
      await realEmit(id);
    });
    const realSchedule = target.scheduleReservedTaskLaunch.bind(taskService);
    spyOn(target, "scheduleReservedTaskLaunch").mockImplementation((plan) => {
      event(`schedule ${plan.taskId}`);
      realSchedule(plan);
    });
    spyOn(target, "startReservedAgentTask").mockImplementation((plan) => {
      event(`launch ${plan.taskId} ${plan.launchLease != null ? "leased" : "unleased"}`);
      launched.push(plan);
      return Promise.resolve();
    });
    spyOn(taskService, "scheduleMaybeStartQueuedTasks").mockImplementation(() => {
      event("queue-drain");
    });

    // A workflow's checkpoint is an awaited store write: recorded once it resolved.
    const onTaskReserved = mock(async (index: number, result: { taskId: string }) => {
      await Promise.resolve();
      event(`reserved ${index} ${result.taskId} @${stage()}`);
    });
    const createMany = (
      count: number,
      options: { abortSignal?: AbortSignal; args?: Partial<CreateManyArgs> } = {}
    ) => {
      const args: CreateManyArgs = {
        parentWorkspaceId: PARENT_ID,
        kind: "agent",
        agentId: "explore",
        prompt: "go",
        title: "Test task",
        ...options.args,
      };
      return taskService.createMany(
        Array.from({ length: count }, () => ({ ...args })),
        {
          onTaskReserved,
          ...(options.abortSignal != null ? { abortSignal: options.abortSignal } : {}),
        }
      );
    };
    return { taskService, hooks, events, onTaskReserved, stage, createMany };
  }

  // Before the split, the head of the method (prepare, then the mutex) and the per-plan
  // revalidation run in this order. Each refusal stops the batch at once: later reads never run,
  // no id of the batch is owned, and nothing is written.
  const PREPARED = ["tree-enter", "meta", "definition"];
  const REVALIDATING = [...PREPARED, "turns +mutex", "meta +mutex"];
  test.each<[string, number, (hooks: Hooks) => void, string[]]>([
    [
      "the parent's revalidation read fails",
      1,
      (hooks) => (hooks.reviseMetadata = (call, read) => (call === 2 ? Err("gone") : read)),
      [...REVALIDATING, "tree-exit"],
    ],
    [
      "the parent was renamed during preparation",
      1,
      (hooks) =>
        (hooks.reviseMetadata = (call, read) =>
          call === 2 && read.success ? Ok({ ...read.data, name: "renamed" }) : read),
      [...REVALIDATING, "tree-exit"],
    ],
    [
      "the definition re-read throws",
      1,
      (hooks) =>
        (hooks.reviseDefinition = (call, read) => {
          if (call === 2) throw new Error("agents dir unreadable");
          return read;
        }),
      [...REVALIDATING, "definition +mutex", "tree-exit"],
    ],
    [
      "the definition's frontmatter changed",
      1,
      (hooks) =>
        (hooks.reviseDefinition = (call, read) =>
          call === 2 ? { ...read, frontmatter: { ...read.frontmatter, name: "Changed" } } : read),
      [...REVALIDATING, "definition +mutex", "tree-exit"],
    ],
    [
      "the definition's source changed",
      1,
      (hooks) =>
        (hooks.reviseDefinition = (call, read) =>
          call === 2 ? { ...read, source: "/elsewhere/agents" } : read),
      [...REVALIDATING, "definition +mutex", "tree-exit"],
    ],
    [
      "the generated workspace name is invalid",
      1,
      (hooks) => (hooks.ids = ["NOT_VALID"]),
      [...REVALIDATING, "definition +mutex", "mint NOT_VALID +mutex", "tree-exit"],
    ],
    [
      "the launch lease is refused",
      1,
      (hooks) => (hooks.refuseLease = true),
      [
        ...REVALIDATING,
        "definition +mutex",
        `mint ${TASK_ID} +mutex`,
        `lease-hold ${TASK_ID} +mutex`,
        "tree-exit",
      ],
    ],
    [
      "the second plan's definition changed after the first plan's id was minted",
      2,
      (hooks) =>
        (hooks.reviseDefinition = (call, read) =>
          call === 4 ? { ...read, source: "/elsewhere/agents" } : read),
      [
        ...PREPARED,
        "meta",
        "definition",
        "turns +mutex",
        "meta +mutex",
        "definition +mutex",
        `mint ${TASK_ID} +mutex`,
        "meta +mutex",
        "definition +mutex",
        "tree-exit",
      ],
    ],
  ])("%s: the batch is refused under the mutex", async (_label, count, arrange, expected) => {
    const { hooks, events, onTaskReserved, stage, createMany } = await setup();
    arrange(hooks);
    const created = await createMany(count);
    expect(created.success).toBe(false);
    if (created.success) return;
    // A refusal, not the cancellation result.
    expect(created.error.startsWith("Interrupted")).toBe(false);
    expect(events).toEqual(expected);
    expect(stage()).toBe("revalidate");
    expect(onTaskReserved).not.toHaveBeenCalled();
    expect(workspaceIds(config)).toEqual([PARENT_ID]);
  });

  // The cancellation points under the mutex before any id is minted: an abort that lands at one
  // ends the batch at that point and stage, before the next read, and the lock is released. The
  // last column is the stage reported while the active turns are counted (the stall warning's).
  test.each<[string, string, string[], string | undefined]>([
    ["after a plan's last preparation read", "prepare", [...PREPARED, "tree-exit"], undefined],
    ["after the mutex race settled", "mutex", [...PREPARED, "tree-exit"], undefined],
    [
      "while active turns are counted",
      "revalidate",
      [...PREPARED, "turns +mutex", "tree-exit"],
      "revalidate",
    ],
    [
      "as the re-read definition is compared",
      "revalidate",
      [...REVALIDATING, "definition +mutex", "tree-exit"],
      "revalidate",
    ],
  ])(
    "an abort %s interrupts the batch at stage %s",
    async (moment, finalStage, expected, counting) => {
      const { taskService, hooks, events, onTaskReserved, stage, createMany } = await setup();
      const controller = new AbortController();
      const target = internals(taskService);
      const mutex = target.mutex;
      // Queued behind the abort race's own handler: the race resolves with the value first.
      const abortOnceSettled = <T>(read: Promise<T>) => {
        void read.then(() => queueMicrotask(() => controller.abort()));
        return read;
      };
      if (moment === "after a plan's last preparation read") {
        const realSettings = target.resolveTaskAISettings.bind(taskService);
        spyOn(target, "resolveTaskAISettings").mockImplementation((...args) =>
          abortOnceSettled(realSettings(...args))
        );
      }
      if (moment === "after the mutex race settled") {
        const realAcquire = mutex.acquire.bind(mutex);
        spyOn(mutex, "acquire").mockImplementation(() => abortOnceSettled(realAcquire()));
      }
      let stageWhileCounting: string | undefined;
      hooks.duringTurnCount = () => {
        stageWhileCounting = stage();
        if (moment === "while active turns are counted") controller.abort();
      };
      if (moment === "as the re-read definition is compared") {
        // JSON.stringify runs toJSON synchronously, after the read already won its abort race.
        hooks.reviseDefinition = (call, read) => {
          if (call !== 2) return read;
          const toJSON = () => {
            controller.abort();
            return read.frontmatter;
          };
          return { ...read, frontmatter: Object.assign({ ...read.frontmatter }, { toJSON }) };
        };
      }
      const created = await createMany(1, { abortSignal: controller.signal });
      expect(created.success).toBe(false);
      if (created.success) return;
      expect(created.error.startsWith("Interrupted")).toBe(true);
      expect(events).toEqual(expected);
      expect(stage()).toBe(finalStage);
      expect(stageWhileCounting).toBe(counting);
      expect(mutex.isLocked).toBe(false);
      expect(onTaskReserved).not.toHaveBeenCalled();
      expect(workspaceIds(config)).toEqual([PARENT_ID]);
    }
  );

  test("the mutex and the launch leases are held from revalidation through scheduling, inside the tree locks", async () => {
    // One parallel slot: the first plan starts and takes the only launch lease, the second queues.
    const { events, stage, createMany } = await setup({ maxParallelAgentTasks: 1 });
    const created = await createMany(2);
    expect(created.success).toBe(true);
    if (!created.success) return;
    expect(created.data.map((result) => [result.taskId, result.status])).toEqual([
      [TASK_ID, "starting"],
      [SECOND_ID, "queued"],
    ]);
    expect(events).toEqual([
      ...PREPARED,
      "meta",
      "definition",
      "turns +mutex",
      "meta +mutex",
      "definition +mutex",
      `mint ${TASK_ID} +mutex`,
      "meta +mutex",
      "definition +mutex",
      `mint ${SECOND_ID} +mutex`,
      `lease-hold ${TASK_ID} +mutex`,
      "gate-enter [] @desktop-gate +mutex",
      // Ownership before exposure: both ids are owned before the first checkpoint callback.
      `own ${TASK_ID} reservation +mutex`,
      `own ${SECOND_ID} reservation +mutex`,
      `reserved 0 ${TASK_ID} @checkpoint +mutex`,
      `reserved 1 ${SECOND_ID} @checkpoint +mutex`,
      "config-edit-enter @config-commit +mutex",
      "config-edit-exit +mutex",
      "gate-exit +mutex",
      `emit ${TASK_ID} +mutex`,
      `emit ${SECOND_ID} +mutex`,
      `schedule ${TASK_ID} +mutex`,
      `launch ${TASK_ID} leased +mutex`,
      "queue-drain +mutex",
      // No lease-release: the launch took the only lease, so the scope had none left.
      "tree-exit",
    ]);
    expect(stage()).toBe("launch");
    expect(launched.map((plan) => plan.taskId)).toEqual([TASK_ID]);
    const cfg = config.loadConfigOrDefault();
    expect(findWorkspaceEntry(cfg, TASK_ID)?.workspace.taskStatus).toBe("starting");
    expect(findWorkspaceEntry(cfg, SECOND_ID)?.workspace.taskStatus).toBe("queued");
  });

  test("a shared-desktop plan enters its owner's desktop gate with itself as the borrower", async () => {
    const { events, createMany } = await setup();
    const created = await createMany(1, { args: { desktop: "shared" } });
    expect(created.success).toBe(true);
    const reservation = { ownerWorkspaceId: PARENT_ID, borrowerWorkspaceId: TASK_ID };
    expect(events.filter((name) => name.startsWith("gate-"))).toEqual([
      `gate-enter ${JSON.stringify([reservation])} @desktop-gate +mutex`,
      "gate-exit +mutex",
    ]);
  });

  test("every plan is revalidated against the config and task settings read once under the mutex", async () => {
    const { hooks, events, createMany } = await setup();
    // While the first plan's parent is re-read, another writer changes an input of every plan
    // (the AI defaults) and the parallel limit. The second plan is checked against the snapshot.
    hooks.reviseMetadata = async (call, read) => {
      if (call !== 3) return read;
      await config.editConfig((cfg) => ({
        ...cfg,
        agentAiDefaults: { ...cfg.agentAiDefaults, exec: { thinkingLevel: "low" } },
        taskSettings: { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 },
      }));
      return read;
    };
    const created = await createMany(2);
    expect(created.success).toBe(true);
    if (!created.success) return;
    expect(created.data.map((result) => [result.taskId, result.status])).toEqual([
      [TASK_ID, "starting"],
      [SECOND_ID, "starting"],
    ]);
    expect(workspaceIds(config).sort()).toEqual([PARENT_ID, TASK_ID, SECOND_ID].sort());
    // Nothing queued, so no queue drain is scheduled.
    expect(events.filter((name) => name.startsWith("queue-drain"))).toEqual([]);
  });
});
