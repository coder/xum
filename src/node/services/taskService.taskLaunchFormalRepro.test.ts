/**
 * Deterministic repros of the violations found by the TLA+ model in formal/task-launch/
 * (TaskLaunch.tla; run formal/task-launch/check.sh): the first launch of a sub-agent task,
 * startReservedAgentTask (taskService.ts). U1, U2, U3 and U4 are fixed: each test states the
 * correct contract and failed at its target assertion before its fix. Each control runs the same
 * steps on the path the code already handled.
 *
 * The launch runs for real; only the checkout materialization (a fake runtime, or a fake fork),
 * the init hook (runBackgroundInit) and the WorkspaceHost (createWorkspaceServiceMocks) are
 * stand-ins. The removal is its first step, the task workspace's mutation gate (what
 * WorkspaceService.remove takes before it marks the row); the second backend (U3) is a second
 * TaskService on its own Config over the same root.
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
import * as forkOrchestrator from "@/node/services/utils/forkOrchestrator";
import { WorkspaceBusyError, workspaceUseLeasesFor } from "@/node/services/workspaceUseLeases";
import { createUnknownSendMessageError } from "@/node/services/utils/sendMessageError";
import type { TaskService } from "@/node/services/taskService";
import type { SendMessageInternalOptions } from "@/node/services/taskWorkspaceSeam";
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
  markTaskLaunchFailed: (...args: unknown[]) => Promise<void>;
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
   * ROOT spawns CHILD. `materialize` runs where materializeReservedTaskWorkspace forks (with
   * `realMaterialize`, the real method runs and `forks` counts its orchestrateFork calls instead),
   * `beforeLaunch` before startReservedAgentTask, and `sanitize` where
   * sanitizeMaterializedTaskWorkspace runs (the sanitize/secrets window before the init starts).
   * `launched` resolves when startReservedAgentTask returns.
   */
  async function setUp(
    hooks: {
      materialize?: (config: Config) => Promise<void>;
      realMaterialize?: boolean;
      beforeLaunch?: (config: Config) => Promise<void>;
      sanitize?: (config: Config) => Promise<void> | void;
      /** The WorkspaceHost send, in place of an accepting mock. */
      send?: (
        workspaceId: string,
        message: string,
        options: unknown,
        internal?: SendMessageInternalOptions
      ) => Promise<Result<void, SendMessageError>>;
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
    let forks = 0;
    if (hooks.realMaterialize === true) {
      spyOn(forkOrchestrator, "orchestrateFork").mockImplementation(() => {
        forks++;
        return Promise.resolve(Err("the fork is not under test"));
      });
    } else {
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
    }
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
        await hooks.beforeLaunch?.(config);
        await realLaunch(plan);
      } finally {
        launchSettled();
      }
    });

    // markTaskLaunchFailed returns after the interrupted write and its stop-epoch bump: a message
    // sent before then is refused as overtaken by that stop.
    let failureSettled!: () => void;
    const launchFailureRecorded = new Promise<void>((resolve) => (failureSettled = resolve));
    const realMarkFailed = internals.markTaskLaunchFailed.bind(taskService);
    spyOn(internals, "markTaskLaunchFailed").mockImplementation(async (...args) => {
      try {
        await realMarkFailed(...args);
      } finally {
        failureSettled();
      }
    });

    return {
      config,
      taskService,
      historyService,
      launchFailureRecorded,
      workspaceService,
      sendMessage,
      deleted,
      inits,
      launched,
      forks: () => forks,
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
  // marked row is not deleted by the launch (the removal can abort and release its marker
  // mid-delete): the removal and the launch exclude each other instead (#5531). The launch holds
  // a lease the removal's mutation gate refuses, and the fork gate refuses a leftover marker.
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

    test("a removal that would mark the row (and delete the checkout the fork recreates) is refused while the launch prepares", async () => {
      let removal: "refused" | "admitted" | undefined;
      const s = await setUp({
        materialize: async (config) => {
          // WorkspaceService.remove takes the task's mutation gate, then claims its marker and
          // deletes the checkout this fork is about to recreate.
          try {
            const release = await workspaceUseLeasesFor(config).acquireMutationGate([CHILD], {
              hasRunningBackgroundProcesses: () => Promise.resolve(false),
            });
            removal = "admitted";
            await editChild(config, { pendingRemoval: removalMarker() });
            await release();
          } catch (error) {
            if (!(error instanceof WorkspaceBusyError)) throw error;
            removal = "refused";
          }
        },
      });

      await spawn(s.taskService);
      await s.launched;

      // Target assertion.
      expect(removal).toBe("refused");
      expect(findWorkspaceInConfig(s.config, CHILD)?.pendingRemoval).toBeUndefined();
      // The launch went on: its checkout belongs to the published row.
      expect(s.inits.length).toBe(1);
      expect(s.deleted.length).toBe(0);
    });

    test("a marker a failed removal left behind refuses the fork", async () => {
      const s = await setUp({
        realMaterialize: true,
        // No live removal (no gate): the marker of a removal that crashed or could not clear it.
        beforeLaunch: (config) => editChild(config, { pendingRemoval: removalMarker() }),
      });

      await spawn(s.taskService);
      await s.launched;

      await waitUntil(
        () => findWorkspaceInConfig(s.config, CHILD)?.taskStatus === "interrupted",
        "the refused launch to be recorded"
      );
      // Target assertion.
      expect(s.forks()).toBe(0);
      expect(findWorkspaceInConfig(s.config, CHILD)?.pendingRemoval).toBeDefined();
    });

    test("control: a removal after the launch settled is admitted", async () => {
      const s = await setUp();

      await spawn(s.taskService);
      await s.launched;

      const release = await workspaceUseLeasesFor(s.config).acquireMutationGate([CHILD], {
        hasRunningBackgroundProcesses: () => Promise.resolve(false),
      });
      await release();
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

  // The queue drain takes the launch lease before its CAS. A live mutation gate refuses it and the
  // task stays queued; the gate's release schedules no drain (another backend's least of all), so
  // the drain retries after QUEUED_LAUNCH_LEASE_RETRY_MS.
  describe("a queued task left behind a mutation gate launches once the gate is released", () => {
    test.each([
      ["this backend's", false],
      ["another backend's", true],
    ])("%s gate", async (_label, foreign) => {
      const s = await setUp();
      await spawn(s.taskService);
      await s.launched;
      expect(s.inits.length).toBe(1);
      // A relaunch through the queue (as after startup recovery requeued it).
      await editChild(s.config, { taskStatus: "queued" });

      const gateConfig = foreign ? await createTestConfig(rootDir) : s.config;
      const release = await workspaceUseLeasesFor(gateConfig).acquireMutationGate([CHILD], {
        hasRunningBackgroundProcesses: () => Promise.resolve(false),
      });
      await s.taskService.maybeStartQueuedTasks();
      expect(findWorkspaceInConfig(s.config, CHILD)?.taskStatus).toBe("queued");
      await release();

      // No queue event follows the release: only the retry launches it.
      await waitUntil(
        () => findWorkspaceInConfig(s.config, CHILD)?.taskStatus === "running",
        "the retried drain to launch the task",
        4_000
      );
      // Exactly one more launch.
      expect(s.inits.length).toBe(2);
    });
  });

  // MC_two_backends (U3), invariants OneMaterializer, CleanupNeverTouchesSuccessor and
  // PromptSentOnce: a second backend starts up on the same root while the launch prepares the
  // checkout. Its startup recovery requeued every `starting` row no backend held a use lease on,
  // and preparation held none, so it relaunched the task: two launches prepared one checkout and
  // could both send the brief. The launch lease is published before the row becomes `starting`.
  describe("a second backend's startup leaves a launch being prepared alone (U3)", () => {
    async function backendB() {
      const configB = await createTestConfig(rootDir);
      const { workspaceService } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(configB, { workspaceService });
      let materialized = 0;
      spyOn(
        taskService as unknown as Internals,
        "materializeReservedTaskWorkspace"
      ).mockImplementation(() => {
        materialized++;
        return Promise.resolve(null);
      });
      return { taskService, materialized: () => materialized };
    }

    test("startup recovery during the fork", async () => {
      let b: Awaited<ReturnType<typeof backendB>> | undefined;
      let reservedAttempt: string | undefined;
      const s = await setUp({
        materialize: async (config) => {
          reservedAttempt = findWorkspaceInConfig(config, CHILD)?.taskAttemptId;
          b = await backendB();
          await b.taskService.recoverInterruptedTasks();
          await b.taskService.queueDrainSettled();
        },
      });

      await spawn(s.taskService);
      await s.launched;

      expect(reservedAttempt).toBeDefined();
      // Target assertion: backend B never prepares the checkout this launch is preparing.
      expect(b?.materialized()).toBe(0);
      // The row is still this launch's, so it went on to run.
      expect(findWorkspaceInConfig(s.config, CHILD)?.taskAttemptId).toBe(reservedAttempt);
      expect(findWorkspaceInConfig(s.config, CHILD)?.taskStatus).toBe("running");
      expect(s.sendMessage).toHaveBeenCalledTimes(1);
    });

    test("control: startup recovery after the launch died requeues its row", async () => {
      const s = await setUp();
      await spawn(s.taskService);
      await s.launched;
      // What a crash mid-launch leaves: the row `starting`, and no live launch lease.
      await editChild(s.config, { taskStatus: "starting" });

      const b = await backendB();
      await b.taskService.recoverInterruptedTasks();
      await b.taskService.queueDrainSettled();

      expect(b.materialized()).toBe(1);
    });
  });

  // MC_prompt (U4, fixed), invariant PromptSentOnce: the launch's send accepts the brief into
  // history, then either fails (path A: agentSession returns Err once its rows are durable when a
  // Stop makes its admission stale) or a Stop lands before the `running` write (path B). Both keep
  // taskPrompt (only `running` clears it). The parent's reawakening prepended that kept prompt, so
  // the child got its brief twice. Now the brief send carries the id the row keeps
  // (taskPromptSendId), and the reawakening drops a kept prompt whose id a history row carries.
  describe("the initial brief reaches the child once (U4)", () => {
    type LaunchSend = "accept-then-fail" | "accept" | "accept-then-stop";

    /** `idOnly`: the brief's row names its id without a digest, so it proves no payload. */
    async function reawakenAfterLaunch(
      launchSend: LaunchSend,
      rowProof: "digest" | "idOnly" = "digest"
    ) {
      const sent: string[] = [];
      const box: {
        appendBrief: (internal?: SendMessageInternalOptions) => Promise<void>;
        config?: Config;
      } = { appendBrief: () => Promise.resolve() };
      const s = await setUp({
        send: async (_workspaceId, message, _options, internal) => {
          sent.push(message);
          if (sent.length > 1) return Ok(undefined);
          await box.appendBrief(internal);
          if (launchSend === "accept-then-fail") {
            return Err(
              createUnknownSendMessageError(WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE)
            );
          }
          // What a Stop persists first, after the send returned and before `running`.
          if (launchSend === "accept-then-stop") {
            if (box.config == null) throw new Error("config is set before the launch");
            await editChild(box.config, { taskStatus: "interrupted" });
          }
          return Ok(undefined);
        },
      });
      box.config = s.config;
      // The brief's row as AgentSession publishes it: it carries the send's ids and digests.
      box.appendBrief = async (internal) => {
        const identities = internal?.sendIdentities ?? [];
        const appended = await s.historyService.appendToHistory(
          CHILD,
          createMuxMessage(
            "launch-brief",
            "user",
            BRIEF,
            identities.length > 0
              ? {
                  sendIds: identities.map((identity) => identity.id),
                  ...(rowProof === "digest"
                    ? {
                        sendDigests: Object.fromEntries(
                          identities.map((identity) => [identity.id, identity.digest])
                        ),
                      }
                    : {}),
                }
              : {}
          )
        );
        expect(appended.success).toBe(true);
      };

      await spawn(s.taskService);
      await s.launched;
      return { s, sent };
    }

    async function reawaken(
      s: Awaited<ReturnType<typeof setUp>>,
      sent: string[],
      launchSend: LaunchSend
    ) {
      await waitUntil(
        () => findWorkspaceInConfig(s.config, CHILD)?.taskStatus === "interrupted",
        "the interrupted launch to be recorded"
      );
      if (launchSend === "accept-then-fail") await s.launchFailureRecorded;
      expect(await s.briefsInHistory()).toBe(1);
      // The kept brief: what a reawakening would prepend.
      expect(findWorkspaceInConfig(s.config, CHILD)?.taskPrompt).toBe(BRIEF);

      const reawakened = await s.taskService.sendMessageToDescendantAgentTask(
        ROOT,
        CHILD,
        "Keep going",
        "tool-end"
      );

      expect(reawakened).toMatchObject({ success: true });
      return (await s.briefsInHistory()) + sent.slice(1).filter((m) => m.includes(BRIEF)).length;
    }

    test("reawakening after a launch whose send failed after accepting the brief (path A)", async () => {
      const { s, sent } = await reawakenAfterLaunch("accept-then-fail");

      const copies = await reawaken(s, sent, "accept-then-fail");

      // Target assertion.
      expect(copies).toBe(1);
      expect(sent.length).toBe(2);
      expect(sent[1]).toContain("Keep going");
      expect(findWorkspaceInConfig(s.config, CHILD)?.taskPrompt).toBeUndefined();
    });

    test("reawakening after a Stop that landed between an accepted launch send and running (path B)", async () => {
      const { s, sent } = await reawakenAfterLaunch("accept-then-stop");

      const copies = await reawaken(s, sent, "accept-then-stop");

      expect(copies).toBe(1);
      expect(findWorkspaceInConfig(s.config, CHILD)?.taskPrompt).toBeUndefined();
    });

    test("a kept brief that never reached history is still prepended on reawakening", async () => {
      // The launch send fails before any row is written: only the reawakening can deliver it.
      const sent: string[] = [];
      const s = await setUp({
        send: (_workspaceId, message) => {
          sent.push(message);
          return Promise.resolve(
            sent.length === 1
              ? Err(createUnknownSendMessageError(WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE))
              : Ok(undefined)
          );
        },
      });
      await spawn(s.taskService);
      await s.launched;
      await s.launchFailureRecorded;
      expect(await s.briefsInHistory()).toBe(0);

      const reawakened = await s.taskService.sendMessageToDescendantAgentTask(
        ROOT,
        CHILD,
        "Keep going",
        "tool-end"
      );

      expect(reawakened).toMatchObject({ success: true });
      expect(sent.slice(1).filter((m) => m.includes(BRIEF)).length).toBe(1);
    });

    test("a row that names the brief's id but proves no payload does not drop the brief", async () => {
      const { s, sent } = await reawakenAfterLaunch("accept-then-fail", "idOnly");
      await s.launchFailureRecorded;

      const reawakened = await s.taskService.sendMessageToDescendantAgentTask(
        ROOT,
        CHILD,
        "Keep going",
        "tool-end"
      );

      expect(reawakened).toMatchObject({ success: true });
      // Sent again: only a row that proves the brief's payload drops the kept prompt.
      expect(sent.slice(1).filter((m) => m.includes(BRIEF)).length).toBe(1);
    });

    test("upgrade: a kept brief without a send id (an older build's row) is still prepended", async () => {
      const { s, sent } = await reawakenAfterLaunch("accept-then-fail");
      await s.launchFailureRecorded;
      // Written before brief send ids: no row proves acceptance, and text never does.
      await editChild(s.config, { taskPromptSendId: undefined });

      const reawakened = await s.taskService.sendMessageToDescendantAgentTask(
        ROOT,
        CHILD,
        "Keep going",
        "tool-end"
      );

      expect(reawakened).toMatchObject({ success: true });
      expect(sent.slice(1).filter((m) => m.includes(BRIEF)).length).toBe(1);
    });

    test("control: a launch whose send succeeded does not resend the brief when a Stop and a message reawaken the child", async () => {
      const { s, sent } = await reawakenAfterLaunch("accept");
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

      expect(reawakened).toMatchObject({ success: true });
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

async function waitUntil(
  condition: () => boolean,
  label: string,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
