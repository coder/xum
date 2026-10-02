/**
 * Deterministic repros of the violations found by the TLA+ model in formal/task-launch/
 * (TaskLaunch.tla; run formal/task-launch/check.sh): the first launch of a sub-agent task,
 * startReservedAgentTask (taskService.ts). U1 and U2's missing-row half are fixed: each test
 * states the correct contract and failed at its target assertion before its fix. Each open repro
 * (U2's removal-marked half, U4) states the contract and fails today at its "Target assertion";
 * `expectReproFailure` passes only on that exact mismatch. Each control runs the same steps on the
 * path the code already handled. (U3, two backends, stays model-only.)
 *
 * The launch runs for real; only the checkout materialization (a fake runtime), the init hook
 * (runBackgroundInit) and the WorkspaceHost (createWorkspaceServiceMocks) are stand-ins.
 *
 * Run: bun test ./src/node/services/taskService.taskLaunchFormalRepro.test.ts
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { Err, Ok, type Result } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import { WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE } from "@/constants/agentMessaging";
import { createMuxMessage } from "@/common/types/message";
import type { Config } from "@/node/config";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { expectReproFailure } from "@/node/utils/formalRepro.testHarness";
import { createUnknownSendMessageError } from "@/node/services/utils/sendMessageError";
import type { TaskService } from "@/node/services/taskService";
import {
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

const ROOT = "launch-root";
const CHILD = "launchchild1";
const BRIEF = "Survey the repository and report back";

interface Internals {
  startReservedAgentTask: (plan: { taskId: string }) => Promise<void>;
  materializeReservedTaskWorkspace: (...args: unknown[]) => Promise<unknown>;
}

describe("task launch: formal-model counterexamples (formal/task-launch)", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    // The init hook is not under test; its registration with the host is.
    spyOn(runtimeFactory, "runBackgroundInit").mockResolvedValue(undefined);
  });
  afterEach(async () => {
    mock.restore();
    await removeTaskServiceTestRoot(rootDir);
  });

  /**
   * ROOT spawns CHILD. `materialize` runs where materializeReservedTaskWorkspace forks, and
   * `sanitize` where sanitizeMaterializedTaskWorkspace runs (the sanitize/secrets window before
   * the init starts). `launched` resolves when startReservedAgentTask returns.
   */
  async function setUp(
    hooks: {
      materialize?: (config: Config) => Promise<void>;
      sanitize?: (config: Config) => Promise<void> | void;
      /** The WorkspaceHost send, in place of an accepting mock. */
      send?: (workspaceId: string, message: string) => Promise<Result<void, SendMessageError>>;
    } = {}
  ) {
    const config = await createTestConfig(rootDir);
    // A real repository: message delivery probes the child's checkout (the fork returns this path).
    const projectPath = await createTestProject(rootDir, "repo");
    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", ROOT)],
      testTaskSettings(4, 3)
    );
    stubStableIds(config, [CHILD]);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks(
      hooks.send != null ? { sendMessage: mock(hooks.send) } : {}
    );
    const { taskService, historyService } = createTaskServiceHarness(config, { workspaceService });
    const internals = taskService as unknown as Internals;

    // The checkout the launch "forks": deleteWorkspace records each deletion.
    const deleted: string[] = [];
    const deleteWorkspace = mock((_projectPath: string, name: string) => {
      deleted.push(name);
      return Promise.resolve(Ok(undefined));
    });
    spyOn(internals, "materializeReservedTaskWorkspace").mockImplementation(async () => {
      await hooks.materialize?.(config);
      return {
        workspacePath: projectPath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        runtimeForTaskWorkspace: { deleteWorkspace, getWorkspacePath: () => projectPath },
        inheritedProjects: undefined,
        reusedExistingCheckout: false,
      };
    });
    spyOn(workspaceService, "sanitizeMaterializedTaskWorkspace").mockImplementation(async () => {
      await hooks.sanitize?.(config);
      return undefined;
    });
    // Every init the launch starts, with the controller that aborts it.
    const inits: AbortController[] = [];
    spyOn(workspaceService, "registerExternalBackgroundInit").mockImplementation(
      (_id: string, controller: AbortController) => {
        inits.push(controller);
      }
    );

    let launchSettled!: () => void;
    const launched = new Promise<void>((resolve) => (launchSettled = resolve));
    const realLaunch = internals.startReservedAgentTask.bind(taskService);
    spyOn(internals, "startReservedAgentTask").mockImplementation(async (plan) => {
      try {
        await realLaunch(plan);
      } finally {
        launchSettled();
      }
    });

    return {
      config,
      taskService,
      historyService,
      workspaceService,
      sendMessage,
      deleted,
      inits,
      launched,
      /** Copies of the initial brief in the child's history. */
      briefsInHistory: async () => {
        const history = await historyService.getHistoryFromLatestBoundary(CHILD);
        const messages = history.success ? history.data : [];
        return messages.filter(
          (message) =>
            message.role === "user" &&
            message.parts.some((part) => part.type === "text" && part.text.includes(BRIEF))
        ).length;
      },
      /** Inits still running: started and never aborted. */
      liveInits: () => inits.filter((controller) => !controller.signal.aborted).length,
    };
  }

  const spawn = (taskService: TaskService, abortSignal?: AbortSignal) =>
    taskService.createMany(
      [{ parentWorkspaceId: ROOT, kind: "agent", agentId: "explore", prompt: BRIEF, title: "T" }],
      abortSignal != null ? { abortSignal } : {}
    );

  // MC_cancel / MC_stop (U1, fixed), invariant NoInitAfterCancel: the parent's cancel, a Stop or a
  // removal mark lands while the launch awaits the sanitize/secrets step. Nothing aborts an init
  // started after that, so the launch rechecks all of them before it starts the init. The Stop
  // and removal cases fail a recheck of the abort signal alone (MC_mut_recheck_abort_only).
  describe("a launch cancelled before its init starts leaves no init running (U1)", () => {
    test("cancel during the sanitize/secrets window", async () => {
      const controller = new AbortController();
      const s = await setUp({ sanitize: () => controller.abort() });

      await spawn(s.taskService, controller.signal);
      await s.launched;

      expect(findWorkspaceInConfig(s.config, CHILD)?.taskStatus).toBe("interrupted");
      // Target assertion.
      expect(s.liveInits()).toBe(0);
    });

    test("Stop during the sanitize/secrets window", async () => {
      // What a Stop persists first: the row turns interrupted.
      const s = await setUp({
        sanitize: (config) => editChild(config, { taskStatus: "interrupted" }),
      });

      await spawn(s.taskService);
      await s.launched;

      expect(findWorkspaceInConfig(s.config, CHILD)?.taskStatus).toBe("interrupted");
      expect(s.liveInits()).toBe(0);
    });

    test("removal mark during the sanitize/secrets window", async () => {
      // What a removal writes first: the pendingRemoval marker (it aborts only running inits).
      const s = await setUp({
        sanitize: (config) => editChild(config, { pendingRemoval: removalMarker() }),
      });

      await spawn(s.taskService);
      await s.launched;

      // The launch fails as the admission would have refused it (as the drain records it).
      await waitUntil(
        () => findWorkspaceInConfig(s.config, CHILD)?.taskStatus === "interrupted",
        "the failed launch to be recorded"
      );
      expect(findWorkspaceInConfig(s.config, CHILD)?.pendingRemoval).toBeDefined();
      expect(s.inits.length).toBe(0);
    });

    test("an unreadable registry at the recheck fails the launch instead of leaving it starting", async () => {
      let failNextStrictRead = false;
      const s = await setUp({
        sanitize: () => {
          failNextStrictRead = true;
        },
      });
      const realLoad = s.config.loadConfigOrDefault.bind(s.config);
      spyOn(s.config, "loadConfigOrDefault").mockImplementation((options) => {
        if (!failNextStrictRead) return realLoad(options);
        failNextStrictRead = false;
        // What an unreadable config.json does: a strict read throws, a lenient one reads empty.
        if (options?.throwOnError === true) throw new Error("config.json is unreadable");
        return { ...realLoad(options), projects: new Map() };
      });

      await spawn(s.taskService);
      await s.launched;

      await waitUntil(
        () => findWorkspaceInConfig(s.config, CHILD)?.taskStatus === "interrupted",
        "the failed launch to be recorded"
      );
      expect(s.inits.length).toBe(0);
    });

    test("control: a cancel during the fork stops the launch before the init", async () => {
      const controller = new AbortController();
      const s = await setUp({
        materialize: () => {
          controller.abort();
          return Promise.resolve();
        },
      });

      await spawn(s.taskService, controller.signal);
      await s.launched;

      expect(findWorkspaceInConfig(s.config, CHILD)?.taskStatus).toBe("interrupted");
      expect(s.liveInits()).toBe(0);
    });
  });

  // MC_remove (U2), invariant RemovedRowLeavesNoCheckout: a removal unpublishes the row while the
  // launch forks, or marks it (pendingRemoval) and deletes the checkout before the fork recreates
  // it. Before the fix, cleanupMaterializedTaskWorkspace counted a missing row as "re-admitted by
  // another writer" (undefined !== owned), so the checkout the fork made was never deleted. The
  // marked-row half stays open: deleting under another process's marker is unsafe (the removal
  // can abort and release it mid-delete), so closing it needs the removal and the launch to
  // exclude each other (#5531).
  describe("a checkout forked after its row was removed is deleted (U2)", () => {
    test("removal while the launch forks", async () => {
      const s = await setUp({
        // What WorkspaceService.remove's last config write does: the row is gone.
        materialize: (config) =>
          config.editConfig((cfg) => {
            for (const project of cfg.projects.values()) {
              project.workspaces = project.workspaces.filter((ws) => ws.id !== CHILD);
            }
            return cfg;
          }),
      });

      await spawn(s.taskService);
      await s.launched;

      expect(findWorkspaceInConfig(s.config, CHILD)).toBeUndefined();
      expect(s.deleted.length).toBe(1);
    });

    test("open: removal marked (and its checkout deleted) before the fork recreates it", async () => {
      const s = await setUp({
        // What WorkspaceService.remove's claimPendingRemoval writes; its checkout delete ran
        // before this fork, so the checkout the fork returns is the only one left.
        materialize: (config) => editChild(config, { pendingRemoval: removalMarker() }),
      });

      await spawn(s.taskService);
      await s.launched;

      // The row stays until the removal unpublishes it; the launch never started under it.
      expect(findWorkspaceInConfig(s.config, CHILD)?.pendingRemoval).toBeDefined();
      expect(s.inits.length).toBe(0);
      await expectReproFailure(
        () => {
          // Target assertion.
          expect(s.deleted.length).toBe(1);
        },
        { matcher: "toBe", expected: "1", received: "0" }
      );
    });

    test("a row the normalized registry drops but the raw config still lists keeps the checkout", async () => {
      let lossy = false;
      const s = await setUp({
        // After the fork the normalized view loses the row (e.g. two project buckets that
        // normalize to one path), so the launch finds no row and runs its cleanup.
        materialize: () => {
          lossy = true;
          return Promise.resolve();
        },
      });
      const realLoad = s.config.loadConfigOrDefault.bind(s.config);
      spyOn(s.config, "loadConfigOrDefault").mockImplementation((options) =>
        lossy ? { ...realLoad(options), projects: new Map() } : realLoad(options)
      );
      spyOn(s.config, "readPersistedWorkspaceIdSuperset").mockReturnValue(new Set([CHILD]));

      await spawn(s.taskService);
      await s.launched;

      expect(s.deleted.length).toBe(0);
    });

    test("an unreadable registry at the cleanup keeps the checkout", async () => {
      const controller = new AbortController();
      let corrupt = false;
      const s = await setUp({
        // The parent cancels after the fork, so the launch runs its cleanup.
        materialize: () => {
          controller.abort();
          corrupt = true;
          return Promise.resolve();
        },
      });
      const realLoad = s.config.loadConfigOrDefault.bind(s.config);
      spyOn(s.config, "loadConfigOrDefault").mockImplementation((options) => {
        if (!corrupt) return realLoad(options);
        // What an unreadable config.json does: a strict read throws, a lenient one reads empty.
        if (options?.throwOnError === true) {
          corrupt = false;
          throw new Error("config.json is unreadable");
        }
        return { ...realLoad(options), projects: new Map() };
      });

      await spawn(s.taskService, controller.signal);
      await s.launched;

      expect(findWorkspaceInConfig(s.config, CHILD)).toBeDefined();
      expect(s.deleted.length).toBe(0);
    });

    test("control: a launch cancelled after the fork keeps the checkout of its published row", async () => {
      const controller = new AbortController();
      const s = await setUp({
        materialize: () => {
          controller.abort();
          return Promise.resolve();
        },
      });

      await spawn(s.taskService, controller.signal);
      await s.launched;

      // The row stays (interrupted, resumable), so its checkout must stay too.
      expect(findWorkspaceInConfig(s.config, CHILD)?.taskStatus).toBe("interrupted");
      expect(s.deleted.length).toBe(0);
    });
  });

  // MC_prompt (U4), invariant PromptSentOnce: the launch's send accepts the brief into history,
  // then fails (agentSession :5629-5649 returns Err once its rows are durable when a Stop is in
  // progress). markTaskLaunchFailed keeps taskPrompt (only `running` clears it), and the parent's
  // reawakening prepends that kept prompt (:9480-9486): the child gets its brief twice.
  describe("the initial brief reaches the child once (U4)", () => {
    const acceptThenFail = (s: { appendBrief: () => Promise<void> }) => async () => {
      await s.appendBrief();
      return Err(createUnknownSendMessageError(WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE));
    };

    async function reawakenAfterLaunch(failLaunchSend: boolean) {
      const sent: string[] = [];
      const box: { appendBrief: () => Promise<void> } = { appendBrief: () => Promise.resolve() };
      const s = await setUp({
        send: async (_workspaceId, message) => {
          sent.push(message);
          if (sent.length === 1 && failLaunchSend) return acceptThenFail(box)();
          if (sent.length === 1) await box.appendBrief();
          return Ok(undefined);
        },
      });
      box.appendBrief = async () => {
        const appended = await s.historyService.appendToHistory(
          CHILD,
          createMuxMessage("launch-brief", "user", BRIEF)
        );
        expect(appended.success).toBe(true);
      };

      await spawn(s.taskService);
      await s.launched;
      return { s, sent };
    }

    test("reawakening after a launch whose send failed after accepting the brief", async () => {
      const { s, sent } = await reawakenAfterLaunch(true);
      await waitUntil(
        () => findWorkspaceInConfig(s.config, CHILD)?.taskStatus === "interrupted",
        "the failed launch to be recorded"
      );
      expect(await s.briefsInHistory()).toBe(1);

      const reawakened = await s.taskService.sendMessageToDescendantAgentTask(
        ROOT,
        CHILD,
        "Keep going",
        "tool-end"
      );

      expect(reawakened.success).toBe(true);
      const copies =
        (await s.briefsInHistory()) + sent.slice(1).filter((m) => m.includes(BRIEF)).length;
      await expectReproFailure(
        () => {
          // Target assertion.
          expect(copies).toBe(1);
        },
        { matcher: "toBe", expected: "1", received: "2" }
      );
    });

    test("control: a launch whose send succeeded does not resend the brief when a Stop and a message reawaken the child", async () => {
      const { s, sent } = await reawakenAfterLaunch(false);
      await waitUntil(
        () => findWorkspaceInConfig(s.config, CHILD)?.taskStatus === "running",
        "the launch to start the child"
      );
      // The user Stops the running child, so the parent's message reawakens it.
      expect((await s.taskService.stopDescendantAgentTask(ROOT, CHILD)).success).toBe(true);
      expect(findWorkspaceInConfig(s.config, CHILD)?.taskStatus).toBe("interrupted");

      const reawakened = await s.taskService.sendMessageToDescendantAgentTask(
        ROOT,
        CHILD,
        "Keep going",
        "tool-end"
      );

      expect(reawakened.success).toBe(true);
      const copies =
        (await s.briefsInHistory()) + sent.slice(1).filter((m) => m.includes(BRIEF)).length;
      expect(copies).toBe(1);
    });
  });
});

type ChildRow = NonNullable<ReturnType<typeof findWorkspaceInConfig>>;

async function editChild(config: Config, patch: Partial<ChildRow>): Promise<void> {
  await config.editConfig((cfg) => {
    for (const project of cfg.projects.values()) {
      const ws = project.workspaces.find((w) => w.id === CHILD);
      if (ws != null) Object.assign(ws, patch);
    }
    return cfg;
  });
}

/** Another live process's marker (pid 1), so no self-heal takes it over. */
function removalMarker(): NonNullable<ChildRow["pendingRemoval"]> {
  const identity = { birth: null, bootId: null, pidNs: null, machineId: null };
  return {
    removalId: "removal",
    instanceId: "other",
    pid: 1,
    identity: { ...identity, platform: process.platform, hostname: null },
    at: new Date().toISOString(),
  };
}

async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
