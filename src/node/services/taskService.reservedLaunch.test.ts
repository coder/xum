// Characterization tests for paths of TaskService's reserved launch (startReservedAgentTaskLeased)
// that the other suites do not reach. The launch runs from the queue drain or createMany through
// the lease wrapper startReservedAgentTask; the pre-identity tests call that wrapper directly, as
// no public path builds a plan without an attempt id. Each test asserts what the launch did with
// the task: its row, its init log (startInit/endInit), the init it registered with the host, the
// checkout cleanup it ran, and whether it sent the brief. Only the init hook (runBackgroundInit)
// and the WorkspaceHost (createWorkspaceServiceMocks) are stand-ins.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Err } from "@/common/types/result";
import { retiredAttemptMessage } from "@/constants/agentMessaging";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import type { TaskService } from "@/node/services/taskService";
import {
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

const PARENT_ID = "parent";
const CHILD = "child";
const FOREIGN_ATTEMPT_ID = "att_00000000000000f1";
const EDIT_FAILURE = "config write failed";
const SEND_FAILURE = "send failed";
const UNREADABLE = "config.json is unreadable";
const FORK_FAILURE = "fork failed";
const SANITIZE_FAILURE = "stale plugin overrides could not be removed";
const RECLAIM_FAILURE = "reclaim failed";
const CLAIM = { runId: "wfr_claim", stepId: "step" };

interface Internals {
  startReservedAgentTask: (plan: object) => Promise<void>;
  enqueueReservedTaskLaunch: (plan: { taskId: string }) => Promise<void>;
  markTaskLaunchFailed: (taskId: string, ...rest: unknown[]) => Promise<void>;
  admitTaskDesktopRecovery: (taskId: string) => Promise<boolean>;
  materializeReservedTaskWorkspace: (...args: unknown[]) => Promise<object | null>;
  cleanupMaterializedTaskWorkspace: (...args: unknown[]) => Promise<void>;
  reclaimUnsanitizedTaskCheckout: (...args: unknown[]) => Promise<object>;
}

function internals(taskService: TaskService): Internals {
  return taskService as unknown as Internals;
}

/** Test code that runs at one point of the launch; each is read when the launch gets there. */
interface LaunchHooks {
  /** Before the lease wrapper (startReservedAgentTask) runs. */
  beforeLaunch?: () => Promise<void> | void;
  /** After the desktop recovery check admitted the launch. */
  afterDesktopCheck?: () => Promise<void>;
  /** On the materialized checkout; returns the one the launch continues with. */
  materialized?: (launch: object) => Promise<object>;
  /** Once, before the next editWorkspaceEntry of CHILD; a rejection fails that write. */
  nextRowEdit?: () => Promise<void>;
  /** While the host sanitizes the checkout (the sanitize/secrets window before the init). */
  sanitize?: () => Promise<void>;
  /** The error the host's sanitize step returns (unset: the sanitize passes). */
  sanitizeError?: string;
  /** Synchronously, when the launch registers its init with the host. */
  initRegistered?: () => void;
}

describe("TaskService reserved launch: exits, cancellations and refusals", () => {
  let rootDir: string;
  let config: Config;
  let projectPath: string;
  // One settle per setup and the stop latches the tests hold. Teardown releases the latches and
  // runs the settles, so a test that fails early still awaits the drains, launches and inits it
  // started before the root is removed.
  let settles: Array<() => Promise<void>>;
  let releases: Array<() => void>;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    config = await createTestConfig(rootDir);
    projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    settles = [];
    releases = [];
    // The init hook is not under test; its registration with the host is.
    spyOn(runtimeFactory, "runBackgroundInit").mockResolvedValue(undefined);
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    // allSettled: a failed launch must not hide the test's own failure.
    await Promise.allSettled(settles.splice(0).map((settle) => settle()));
    mock.restore();
    await removeTaskServiceTestRoot(rootDir);
  });

  const row = (id: string) => findWorkspaceInConfig(config, id);
  /** Another writer's change to CHILD's row (a Stop, another backend's stamp, a workflow claim). */
  const patchChild = (patch: Partial<WorkspaceConfigEntry>) =>
    config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const workspace = project.workspaces.find((candidate) => candidate.id === CHILD);
        if (workspace != null) Object.assign(workspace, patch);
      }
      return cfg;
    });
  /** A removal unpublishes CHILD's row. */
  const unpublishChild = () =>
    config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        project.workspaces = project.workspaces.filter((workspace) => workspace.id !== CHILD);
      }
      return cfg;
    });

  /** CHILD under PARENT_ID, a local task in the project directory. */
  function child(overrides: Partial<WorkspaceConfigEntry>): WorkspaceConfigEntry {
    return {
      path: projectPath,
      id: CHILD,
      name: CHILD,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 1)).toISOString(),
      runtimeConfig: { type: "local" },
      parentWorkspaceId: PARENT_ID,
      agentId: "explore",
      agentType: "explore",
      taskPrompt: "work for the child",
      taskModelString: "openai:gpt-5.2",
      ...overrides,
    };
  }

  /**
   * Saves PARENT_ID (its checkout at `parentPath`, the project directory by default) plus `rows`,
   * then builds a TaskService on a fake host with the hook spies.
   */
  async function setup(rows: WorkspaceConfigEntry[], parentPath = projectPath) {
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: PARENT_ID,
          name: PARENT_ID,
          createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
          runtimeConfig: { type: "local" },
        },
        ...rows,
      ],
      testTaskSettings(3)
    );
    const hooks: LaunchHooks = {};
    const backgroundInits: Array<Promise<void>> = [];
    const directLaunches: Array<Promise<void>> = [];
    const host = createWorkspaceServiceMocks();
    spyOn(host.workspaceService, "registerExternalBackgroundInit").mockImplementation(
      (_workspaceId: string, _controller: AbortController, settlement: Promise<void>) => {
        backgroundInits.push(settlement);
        hooks.initRegistered?.();
      }
    );
    const sanitize = spyOn(
      host.workspaceService,
      "sanitizeMaterializedTaskWorkspace"
    ).mockImplementation(async () => {
      await hooks.sanitize?.();
      return hooks.sanitizeError;
    });
    const { taskService, initStateManager } = createTaskServiceHarness(config, {
      workspaceService: host.workspaceService,
    });
    const svc = internals(taskService);

    // Call-through spies. Without its hook each returns the real call's promise, so it adds no
    // await to the launch.
    const launch = svc.startReservedAgentTask.bind(taskService);
    spyOn(svc, "startReservedAgentTask").mockImplementation((plan) => {
      const hook = hooks.beforeLaunch;
      return hook == null ? launch(plan) : Promise.resolve(hook()).then(() => launch(plan));
    });
    const admitDesktop = svc.admitTaskDesktopRecovery.bind(taskService);
    spyOn(svc, "admitTaskDesktopRecovery").mockImplementation((taskId) => {
      const hook = hooks.afterDesktopCheck;
      const admitted = admitDesktop(taskId);
      return hook == null ? admitted : admitted.then((ok) => hook().then(() => ok));
    });
    const materialize = svc.materializeReservedTaskWorkspace.bind(taskService);
    spyOn(svc, "materializeReservedTaskWorkspace").mockImplementation((...args) => {
      const hook = hooks.materialized;
      const materialized = materialize(...args);
      return hook == null ? materialized : materialized.then((it) => (it == null ? it : hook(it)));
    });
    const editEntry = taskService.editWorkspaceEntry.bind(taskService);
    spyOn(taskService, "editWorkspaceEntry").mockImplementation((workspaceId, ...rest) => {
      const hook = workspaceId === CHILD ? hooks.nextRowEdit : undefined;
      if (hook == null) return editEntry(workspaceId, ...rest);
      hooks.nextRowEdit = undefined;
      return hook().then(() => editEntry(workspaceId, ...rest));
    });
    const cleanups = spyOn(svc, "cleanupMaterializedTaskWorkspace");
    const initStarts = spyOn(initStateManager, "startInit");
    const initEnds = spyOn(initStateManager, "endInit");

    // A launch ends with a drain it does not await, and a failed launch (or its failure mark)
    // schedules one. `settle` awaits every recorded run, the in-flight drain and the inits until
    // no new one appears.
    const drains = spyOn(taskService, "maybeStartQueuedTasks");
    const launches = spyOn(svc, "enqueueReservedTaskLaunch");
    const launchFailures = spyOn(svc, "markTaskLaunchFailed");
    const pending = () => [
      ...[...drains.mock.results, ...launches.mock.results, ...launchFailures.mock.results].map(
        (result) => result.value as Promise<unknown>
      ),
      ...directLaunches,
      ...backgroundInits,
    ];
    const settle = async () => {
      let settled = -1;
      while (settled !== pending().length) {
        settled = pending().length;
        await Promise.allSettled(pending());
        await taskService.queueDrainSettled();
      }
    };
    settles.push(settle);

    const callsFor = (calls: unknown[][]) => calls.filter(([taskId]) => taskId === CHILD);
    return {
      hooks,
      drain: async () => {
        await taskService.maybeStartQueuedTasks();
        await settle();
      },
      /** createMany of CHILD under PARENT_ID with `abortSignal`, then its launch. */
      spawn: async (abortSignal: AbortSignal) => {
        stubStableIds(config, [CHILD]);
        const created = await taskService.createMany(
          [
            {
              parentWorkspaceId: PARENT_ID,
              kind: "agent",
              agentId: "explore",
              prompt: "work for the child",
              title: "Child",
            },
          ],
          { abortSignal }
        );
        assert(created.success, "createMany reserved the task");
        await settle();
      },
      /** The lease wrapper on a plan without an attempt id, as for a pre-identity row. */
      launchPreIdentity: async (abortSignal?: AbortSignal) => {
        const parentMeta = (await config.getAllWorkspaceMetadata()).find(
          (metadata) => metadata.id === PARENT_ID
        );
        assert(parentMeta != null, "the parent has metadata");
        const launched = svc.startReservedAgentTask({
          taskId: CHILD,
          parentWorkspaceId: PARENT_ID,
          parentMeta,
          agentId: "explore",
          agentType: "explore",
          start: { kind: "sendMessage", prompt: "work for the child", sendId: "srv-pre-identity" },
          title: "Child",
          workspaceName: CHILD,
          createdAt: new Date().toISOString(),
          taskRuntimeConfig: { type: "local" },
          parentRuntimeConfig: { type: "local" },
          configProjectPath: projectPath,
          taskModelString: "openai:gpt-5.2",
          canonicalModel: "openai:gpt-5.2",
          skipInitHook: true,
          ...(abortSignal != null ? { abortSignal } : {}),
        });
        directLaunches.push(launched);
        await launched;
        await settle();
      },
      /** The reclaim of an unsanitized checkout throws RECLAIM_FAILURE. */
      failReclaim: () =>
        spyOn(svc, "reclaimUnsanitizedTaskCheckout").mockRejectedValue(new Error(RECLAIM_FAILURE)),
      /** Every send of the brief fails with SEND_FAILURE. */
      failSends: () =>
        host.sendMessage.mockImplementation(() => Promise.resolve(Err(SEND_FAILURE))),
      /**
       * config.json turns unreadable until the next strict read, which throws UNREADABLE (a
       * lenient read meanwhile reads it empty).
       */
      unreadableUntilNextStrictRead: () => {
        const load = config.loadConfigOrDefault.bind(config);
        const spy = spyOn(config, "loadConfigOrDefault").mockImplementation((options) => {
          if (options?.throwOnError !== true) return { ...load(options), projects: new Map() };
          spy.mockRestore();
          throw new Error(UNREADABLE);
        });
      },
      /** Hold CHILD's stop latch until teardown, as a Stop between its latch and its write. */
      holdStopLatch: () => releases.push(taskService.latchWorkspaceStopsInProgress([CHILD])),
      launched: () => launches.mock.calls.map(([plan]) => plan.taskId),
      markedFailed: () => launchFailures.mock.calls.map(([taskId]) => taskId),
      sends: () => host.sendMessage.mock.calls.length,
      sanitized: () => sanitize.mock.calls.length,
      registeredInits: () => backgroundInits.length,
      initLogStarts: () => callsFor(initStarts.mock.calls).length,
      initLogExitCodes: () => callsFor(initEnds.mock.calls).map(([, exitCode]) => exitCode),
      /** The task id and options of each checkout cleanup (runtime, project, name, id, options). */
      cleanups: () => cleanups.mock.calls.map(([, , , taskId, options]) => [taskId, options]),
    };
  }

  /** The marker a removal in another process writes on the row before it deletes the checkout. */
  const removalMarker = (): NonNullable<WorkspaceConfigEntry["pendingRemoval"]> => ({
    removalId: "removal",
    instanceId: "other",
    pid: 1,
    identity: {
      birth: null,
      bootId: null,
      pidNs: null,
      machineId: null,
      platform: process.platform,
      hostname: null,
    },
    at: new Date(Date.UTC(2026, 0, 1, 0, 2)).toISOString(),
  });

  const pathExists = (target: string) =>
    fs.access(target).then(
      () => true,
      () => false
    );

  test("a row a Stop ended before the launch ran is left as is", async () => {
    const s = await setup([child({ taskStatus: "queued" })]);
    // The Stop persists interrupted after the drain's launch CAS wrote starting.
    s.hooks.beforeLaunch = () => patchChild({ taskStatus: "interrupted" });

    await s.drain();

    expect(s.launched()).toEqual([CHILD]);
    expect(row(CHILD)?.taskStatus).toBe("interrupted");
    expect(row(CHILD)?.taskLaunchError).toBe(undefined);
    expect(s.markedFailed()).toEqual([]);
    expect(s.initLogStarts()).toBe(0);
    expect(s.sends()).toBe(0);
  });

  test("a row a removal unpublished before the launch ran is left alone", async () => {
    const s = await setup([child({ taskStatus: "queued" })]);
    s.hooks.beforeLaunch = unpublishChild;

    await s.drain();

    expect(s.launched()).toEqual([CHILD]);
    expect(row(CHILD)).toBe(undefined);
    expect(s.markedFailed()).toEqual([]);
    expect(s.initLogStarts()).toBe(0);
    expect(s.sends()).toBe(0);
  });

  describe("a launch a held stop latch defers", () => {
    test("hands its row back to queued", async () => {
      const s = await setup([child({ taskStatus: "queued" })]);
      s.hooks.beforeLaunch = () => {
        s.holdStopLatch();
      };

      await s.drain();

      expect(row(CHILD)?.taskStatus).toBe("queued");
      expect(s.markedFailed()).toEqual([]);
      expect(s.initLogStarts()).toBe(0);
      expect(s.sends()).toBe(0);
    });

    test("leaves a row another writer re-admitted as is", async () => {
      const s = await setup([child({ taskStatus: "queued" })]);
      s.hooks.beforeLaunch = () => {
        s.holdStopLatch();
        return patchChild({ taskAttemptId: FOREIGN_ATTEMPT_ID });
      };

      await s.drain();

      expect(row(CHILD)).toMatchObject({
        taskStatus: "starting",
        taskAttemptId: FOREIGN_ATTEMPT_ID,
      });
      expect(s.markedFailed()).toEqual([]);
      expect(s.initLogStarts()).toBe(0);
      expect(s.sends()).toBe(0);
    });
  });

  test("a launch a held stop latch defers is marked failed when its revert to queued fails", async () => {
    const s = await setup([child({ taskStatus: "queued" })]);
    // A Stop latches the task after the drain's launch CAS, and the launch's write that hands the
    // row back to queued fails.
    s.hooks.beforeLaunch = () => {
      s.holdStopLatch();
      s.hooks.nextRowEdit = () => Promise.reject(new Error(EDIT_FAILURE));
    };

    await s.drain();

    expect(s.markedFailed()).toEqual([CHILD]);
    expect(row(CHILD)).toMatchObject({ taskStatus: "interrupted", taskLaunchError: EDIT_FAILURE });
    expect(s.initLogStarts()).toBe(0);
    expect(s.sends()).toBe(0);
  });

  describe("a starting row without an attempt id (pre-identity)", () => {
    test("is marked failed and not launched when its stamp write fails", async () => {
      const s = await setup([child({ taskStatus: "starting" })]);
      s.hooks.nextRowEdit = () => Promise.reject(new Error(EDIT_FAILURE));

      await s.launchPreIdentity();

      expect(s.markedFailed()).toEqual([CHILD]);
      expect(row(CHILD)).toMatchObject({
        taskStatus: "interrupted",
        taskLaunchError: EDIT_FAILURE,
      });
      expect(row(CHILD)?.taskAttemptId).toBe(undefined);
      expect(s.initLogStarts()).toBe(0);
      expect(s.sends()).toBe(0);
    });

    test("launches under the id another writer stamped before the stamp write", async () => {
      const s = await setup([child({ taskStatus: "starting" })]);
      s.hooks.nextRowEdit = () => patchChild({ taskAttemptId: FOREIGN_ATTEMPT_ID });

      await s.launchPreIdentity();

      // The stamp write keeps that id and does not mark it unproven.
      expect(row(CHILD)).toMatchObject({
        taskStatus: "running",
        taskAttemptId: FOREIGN_ATTEMPT_ID,
      });
      expect(row(CHILD)?.taskAttemptUnproven).toBe(undefined);
      expect(s.sends()).toBe(1);
    });
  });

  test("a row a Stop ended during the desktop check is not materialized", async () => {
    // Shared (its checkout is the parent's): a task that forks would also stop at the row check
    // after the materialize step, so only here does the launch depend on the null exit.
    const s = await setup([child({ taskStatus: "queued", taskIsolation: "none" })]);
    s.hooks.afterDesktopCheck = () => patchChild({ taskStatus: "interrupted" });

    await s.drain();

    // The materialize gate refused the row: the init log ends failed and nothing else runs.
    expect(s.initLogExitCodes()).toEqual([-1]);
    expect(s.registeredInits()).toBe(0);
    expect(s.sends()).toBe(0);
    expect(s.markedFailed()).toEqual([]);
    expect(row(CHILD)?.taskStatus).toBe("interrupted");
    expect(row(CHILD)?.taskLaunchError).toBe(undefined);
  });

  test("a row a Stop ended after the materialize step stops the launch before the parent's runtime update", async () => {
    const s = await setup([child({ taskStatus: "queued" })]);
    s.hooks.materialized = async (launch) => {
      await patchChild({ taskStatus: "interrupted" });
      // A fork that updates the parent's runtime config.
      return {
        ...launch,
        sourceRuntimeConfigUpdate: { type: "worktree", srcBaseDir: config.srcDir },
      };
    };

    await s.drain();

    expect(row(PARENT_ID)?.runtimeConfig).toEqual({ type: "local" });
    expect(s.initLogExitCodes()).toEqual([-1]);
    expect(s.registeredInits()).toBe(0);
    expect(s.sends()).toBe(0);
    expect(s.markedFailed()).toEqual([]);
    expect(row(CHILD)?.taskStatus).toBe("interrupted");
  });

  test("a shared task whose parent checkout is gone forks and loses its shared flag", async () => {
    // A shared task's path follows its parent's checkout, which no longer exists.
    const goneCheckout = path.join(rootDir, "gone");
    const s = await setup([child({ taskStatus: "queued", taskIsolation: "none" })], goneCheckout);
    expect(row(CHILD)?.path).toBe(goneCheckout);

    await s.drain();

    // The local runtime forks to the project directory, and the row now owns that checkout.
    expect(row(CHILD)).toMatchObject({ taskStatus: "running", path: projectPath });
    expect(row(CHILD)?.taskIsolation).toBe(undefined);
    expect(s.registeredInits()).toBe(1);
    expect(s.sends()).toBe(1);
  });

  describe("a shared task whose parent checkout exists", () => {
    test("runs in that checkout without a sanitize step or an init", async () => {
      const s = await setup([child({ taskStatus: "queued", taskIsolation: "none" })]);

      await s.drain();

      expect(row(CHILD)).toMatchObject({ taskStatus: "running", taskIsolation: "none" });
      expect(s.sanitized()).toBe(0);
      expect(s.registeredInits()).toBe(0);
      // The skipped init ends its log as done, not failed.
      expect(s.initLogExitCodes()).toEqual([0]);
      expect(s.sends()).toBe(1);
    });

    test("keeps that checkout when a removal unpublishes its row after the materialize step", async () => {
      const s = await setup([child({ taskStatus: "queued", taskIsolation: "none" })]);
      s.hooks.materialized = async (launch) => {
        await unpublishChild();
        return launch;
      };

      await s.drain();

      // The cleanup of the unpublished row never deletes the checkout: it is the parent's.
      expect(s.cleanups()).toEqual([[CHILD, { preservePhysicalWorkspace: true }]]);
      expect(await pathExists(projectPath)).toBe(true);
      expect(s.initLogExitCodes()).toEqual([-1]);
      expect(s.registeredInits()).toBe(0);
      expect(s.sends()).toBe(0);
      expect(s.markedFailed()).toEqual([]);
    });

    test("keeps that checkout when the launch is cancelled after the materialize step", async () => {
      // createMany never shares a checkout on a local parent, so the lease wrapper launches the
      // shared row directly with a signal that aborts once the checkout is materialized.
      const s = await setup([child({ taskStatus: "starting", taskIsolation: "none" })]);
      const cancel = new AbortController();
      s.hooks.materialized = (launch) => {
        cancel.abort();
        return Promise.resolve(launch);
      };

      await s.launchPreIdentity(cancel.signal);

      expect(s.cleanups()).toEqual([[CHILD, { preservePhysicalWorkspace: true }]]);
      expect(await pathExists(projectPath)).toBe(true);
      expect(s.registeredInits()).toBe(0);
      expect(s.sends()).toBe(0);
    });
  });

  describe("a row another writer re-admits under its own attempt", () => {
    test("during the checkout persist keeps its fields and is not sanitized", async () => {
      const s = await setup([child({ taskStatus: "queued" })]);
      s.hooks.materialized = (launch) => {
        s.hooks.nextRowEdit = () => patchChild({ taskAttemptId: FOREIGN_ATTEMPT_ID });
        return Promise.resolve(launch);
      };

      await s.drain();

      // The row and its checkout are the other writer's: the persist skips the row, and the
      // launch stops before the sanitize step without a cleanup or a failure mark.
      expect(row(CHILD)).toMatchObject({
        taskStatus: "starting",
        taskAttemptId: FOREIGN_ATTEMPT_ID,
      });
      expect(row(CHILD)?.taskBaseCommitShaByProjectPath).toBe(undefined);
      expect(s.sanitized()).toBe(0);
      expect(s.initLogExitCodes()).toEqual([-1]);
      expect(s.registeredInits()).toBe(0);
      expect(s.cleanups()).toEqual([]);
      expect(s.markedFailed()).toEqual([]);
      expect(s.sends()).toBe(0);
    });

    test("during the sanitize step gets no init", async () => {
      const s = await setup([child({ taskStatus: "queued" })]);
      s.hooks.sanitize = () => patchChild({ taskAttemptId: FOREIGN_ATTEMPT_ID });

      await s.drain();

      expect(row(CHILD)).toMatchObject({
        taskStatus: "starting",
        taskAttemptId: FOREIGN_ATTEMPT_ID,
      });
      expect(s.registeredInits()).toBe(0);
      expect(s.initLogExitCodes()).toEqual([-1]);
      expect(s.cleanups()).toEqual([]);
      expect(s.markedFailed()).toEqual([]);
      expect(s.sends()).toBe(0);
    });
  });

  test("a row a removal unpublishes during the checkout persist gets its checkout cleaned up before the sanitize step", async () => {
    const s = await setup([child({ taskStatus: "queued" })]);
    s.hooks.materialized = (launch) => {
      s.hooks.nextRowEdit = unpublishChild;
      return Promise.resolve(launch);
    };

    await s.drain();

    expect(row(CHILD)).toBe(undefined);
    expect(s.cleanups()).toEqual([[CHILD, { preservePhysicalWorkspace: false }]]);
    expect(s.initLogExitCodes()).toEqual([-1]);
    expect(s.sanitized()).toBe(0);
    expect(s.markedFailed()).toEqual([]);
    expect(s.sends()).toBe(0);
  });

  test("a row a removal marks before the init gets its checkout cleaned up and no init, and fails", async () => {
    const s = await setup([child({ taskStatus: "queued" })]);
    s.hooks.sanitize = () => patchChild({ pendingRemoval: removalMarker() });

    await s.drain();

    expect(s.cleanups()).toEqual([[CHILD, { preservePhysicalWorkspace: false }]]);
    expect(s.initLogExitCodes()).toEqual([-1]);
    expect(s.registeredInits()).toBe(0);
    expect(s.sends()).toBe(0);
    expect(s.markedFailed()).toEqual([CHILD]);
  });

  describe("an unreadable config fails the launch and ends its init log", () => {
    test("at the row check after the materialize step", async () => {
      const s = await setup([child({ taskStatus: "queued" })]);
      s.hooks.materialized = (launch) => {
        s.unreadableUntilNextStrictRead();
        return Promise.resolve(launch);
      };

      await s.drain();

      expect(s.initLogExitCodes()).toEqual([-1]);
      expect(s.markedFailed()).toEqual([CHILD]);
      expect(row(CHILD)).toMatchObject({ taskStatus: "interrupted", taskLaunchError: UNREADABLE });
      expect(s.registeredInits()).toBe(0);
      expect(s.sends()).toBe(0);
    });

    test("at the row check before the init", async () => {
      const s = await setup([child({ taskStatus: "queued" })]);
      s.hooks.sanitize = () => {
        s.unreadableUntilNextStrictRead();
        return Promise.resolve();
      };

      await s.drain();

      expect(s.initLogExitCodes()).toEqual([-1]);
      expect(s.markedFailed()).toEqual([CHILD]);
      expect(row(CHILD)).toMatchObject({ taskStatus: "interrupted", taskLaunchError: UNREADABLE });
      expect(s.registeredInits()).toBe(0);
      expect(s.sends()).toBe(0);
    });
  });

  test("a launch whose materialize step throws ends its init log and fails", async () => {
    const s = await setup([child({ taskStatus: "queued" })]);
    s.hooks.materialized = () => Promise.reject(new Error(FORK_FAILURE));

    await s.drain();

    expect(s.initLogExitCodes()).toEqual([-1]);
    expect(s.markedFailed()).toEqual([CHILD]);
    expect(row(CHILD)).toMatchObject({ taskStatus: "interrupted", taskLaunchError: FORK_FAILURE });
    expect(s.sends()).toBe(0);
  });

  describe("a forked checkout whose sanitize step fails", () => {
    test("is reclaimed with its row, and its init state is dropped, not ended", async () => {
      const s = await setup([child({ taskStatus: "queued" })]);
      s.hooks.sanitizeError = SANITIZE_FAILURE;

      await s.drain();

      expect(row(CHILD)).toBe(undefined);
      expect(s.initLogExitCodes()).toEqual([]);
      expect(s.registeredInits()).toBe(0);
      expect(s.sends()).toBe(0);
    });

    test("whose row cannot be unpublished is kept and ends its init log failed", async () => {
      const s = await setup([child({ taskStatus: "queued" })]);
      s.hooks.sanitizeError = SANITIZE_FAILURE;
      // The reclaim's unpublish write is the next config edit after the sanitize step.
      s.hooks.sanitize = () => {
        spyOn(config, "editConfig").mockRejectedValueOnce(new Error(EDIT_FAILURE));
        return Promise.resolve();
      };

      await s.drain();

      expect(row(CHILD)).toMatchObject({
        taskStatus: "interrupted",
        taskLaunchError: SANITIZE_FAILURE,
      });
      expect(s.initLogExitCodes()).toEqual([-1]);
      expect(s.registeredInits()).toBe(0);
      expect(s.sends()).toBe(0);
    });

    test("whose reclaim throws ends its init log failed", async () => {
      const s = await setup([child({ taskStatus: "queued" })]);
      s.hooks.sanitizeError = SANITIZE_FAILURE;
      s.failReclaim();

      await s.drain();

      expect(s.initLogExitCodes()).toEqual([-1]);
      expect(s.markedFailed()).toEqual([CHILD]);
      expect(row(CHILD)).toMatchObject({
        taskStatus: "interrupted",
        taskLaunchError: RECLAIM_FAILURE,
      });
      expect(s.registeredInits()).toBe(0);
      expect(s.sends()).toBe(0);
    });
  });

  test("a launch whose send fails cleans up its checkout and is marked failed", async () => {
    const s = await setup([child({ taskStatus: "queued" })]);
    s.failSends();

    await s.drain();

    expect(s.sends()).toBe(1);
    expect(s.cleanups()).toEqual([[CHILD, { preservePhysicalWorkspace: false }]]);
    expect(s.markedFailed()).toEqual([CHILD]);
    expect(row(CHILD)).toMatchObject({ taskStatus: "interrupted", taskLaunchError: SEND_FAILURE });
  });

  test("an attempt a workflow claim retires before the init is refused at admission and fails", async () => {
    const s = await setup([child({ taskStatus: "queued" })]);
    s.hooks.sanitize = async () => {
      const attemptId = row(CHILD)?.taskAttemptId;
      assert(attemptId != null, "the launch CAS stamped an attempt id");
      await patchChild({
        taskAttemptRetiredBy: {
          ...CLAIM,
          inputHash: "hash",
          childTaskId: CHILD,
          attemptId,
          mode: "no-report",
          at: new Date(Date.UTC(2026, 0, 1, 0, 2)).toISOString(),
        },
      });
    };

    await s.drain();

    // The checks before the init read the status and the id only; the admission refuses.
    expect(s.registeredInits()).toBe(1);
    expect(s.sends()).toBe(0);
    expect(s.cleanups()).toEqual([[CHILD, { preservePhysicalWorkspace: false }]]);
    expect(s.markedFailed()).toEqual([CHILD]);
    expect(row(CHILD)?.taskStatus).toBe("interrupted");
    expect(row(CHILD)?.taskLaunchError).toBe(retiredAttemptMessage(CLAIM));
  });

  test("a row a removal unpublishes before the init gets its checkout cleaned up and no init", async () => {
    const s = await setup([child({ taskStatus: "queued" })]);
    const sessionDir = path.join(config.sessionsDir, CHILD);
    await fs.mkdir(sessionDir, { recursive: true });
    s.hooks.sanitize = unpublishChild;

    await s.drain();

    expect(row(CHILD)).toBe(undefined);
    expect(s.cleanups()).toEqual([[CHILD, { preservePhysicalWorkspace: false }]]);
    // The cleanup of an unpublished row deletes its session dir.
    expect(await pathExists(sessionDir)).toBe(false);
    expect(s.initLogExitCodes()).toEqual([-1]);
    expect(s.registeredInits()).toBe(0);
    expect(s.sends()).toBe(0);
    expect(s.markedFailed()).toEqual([]);
  });

  describe("a launch its parent cancels", () => {
    test("during the desktop check is cancelled before its init log starts", async () => {
      const s = await setup([]);
      const reservation = new AbortController();
      s.hooks.afterDesktopCheck = () => {
        reservation.abort();
        return Promise.resolve();
      };

      await s.spawn(reservation.signal);

      expect(s.markedFailed()).toEqual([CHILD]);
      expect(row(CHILD)?.taskStatus).toBe("interrupted");
      expect(s.initLogStarts()).toBe(0);
      expect(s.cleanups()).toEqual([]);
      expect(s.sends()).toBe(0);
    });

    test("during the materialize step is cancelled before the checkout persist", async () => {
      const s = await setup([]);
      const reservation = new AbortController();
      s.hooks.materialized = (launch) => {
        reservation.abort();
        return Promise.resolve(launch);
      };

      await s.spawn(reservation.signal);

      expect(row(CHILD)?.taskBaseCommitShaByProjectPath).toBe(undefined);
      expect(s.cleanups()).toEqual([[CHILD, { preservePhysicalWorkspace: false }]]);
      expect(s.markedFailed()).toEqual([CHILD]);
      expect(row(CHILD)?.taskStatus).toBe("interrupted");
      expect(s.sanitized()).toBe(0);
      expect(s.sends()).toBe(0);
    });

    test("during the checkout persist is cancelled before the sanitize step", async () => {
      const s = await setup([]);
      const reservation = new AbortController();
      s.hooks.materialized = (launch) => {
        s.hooks.nextRowEdit = () => {
          reservation.abort();
          return Promise.resolve();
        };
        return Promise.resolve(launch);
      };

      await s.spawn(reservation.signal);

      expect(s.sanitized()).toBe(0);
      expect(s.cleanups()).toEqual([[CHILD, { preservePhysicalWorkspace: false }]]);
      expect(s.markedFailed()).toEqual([CHILD]);
      expect(row(CHILD)?.taskStatus).toBe("interrupted");
      expect(s.registeredInits()).toBe(0);
      expect(s.sends()).toBe(0);
    });

    test("at the linearization point after its init started is cancelled and sends nothing", async () => {
      const s = await setup([]);
      const reservation = new AbortController();
      s.hooks.initRegistered = () => reservation.abort();

      await s.spawn(reservation.signal);

      expect(s.registeredInits()).toBe(1);
      expect(s.sends()).toBe(0);
      expect(s.cleanups()).toEqual([[CHILD, { preservePhysicalWorkspace: false }]]);
      expect(s.markedFailed()).toEqual([CHILD]);
      expect(row(CHILD)?.taskStatus).toBe("interrupted");
    });
  });
});
