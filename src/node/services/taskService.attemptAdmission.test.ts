import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { Config } from "@/node/config";
import { type Workspace as WorkspaceConfigEntry } from "@/node/config";
import { Ok, type Result } from "@/common/types/result";
import { SecretsStore } from "@/node/config";
import {
  TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE,
  WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE,
  retiredAttemptMessage,
} from "@/constants/agentMessaging";
import {
  TASK_TERMINATION_STOP_STREAM_AGGREGATE_TIMEOUT_MS,
  TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS,
} from "@/constants/terminationTimeouts";
import { HistoryService } from "@/node/services/historyService";
import { writeSubagentAttemptSettlementReceipt } from "@/node/services/subagentAttemptSettlements";
import { TaskService } from "@/node/services/taskService";
import {
  createAIServiceMocks,
  createMockInitStateManager,
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import type {
  TaskTurnAdmission,
  TurnAdmissionToken,
  WorkspaceHost,
} from "@/node/services/taskWorkspaceSeam";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import { isTaskAttemptId } from "@/node/utils/taskAttemptId";
import type { AIService } from "@/node/services/aiService";

/**
 * G1 — attempt identity, lineage and the send-admission lifecycle (Changes 1, 2, 3a). No receipt
 * producer, classifier or claim is exercised here: "settled" reads as the in-process settlement
 * entry upgrading to `settled` and the stop record releasing.
 */
const rootId = "root-admission";
const requesting = { requestingWorkspaceId: rootId };
const ATTEMPT_ID = /^att_[0-9a-f]{16}$/;

interface Internals {
  ownedAttemptByTaskId: Map<
    string,
    { attemptId?: string; receiptEligible: boolean; source: string }
  >;
  attemptSettlementByTaskId: Map<
    string,
    { attemptId?: string; attempt?: unknown; phase: "closing" | "settled"; source: string }
  >;
  admittedSendsByTaskId: Map<string, Set<{ state: string; turnId?: symbol; attemptId: string }>>;
  workspaceStopRecords: Map<
    string,
    { capturedTurns: Set<symbol>; pendingAdmissions: Set<unknown>; cleanupInFlight: number }
  >;
  currentAttemptIdByTaskId: Map<string, string>;
  markTaskLaunchFailed: (taskId: string, message: string) => Promise<void>;
  closeAttemptAdmission: (
    taskId: string,
    identity: { attemptId: string | undefined },
    source: string
  ) => void;
  releaseSharedDesktopTaskOnUserStop: (taskId: string) => Promise<void>;
  startReservedAgentTask: (plan: unknown) => Promise<void>;
  materializeReservedTaskWorkspace: (...args: unknown[]) => Promise<unknown>;
  cleanupMaterializedTaskWorkspace: (...args: unknown[]) => Promise<void>;
  evaluateAttemptLineage: (
    taskId: string,
    entry: WorkspaceConfigEntry
  ) => Promise<{ proven: boolean; reason: string }>;
}
const internals = (service: TaskService) => service as unknown as Internals;

describe("TaskService attempt identity and send admission (G1)", () => {
  let rootDir: string;
  let restoreTimers: (() => void) | undefined;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-attempt-admission-"));
  });
  afterEach(async () => {
    restoreTimers?.();
    restoreTimers = undefined;
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  /** Fire only the termination timers immediately; every other timer keeps its delay. */
  function shortenTerminationTimers(): void {
    const originalSetTimeout = globalThis.setTimeout;
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      timeout?: number
    ) => {
      if (
        timeout === TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS ||
        timeout === TASK_TERMINATION_STOP_STREAM_AGGREGATE_TIMEOUT_MS
      ) {
        return originalSetTimeout(handler, 0);
      }
      return originalSetTimeout(handler, timeout);
    }) as typeof setTimeout);
    restoreTimers = () => spy.mockRestore();
  }

  async function setupTree(
    descendants: Array<{ id: string; overrides?: Partial<WorkspaceConfigEntry> }>
  ) {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId, { runtimeConfig: { type: "local" } }),
        ...descendants.map(({ id, overrides }) =>
          projectWorkspace(projectPath, id, id, {
            parentWorkspaceId: rootId,
            agentType: "explore",
            agentId: "explore",
            taskStatus: "running",
            taskModelString: "openai:gpt-5.2",
            runtimeConfig: { type: "local" },
            ...overrides,
          })
        ),
      ],
      testTaskSettings(4, 3)
    );
    return { config, projectPath };
  }

  function createHarness(
    config: Config,
    overrides?: { aiService?: AIService; workspaceService?: WorkspaceHost }
  ) {
    const historyService = new HistoryService(config);
    const aiService = overrides?.aiService ?? createAIServiceMocks(config).aiService;
    const workspaceService =
      overrides?.workspaceService ?? createWorkspaceServiceMocks().workspaceService;
    const initStateManager = createMockInitStateManager();
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const taskService = new TaskService(
      config,
      historyService,
      aiService,
      workspaceService,
      initStateManager,
      undefined,
      undefined,
      new SecretsStore(config.rootDir),
      terminalAttentionStore
    );
    const workspaceTurnManager = new WorkspaceTurnManager(
      config,
      historyService,
      aiService,
      workspaceService,
      initStateManager,
      taskService,
      terminalAttentionStore,
      aiService as unknown as ConstructorParameters<typeof WorkspaceTurnManager>[7]
    );
    taskService.setWorkspaceTurnManager(workspaceTurnManager);
    return { taskService, aiService, workspaceService };
  }

  /** WorkspaceHost mocks that also expose the turn-settled/superseded listeners TaskService bound. */
  function hostWithTurnEvents(overrides: Parameters<typeof createWorkspaceServiceMocks>[0] = {}) {
    const settledListeners = new Set<(workspaceId: string, turn: symbol) => void>();
    const supersededListeners = new Set<
      (workspaceId: string, previous: symbol, next: symbol) => void
    >();
    const mocks = createWorkspaceServiceMocks({
      ...overrides,
      onWorkspaceTurnSettled: mock((listener: (workspaceId: string, turn: symbol) => void) => {
        settledListeners.add(listener);
        return () => settledListeners.delete(listener);
      }),
      onWorkspaceTurnSuperseded: mock(
        (listener: (workspaceId: string, previous: symbol, next: symbol) => void) => {
          supersededListeners.add(listener);
          return () => supersededListeners.delete(listener);
        }
      ),
    });
    return {
      ...mocks,
      settleTurn: (workspaceId: string, turn: symbol) => {
        for (const listener of settledListeners) listener(workspaceId, turn);
      },
      supersedeTurn: (workspaceId: string, previous: symbol, next: symbol) => {
        for (const listener of supersededListeners) listener(workspaceId, previous, next);
      },
    };
  }

  function admitted(admission: TaskTurnAdmission): TurnAdmissionToken {
    expect(admission.kind).toBe("admitted");
    if (admission.kind !== "admitted") throw new Error("not admitted");
    return admission.token;
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const entryOf = (config: Config, id: string) => findWorkspaceInConfig(config, id);

  describe("identity writers", () => {
    test("reservation persists a fresh attempt id owned as receipt-eligible; the launch keeps it and fences its send", async () => {
      const spawnedId = "reservedchild1";
      const { config, projectPath } = await setupTree([]);
      stubStableIds(config, [spawnedId]);
      const sendTokens: Array<TurnAdmissionToken | undefined> = [];
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
        sendMessage: mock(
          (
            _id: string,
            _prompt: string,
            _options: unknown,
            internal?: { turnAdmission?: TurnAdmissionToken }
          ): Promise<Result<void>> => {
            sendTokens.push(internal?.turnAdmission);
            return Promise.resolve(Ok(undefined));
          }
        ),
      });
      const { taskService } = createHarness(config, { workspaceService });
      const svc = internals(taskService);
      spyOn(svc, "materializeReservedTaskWorkspace").mockImplementation(() =>
        Promise.resolve({
          workspacePath: projectPath,
          trunkBranch: "main",
          forkedRuntimeConfig: { type: "local" },
          runtimeForTaskWorkspace: {
            deleteWorkspace: mock(() => Promise.resolve(Ok(undefined))),
            getWorkspacePath: () => "/tmp/reserved",
          },
          inheritedProjects: undefined,
        })
      );
      spyOn(svc, "cleanupMaterializedTaskWorkspace").mockImplementation(() => Promise.resolve());
      spyOn(workspaceService, "sanitizeMaterializedTaskWorkspace").mockImplementation(() =>
        Promise.resolve(undefined)
      );

      const created = await taskService.createMany([
        { parentWorkspaceId: rootId, kind: "agent", agentId: "explore", prompt: "go", title: "T" },
      ]);
      expect(created.success).toBe(true);
      const reserved = entryOf(config, spawnedId);
      expect(reserved?.taskAttemptId).toMatch(ATTEMPT_ID);
      expect(reserved?.taskAttemptUnproven).toBeUndefined();
      const owned = svc.ownedAttemptByTaskId.get(spawnedId);
      expect(owned).toMatchObject({
        source: "reservation",
        attemptId: reserved!.taskAttemptId,
        receiptEligible: true,
      });

      // The launch is a same-attempt send: fenced (token passed to the send), id unchanged.
      const deadline = Date.now() + 2_000;
      while (entryOf(config, spawnedId)?.taskStatus !== "running") {
        if (Date.now() > deadline) throw new Error("launch did not run");
        await settle();
      }
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendTokens[0]).toBeDefined();
      expect(entryOf(config, spawnedId)?.taskAttemptId).toBe(reserved!.taskAttemptId);
      expect(svc.ownedAttemptByTaskId.get(spawnedId)).toBe(owned);
      // The fake host disposed the token (no session → no turn): the obligation is discharged.
      expect(svc.admittedSendsByTaskId.get(spawnedId)).toBeUndefined();
      expect(await taskService.readAttemptOutcome(spawnedId, requesting)).toEqual({
        kind: "live",
        executionId: spawnedId,
      });
    });

    test("the queue drain's exclusive CAS rotates a foreign queued entry's id and owns it; a marked entry is owned but not eligible", async () => {
      const proven = "queuedproven1";
      const marked = "queuedmarked1";
      const { config, projectPath } = await setupTree([
        {
          id: proven,
          overrides: { taskStatus: "queued", taskPrompt: "queued work", taskAttemptId: undefined },
        },
        {
          id: marked,
          overrides: {
            taskStatus: "queued",
            taskPrompt: "queued work",
            taskAttemptId: "att_0000000000000001",
            taskAttemptUnproven: true,
          },
        },
      ]);
      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      spyOn(svc, "materializeReservedTaskWorkspace").mockImplementation(() =>
        Promise.resolve({
          workspacePath: projectPath,
          trunkBranch: "main",
          forkedRuntimeConfig: { type: "local" },
          runtimeForTaskWorkspace: {
            deleteWorkspace: mock(() => Promise.resolve(Ok(undefined))),
            getWorkspacePath: () => "/tmp/queued",
          },
          inheritedProjects: undefined,
        })
      );
      spyOn(svc, "cleanupMaterializedTaskWorkspace").mockImplementation(() => Promise.resolve());
      await taskService.maybeStartQueuedTasks();
      const deadline = Date.now() + 2_000;
      while (
        entryOf(config, proven)?.taskStatus !== "running" ||
        entryOf(config, marked)?.taskStatus !== "running"
      ) {
        if (Date.now() > deadline) throw new Error("drain did not launch both");
        await settle();
      }
      const provenEntry = entryOf(config, proven);
      expect(provenEntry?.taskAttemptId).toMatch(ATTEMPT_ID);
      expect(provenEntry?.taskAttemptUnproven).toBeUndefined();
      expect(svc.ownedAttemptByTaskId.get(proven)).toMatchObject({
        source: "launch",
        attemptId: provenEntry!.taskAttemptId,
        receiptEligible: true,
      });
      const markedEntry = entryOf(config, marked);
      expect(markedEntry?.taskAttemptId).toMatch(ATTEMPT_ID);
      expect(markedEntry?.taskAttemptId).not.toBe("att_0000000000000001");
      expect(markedEntry?.taskAttemptUnproven).toBe(true);
      expect(svc.ownedAttemptByTaskId.get(marked)).toMatchObject({
        source: "launch",
        attemptId: markedEntry!.taskAttemptId,
        receiptEligible: false,
      });
    });

    test("a queued entry retired by a workflow claim is never launched", async () => {
      const taskId = "queuedretired1";
      const claim = {
        runId: "wfr_1",
        stepId: "step-1",
        inputHash: "h",
        childTaskId: taskId,
        attemptId: "att_0000000000000002",
        mode: "no-report" as const,
        at: "2026-09-18T00:00:00.000Z",
      };
      const { config } = await setupTree([
        {
          id: taskId,
          overrides: {
            taskStatus: "queued",
            taskPrompt: "queued work",
            taskAttemptId: claim.attemptId,
            taskAttemptRetiredBy: claim,
          },
        },
      ]);
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createHarness(config, { workspaceService });
      await taskService.maybeStartQueuedTasks();
      await settle();
      expect(entryOf(config, taskId)?.taskStatus).toBe("queued");
      expect(entryOf(config, taskId)?.taskAttemptId).toBe(claim.attemptId);
      expect(internals(taskService).ownedAttemptByTaskId.has(taskId)).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    test("reawaken: unproven predecessor → fresh marked id owned but not eligible; refused when retired", async () => {
      const taskId = "reawaken-unproven";
      const retired = "reawaken-retired";
      const claim = {
        runId: "wfr_2",
        stepId: "s",
        inputHash: "h",
        childTaskId: retired,
        attemptId: "att_0000000000000003",
        mode: "no-report" as const,
        at: "2026-09-18T00:00:00.000Z",
      };
      const { config } = await setupTree([
        {
          id: taskId,
          overrides: { taskStatus: "interrupted", taskAttemptId: "att_00000000000000aa" },
        },
        {
          id: retired,
          overrides: {
            taskStatus: "interrupted",
            taskAttemptId: claim.attemptId,
            taskAttemptRetiredBy: claim,
          },
        },
      ]);
      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      const entry = entryOf(config, taskId);
      expect(entry?.taskStatus).toBe("running");
      expect(entry?.taskAttemptId).toMatch(ATTEMPT_ID);
      expect(entry?.taskAttemptId).not.toBe("att_00000000000000aa");
      expect(entry?.taskAttemptUnproven).toBe(true);
      expect(svc.ownedAttemptByTaskId.get(taskId)).toMatchObject({
        source: "reawaken",
        attemptId: entry!.taskAttemptId,
        receiptEligible: false,
      });
      expect(svc.currentAttemptIdByTaskId.get(taskId)).toBe(entry!.taskAttemptId);

      expect(await taskService.markInterruptedTaskRunning(retired)).toBe(false);
      expect(entryOf(config, retired)?.taskStatus).toBe("interrupted");
      expect(entryOf(config, retired)?.taskAttemptId).toBe(claim.attemptId);
      expect(svc.ownedAttemptByTaskId.has(retired)).toBe(false);
      const reactivation = await taskService.sendMessageToDescendantAgentTask(
        rootId,
        retired,
        "again",
        "tool-end"
      );
      expect(reactivation).toEqual({
        success: false,
        error: { code: "send_failed", message: retiredAttemptMessage(claim) },
      });
      expect(entryOf(config, retired)?.taskAttemptId).toBe(claim.attemptId);
    });

    test("reawaken lineage: this process's settled attempt proves the successor; a receipt proves an unowned one; unreadable never does", async () => {
      const taskId = "reawaken-proven";
      const byReceipt = "reawaken-receipt";
      const unreadable = "reawaken-unreadable";
      const receiptAttempt = "att_00000000000000bb";
      const unreadableAttempt = "att_00000000000000cc";
      const { config } = await setupTree([
        {
          id: taskId,
          overrides: { taskStatus: "interrupted", taskAttemptId: "att_00000000000000a1" },
        },
        { id: byReceipt, overrides: { taskStatus: "interrupted", taskAttemptId: receiptAttempt } },
        {
          id: unreadable,
          overrides: { taskStatus: "interrupted", taskAttemptId: unreadableAttempt },
        },
      ]);
      const parentDir = path.join(config.sessionsDir, rootId);
      expect(
        (
          await writeSubagentAttemptSettlementReceipt({
            ownerWorkspaceSessionDirs: [parentDir],
            receipt: {
              taskId: byReceipt,
              attemptId: receiptAttempt,
              parentWorkspaceId: rootId,
              source: "idle-settled",
              settledAt: "2026-09-18T00:00:00.000Z",
            },
          })
        ).success
      ).toBe(true);
      const corruptPath = path.join(
        parentDir,
        "subagent-attempt-settlements",
        encodeURIComponent(unreadable),
        `${unreadableAttempt}.json`
      );
      await fsPromises.mkdir(path.dirname(corruptPath), { recursive: true });
      await fsPromises.writeFile(corruptPath, "{", "utf-8");

      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      shortenTerminationTimers();

      // First reawaken: unowned predecessor without receipt → unproven.
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      const first = svc.ownedAttemptByTaskId.get(taskId);
      expect(first?.receiptEligible).toBe(false);
      // Stop settles THIS process's attempt; the next reawaken's predecessor is settled here.
      await taskService.terminateAllDescendantAgentTasks(rootId);
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
        kind: "terminal-no-report",
      });
      // ...but the predecessor is marked, and the marker is inherited: still not eligible.
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      expect(svc.ownedAttemptByTaskId.get(taskId)?.receiptEligible).toBe(false);
      expect(entryOf(config, taskId)?.taskAttemptUnproven).toBe(true);

      // Receipt for the current unowned id → proven, no marker.
      expect(await taskService.markInterruptedTaskRunning(byReceipt)).toBe(true);
      expect(svc.ownedAttemptByTaskId.get(byReceipt)).toMatchObject({ receiptEligible: true });
      expect(entryOf(config, byReceipt)?.taskAttemptUnproven).toBeUndefined();
      expect(entryOf(config, byReceipt)?.taskAttemptId).not.toBe(receiptAttempt);
      // An eligible attempt settled by this process proves the next successor too.
      await taskService.terminateAllDescendantAgentTasks(rootId);
      expect(await taskService.markInterruptedTaskRunning(byReceipt)).toBe(true);
      expect(svc.ownedAttemptByTaskId.get(byReceipt)).toMatchObject({ receiptEligible: true });
      expect(entryOf(config, byReceipt)?.taskAttemptUnproven).toBeUndefined();

      // Unreadable receipt is no evidence.
      expect(await taskService.markInterruptedTaskRunning(unreadable)).toBe(true);
      expect(svc.ownedAttemptByTaskId.get(unreadable)?.receiptEligible).toBe(false);
      expect(entryOf(config, unreadable)?.taskAttemptUnproven).toBe(true);
    });

    test("marker race: an unproven marker appearing between the proof snapshot and the CAS downgrades the committed attempt", async () => {
      const taskId = "reawaken-race";
      const previous = "att_00000000000000dd";
      const { config } = await setupTree([
        { id: taskId, overrides: { taskStatus: "interrupted", taskAttemptId: previous } },
      ]);
      await writeSubagentAttemptSettlementReceipt({
        ownerWorkspaceSessionDirs: [path.join(config.sessionsDir, rootId)],
        receipt: {
          taskId,
          attemptId: previous,
          parentWorkspaceId: rootId,
          source: "idle-settled",
          settledAt: "2026-09-18T00:00:00.000Z",
        },
      });
      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      const original = svc.evaluateAttemptLineage.bind(taskService);
      spyOn(svc, "evaluateAttemptLineage").mockImplementation(async (id, entry) => {
        const proof = await original(id, entry);
        expect(proof.proven).toBe(true);
        // Another process marks the lineage while this admission holds its snapshot.
        await config.editConfig((cfg) => {
          for (const project of cfg.projects.values()) {
            const ws = project.workspaces.find((w) => w.id === id);
            if (ws) ws.taskAttemptUnproven = true;
          }
          return cfg;
        });
        return proof;
      });
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      expect(entryOf(config, taskId)?.taskAttemptUnproven).toBe(true);
      expect(svc.ownedAttemptByTaskId.get(taskId)?.receiptEligible).toBe(false);
    });

    test("stale-starting revert marks the lineage; startup re-drive rotates unowned and marks; a retired task is skipped", async () => {
      const stale = "stale-starting";
      const redriven = "redriven-running";
      const retired = "redriven-retired";
      const claim = {
        runId: "wfr_3",
        stepId: "s",
        inputHash: "h",
        childTaskId: retired,
        attemptId: "att_00000000000000ee",
        mode: "no-report" as const,
        at: "2026-09-18T00:00:00.000Z",
      };
      const { config, projectPath } = await setupTree([
        {
          id: stale,
          overrides: {
            taskStatus: "starting",
            taskPrompt: "p",
            taskAttemptId: "att_00000000000000f1",
          },
        },
        {
          id: redriven,
          overrides: { taskStatus: "running", taskAttemptId: "att_00000000000000f2" },
        },
        {
          id: retired,
          overrides: {
            taskStatus: "running",
            taskAttemptId: claim.attemptId,
            taskAttemptRetiredBy: claim,
          },
        },
      ]);
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createHarness(config, { workspaceService });
      const svc = internals(taskService);
      spyOn(svc, "materializeReservedTaskWorkspace").mockImplementation(() =>
        Promise.resolve({
          workspacePath: projectPath,
          trunkBranch: "main",
          forkedRuntimeConfig: { type: "local" },
          runtimeForTaskWorkspace: {
            deleteWorkspace: mock(() => Promise.resolve(Ok(undefined))),
            getWorkspacePath: () => "/tmp/stale",
          },
          inheritedProjects: undefined,
        })
      );
      spyOn(svc, "cleanupMaterializedTaskWorkspace").mockImplementation(() => Promise.resolve());
      await taskService.recoverInterruptedTasks();
      const deadline = Date.now() + 2_000;
      while (entryOf(config, stale)?.taskStatus !== "running") {
        if (Date.now() > deadline) throw new Error("stale starting task was not relaunched");
        await settle();
      }
      // Reverted to queued with the marker, then launched by the drain: owned, never eligible.
      const staleEntry = entryOf(config, stale);
      expect(staleEntry?.taskAttemptUnproven).toBe(true);
      expect(staleEntry?.taskAttemptId).toMatch(ATTEMPT_ID);
      expect(staleEntry?.taskAttemptId).not.toBe("att_00000000000000f1");
      expect(svc.ownedAttemptByTaskId.get(stale)).toMatchObject({
        source: "launch",
        receiptEligible: false,
      });
      // Re-driven running task: rotated + marked, NOT owned, exactly one send.
      const redrivenEntry = entryOf(config, redriven);
      expect(redrivenEntry?.taskAttemptId).toMatch(ATTEMPT_ID);
      expect(redrivenEntry?.taskAttemptId).not.toBe("att_00000000000000f2");
      expect(redrivenEntry?.taskAttemptUnproven).toBe(true);
      expect(svc.ownedAttemptByTaskId.has(redriven)).toBe(false);
      expect(svc.currentAttemptIdByTaskId.get(redriven)).toBe(redrivenEntry!.taskAttemptId);
      const redrivenSends = sendMessage.mock.calls.filter((call) => call[0] === redriven);
      expect(redrivenSends).toHaveLength(1);
      // Retired: untouched and never sent.
      expect(entryOf(config, retired)?.taskAttemptId).toBe(claim.attemptId);
      expect(sendMessage.mock.calls.filter((call) => call[0] === retired)).toHaveLength(0);
    });

    test("a pre-identity starting entry is stamped with a marked id at launch", async () => {
      const taskId = "preupgrade1";
      const { config, projectPath } = await setupTree([
        { id: taskId, overrides: { taskStatus: "starting", taskAttemptId: undefined } },
      ]);
      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      spyOn(svc, "materializeReservedTaskWorkspace").mockImplementation(() =>
        Promise.resolve({
          workspacePath: projectPath,
          trunkBranch: "main",
          forkedRuntimeConfig: { type: "local" },
          runtimeForTaskWorkspace: {
            deleteWorkspace: mock(() => Promise.resolve(Ok(undefined))),
            getWorkspacePath: () => "/tmp/pre",
          },
          inheritedProjects: undefined,
        })
      );
      spyOn(svc, "cleanupMaterializedTaskWorkspace").mockImplementation(() => Promise.resolve());
      const parentMeta = (await config.getAllWorkspaceMetadata()).find((m) => m.id === rootId)!;
      await svc.startReservedAgentTask({
        taskId,
        parentWorkspaceId: rootId,
        parentMeta,
        agentId: "explore",
        agentType: "explore",
        start: { kind: "sendMessage", prompt: "p" },
        title: "T",
        workspaceName: taskId,
        createdAt: new Date().toISOString(),
        taskRuntimeConfig: { type: "local" },
        parentRuntimeConfig: { type: "local" },
        configProjectPath: projectPath,
        taskModelString: "openai:gpt-5.2",
        canonicalModel: "openai:gpt-5.2",
        skipInitHook: true,
      });
      const entry = entryOf(config, taskId);
      expect(entry?.taskStatus).toBe("running");
      expect(entry?.taskAttemptId).toMatch(ATTEMPT_ID);
      expect(entry?.taskAttemptUnproven).toBe(true);
      expect(svc.ownedAttemptByTaskId.get(taskId)).toMatchObject({
        source: "launch",
        attemptId: entry!.taskAttemptId,
        receiptEligible: false,
      });
    });
  });

  describe("admission lifecycle", () => {
    test("the fence binds sends to the current attempt: non-task and pre-identity entries carry no obligation; retired and closed attempts refuse", async () => {
      const legacy = "legacy-no-id";
      const owned = "owned-child";
      const { config } = await setupTree([
        { id: legacy, overrides: { taskStatus: "running", taskAttemptId: undefined } },
        {
          id: owned,
          overrides: { taskStatus: "interrupted", taskAttemptId: "att_0000000000000101" },
        },
      ]);
      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      expect(taskService.admitTaskWorkspaceTurn(rootId, { acceptanceOrigin: "manual" })).toEqual({
        kind: "not-a-task",
      });
      expect(taskService.admitTaskWorkspaceTurn(legacy, { acceptanceOrigin: "manual" })).toEqual({
        kind: "not-a-task",
      });
      expect(await taskService.markInterruptedTaskRunning(owned)).toBe(true);
      const attemptId = entryOf(config, owned)!.taskAttemptId!;
      const token = admitted(
        taskService.admitTaskWorkspaceTurn(owned, { acceptanceOrigin: "automatic" })
      );
      expect(token.admissionStale()).toBe(false);
      const [send] = [...svc.admittedSendsByTaskId.get(owned)!];
      expect(send).toMatchObject({ state: "pending", attemptId });
      // A closure recorded for the current id refuses further sends and marks the token stale.
      svc.closeAttemptAdmission(owned, { attemptId }, "test");
      expect(token.admissionStale()).toBe(true);
      expect(taskService.admitTaskWorkspaceTurn(owned, { acceptanceOrigin: "automatic" })).toEqual({
        kind: "refused",
        message: TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE,
      });
      token.onDisposed("refused");
      expect(send.state).toBe("discharged");
      expect(svc.admittedSendsByTaskId.get(owned)).toBeUndefined();
      // A disposed token is terminal even though nothing else changed.
      expect(token.admissionStale()).toBe(true);
    });

    test("a rotation revokes pending tokens of the older attempt; admitted tokens are bound to their turn", async () => {
      const taskId = "rotation-revokes";
      const { config } = await setupTree([
        {
          id: taskId,
          overrides: { taskStatus: "interrupted", taskAttemptId: "att_0000000000000201" },
        },
      ]);
      const host = hostWithTurnEvents();
      const { taskService } = createHarness(config, { workspaceService: host.workspaceService });
      const svc = internals(taskService);
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      const pending = admitted(
        taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "automatic" })
      );
      const adopted = admitted(
        taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "automatic" })
      );
      const turn = Symbol("turn");
      adopted.onAdmitted(turn);
      adopted.onAdmitted(turn); // idempotent per turn
      expect([...svc.admittedSendsByTaskId.get(taskId)!].map((s) => s.state).sort()).toEqual([
        "admitted",
        "pending",
      ]);
      await taskService.stopDescendantAgentTask(rootId, taskId);
      // The admitted turn AND the pending obligation keep the record: the Stop cannot release
      // until the turn settles and the pending send is dispositioned.
      expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(true);
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
        kind: "cleanup-pending",
      });
      host.settleTurn(taskId, turn);
      await settle();
      expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(true);
      expect([...svc.admittedSendsByTaskId.get(taskId)!].map((s) => s.state)).toEqual(["pending"]);
      // The pending send is stale (stop in progress) and gets refused at its gate.
      expect(pending.admissionStale()).toBe(true);
      pending.onDisposed("refused");
      await settle();
      expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(false);
      expect(svc.admittedSendsByTaskId.get(taskId)).toBeUndefined();
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
        kind: "terminal-no-report",
      });
      // Legitimate reawaken publishes a fresh id; the fence admits it and installs ownership.
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      const fresh = admitted(
        taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })
      );
      expect(fresh.admissionStale()).toBe(false);
      expect(svc.attemptSettlementByTaskId.get(taskId)).toBeUndefined();
      fresh.onDisposed("no-work");
    });

    test("a stop record waits for a pending admission, then for the turn it becomes, and owes a second stopStream for it", async () => {
      const taskId = "stop-pending-admission";
      const { config } = await setupTree([
        {
          id: taskId,
          overrides: { taskStatus: "interrupted", taskAttemptId: "att_0000000000000301" },
        },
      ]);
      const stopStream = mock(
        (_id: string): Promise<Result<void>> => Promise.resolve(Ok(undefined))
      );
      const { aiService } = createAIServiceMocks(config, { stopStream });
      const host = hostWithTurnEvents();
      const { taskService } = createHarness(config, {
        aiService,
        workspaceService: host.workspaceService,
      });
      const svc = internals(taskService);
      shortenTerminationTimers();
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      const token = admitted(
        taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "automatic" })
      );

      await taskService.terminateAllDescendantAgentTasks(rootId);
      // Phase B ran (one stopStream) but the record is retained by the pending obligation.
      expect(stopStream).toHaveBeenCalledTimes(1);
      const record = svc.workspaceStopRecords.get(taskId)!;
      expect(record.pendingAdmissions.size).toBe(1);
      expect(record.capturedTurns.size).toBe(0);
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
        kind: "cleanup-pending",
      });
      // The pending send claims a turn after all: the record moves to waiting on that turn and
      // stops it (second stopStream), because Phase B's stop targeted the execution captured
      // before this turn existed.
      const late = Symbol("late-turn");
      token.onAdmitted(late);
      expect(record.pendingAdmissions.size).toBe(0);
      expect(record.capturedTurns.has(late)).toBe(true);
      expect(stopStream).toHaveBeenCalledTimes(2);
      await settle();
      expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(true);
      // The late turn settles → discharged obligation, released record, settled attempt.
      host.settleTurn(taskId, late);
      await settle();
      expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(false);
      expect(svc.admittedSendsByTaskId.get(taskId)).toBeUndefined();
      expect(svc.attemptSettlementByTaskId.get(taskId)?.phase).toBe("settled");
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
        kind: "terminal-no-report",
      });
      // Settlement closed the attempt: a continuation is refused; only a reawaken reopens.
      expect(taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "automatic" })).toEqual(
        {
          kind: "refused",
          message: TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE,
        }
      );
    });

    test("supersession rebinds admitted obligations and captured turns to the successor", async () => {
      const taskId = "supersession-rebind";
      const { config } = await setupTree([
        {
          id: taskId,
          overrides: { taskStatus: "interrupted", taskAttemptId: "att_0000000000000401" },
        },
      ]);
      const first = Symbol("T1");
      const second = Symbol("T2");
      let activeTurn: symbol | undefined;
      const host = hostWithTurnEvents({
        getActiveTurnGeneration: mock(() => activeTurn),
      });
      const { taskService } = createHarness(config, { workspaceService: host.workspaceService });
      const svc = internals(taskService);
      shortenTerminationTimers();
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      const token = admitted(
        taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "automatic" })
      );
      token.onAdmitted(first);
      activeTurn = first;
      await taskService.terminateAllDescendantAgentTasks(rootId);
      const record = svc.workspaceStopRecords.get(taskId)!;
      expect(record.capturedTurns.has(first)).toBe(true);
      // The coordinator replaced T1 with T2 without T1 ever going idle.
      host.supersedeTurn(taskId, first, second);
      expect(record.capturedTurns.has(first)).toBe(false);
      expect(record.capturedTurns.has(second)).toBe(true);
      const [send] = [...svc.admittedSendsByTaskId.get(taskId)!];
      expect(send.turnId).toBe(second);
      // A settlement for the superseded generation is not evidence about the live successor.
      host.settleTurn(taskId, first);
      await settle();
      expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(true);
      expect(send.state).toBe("admitted");
      activeTurn = undefined;
      host.settleTurn(taskId, second);
      await settle();
      expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(false);
      expect(send.state).toBe("discharged");
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
        kind: "terminal-no-report",
      });
    });

    test("a queued token is refused while a stop is in progress and stays refused once the attempt settled", async () => {
      const taskId = "stop-refuses-new-sends";
      const { config } = await setupTree([
        {
          id: taskId,
          overrides: { taskStatus: "interrupted", taskAttemptId: "att_0000000000000501" },
        },
      ]);
      const stopStream = mock((_id: string): Promise<Result<void>> => new Promise(() => undefined));
      const { aiService } = createAIServiceMocks(config, { stopStream });
      const { taskService } = createHarness(config, { aiService });
      shortenTerminationTimers();
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      const beforeStop = admitted(
        taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "automatic" })
      );
      beforeStop.onDisposed("no-work");
      await taskService.terminateAllDescendantAgentTasks(rootId);
      // Stop in progress (cleanup hung): refused with the stop message, no obligation created.
      expect(taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "automatic" })).toEqual(
        {
          kind: "refused",
          message: WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE,
        }
      );
      expect(internals(taskService).admittedSendsByTaskId.get(taskId)).toBeUndefined();
    });

    test("markTaskLaunchFailed closes the attempt for its id; a later send under that id is refused", async () => {
      const spawnedId = "launchfailed1";
      const { config } = await setupTree([]);
      stubStableIds(config, [spawnedId]);
      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      spyOn(svc, "startReservedAgentTask").mockImplementation(() =>
        Promise.reject(new Error("fork failed"))
      );
      const created = await taskService.createMany([
        {
          parentWorkspaceId: rootId,
          kind: "agent",
          agentId: "explore",
          prompt: "doomed",
          title: "D",
        },
      ]);
      expect(created.success).toBe(true);
      // The in-memory settlement follows the status write asynchronously (the closing window is
      // covered separately below); poll the authoritative phase.
      const deadline = Date.now() + 2_000;
      while (svc.attemptSettlementByTaskId.get(spawnedId)?.phase !== "settled") {
        if (Date.now() > deadline) throw new Error("launch failure did not settle");
        await settle();
      }
      expect(entryOf(config, spawnedId)?.taskStatus).toBe("interrupted");
      const attemptId = entryOf(config, spawnedId)!.taskAttemptId!;
      expect(isTaskAttemptId(attemptId)).toBe(true);
      expect(svc.attemptSettlementByTaskId.get(spawnedId)).toMatchObject({
        attemptId,
        phase: "settled",
        source: "launch-failed",
      });
      expect(await taskService.readAttemptOutcome(spawnedId, requesting)).toEqual({
        kind: "terminal-no-report",
      });
      expect(
        taskService.admitTaskWorkspaceTurn(spawnedId, { acceptanceOrigin: "automatic" })
      ).toEqual({
        kind: "refused",
        message: TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE,
      });
      // Config identity is untouched by the closure (P3: no rollback, no re-derivation).
      expect(entryOf(config, spawnedId)?.taskAttemptId).toBe(attemptId);
    });

    test("while a producer's closing write is in flight the attempt reads cleanup-pending and refuses continuations", async () => {
      const spawnedId = "closingwindow1";
      const { config } = await setupTree([]);
      stubStableIds(config, [spawnedId]);
      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      spyOn(svc, "startReservedAgentTask").mockImplementation(() => new Promise(() => undefined));
      const created = await taskService.createMany([
        { parentWorkspaceId: rootId, kind: "agent", agentId: "explore", prompt: "p", title: "T" },
      ]);
      expect(created.success).toBe(true);
      const attemptId = entryOf(config, spawnedId)!.taskAttemptId!;
      // Hold the launch-failure config write open: closure is recorded inside the updater, the
      // in-memory settlement only after the write completes.
      const gate = Promise.withResolvers<void>();
      const originalEdit = config.editConfig.bind(config);
      const editSpy = spyOn(config, "editConfig").mockImplementation(async (mutator) => {
        const result = await originalEdit(mutator);
        await gate.promise;
        return result;
      });
      const failing = svc.markTaskLaunchFailed(spawnedId, "fork failed");
      const deadline = Date.now() + 2_000;
      while (svc.attemptSettlementByTaskId.get(spawnedId)?.phase !== "closing") {
        if (Date.now() > deadline) throw new Error("closure was not recorded");
        await settle();
      }
      expect(svc.attemptSettlementByTaskId.get(spawnedId)).toMatchObject({
        attemptId,
        phase: "closing",
      });
      // Closing, not settled: the owned read is cleanup-pending (a bounded, observable state,
      // not a lock wait) and a continuation is refused before any settlement exists.
      expect(await taskService.readAttemptOutcome(spawnedId, requesting)).toEqual({
        kind: "cleanup-pending",
      });
      expect(
        taskService.admitTaskWorkspaceTurn(spawnedId, { acceptanceOrigin: "automatic" })
      ).toEqual({
        kind: "refused",
        message: TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE,
      });
      gate.resolve();
      await failing;
      editSpy.mockRestore();
      expect(svc.attemptSettlementByTaskId.get(spawnedId)).toMatchObject({
        attemptId,
        phase: "settled",
      });
      expect(await taskService.readAttemptOutcome(spawnedId, requesting)).toEqual({
        kind: "terminal-no-report",
      });
    });

    test("an idle stop treats a pending admission as live and closes the attempt only once it is dispositioned", async () => {
      const taskId = "idle-stop-pending";
      const { config } = await setupTree([
        {
          id: taskId,
          overrides: {
            taskStatus: "interrupted",
            taskAttemptId: "att_0000000000000601",
            taskDesktopOwnerWorkspaceId: rootId,
          },
        },
      ]);
      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      const token = admitted(
        taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "automatic" })
      );
      await svc.releaseSharedDesktopTaskOnUserStop(taskId);
      // The pending send keeps the task live: no transition, no closure.
      expect(entryOf(config, taskId)?.taskStatus).toBe("running");
      expect(svc.attemptSettlementByTaskId.get(taskId)).toBeUndefined();
      token.onDisposed("refused");
      await svc.releaseSharedDesktopTaskOnUserStop(taskId);
      expect(entryOf(config, taskId)?.taskStatus).toBe("interrupted");
      expect(svc.attemptSettlementByTaskId.get(taskId)).toMatchObject({
        attemptId: entryOf(config, taskId)?.taskAttemptId,
        phase: "settled",
        source: "user-stop-idle",
      });
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
        kind: "terminal-no-report",
      });
    });

    test("a Stop of an unowned prior-process attempt closes its id without minting settlement evidence", async () => {
      const taskId = "unowned-stop-closes";
      const attemptId = "att_0000000000000701";
      const { config } = await setupTree([
        { id: taskId, overrides: { taskStatus: "running", taskAttemptId: attemptId } },
      ]);
      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      shortenTerminationTimers();
      await taskService.terminateAllDescendantAgentTasks(rootId);
      expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(false);
      expect(svc.attemptSettlementByTaskId.get(taskId)).toMatchObject({
        attemptId,
        phase: "closing",
        source: "stop-settled",
      });
      expect((await taskService.readAttemptOutcome(taskId, requesting)).kind).toBe("indeterminate");
      expect(taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "automatic" })).toEqual(
        {
          kind: "refused",
          message: TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE,
        }
      );
      // A user reawaken mints a fresh id and reopens admission.
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      expect(entryOf(config, taskId)?.taskAttemptId).not.toBe(attemptId);
      const fresh = taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" });
      expect(fresh.kind).toBe("admitted");
      if (fresh.kind === "admitted") fresh.token.onDisposed("no-work");
    });

    test("an unreadable registry fails a task-workspace send closed", async () => {
      const taskId = "unreadable-registry";
      const { config } = await setupTree([
        {
          id: taskId,
          overrides: { taskStatus: "interrupted", taskAttemptId: "att_0000000000000801" },
        },
      ]);
      const { taskService } = createHarness(config);
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      const load = spyOn(config, "loadConfigOrDefault").mockImplementation((options) => {
        if (options?.throwOnError) throw new Error("registry unreadable");
        return { projects: new Map() } as unknown as ReturnType<Config["loadConfigOrDefault"]>;
      });
      try {
        const admission = taskService.admitTaskWorkspaceTurn(taskId, {
          acceptanceOrigin: "manual",
        });
        expect(admission.kind).toBe("refused");
        if (admission.kind === "refused") expect(admission.message).toContain("unreadable");
      } finally {
        load.mockRestore();
      }
    });
  });
});
