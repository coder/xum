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
// TASK_RESERVATION_CANCELED_MESSAGE: the fence persists it and rejects the waiters with it.
const CANCELED = "Reservation canceled";
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
  closeReservedAttempts(plans: unknown, source: string): void;
  recordTaskInterrupted(taskId: string, parentWorkspaceId: string | undefined): void;
  settleChildGoalPause(workspaceId: string): Promise<void>;
  rejectWaiters(taskId: string, error: Error): void;
  attemptLedger: {
    persistOwnedAttemptSettlement(
      id: string,
      attempt: unknown,
      receipt: string,
      source: string
    ): Promise<void>;
  };
  waiters: { armWaitersOfUnendedTask(taskId: string): void };
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
  /** Runs inside each checkpoint callback. */
  duringCheckpoint?: () => void;
  /** Runs after each metadata emit, before it resolves. */
  afterEmit?: (taskId: string) => Promise<void> | void;
  /** The error a task's editWorkspaceEntry rejects with (before its updater runs, or after). */
  failFenceEdit?: (taskId: string) => { error: Error; afterUpdate: boolean } | undefined;
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
    // The attempts the reservation owns, and the attempt id each one minted.
    const owned = new Map<string, { attempt: unknown; attemptId: unknown }>();
    spyOn(target, "beginOwnedTaskAttempt").mockImplementation((taskId, source, identity) => {
      event(`own ${taskId} ${source}`);
      const attempt = realBegin(taskId, source, identity);
      owned.set(taskId, { attempt, attemptId: (identity as { attemptId?: string }).attemptId });
      return attempt;
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
      await hooks.afterEmit?.(id);
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
      hooks.duringCheckpoint?.();
    });
    recordFence(taskService, hooks, event, owned);
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
    return { taskService, hooks, events, onTaskReserved, stage, createMany, owned };
  }

  /** Records the post-commit fence's collaborators (call-through, see setup). */
  function recordFence(
    taskService: TaskService,
    hooks: Hooks,
    event: (name: string) => void,
    owned: ReadonlyMap<string, { attempt: unknown }>
  ) {
    const target = internals(taskService);
    const realClose = target.closeReservedAttempts.bind(taskService);
    spyOn(target, "closeReservedAttempts").mockImplementation((plans, source) => {
      event(`close ${source}`);
      realClose(plans, source);
    });
    const realEditEntry = taskService.editWorkspaceEntry.bind(taskService);
    spyOn(taskService, "editWorkspaceEntry").mockImplementation(async (id, updater, options) => {
      event(`edit ${id}`);
      const failure = hooks.failFenceEdit?.(id);
      if (failure == null) return await realEditEntry(id, updater, options);
      if (failure.afterUpdate) await realEditEntry(id, updater, options);
      throw failure.error;
    });
    const realInterrupted = target.recordTaskInterrupted.bind(taskService);
    spyOn(target, "recordTaskInterrupted").mockImplementation((id, parentId) => {
      event(`interrupted ${id} ${parentId ?? "none"}`);
      realInterrupted(id, parentId);
    });
    const realGoalPause = target.settleChildGoalPause.bind(taskService);
    spyOn(target, "settleChildGoalPause").mockImplementation((id) => {
      event(`goal-pause ${id}`);
      return realGoalPause(id);
    });
    const realReject = target.rejectWaiters.bind(taskService);
    spyOn(target, "rejectWaiters").mockImplementation((id, error) => {
      event(`reject ${id} ${error.message}`);
      realReject(id, error);
    });
    const ledger = target.attemptLedger;
    const realReceipt = ledger.persistOwnedAttemptSettlement.bind(ledger);
    spyOn(ledger, "persistOwnedAttemptSettlement").mockImplementation((id, attempt, ...rest) => {
      const whose = attempt === owned.get(id)?.attempt ? "owned" : "other";
      event(`receipt ${id} ${whose} ${rest.join(" ")}`);
      return realReceipt(id, attempt, ...rest);
    });
    const realArm = target.waiters.armWaitersOfUnendedTask.bind(target.waiters);
    spyOn(target.waiters, "armWaitersOfUnendedTask").mockImplementation((id) => {
      event(`arm ${id}`);
      realArm(id);
    });
  }

  /** The events after the commit left the desktop gate, without the config-edit records. */
  function afterCommit(events: readonly string[]): string[] {
    return events
      .slice(events.indexOf("gate-exit +mutex") + 1)
      .filter((name) => !name.startsWith("config-edit"));
  }

  interface RowState {
    taskStatus?: string;
    taskLaunchError?: string;
    taskAttemptId?: string;
    taskGoalPauseOwed?: string;
  }
  /** A task row's fenced fields; the reservation's own attempt id reads "reserved". */
  function rowState(
    taskId: string,
    owned: ReadonlyMap<string, { attemptId: unknown }>
  ): RowState | undefined {
    const row = findWorkspaceEntry(config.loadConfigOrDefault(), taskId)?.workspace;
    if (row == null) return undefined;
    const attempt = (id: string | undefined) =>
      id != null && id === owned.get(taskId)?.attemptId ? "reserved" : id;
    return {
      taskStatus: row.taskStatus,
      taskLaunchError: row.taskLaunchError,
      taskAttemptId: attempt(row.taskAttemptId),
      taskGoalPauseOwed: row.taskGoalPauseOwed == null ? undefined : attempt(row.taskGoalPauseOwed),
    };
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

  // The post-commit fence (an abort that landed after the commit's mutator ran), one plan. Each
  // row names who else wrote the task row before the fence's own edit, which the fence must
  // respect: it interrupts only a row still in the status it committed under its own attempt.
  // Well formed: the config loader replaces a malformed attempt id on read.
  const OTHER_ATTEMPT = "att_00000000000000ff";
  const fenceCases: Array<{
    label: string;
    otherWriter?: (cfg: ReturnType<Config["loadConfigOrDefault"]>) => void;
    canceledInsideCommit?: boolean;
    fence: { edit: boolean; transition: boolean; reject: boolean };
    row: RowState | undefined;
  }> = [
    {
      label: "a row nobody else wrote is interrupted with the cancel message",
      fence: { edit: true, transition: true, reject: true },
      row: {
        taskStatus: "interrupted",
        taskLaunchError: CANCELED,
        taskAttemptId: "reserved",
        taskGoalPauseOwed: "reserved",
      },
    },
    {
      label: "a row whose status moved on is left as is, its waiters still rejected",
      otherWriter: (cfg) => {
        const row = findWorkspaceEntry(cfg, TASK_ID)?.workspace;
        if (row != null) row.taskStatus = "running";
      },
      fence: { edit: true, transition: false, reject: true },
      row: { taskStatus: "running", taskAttemptId: "reserved" },
    },
    {
      label: "a row another writer re-admitted keeps its status and its waiters",
      otherWriter: (cfg) => {
        const row = findWorkspaceEntry(cfg, TASK_ID)?.workspace;
        if (row != null) row.taskAttemptId = OTHER_ATTEMPT;
      },
      fence: { edit: true, transition: false, reject: false },
      row: { taskStatus: "starting", taskAttemptId: OTHER_ATTEMPT },
    },
    {
      // allowMissing: the fence's edit of a removed row is a no-op, not a failure.
      label: "a row another writer removed is not an error",
      otherWriter: (cfg) => {
        for (const project of cfg.projects.values()) {
          project.workspaces = project.workspaces.filter((ws) => ws.id !== TASK_ID);
        }
      },
      fence: { edit: true, transition: false, reject: true },
      row: undefined,
    },
    {
      // The commit's mutator saw the abort and wrote the row interrupted itself (the callback
      // it calls sets canceledInsideCommit): the fence does not edit it again.
      label: "a row the commit already wrote interrupted is not edited again",
      canceledInsideCommit: true,
      fence: { edit: false, transition: true, reject: true },
      row: { taskStatus: "interrupted", taskLaunchError: CANCELED, taskAttemptId: "reserved" },
    },
  ];
  test.each(fenceCases)("$label", async ({ otherWriter, canceledInsideCommit, fence, row }) => {
    const { hooks, events, stage, createMany, owned } = await setup();
    const controller = new AbortController();
    if (canceledInsideCommit === true) {
      hooks.duringCheckpoint = () => controller.abort();
    } else {
      hooks.afterEmit = async () => {
        hooks.afterEmit = undefined;
        if (otherWriter != null) {
          await config.editConfig((cfg) => {
            otherWriter(cfg);
            return cfg;
          });
        }
        controller.abort();
      };
    }
    const created = await createMany(1, { abortSignal: controller.signal });
    expect(created.success).toBe(false);
    if (created.success) return;
    expect(created.error.startsWith("Interrupted")).toBe(true);
    expect(afterCommit(events)).toEqual([
      `emit ${TASK_ID} +mutex`,
      "close reservation-canceled +mutex",
      ...(fence.edit ? [`edit ${TASK_ID} +mutex`] : []),
      ...(fence.transition
        ? [`interrupted ${TASK_ID} ${PARENT_ID} +mutex`, `goal-pause ${TASK_ID} +mutex`]
        : []),
      // Rejected before the receipt write's await.
      ...(fence.reject ? [`reject ${TASK_ID} ${CANCELED} +mutex`] : []),
      `receipt ${TASK_ID} owned reservation-canceled reservation-canceled +mutex`,
      `emit ${TASK_ID} +mutex`,
      // The untaken lease is released at scope exit, before the mutex.
      `lease-release ${TASK_ID} +mutex`,
      "tree-exit",
    ]);
    expect(rowState(TASK_ID, owned)).toEqual(row);
    expect(stage()).toBe("launch");
    expect(launched).toEqual([]);
  });

  test.each([
    ["the first plan's fence write rejects", [TASK_ID], false],
    ["both plans' fence writes reject", [TASK_ID, SECOND_ID], false],
    // The updater ran and saw the row moved on (another writer's): its waiters are not armed.
    ["the first plan's fence write rejects after its row moved on", [TASK_ID], true],
  ])("%s: every plan is still fenced, then the first failure is thrown", async (_l, ids, moved) => {
    const { hooks, events, createMany, owned } = await setup();
    const controller = new AbortController();
    const failures = new Map(ids.map((id) => [id, new Error(`fence write of ${id} failed`)]));
    hooks.failFenceEdit = (id) => {
      const error = failures.get(id);
      return error == null ? undefined : { error, afterUpdate: moved };
    };
    hooks.afterEmit = async (id) => {
      if (id !== SECOND_ID) return;
      hooks.afterEmit = undefined;
      if (moved) {
        await config.editConfig((cfg) => {
          const row = findWorkspaceEntry(cfg, TASK_ID)?.workspace;
          if (row != null) row.taskStatus = "running";
          return cfg;
        });
      }
      controller.abort();
    };
    const outcome = await createMany(2, { abortSignal: controller.signal }).then(
      () => "resolved",
      (error: unknown) => error
    );
    expect(outcome).toBe(failures.get(TASK_ID));
    // A rejected write leaves the row starting with nothing to launch it: its waiters are armed.
    const fenced = (id: string) =>
      failures.has(id)
        ? [`edit ${id} +mutex`, ...(moved ? [] : [`arm ${id} +mutex`])]
        : [
            `edit ${id} +mutex`,
            `interrupted ${id} ${PARENT_ID} +mutex`,
            `goal-pause ${id} +mutex`,
            `reject ${id} ${CANCELED} +mutex`,
            `receipt ${id} owned reservation-canceled reservation-canceled +mutex`,
            `emit ${id} +mutex`,
          ];
    expect(afterCommit(events)).toEqual([
      `emit ${TASK_ID} +mutex`,
      `emit ${SECOND_ID} +mutex`,
      "close reservation-canceled +mutex",
      ...fenced(TASK_ID),
      ...fenced(SECOND_ID),
      `lease-release ${TASK_ID} +mutex`,
      `lease-release ${SECOND_ID} +mutex`,
      "tree-exit",
    ]);
    expect(rowState(TASK_ID, owned)?.taskStatus).toBe(moved ? "running" : "starting");
    expect(rowState(SECOND_ID, owned)?.taskStatus).toBe(
      failures.has(SECOND_ID) ? "starting" : "interrupted"
    );
  });

  test("the post-commit fence reads the abort after the last emit, in the tick that schedules", async () => {
    const { events, createMany } = await setup();
    const controller = new AbortController();
    // Every read is recorded, with a marker queued behind it: work after an await lands after it.
    Object.defineProperty(controller.signal, "aborted", {
      get(this: AbortSignal): boolean {
        events.push("abort-read");
        queueMicrotask(() => events.push("tick"));
        // The prototype's accessor, read for this signal.
        return Reflect.get(AbortSignal.prototype, "aborted", this);
      },
    });
    const created = await createMany(2, { abortSignal: controller.signal });
    expect(created.success).toBe(true);
    expect(events.slice(events.lastIndexOf(`emit ${SECOND_ID} +mutex`))).toEqual([
      `emit ${SECOND_ID} +mutex`,
      "abort-read",
      `schedule ${TASK_ID} +mutex`,
      `launch ${TASK_ID} leased +mutex`,
      `schedule ${SECOND_ID} +mutex`,
      `launch ${SECOND_ID} leased +mutex`,
      "tick",
      "tree-exit",
    ]);
  });
});
