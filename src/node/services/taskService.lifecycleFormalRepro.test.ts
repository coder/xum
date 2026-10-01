/**
 * Deterministic repros of counterexamples found by the TLA+ model in formal/task-lifecycle/
 * (TaskLifecycle.tla; run formal/task-lifecycle/check.sh). Each repro asserts the behavior the
 * model's invariant requires: a `test.failing` still fails at that assertion on the current code,
 * a fixed finding's repro is a plain `test`; each control shows the guard the bug slipped past.
 *
 * Run: bun test ./src/node/services/taskService.lifecycleFormalRepro.test.ts
 */
import * as path from "path";
import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Err, Ok, type Result } from "@/common/types/result";
import type { Workspace as WorkspaceConfigEntry } from "@/node/config";
import { settleArchivedSharedDesktopTask } from "@/node/services/desktop/DesktopInputCoordinator";
import type { SendMessageError } from "@/common/types/errors";
import { createUnknownSendMessageError } from "@/node/services/utils/sendMessageError";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import type { TaskService } from "@/node/services/taskService";
import {
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspacesWithCheckouts as saveWorkspaces,
  testTaskSettings,
  workspaceTurnManagerFor,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";
import type { AIService } from "./aiService";
import type { AgentSession } from "./agentSession";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import { ContextManagementService } from "./contextManagement/contextManagementService";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { InitStateManager } from "./initStateManager";
import type { TurnCompletion } from "./streamManager";
import { makeAgentTaskIntegrationFake } from "./taskWorkspaceSeam.testUtils";
import { createTestHistoryService } from "./testHistoryService";
import { WorkspaceService } from "./workspaceService";
import { createMockAIService } from "./workspaceService.testHarness";

type SendArgs = Parameters<WorkspaceHost["sendMessage"]>;
type Lineage = (...args: unknown[]) => Promise<unknown>;

const ROOT = "lifecycle-root";
const PARENT = "lifecycle-parent";
const CHILD = "lifecycle-child";

describe("task lifecycle: formal-model counterexamples (TaskService)", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  /**
   * R (root) > P (running sub-agent) > C (child). WorkspaceHost.sendMessage replays
   * WorkspaceService's admission fence (admitTaskWorkspaceTurn) and records every turn it admits.
   */
  async function setUp(
    childStatus: "reported" | "interrupted" | "running",
    child: {
      overrides?: Omit<Partial<WorkspaceConfigEntry>, "id" | "path">;
      settleOnUnarchive?: boolean;
    } = {}
  ) {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", ROOT),
        projectWorkspace(projectPath, "parent", PARENT, {
          runtimeConfig: { type: "local" },
          parentWorkspaceId: ROOT,
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child", CHILD, {
          runtimeConfig: { type: "local" },
          parentWorkspaceId: PARENT,
          taskStatus: childStatus,
          title: "Child",
          ...child.overrides,
        }),
      ],
      testTaskSettings()
    );
    const admitted: string[] = [];
    // Filled in once the harness exists; the send mock closes over it.
    const holder: { service?: TaskService } = {};
    const sendMessage = mock(async (...args: SendArgs): Promise<Result<void, SendMessageError>> => {
      const [workspaceId, , , internal] = args;
      const service = holder.service;
      if (service == null) return Ok(undefined);
      const admission = service.admitTaskWorkspaceTurn(workspaceId, {
        acceptanceOrigin: internal?.acceptanceOrigin ?? "manual",
      });
      if (admission.kind === "refused")
        return Err(createUnknownSendMessageError(admission.message));
      await internal?.onAccepted?.();
      admitted.push(workspaceId);
      return Ok(undefined);
    });
    // WorkspaceService's unarchive settles a stale active status of a shared-desktop child in the
    // same config edit that clears its archive.
    const unarchiveWhileTaskTreeLocked = mock(async (workspaceId: string) => {
      if (child.settleOnUnarchive === true && workspaceId === CHILD) {
        await config.editConfig((cfg) => {
          for (const project of cfg.projects.values()) {
            const entry = project.workspaces.find((w) => w.id === CHILD);
            if (entry == null) continue;
            entry.unarchivedAt = new Date().toISOString();
            settleArchivedSharedDesktopTask(entry);
          }
          return cfg;
        });
      }
      return Ok(undefined);
    });
    const workspaceMocks = createWorkspaceServiceMocks({
      sendMessage,
      unarchiveWhileTaskTreeLocked,
    });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });
    holder.service = taskService;
    const internals = taskService as unknown as { evaluateAttemptLineage: Lineage };
    const lineage: Lineage = internals.evaluateAttemptLineage.bind(taskService);
    const attemptId = () => findWorkspaceInConfig(config, CHILD)?.taskAttemptId;
    return { config, taskService, internals, lineage, admitted, attemptId };
  }

  // Model: MC_L1_nested.cfg, invariant NoAutoStartAfterStop (finding L1).
  test("L1: a reawakening suspended across a completed tree Stop does not start the child", async () => {
    const s = await setUp("reported");
    // The user hard-Stops R while P's task_send_message reawakening of C awaits its lineage
    // evaluation (taskService.ts 8723). R's interruptStream marks R interrupted and runs the
    // cascade; C (reported, nothing live) releases its latch at once, independent of P's own
    // cleanup, which in production waits for this very tool call. So C's own latch is gone and
    // only the stop epochs can show the Stop.
    spyOn(s.internals, "evaluateAttemptLineage").mockImplementationOnce(async (...args) => {
      s.taskService.markParentWorkspaceInterrupted(ROOT);
      await s.taskService.terminateAllDescendantAgentTasks(ROOT);
      expect(s.taskService.isWorkspaceStopInProgress(CHILD)).toBe(false);
      return s.lineage(...args);
    });
    const result = await s.taskService.sendMessageToDescendantAgentTask(
      PARENT,
      CHILD,
      "Keep going",
      "tool-end"
    );
    // The Stop came after the send began: like reawakenInterruptedTask's stop-epoch recheck
    // (16219-16247), the reawakening must lose, and no turn may start in C.
    expect(result.success).toBe(false);
    expect(s.admitted).toEqual([]);
  });

  // Control for L1: while the cascade still holds C's latch, the same reawakening is refused
  // under the mutex (taskService.ts 8733).
  test("L1 control: a reawakening that meets the cascade's held latch is refused", async () => {
    const s = await setUp("reported");
    const cleanupInternals = s.taskService as unknown as {
      runWorkspaceStopCleanup: (...args: unknown[]) => Promise<unknown>;
    };
    const cleanup = cleanupInternals.runWorkspaceStopCleanup.bind(s.taskService) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const phaseB = Promise.withResolvers<void>();
    spyOn(cleanupInternals, "runWorkspaceStopCleanup").mockImplementationOnce(async (...args) => {
      await phaseB.promise;
      return cleanup(...args);
    });
    let cascade: Promise<unknown> | undefined;
    spyOn(s.internals, "evaluateAttemptLineage").mockImplementationOnce((...args) => {
      s.taskService.markParentWorkspaceInterrupted(ROOT);
      cascade = s.taskService.terminateAllDescendantAgentTasks(ROOT);
      return s.lineage(...args);
    });
    const before = s.attemptId();
    const sending = s.taskService.sendMessageToDescendantAgentTask(
      PARENT,
      CHILD,
      "Keep going",
      "tool-end"
    );
    const result = await sending;
    expect(s.taskService.isWorkspaceStopInProgress(CHILD)).toBe(true);
    expect(result.success).toBe(false);
    expect(s.admitted).toEqual([]);
    expect(s.attemptId()).toBe(before);
    phaseB.resolve();
    await cascade;
  });

  // Model: MC_L2_manual_react.cfg, invariant NoLostReport (finding L2).
  test("L2: a manual resume does not rotate the attempt of a live reawakened continuation", async () => {
    const s = await setUp("interrupted");
    const manualLineage = Promise.withResolvers<void>();
    let lineageCalls = 0;
    spyOn(s.internals, "evaluateAttemptLineage").mockImplementation(async (...args) => {
      lineageCalls += 1;
      // The manual resume's lineage evaluation (16225) spans the reawakening's turn admission.
      if (lineageCalls === 2) await manualLineage.promise;
      return s.lineage(...args);
    });
    const manager = workspaceTurnManagerFor(s.taskService);
    const createTurn = manager.createWorkspaceTurn.bind(manager);
    let manual: ReturnType<TaskService["reawakenInterruptedTask"]> | undefined;
    let reawakenedId: string | undefined;
    spyOn(manager, "createWorkspaceTurn").mockImplementationOnce(async (args) => {
      // P's reawakening published its attempt (8785-8796) and is about to send. The user's
      // send hits C while it is still idle and takes WorkspaceService's resume rescue.
      reawakenedId = s.attemptId();
      manual = s.taskService.reawakenInterruptedTask(CHILD);
      const created = await createTurn(args);
      manualLineage.resolve();
      return created;
    });
    const result = await s.taskService.sendMessageToDescendantAgentTask(
      PARENT,
      CHILD,
      "Keep going",
      "tool-end"
    );
    expect(result).toMatchObject({ success: true, data: { delivery: "reactivated" } });
    expect(s.admitted).toEqual([CHILD]);
    if (manual == null) throw new Error("the manual resume did not start");
    const outcome = await manual;
    // C now runs P's continuation under `reawakenedId`. Rotating it supersedes that live
    // continuation: its report (CAS on reawakenedId, 19168-19192) is dropped.
    expect(outcome.kind).not.toBe("reawakened");
    expect(s.attemptId()).toBe(reawakenedId);
  });

  // The status the reawakening decided on may change during its own unarchive: a legacy archived
  // shared-desktop child still reading `running` is settled to `interrupted` there. That is no
  // concurrent resume, so the reawakening must still proceed.
  test("a reawakening of a legacy archived shared-desktop child survives its unarchive settlement", async () => {
    const s = await setUp("running", {
      overrides: {
        archivedAt: "2026-09-01T00:00:00.000Z",
        taskDesktopOwnerWorkspaceId: ROOT,
      },
      settleOnUnarchive: true,
    });
    const before = s.attemptId();
    const result = await s.taskService.sendMessageToDescendantAgentTask(
      PARENT,
      CHILD,
      "Keep going",
      "tool-end"
    );
    expect(result).toMatchObject({ success: true, data: { delivery: "reactivated" } });
    expect(s.admitted).toEqual([CHILD]);
    expect(s.attemptId()).not.toBe(before);
  });

  // The reverse interleaving of L2 (MC_L2_fixed.cfg: ReactCommit rechecks that C is still
  // inactive): the user's resume wins while P's reawakening is between its caller's inactive
  // check and its row refresh; P must not rotate the attempt the user's turn is bound to.
  test("L2 reverse: a reawakening does not rotate the attempt of a live manual resume", async () => {
    const s = await setUp("interrupted");
    const internals = s.taskService as unknown as {
      unarchiveAgentTaskAncestry: (...args: unknown[]) => Promise<unknown>;
    };
    const unarchive = internals.unarchiveAgentTaskAncestry.bind(s.taskService) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    let resumedId: string | undefined;
    let release: (() => void) | undefined;
    spyOn(internals, "unarchiveAgentTaskAncestry").mockImplementationOnce(async (...args) => {
      // WorkspaceService's resume rescue, then the send's admission bound to its fresh attempt.
      const outcome = await s.taskService.reawakenInterruptedTask(CHILD);
      if (outcome.kind !== "reawakened") throw new Error(`resume did not win: ${outcome.kind}`);
      resumedId = outcome.attemptId;
      const admission = s.taskService.admitTaskWorkspaceTurn(CHILD, {
        acceptanceOrigin: "manual",
        expectedAttemptId: resumedId,
      });
      if (admission.kind !== "admitted") throw new Error(`send not admitted: ${admission.kind}`);
      release = () => admission.token.onDisposed("no-work");
      return unarchive(...args);
    });
    const result = await s.taskService.sendMessageToDescendantAgentTask(
      PARENT,
      CHILD,
      "Keep going",
      "tool-end"
    );
    expect(result.success).toBe(false);
    expect(s.admitted).toEqual([]);
    expect(s.attemptId()).toBe(resumedId);
    release?.();
  });
});

describe("task lifecycle: formal-model counterexamples (WorkspaceService resume)", () => {
  const workspaceId = "lifecycle-resumed-task";
  const rootWorkspaceId = "lifecycle-resumed-root";
  const successorAttemptId = "att_00000000000000f2";
  const model = "anthropic:claude-sonnet-4-5";
  const attemptId = "att_00000000000000f1";
  let cleanup: (() => Promise<void>) | undefined;
  let session: AgentSession | undefined;
  const completions: Array<ReturnType<typeof Promise.withResolvers<TurnCompletion>>> = [];

  afterEach(async () => {
    for (const completion of completions) {
      completion.resolve({ status: "aborted", abortReason: "user" });
    }
    completions.length = 0;
    await session?.dispose();
    session = undefined;
    await cleanup?.();
    cleanup = undefined;
  });

  // The fixture of workspaceService.turnAdmission.test.ts: a real WorkspaceService and session.
  // `asTask`: `workspaceId` is an `interrupted` agent task under a root workspace.
  async function createFixture(options: { asTask?: boolean } = {}) {
    const testHistory = await createTestHistoryService();
    cleanup = testHistory.cleanup;
    const { config, historyService } = testHistory;
    const ids = options.asTask === true ? [rootWorkspaceId, workspaceId] : [workspaceId];
    for (const id of ids) {
      await config.addWorkspace("/tmp/lifecycle-project", {
        id,
        name: id,
        projectName: "lifecycle-project",
        projectPath: "/tmp/lifecycle-project",
        runtimeConfig: { type: "local" },
      });
    }
    if (options.asTask === true) {
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const ws = project.workspaces.find((w) => w.id === workspaceId);
          if (ws == null) continue;
          ws.parentWorkspaceId = rootWorkspaceId;
          ws.taskStatus = "interrupted";
        }
        return cfg;
      });
    }
    const backgroundProcessManager = Object.assign(new EventEmitter(), {
      cleanup: mock(() => Promise.resolve()),
      hasRunningBackgroundProcesses: mock(() => false),
      hasOrphanedRunningBackgroundProcesses: mock(() => Promise.resolve(false)),
      setMessageQueued: mock(() => undefined),
      getActiveMonitorCount: mock(() => 0),
    }) as unknown as BackgroundProcessManager;
    const aiEmitter = new EventEmitter();
    let streaming = false;
    const harness = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      backgroundProcessManager,
      aiEmitter,
      aiServiceOverrides: {
        isStreaming: () => streaming,
        streamMessage: mock(() => {
          const completion = Promise.withResolvers<TurnCompletion>();
          completions.push(completion);
          streaming = true;
          const messageId = `assistant-${completions.length}`;
          aiEmitter.emit("stream-start", {
            type: "stream-start",
            workspaceId,
            messageId,
            model,
            startTime: Date.now(),
          });
          return Promise.resolve(Ok({ messageId, completion: completion.promise }));
        }),
      },
    });
    session = harness.session;
    const initStateManager = {
      on: mock(() => undefined),
      off: mock(() => undefined),
      getInitState: mock(() => undefined),
      waitForInit: mock(() => Promise.resolve()),
      clearInMemoryState: mock(() => undefined),
      getUnsanitizedCheckoutError: mock(() => undefined),
    } as unknown as InitStateManager;
    const aiService = createMockAIService({
      on: aiEmitter.on.bind(aiEmitter) as AIService["on"],
      off: aiEmitter.off.bind(aiEmitter) as AIService["off"],
      isStreaming: () => streaming,
    });
    const service = new WorkspaceService(
      config,
      historyService,
      aiService,
      new ContextManagementService({ config, historyService, aiService }),
      initStateManager,
      new ExtensionMetadataService(path.join(config.rootDir, "lifecycle-extension-metadata.json")),
      backgroundProcessManager
    );
    (service as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
      workspaceId,
      harness.session
    );
    return { service, session: harness.session, config };
  }

  function resumedIntegration(admission: { kind: "refused"; message: string } | undefined) {
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    const fake = makeAgentTaskIntegrationFake({
      getAgentTaskStatus: mock(() => "interrupted" as const),
      // reawakenInterruptedTask committed `running` and a fresh attempt (16255-16293).
      reawakenInterruptedTask: mock(() =>
        Promise.resolve({ kind: "reawakened" as const, attemptId, statusChanged: true })
      ),
      admitTaskWorkspaceTurn: mock(() => admission ?? ({ kind: "not-a-task" } as const)),
      restoreInterruptedTaskAfterResumeFailure,
    });
    return { fake, restoreInterruptedTaskAfterResumeFailure };
  }

  /**
   * A real TaskService behind the real WorkspaceService: `workspaceId` is an `interrupted` task
   * under a root, and the user's send/resume takes the real rescue (reawakenInterruptedTask)
   * and the real fence (admitTaskWorkspaceTurn).
   */
  // `interleave`: what lands between the reawaken's commit and the fence.
  async function createTaskFixture(interleave: "removal" | "successor" = "removal") {
    const { service, config } = await createFixture({ asTask: true });
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: service as unknown as WorkspaceHost,
    });
    service.setAgentTaskIntegration(taskService);
    const row = () => findWorkspaceInConfig(config, workspaceId);
    async function setRemovalMarker(on: boolean) {
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const ws = project.workspaces.find((w) => w.id === workspaceId);
          if (ws == null) continue;
          const identity = { birth: null, bootId: null, pidNs: null, machineId: null };
          // Another live process (init), so no self-heal takes the marker over.
          ws.pendingRemoval = on
            ? {
                removalId: "removal",
                instanceId: "other",
                pid: 1,
                identity: { ...identity, platform: process.platform, hostname: null },
                at: new Date().toISOString(),
              }
            : undefined;
        }
        return cfg;
      });
    }
    // A removal's pendingRemoval marker, or another writer's successor attempt (e.g. another
    // backend's admission), lands between the reawaken's commit and the fence.
    const reawaken = taskService.reawakenInterruptedTask.bind(taskService);
    let reawakenedId: string | undefined;
    spyOn(taskService, "reawakenInterruptedTask").mockImplementationOnce(async (...args) => {
      const outcome = await reawaken(...args);
      expect(outcome.kind).toBe("reawakened");
      expect(row()?.taskStatus).toBe("running");
      reawakenedId = row()?.taskAttemptId;
      if (interleave === "removal") {
        await setRemovalMarker(true);
      } else {
        await config.editConfig((cfg) => {
          for (const project of cfg.projects.values()) {
            const ws = project.workspaces.find((w) => w.id === workspaceId);
            if (ws != null) ws.taskAttemptId = successorAttemptId;
          }
          return cfg;
        });
      }
      return outcome;
    });
    return { service, taskService, row, setRemovalMarker, reawakenedId: () => reawakenedId };
  }

  // Model: MC_L3_removal.cfg, invariant RunningIsLive (finding L3); the fix is MC_L3_fixed.
  for (const entry of ["sendMessage", "resumeStream"] as const) {
    test(`L3: a resume refused at the admission fence restores the task it set running (${entry})`, async () => {
      const s = await createTaskFixture();
      const result =
        entry === "sendMessage"
          ? await s.service.sendMessage(workspaceId, "continue", { model, agentId: "exec" })
          : await s.service.resumeStream(workspaceId, { model, agentId: "exec" });
      expect(result.success).toBe(false);
      expect(completions).toHaveLength(0);
      const reawakenedId = s.reawakenedId();
      expect(reawakenedId).toBeDefined();
      // Otherwise the row stays `running` with an owned attempt and no turn.
      expect(s.row()).toMatchObject({ taskStatus: "interrupted", taskAttemptId: reawakenedId });
      // The refused attempt is closed, not left owned and open: once the removal aborts, no send
      // can still be admitted under it.
      await s.setRemovalMarker(false);
      const admission = s.taskService.admitTaskWorkspaceTurn(workspaceId, {
        acceptanceOrigin: "manual",
        expectedAttemptId: reawakenedId,
      });
      if (admission.kind === "admitted") admission.token.onDisposed("refused");
      expect(admission.kind).toBe("refused");
    });
  }

  // The rollback is bound to the attempt this resume committed: a successor never reverts.
  test("L3: a resume refused as stale leaves a successor attempt running", async () => {
    const s = await createTaskFixture("successor");
    const result = await s.service.sendMessage(workspaceId, "continue", { model, agentId: "exec" });
    expect(result.success).toBe(false);
    expect(completions).toHaveLength(0);
    expect(s.reawakenedId()).not.toBe(successorAttemptId);
    expect(s.row()).toMatchObject({ taskStatus: "running", taskAttemptId: successorAttemptId });
  });

  // Control for L3: a refusal after the fence (the session's) does restore.
  test("L3 control: a resume refused by the session restores the task", async () => {
    const { service, session: agentSession } = await createFixture();
    const { fake, restoreInterruptedTaskAfterResumeFailure } = resumedIntegration(undefined);
    service.setAgentTaskIntegration(fake);
    spyOn(agentSession, "sendMessage").mockResolvedValue({
      success: false,
      error: { type: "unknown", raw: "session refused" },
    });
    const result = await service.sendMessage(workspaceId, "continue", { model, agentId: "exec" });
    expect(result.success).toBe(false);
    expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledWith(
      workspaceId,
      "interrupted",
      attemptId
    );
  });
});
