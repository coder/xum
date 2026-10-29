// Characterization tests for paths of TaskService.recoverInterruptedTasks that the other suites
// do not reach: they pin today's behavior before that method is split into steps. The method
// tallies skipped, failed and resumed tasks only in its completion log, so each test asserts what
// the tally stands for instead: which tasks got a send or a completion prompt, which rows were
// rotated or left alone, and that the pass went on to the next task.
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { TaskService } from "@/node/services/taskService";
import { Err, Ok, type Result } from "@/common/types/result";
import {
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspacesWithCheckouts,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

const PARENT_ID = "parent";
/** The attempt another backend admits a row under while this backend's recovery runs. */
const FOREIGN_ATTEMPT_ID = "att_00000000000000f1";
const GUIDANCE = [
  { id: "guidance-1", message: "First correction", queueDispatchMode: "turn-end" as const },
  { id: "guidance-2", message: "Second correction", queueDispatchMode: "tool-end" as const },
];

type TaskStep = (taskId: string, ...rest: unknown[]) => Promise<unknown>;
interface Internals {
  settleChildGoalPause: TaskStep;
  dispatchFencedStartupCompactionFollowUp: TaskStep;
  promptTaskForRequiredCompletionTool: TaskStep;
  enqueueReservedTaskLaunch: (...args: unknown[]) => Promise<void>;
  markTaskLaunchFailed: (...args: unknown[]) => Promise<void>;
}

function internals(taskService: TaskService): Internals {
  return taskService as unknown as Internals;
}

interface SendInternal {
  onAccepted?: () => Promise<void> | void;
  taskTurnKind?: string;
  queueDedupeKey?: string;
}

describe("TaskService.recoverInterruptedTasks paths before the split", () => {
  let rootDir: string;
  let config: Config;
  let seededAttempts: number;
  // One settle per setup. Teardown runs them too, so a test that fails before its own settle
  // still awaits the work its recovery started before the root is removed.
  let settles: Array<() => Promise<void>>;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    config = await createTestConfig(rootDir);
    seededAttempts = 0;
    settles = [];
  });
  afterEach(async () => {
    // allSettled: a failed drain must not hide the test's own failure.
    await Promise.allSettled(settles.splice(0).map((settle) => settle()));
    mock.restore();
    await removeTaskServiceTestRoot(rootDir);
  });

  const repo = () => path.join(rootDir, "repo");
  const row = (id: string) => findWorkspaceInConfig(config, id);

  /** An exec task row under PARENT_ID with its own seeded attempt id. */
  function task(id: string, overrides: Omit<Partial<WorkspaceConfigEntry>, "id" | "path">) {
    seededAttempts += 1;
    return projectWorkspace(repo(), id, id, {
      parentWorkspaceId: PARENT_ID,
      agentId: "exec",
      agentType: "exec",
      taskModelString: "openai:gpt-5.2",
      taskAttemptId: `att_${seededAttempts.toString(16).padStart(16, "0")}`,
      ...overrides,
    });
  }

  /**
   * Saves PARENT_ID and `tasks`, then builds a TaskService whose host records each send as
   * `<workspaceId>:<turn kind or dedupe key>` and fails every send to `failSendsTo`.
   */
  async function setup(tasks: WorkspaceConfigEntry[], options: { failSendsTo?: string } = {}) {
    await saveWorkspacesWithCheckouts(
      config,
      repo(),
      [projectWorkspace(repo(), "parent", PARENT_ID), ...tasks],
      testTaskSettings()
    );
    const sent: string[] = [];
    const sendMessage = mock(
      async (
        workspaceId: string,
        _message: string,
        _options: unknown,
        internal?: SendInternal
      ): Promise<Result<void, { type: "unknown"; raw: string }>> => {
        const kind = internal?.taskTurnKind ?? internal?.queueDedupeKey ?? "untagged";
        sent.push(`${workspaceId}:${kind}`);
        if (workspaceId === options.failSendsTo) {
          return Err({ type: "unknown", raw: "provider unavailable" });
        }
        await internal?.onAccepted?.();
        return Ok(undefined);
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const prompted = spyOn(internals(taskService), "promptTaskForRequiredCompletionTool");
    const settle = trackBackgroundWork(taskService);
    settles.push(settle);
    return {
      taskService,
      sent,
      /** Task ids the awaiting-report re-drive entered the completion prompt for. */
      promptedForCompletion: () => prompted.mock.calls.map(([taskId]) => taskId),
      recover: async () => {
        await taskService.recoverInterruptedTasks();
        await settle();
      },
    };
  }

  /**
   * Recovery schedules its queue drain without awaiting it, and a drain starts launches and their
   * failure handlers the same way. Spies (call-through) on each starter. The returned function
   * awaits every recorded run, and the drain, until no new run appears.
   */
  function trackBackgroundWork(taskService: TaskService): () => Promise<void> {
    const drains = spyOn(taskService, "maybeStartQueuedTasks");
    const launches = spyOn(internals(taskService), "enqueueReservedTaskLaunch");
    const launchFailures = spyOn(internals(taskService), "markTaskLaunchFailed");
    const pending = () =>
      [...drains.mock.results, ...launches.mock.results, ...launchFailures.mock.results].map(
        (result) => result.value
      );
    return async () => {
      let settled = -1;
      while (settled !== pending().length) {
        settled = pending().length;
        await Promise.allSettled(pending());
        await taskService.queueDrainSettled();
      }
    };
  }

  /** Another backend's write of a task row on the same root (its own Config). */
  async function writeRowElsewhere(taskId: string, write: (row: WorkspaceConfigEntry) => void) {
    const otherBackend = await createTestConfig(rootDir);
    await otherBackend.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const found = project.workspaces.find((workspace) => workspace.id === taskId);
        if (found != null) write(found);
      }
      return cfg;
    });
  }

  /** Runs `write` once, right after the first call of `step` for `taskId` resolves. */
  function writeAfterStep(
    taskService: TaskService,
    step: "settleChildGoalPause" | "dispatchFencedStartupCompactionFollowUp",
    taskId: string,
    write: () => Promise<void>
  ): void {
    const target = internals(taskService);
    const original = target[step].bind(taskService);
    let written = false;
    spyOn(target, step).mockImplementation(async (id, ...rest) => {
      const result = await original(id, ...rest);
      if (id === taskId && !written) {
        written = true;
        await write();
      }
      return result;
    });
  }

  test.each(["awaiting_report", "running"] as const)(
    "a task in %s with a blocking active descendant is not re-driven",
    async (taskStatus) => {
      const child = task("child", { taskStatus });
      const { sent, promptedForCompletion, recover } = await setup([
        child,
        task("grandchild", { parentWorkspaceId: "child", taskStatus: "running" }),
      ]);

      await recover();

      // The descendant gets its restart nudge. Its ancestor gets no send, no completion prompt
      // and no attempt rotation.
      expect(sent).toEqual(["grandchild:recovery"]);
      expect(promptedForCompletion()).toEqual([]);
      expect(row("child")).toMatchObject({ taskStatus, taskAttemptId: child.taskAttemptId });
      expect(row("child")?.taskAttemptUnproven).toBeUndefined();
    }
  );

  test.each([
    ["before its attempt rotation", "settleChildGoalPause"],
    ["after its compaction follow-up", "dispatchFencedStartupCompactionFollowUp"],
  ] as const)(
    "an awaiting_report re-drive whose row another writer re-admits %s prompts nothing",
    async (_when, step) => {
      const { taskService, sent, promptedForCompletion, recover } = await setup([
        task("first", { taskStatus: "awaiting_report" }),
        task("later", { taskStatus: "awaiting_report" }),
      ]);
      writeAfterStep(taskService, step, "first", () =>
        writeRowElsewhere("first", (found) => {
          found.taskAttemptId = FOREIGN_ATTEMPT_ID;
          found.taskAttemptUnproven = true;
        })
      );

      await recover();

      // The refused re-drive leaves the other writer's row as it wrote it (no budget charge),
      // and the pass goes on to the next task.
      expect(promptedForCompletion()).toEqual(["later"]);
      expect(sent).toEqual(["later:required_report"]);
      expect(row("first")).toMatchObject({
        taskStatus: "awaiting_report",
        taskAttemptId: FOREIGN_ATTEMPT_ID,
      });
      expect(row("first")?.taskRecoveryAttempts).toBeUndefined();
      expect(row("later")?.taskRecoveryAttempts).toBe(1);
    }
  );

  test("a failed guidance send stops that task's replay, keeps its guidance and the pass goes on", async () => {
    const { sent, recover } = await setup(
      [
        task("child", { taskStatus: "running", taskPendingGuidance: GUIDANCE }),
        task("later", { taskStatus: "running" }),
      ],
      { failSendsTo: "child" }
    );

    await recover();

    expect(sent).toEqual(["child:guidance-1", "later:recovery"]);
    expect(row("child")?.taskPendingGuidance?.map((guidance) => guidance.id)).toEqual([
      "guidance-1",
      "guidance-2",
    ]);
  });

  test("a guidance replay whose attempt another writer retired after the rotation sends nothing", async () => {
    const { taskService, sent, recover } = await setup([
      task("child", { taskStatus: "running", taskPendingGuidance: GUIDANCE.slice(0, 1) }),
      task("later", { taskStatus: "running" }),
    ]);
    // A workflow claim on another backend retires the attempt this recovery just rotated.
    writeAfterStep(taskService, "dispatchFencedStartupCompactionFollowUp", "child", () =>
      writeRowElsewhere("child", (found) => {
        found.taskAttemptRetiredBy = {
          runId: "run",
          stepId: "step",
          inputHash: "hash",
          childTaskId: "child",
          attemptId: String(found.taskAttemptId),
          mode: "no-report",
          at: new Date(0).toISOString(),
        };
      })
    );

    await recover();

    expect(sent).toEqual(["later:recovery"]);
    expect(row("child")?.taskPendingGuidance?.map((guidance) => guidance.id)).toEqual([
      "guidance-1",
    ]);
  });

  test("a failed restart nudge leaves the task running and the pass goes on", async () => {
    const { sent, recover } = await setup(
      [task("first", { taskStatus: "running" }), task("later", { taskStatus: "running" })],
      { failSendsTo: "first" }
    );

    await recover();

    expect(sent).toEqual(["first:recovery", "later:recovery"]);
    expect(row("first")?.taskStatus).toBe("running");
  });
});
