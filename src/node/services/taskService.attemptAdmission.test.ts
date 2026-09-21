import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { Config } from "@/node/config";
import { type Workspace as WorkspaceConfigEntry } from "@/node/config";
import { Err, Ok, type Result } from "@/common/types/result";
import { SecretsStore } from "@/node/config";
import {
  SEND_ADMISSION_STALE_MESSAGE,
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
import { ATTEMPT_CLOSURE_SETTLE_WAIT_MS, TaskService } from "@/node/services/taskService";
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
import { EventEmitter } from "events";
import { createAgentSessionHarness } from "@/node/services/agentSession.testHarness";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { ContextManagementService } from "@/node/services/contextManagement/contextManagementService";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { TurnCompletion } from "@/node/services/streamManager";
import { WorkspaceService } from "@/node/services/workspaceService";

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
  admittedSendsByTaskId: Map<
    string,
    Set<{ state: string; turnId?: symbol; attemptId: string; attempt?: unknown }>
  >;
  workspaceStopRecords: Map<
    string,
    {
      attemptId: string | undefined;
      ownedAttempt: unknown;
      capturedTurns: Set<symbol>;
      pendingAdmissions: Set<unknown>;
      cleanupInFlight: number;
      capturedExecutionId: string | undefined;
      executionSettled: boolean;
    }
  >;
  currentAttemptIdByTaskId: Map<string, string>;
  markTaskLaunchFailed: (taskId: string, message: string) => Promise<void>;
  closeAttemptAdmission: (
    taskId: string,
    attemptId: string | undefined,
    ownedAttempt: undefined,
    source: string
  ) => void;
  releaseSharedDesktopTaskOnUserStop: (taskId: string) => Promise<void>;
  startReservedAgentTask: (plan: unknown) => Promise<void>;
  materializeReservedTaskWorkspace: (...args: unknown[]) => Promise<unknown>;
  cleanupMaterializedTaskWorkspace: (...args: unknown[]) => Promise<void>;
  editActiveWorkspaceEntry: (
    taskId: string,
    updater: (workspace: WorkspaceConfigEntry) => void,
    options?: { allowMissing?: boolean }
  ) => Promise<boolean>;
  evaluateAttemptLineage: (
    taskId: string,
    entry: WorkspaceConfigEntry
  ) => Promise<{ proven: boolean; reason: string }>;
  admitTaskDesktopRecovery: (taskId: string) => Promise<boolean>;
  failAgentTaskTerminally: (
    workspaceId: string,
    entry: { projectPath: string; workspace: WorkspaceConfigEntry },
    failure: { errorType: string; errorMessage: string }
  ) => Promise<void>;
  /** The production stream-end listener's handler (entry-time origin capture for direct callers). */
  handleStreamEnd: (event: unknown) => Promise<void>;
  /** The direct create's rollback: the only deleter of a failed launch's row, checkout and session. */
  rollbackFailedTaskCreate: (...args: unknown[]) => Promise<void>;
  emitWorkspaceMetadata: (workspaceId: string) => Promise<void>;
}
const internals = (service: TaskService) => service as unknown as Internals;

/** A child's stream ending on a successful terminal `agent_report` (the ordinary report path). */
function reportingStreamEnd(taskId: string, messageId: string, reportMarkdown: string) {
  return {
    type: "stream-end",
    workspaceId: taskId,
    messageId,
    metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
    parts: [
      {
        type: "dynamic-tool",
        toolCallId: `${messageId}-report`,
        toolName: "agent_report",
        input: { reportMarkdown },
        state: "output-available",
        output: { success: true, report: { reportMarkdown } },
      },
      { type: "text", text: reportMarkdown },
    ],
  };
}

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

  /**
   * Fire only the termination timers and the closure-settle wait immediately; every other timer
   * keeps its delay. The settle wait is a deadline loop (`deadline - Date.now()`, so its timer is
   * matched by a narrow range below the bound): firing it early alone would only re-arm it, so
   * the clock is moved past the bound as it fires — the wait then genuinely elapses.
   */
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
      if (
        timeout != null &&
        timeout <= ATTEMPT_CLOSURE_SETTLE_WAIT_MS &&
        timeout > ATTEMPT_CLOSURE_SETTLE_WAIT_MS - 100
      ) {
        return originalSetTimeout(() => {
          setSystemTime(new Date(Date.now() + timeout));
          handler();
        }, 0);
      }
      return originalSetTimeout(handler, timeout);
    }) as typeof setTimeout);
    restoreTimers = () => {
      spy.mockRestore();
      setSystemTime();
    };
  }

  async function setupTree(
    descendants: Array<{
      id: string;
      overrides?: Partial<WorkspaceConfigEntry>;
      /** Project-dir local runtimes execute in the project root; persist that path (real host). */
      inProjectDir?: boolean;
    }>
  ) {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId, { runtimeConfig: { type: "local" } }),
        ...descendants.map(({ id, overrides, inProjectDir }) => ({
          ...projectWorkspace(projectPath, id, id, {
            parentWorkspaceId: rootId,
            agentType: "explore",
            agentId: "explore",
            taskStatus: "running",
            taskModelString: "openai:gpt-5.2",
            runtimeConfig: { type: "local" },
            ...overrides,
          }),
          ...(inProjectDir ? { path: projectPath } : {}),
        })),
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

  /** Resolve `promise` or fail the test after `timeoutMs` (a hung acquisition must not hang the suite). */
  async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }

  /** Bounded wait for work that owns its own completion (a cleanup that outlived its deadline). */
  async function waitForCondition(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !condition(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(condition()).toBe(true);
  }

  const entryOf = (config: Config, id: string) => findWorkspaceInConfig(config, id);
  /** The entry with its project path, as the stream-end producers receive it. */
  function findEntryWithProject(config: Config, id: string) {
    for (const [projectPath, project] of config.loadConfigOrDefault().projects) {
      const workspace = project.workspaces.find((w) => w.id === id);
      if (workspace) return { projectPath, workspace };
    }
    throw new Error(`workspace ${id} not found`);
  }

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

    test("manual recovery rotates a settled reported attempt without reviving its report or old tokens", async () => {
      const taskId = "reported-recovery";
      const attemptId = "att_00000000000000aa";
      const reportedAt = "2026-09-20T00:00:00.000Z";
      const { config } = await setupTree([
        {
          id: taskId,
          overrides: {
            taskStatus: "reported",
            taskAttemptId: attemptId,
            reportedAt,
            taskAttemptUnproven: true,
          },
        },
      ]);
      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      const oldToken = admitted(
        taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })
      );
      svc.attemptSettlementByTaskId.set(taskId, {
        attemptId,
        phase: "settled",
        source: "idle-settled",
      });
      try {
        // false means no status rollback is needed on send failure, not that no attempt was minted.
        expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(false);
        const current = entryOf(config, taskId);
        expect(current).toMatchObject({
          taskStatus: "reported",
          reportedAt,
          taskAttemptUnproven: true,
        });
        expect(current?.taskAttemptId).toMatch(ATTEMPT_ID);
        expect(current?.taskAttemptId).not.toBe(attemptId);
        expect(svc.ownedAttemptByTaskId.get(taskId)).toMatchObject({
          attemptId: current?.taskAttemptId,
          receiptEligible: false,
        });
        expect(oldToken.admissionStale()).toBe(true);
        const freshToken = admitted(
          taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })
        );
        expect(freshToken.admissionStale()).toBe(false);
        freshToken.onDisposed("no-work");
        // Ordinary manual follow-ups keep the fresh, unsettled attempt rather than rotating again.
        expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(false);
        expect(entryOf(config, taskId)?.taskAttemptId).toBe(current?.taskAttemptId);
      } finally {
        oldToken.onDisposed("refused");
      }
    });

    test("an ordinary reported child (durable report, ledgers released) gets a fresh attempt on the manual send/resume rescue instead of the fence admitting under the completed id", async () => {
      // The ordinary lifecycle, end to end through the real producers: a reawaken owns the attempt,
      // the stream ends on a terminal agent_report, the report is persisted for every ancestor and
      // releaseReportedTaskAttempt drops the attempt's owner AND settlement entry. The user then
      // types into the finished child (WorkspaceService.sendMessage) or resumes it
      // (WorkspaceService.resumeStream): both run markInterruptedTaskRunning and then the fence.
      const taskId = "reported-released";
      const { config } = await setupTree([
        {
          id: taskId,
          overrides: { taskStatus: "interrupted", taskAttemptId: "att_00000000000000d0" },
        },
      ]);
      const host = hostWithTurnEvents();
      const { taskService } = createHarness(config, { workspaceService: host.workspaceService });
      const svc = internals(taskService);
      shortenTerminationTimers();
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      const reportedAttemptId = entryOf(config, taskId)!.taskAttemptId!;
      expect(svc.ownedAttemptByTaskId.get(taskId)?.attemptId).toBe(reportedAttemptId);
      await svc.handleStreamEnd(reportingStreamEnd(taskId, "assistant-report-1", "done"));
      expect(entryOf(config, taskId)).toMatchObject({
        taskStatus: "reported",
        taskAttemptId: reportedAttemptId,
      });
      expect(svc.ownedAttemptByTaskId.has(taskId)).toBe(false);
      expect(svc.attemptSettlementByTaskId.has(taskId)).toBe(false);
      expect((await taskService.readAttemptOutcome(taskId, requesting)).kind).toBe("reported");

      // Manual send: the rescue mints a fresh owned attempt (false: the report stays historical,
      // no status rollback is owed) and the fence binds the send to IT, never to the completed id.
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(false);
      const continued = entryOf(config, taskId);
      expect(continued?.taskStatus).toBe("reported");
      expect(continued?.taskAttemptId).toMatch(ATTEMPT_ID);
      const continuedAttemptId = continued!.taskAttemptId!;
      expect(continuedAttemptId).not.toBe(reportedAttemptId);
      // Lineage: the completed attempt is neither settled by this process nor by a receipt.
      expect(continued?.taskAttemptUnproven).toBe(true);
      expect(svc.ownedAttemptByTaskId.get(taskId)).toMatchObject({
        source: "reawaken",
        attemptId: continuedAttemptId,
        receiptEligible: false,
      });
      // The historical report still decides the task's outcome for its ancestors.
      expect((await taskService.readAttemptOutcome(taskId, requesting)).kind).toBe("reported");
      const sendToken = admitted(
        taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })
      );
      expect(svc.admittedSendsByTaskId.get(taskId)?.size).toBe(1);
      for (const send of svc.admittedSendsByTaskId.get(taskId) ?? []) {
        expect(send.attemptId).toBe(continuedAttemptId);
      }
      // The continuation runs and settles without a second report (a reported child never turns
      // back into an active task): its attempt stays owned and unsettled...
      const turn = Symbol("manual-continuation");
      sendToken.onAdmitted(turn);
      host.settleTurn(taskId, turn);
      expect(svc.admittedSendsByTaskId.get(taskId)).toBeUndefined();
      // ...so a resume (same rescue, same fence) continues THAT attempt rather than rotating again.
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(false);
      expect(entryOf(config, taskId)?.taskAttemptId).toBe(continuedAttemptId);
      const resumeToken = admitted(
        taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })
      );
      expect(resumeToken.admissionStale()).toBe(false);
      resumeToken.onDisposed("no-work");
      // An explicit Stop settles the owned continuation; the next rescue rotates from that
      // settlement (the pre-existing settled-predecessor path) and inherits the marker.
      await taskService.terminateAllDescendantAgentTasks(rootId);
      expect(svc.attemptSettlementByTaskId.get(taskId)).toMatchObject({
        attemptId: continuedAttemptId,
        phase: "settled",
      });
      expect(entryOf(config, taskId)?.taskStatus).toBe("reported");
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(false);
      expect(entryOf(config, taskId)?.taskAttemptId).not.toBe(continuedAttemptId);
      expect(entryOf(config, taskId)?.taskAttemptUnproven).toBe(true);
    });

    test.each(["missing-id", "owned-unsettled", "closing", "stale", "retired"] as const)(
      "manual recovery of a reported child refuses %s settlement evidence",
      async (evidence) => {
        const taskId = "reported-recovery";
        const attemptId = evidence === "missing-id" ? undefined : "att_00000000000000aa";
        const { config } = await setupTree([
          { id: taskId, overrides: { taskStatus: "reported", taskAttemptId: attemptId } },
        ]);
        const { taskService } = createHarness(config);
        const svc = internals(taskService);
        if (evidence === "owned-unsettled") {
          // A live continuation this process owns (a parent reactivation, an earlier manual
          // follow-up): the attempt is neither released nor settled, so it is continued, not
          // rotated. The released shape (no owner, no entry) is the lifecycle test above.
          svc.ownedAttemptByTaskId.set(taskId, {
            attemptId,
            receiptEligible: true,
            source: "reactivation",
          });
        } else {
          svc.attemptSettlementByTaskId.set(taskId, {
            attemptId: evidence === "stale" ? "att_00000000000000bb" : attemptId,
            phase: evidence === "closing" ? "closing" : "settled",
            source: "idle-settled",
          });
        }
        if (evidence === "retired") {
          await config.editConfig((cfg) => {
            const ws = findWorkspaceInConfig(config, taskId);
            if (!ws?.taskAttemptId) throw new Error("missing attempt");
            for (const project of cfg.projects.values()) {
              const entry = project.workspaces.find((w) => w.id === taskId);
              if (entry) {
                entry.taskAttemptRetiredBy = {
                  runId: "wfr_claim",
                  stepId: "step",
                  inputHash: "input",
                  childTaskId: taskId,
                  attemptId: ws.taskAttemptId,
                  mode: "retire-reported",
                  at: "2026-09-20T00:00:00.000Z",
                };
              }
            }
            return cfg;
          });
        }
        const before = entryOf(config, taskId);
        const owned = svc.ownedAttemptByTaskId.get(taskId);
        const settlement = svc.attemptSettlementByTaskId.get(taskId);
        expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(false);
        expect(entryOf(config, taskId)).toEqual(before);
        expect(svc.ownedAttemptByTaskId.get(taskId)).toBe(owned);
        expect(svc.attemptSettlementByTaskId.get(taskId)).toBe(settlement);
      }
    );

    test.each([
      "stop",
      "stop-before-cas",
      "supersession",
      "claim",
      "status",
      "settlement",
    ] as const)(
      "manual recovery of a settled reported child rechecks %s after lineage awaits",
      async (race) => {
        const taskId = "reported-race";
        const attemptId = "att_00000000000000aa";
        const reportedAt = "2026-09-20T00:00:00.000Z";
        const { config } = await setupTree([
          {
            id: taskId,
            overrides: { taskStatus: "reported", taskAttemptId: attemptId, reportedAt },
          },
        ]);
        const { taskService } = createHarness(config);
        const svc = internals(taskService);
        const oldToken = admitted(
          taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })
        );
        const settlement = { attemptId, phase: "settled" as const, source: "idle-settled" };
        svc.attemptSettlementByTaskId.set(taskId, settlement);
        const original = svc.evaluateAttemptLineage.bind(taskService);
        let releaseStop: (() => void) | undefined;
        const proof = spyOn(svc, "evaluateAttemptLineage").mockImplementation(async (id, entry) => {
          const lineage = await original(id, entry);
          if (race === "stop") {
            releaseStop = taskService.latchHardInterruptCascade(taskId);
          } else if (race === "settlement") {
            svc.attemptSettlementByTaskId.set(taskId, { ...settlement, phase: "closing" });
          } else if (race !== "stop-before-cas") {
            await config.editConfig((cfg) => {
              for (const project of cfg.projects.values()) {
                const ws = project.workspaces.find((w) => w.id === taskId);
                if (!ws) continue;
                if (race === "supersession") ws.taskAttemptId = "att_00000000000000bb";
                if (race === "status") ws.taskStatus = "interrupted";
                if (race === "claim") {
                  ws.taskAttemptRetiredBy = {
                    runId: "wfr_claim",
                    stepId: "step",
                    inputHash: "input",
                    childTaskId: taskId,
                    attemptId,
                    mode: "retire-reported",
                    at: reportedAt,
                  };
                }
              }
              return cfg;
            });
          }
          return lineage;
        });
        const edit = svc.editActiveWorkspaceEntry.bind(taskService);
        const cas = spyOn(svc, "editActiveWorkspaceEntry").mockImplementation((...args) => {
          if (race === "stop-before-cas") {
            releaseStop = taskService.latchHardInterruptCascade(taskId);
          }
          return edit(...args);
        });
        try {
          expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(false);
          expect(proof).toHaveBeenCalledTimes(1);
          expect(entryOf(config, taskId)?.taskAttemptId).toBe(
            race === "supersession" ? "att_00000000000000bb" : attemptId
          );
          expect(entryOf(config, taskId)?.taskStatus).toBe(
            race === "status" ? "interrupted" : "reported"
          );
          expect(svc.attemptSettlementByTaskId.get(taskId)).toEqual(
            race === "settlement" ? { ...settlement, phase: "closing" } : settlement
          );
          expect(svc.ownedAttemptByTaskId.has(taskId)).toBe(false);
          expect(oldToken.admissionStale()).toBe(true);
        } finally {
          cas.mockRestore();
          proof.mockRestore();
          releaseStop?.();
          oldToken.onDisposed("refused");
        }
      }
    );

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

    test.each(["before-launch", "during-materialize", "on-failure"] as const)(
      "a reserved launch whose row was re-reserved by another writer (%s) neither adopts, dispatches, nor cleans up the successor",
      async (when) => {
        const taskId = "reservedsuper1";
        const foreign = "att_00000000000000a7";
        const { config, projectPath } = await setupTree([]);
        stubStableIds(config, [taskId]);
        const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
        const { taskService } = createHarness(config, { workspaceService });
        const svc = internals(taskService);
        // A marker in the task's session dir: the launch's cleanup removes that dir.
        const sessionMarker = path.join(config.sessionsDir, taskId, "marker");
        await fsPromises.mkdir(path.dirname(sessionMarker), { recursive: true });
        await fsPromises.writeFile(sessionMarker, "keep", "utf-8");
        // Another backend recovered the row and re-reserved it under its own attempt.
        const supersede = () =>
          config.editConfig((cfg) => {
            for (const project of cfg.projects.values()) {
              const ws = project.workspaces.find((w) => w.id === taskId);
              if (ws) ws.taskAttemptId = foreign;
            }
            return cfg;
          });
        const materialization = {
          workspacePath: projectPath,
          trunkBranch: "main",
          forkedRuntimeConfig: { type: "local" as const },
          runtimeForTaskWorkspace: {
            deleteWorkspace: mock(() => Promise.resolve(Ok(undefined))),
            getWorkspacePath: () => "/tmp/reserved-super",
          },
          inheritedProjects: undefined,
        };
        if (when === "before-launch") {
          const launch = svc.startReservedAgentTask.bind(taskService);
          spyOn(svc, "startReservedAgentTask").mockImplementation(async (plan) => {
            await supersede();
            return launch(plan);
          });
        }
        spyOn(svc, "materializeReservedTaskWorkspace").mockImplementation(async () => {
          if (when === "during-materialize") await supersede();
          return materialization;
        });
        spyOn(workspaceService, "sanitizeMaterializedTaskWorkspace").mockImplementation(
          async () => {
            if (when === "on-failure") {
              await supersede();
              return "sanitize failed";
            }
            return undefined;
          }
        );

        const created = await taskService.createMany([
          {
            parentWorkspaceId: rootId,
            kind: "agent",
            agentId: "explore",
            prompt: "go",
            title: "T",
          },
        ]);
        expect(created.success).toBe(true);
        const reserved = svc.ownedAttemptByTaskId.get(taskId)!.attemptId!;
        expect(reserved).toMatch(ATTEMPT_ID);
        // The launch settles one way or the other; nothing about the successor's row may move.
        const deadline = Date.now() + 2_000;
        while (entryOf(config, taskId)?.taskAttemptId !== foreign) {
          if (Date.now() > deadline) throw new Error("supersession never landed");
          await settle();
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(sendMessage.mock.calls.filter((call) => call[0] === taskId)).toHaveLength(0);
        expect(entryOf(config, taskId)).toMatchObject({
          taskAttemptId: foreign,
          taskStatus: "starting",
        });
        expect(entryOf(config, taskId)?.taskLaunchError).toBeUndefined();
        expect(svc.ownedAttemptByTaskId.get(taskId)?.attemptId).toBe(reserved);
        expect(svc.currentAttemptIdByTaskId.get(taskId)).not.toBe(foreign);
        expect(svc.attemptSettlementByTaskId.get(taskId)?.attemptId).not.toBe(foreign);
        expect(await fsPromises.readFile(sessionMarker, "utf-8")).toBe("keep");
      }
    );

    test.each(["admitted-after-sample", "pending-before-decision"] as const)(
      "terminal failure closes the attempt before sampling activity: a send %s is refused or drained, never run under a settled attempt",
      async (race) => {
        const taskId = "terminal-failure-race";
        const { config } = await setupTree([
          {
            id: taskId,
            overrides: { taskStatus: "interrupted", taskAttemptId: "att_00000000000000a8" },
          },
        ]);
        const { taskService } = createHarness(config);
        const svc = internals(taskService);
        shortenTerminationTimers();
        expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
        const attemptId = entryOf(config, taskId)!.taskAttemptId!;
        const owned = svc.ownedAttemptByTaskId.get(taskId);
        const entry = findEntryWithProject(config, taskId);
        let pending: TurnAdmissionToken | undefined;
        if (race === "pending-before-decision") {
          pending = admitted(
            taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "automatic" })
          );
        }
        // A send reaching the fence after the producer sampled activity but before its config
        // updater ran must meet a closed attempt.
        let raced: TaskTurnAdmission | undefined;
        const edit = taskService.editWorkspaceEntry.bind(taskService);
        spyOn(taskService, "editWorkspaceEntry").mockImplementation(
          async (id, updater, options) => {
            if (id === taskId && raced == null) {
              raced = taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "automatic" });
              if (raced.kind === "admitted") raced.token.onAdmitted(Symbol("late-turn"));
            }
            return edit(id, updater, options);
          }
        );
        const failure = svc.failAgentTaskTerminally(taskId, entry, {
          errorType: "provider",
          errorMessage: "boom",
        });
        if (race === "pending-before-decision") {
          // The pending obligation counted as live: a stop record captured it and cannot release
          // (nor settle) until it is dispositioned.
          await waitForCondition(() => svc.workspaceStopRecords.has(taskId));
          expect(svc.workspaceStopRecords.get(taskId)!.pendingAdmissions.size).toBe(1);
          expect(pending!.admissionStale()).toBe(true);
          pending!.onDisposed("refused");
        }
        await failure;
        // The closure refuses the late send; with a live obligation the latch refuses it first.
        expect(raced).toEqual({
          kind: "refused",
          message:
            race === "pending-before-decision"
              ? WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE
              : TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE,
        });
        await waitForCondition(() => !taskService.isWorkspaceStopInProgress(taskId));
        expect(entryOf(config, taskId)).toMatchObject({
          taskStatus: "interrupted",
          taskAttemptId: attemptId,
          taskLaunchError: "boom",
        });
        expect(svc.attemptSettlementByTaskId.get(taskId)).toMatchObject({
          attemptId,
          attempt: owned,
          phase: "settled",
        });
        expect(svc.admittedSendsByTaskId.get(taskId)).toBeUndefined();
        expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
          kind: "terminal-no-report",
        });
      }
    );

    test.each([
      "rotated-before",
      "retired-before",
      "rotated-during",
      "retired-during",
      "clean",
    ] as const)(
      "startup compaction follow-up is fenced to the attempt rotated for this decision (%s)",
      async (variant) => {
        const taskId = "redrive-followup";
        const snapshot = "att_00000000000000a9";
        const foreign = "att_00000000000000b0";
        const claim = {
          runId: "wfr_f",
          stepId: "s",
          inputHash: "h",
          childTaskId: taskId,
          attemptId: foreign,
          mode: "no-report" as const,
          at: "2026-09-18T00:00:00.000Z",
        };
        const { config } = await setupTree([
          { id: taskId, overrides: { taskStatus: "running", taskAttemptId: snapshot } },
        ]);
        const interfere = () =>
          config.editConfig((cfg) => {
            for (const project of cfg.projects.values()) {
              const ws = project.workspaces.find((w) => w.id === taskId);
              if (!ws) continue;
              if (variant.startsWith("rotated")) ws.taskAttemptId = foreign;
              else if (variant.startsWith("retired")) ws.taskAttemptRetiredBy = claim;
            }
            return cfg;
          });
        const turn = Symbol("follow-up-turn");
        const dispatchCalls: Array<{ turnAdmission?: TurnAdmissionToken; stale?: boolean }> = [];
        const dispatchPendingCompactionFollowUp = mock(
          async (
            ...[, internal]: Parameters<WorkspaceHost["dispatchPendingCompactionFollowUp"]>
          ): Promise<Result<boolean>> => {
            if (variant.endsWith("-during")) await interfere();
            const stale = internal?.turnAdmission?.admissionStale();
            dispatchCalls.push({ turnAdmission: internal?.turnAdmission, stale });
            // The session's admission gates refuse a stale token; otherwise the follow-up's turn
            // is admitted under it.
            if (internal?.turnAdmission == null || stale === true) return Ok(false);
            internal.turnAdmission.onAdmitted(turn);
            return Ok(true);
          }
        );
        const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
          dispatchPendingCompactionFollowUp,
        });
        const { taskService } = createHarness(config, { workspaceService });
        const svc = internals(taskService);
        if (variant.endsWith("-before")) {
          // Lands after this startup's rotation is durable, before the wrapper reaches the session.
          const edit = taskService.editWorkspaceEntry.bind(taskService);
          let once = false;
          spyOn(taskService, "editWorkspaceEntry").mockImplementation(async (id, updater, opts) => {
            const result = await edit(id, updater, opts);
            if (id === taskId && !once && entryOf(config, taskId)?.taskAttemptId !== snapshot) {
              once = true;
              await interfere();
            }
            return result;
          });
        }
        await taskService.recoverInterruptedTasks();
        const row = entryOf(config, taskId)!;
        if (variant === "clean") {
          expect(dispatchCalls).toHaveLength(1);
          expect(dispatchCalls[0].turnAdmission).toBeDefined();
          expect(dispatchCalls[0].stale).toBe(false);
          // The follow-up's turn is bound to the attempt rotated here, so a Stop captures it.
          const sends = [...svc.admittedSendsByTaskId.get(taskId)!];
          expect(sends.map((s) => s.attemptId)).toEqual([row.taskAttemptId!]);
          expect(sends[0].state).toBe("admitted");
          expect(sendMessage.mock.calls.filter((call) => call[0] === taskId)).toHaveLength(0);
          return;
        }
        if (variant.endsWith("-before")) {
          // Not this decision's identity anymore: no wrapper call, no send, no obligation.
          expect(dispatchCalls).toHaveLength(0);
        } else {
          expect(dispatchCalls).toHaveLength(1);
          expect(dispatchCalls[0].stale).toBe(true);
        }
        expect(sendMessage.mock.calls.filter((call) => call[0] === taskId)).toHaveLength(0);
        expect(svc.admittedSendsByTaskId.get(taskId)).toBeUndefined();
        expect(svc.ownedAttemptByTaskId.has(taskId)).toBe(false);
        if (variant.startsWith("rotated")) expect(row.taskAttemptId).toBe(foreign);
        else expect(row.taskAttemptRetiredBy).toEqual(claim);
      }
    );

    test("a reawaken whose send fails restores `interrupted` and discharges its obligation; the owner stays unsettled until an explicit Stop settles it", async () => {
      // Deferred by the accepted plan (owned attempt interrupted without settlement evidence): the
      // witness pins the recovery contract — no dangling obligation, and a Stop proves the lineage.
      const taskId = "reawaken-send-failed";
      const { config } = await setupTree([
        {
          id: taskId,
          overrides: { taskStatus: "interrupted", taskAttemptId: "att_00000000000000c9" },
        },
      ]);
      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      shortenTerminationTimers();
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      const attemptId = entryOf(config, taskId)!.taskAttemptId!;
      // WorkspaceService binds the obligation, the send fails before a turn: the token is refused
      // and the status restored.
      const token = admitted(
        taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })
      );
      token.onDisposed("refused");
      await taskService.restoreInterruptedTaskAfterResumeFailure(taskId, "interrupted");
      expect(entryOf(config, taskId)).toMatchObject({
        taskStatus: "interrupted",
        taskAttemptId: attemptId,
      });
      expect(svc.admittedSendsByTaskId.get(taskId)).toBeUndefined();
      expect(svc.ownedAttemptByTaskId.get(taskId)?.attemptId).toBe(attemptId);
      expect((await taskService.readAttemptOutcome(taskId, requesting)).kind).toBe("indeterminate");
      // A retry rotates again; its predecessor is owned but unsettled, so the retry's lineage is
      // marked unproven (the deferred cost: no receipt can ever describe this chain)...
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      expect(entryOf(config, taskId)?.taskAttemptId).not.toBe(attemptId);
      const rotated = entryOf(config, taskId)!.taskAttemptId!;
      expect(entryOf(config, taskId)?.taskAttemptUnproven).toBe(true);
      // ...and an explicit Stop settles whatever is owned: the outcome recovers to terminal, the
      // id is closed, and the next reawaken is admitted (still marked, as the marker is inherited).
      await taskService.terminateAllDescendantAgentTasks(rootId);
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
        kind: "terminal-no-report",
      });
      expect(svc.attemptSettlementByTaskId.get(taskId)).toMatchObject({
        attemptId: rotated,
        phase: "settled",
      });
      expect(taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })).toEqual({
        kind: "refused",
        message: TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE,
      });
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      expect(svc.ownedAttemptByTaskId.get(taskId)).toMatchObject({
        source: "reawaken",
        receiptEligible: false,
      });
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

    test("a reawaken losing its CAS to a concurrent reawaken leaves the winner current; no send ever binds to an unpublished id", async () => {
      const taskId = "reawaken-concurrent";
      const previous = "att_00000000000000c1";
      const { config } = await setupTree([
        { id: taskId, overrides: { taskStatus: "interrupted", taskAttemptId: previous } },
      ]);
      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      const original = svc.evaluateAttemptLineage.bind(taskService);
      const gate = Promise.withResolvers<void>();
      let lineageCalls = 0;
      spyOn(svc, "evaluateAttemptLineage").mockImplementation(async (id, entry) => {
        // The first (losing) reawaken holds its snapshot while the second one commits.
        if (++lineageCalls === 1) await gate.promise;
        return original(id, entry);
      });
      // A manual send racing the winner's CAS: admitted against the persisted predecessor (and
      // revoked by the commit), never against an id that is not published yet.
      const edit = svc.editActiveWorkspaceEntry.bind(taskService);
      const racing: TurnAdmissionToken[] = [];
      spyOn(svc, "editActiveWorkspaceEntry").mockImplementation((...args) => {
        if (args[0] === taskId && racing.length === 0) {
          racing.push(
            admitted(taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" }))
          );
        }
        return edit(...args);
      });

      const loser = taskService.markInterruptedTaskRunning(taskId);
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      const winner = entryOf(config, taskId)!.taskAttemptId!;
      expect(winner).toMatch(ATTEMPT_ID);
      expect(winner).not.toBe(previous);
      expect(racing).toHaveLength(1);
      expect([...svc.admittedSendsByTaskId.get(taskId)!].map((s) => s.attemptId)).toEqual([
        previous,
      ]);
      expect(racing[0].admissionStale()).toBe(true);
      racing[0].onDisposed("refused");

      gate.resolve();
      expect(await loser).toBe(false);
      // The loser published nothing: config, mirror and ownership all name the winner.
      expect(entryOf(config, taskId)?.taskAttemptId).toBe(winner);
      expect(svc.currentAttemptIdByTaskId.get(taskId)).toBe(winner);
      expect(svc.ownedAttemptByTaskId.get(taskId)).toMatchObject({
        source: "reawaken",
        attemptId: winner,
      });
      const next = admitted(
        taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })
      );
      expect([...svc.admittedSendsByTaskId.get(taskId)!].map((s) => s.attemptId)).toEqual([winner]);
      expect(next.admissionStale()).toBe(false);
      next.onDisposed("no-work");
    });

    /**
     * Reawaken under a Stop race: the identity CAS, the row check and the ownership install run
     * under the global mutex that every cascade's Phase A (stop-record capture) holds too. The
     * harness pauses the reawaken INSIDE that critical section — `pause` is where the gate is held:
     * before the CAS write ("during-write") or after the fresh id is durable ("after-durable") —
     * requests a real Stop, proves it cannot capture until the owner is installed, then releases
     * and awaits the Stop to completion OUTSIDE the section.
     */
    async function reawakenUnderStopRace(
      pause: "during-write" | "after-durable",
      configure: (config: Config) => Promise<void> | void = () => undefined
    ) {
      const taskId = "reawaken-stop-race";
      const previous = "att_00000000000000b1";
      const { config } = await setupTree([
        { id: taskId, overrides: { taskStatus: "interrupted", taskAttemptId: previous } },
      ]);
      // Proven predecessor, so the chain (fresh attempt settled → next reawaken proven by this
      // process) is observable end to end.
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
      await configure(config);
      // Phase B blocks on the cleanup gate so the Stop's capture is observable before release.
      const cleanupGate = Promise.withResolvers<void>();
      const { aiService } = createAIServiceMocks(config, {
        stopStream: mock(() => cleanupGate.promise.then(() => Ok(undefined))),
      });
      const { taskService } = createHarness(config, { aiService });
      const svc = internals(taskService);
      const gate = Promise.withResolvers<void>();
      const paused = Promise.withResolvers<void>();
      let raced = false;
      const edit = svc.editActiveWorkspaceEntry.bind(taskService);
      spyOn(svc, "editActiveWorkspaceEntry").mockImplementation(async (id, updater, options) => {
        if (raced) return edit(id, updater, options);
        raced = true;
        if (pause === "during-write") {
          paused.resolve();
          await gate.promise;
          return edit(id, updater, options);
        }
        const result = await edit(id, updater, options);
        paused.resolve();
        await gate.promise;
        return result;
      });
      const reawaken = taskService.markInterruptedTaskRunning(taskId);
      await paused.promise;
      return { config, taskService, svc, taskId, previous, reawaken, gate, cleanupGate };
    }

    test.each(["during-write", "after-durable"] as const)(
      "a Stop requested while a reawaken is paused %s cannot capture before the owner installs; it then settles exactly the fresh attempt",
      async (pause) => {
        const { config, taskService, svc, taskId, previous, reawaken, gate, cleanupGate } =
          await reawakenUnderStopRace(pause);
        // Paused inside the critical section (mutex held). A real Stop starts now: its Phase A
        // blocks on the mutex, so no record exists and nothing is latched while we hold it.
        const stop = taskService.terminateAllDescendantAgentTasks(rootId);
        await settle();
        await settle();
        expect(svc.workspaceStopRecords.has(taskId)).toBe(false);
        expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(false);
        expect(svc.ownedAttemptByTaskId.has(taskId)).toBe(false);
        // "during-write": nothing is committed yet; "after-durable": the fresh id is already the
        // row's id, yet no cascade can observe it before its owner exists.
        const rowWhilePaused = entryOf(config, taskId)!;
        if (pause === "during-write") expect(rowWhilePaused.taskAttemptId).toBe(previous);
        else expect(rowWhilePaused.taskAttemptId).not.toBe(previous);

        gate.resolve();
        expect(await reawaken).toBe(true);
        const fresh = entryOf(config, taskId)!.taskAttemptId!;
        expect(fresh).toMatch(ATTEMPT_ID);
        expect(fresh).not.toBe(previous);
        // Ownership was installed before the mutex was released; only now can Phase A capture,
        // and it captures the fresh attempt OWNED.
        await waitForCondition(() => svc.workspaceStopRecords.has(taskId));
        expect(svc.workspaceStopRecords.get(taskId)).toMatchObject({
          attemptId: fresh,
          ownedAttempt: svc.ownedAttemptByTaskId.get(taskId),
        });
        expect(taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })).toEqual({
          kind: "refused",
          message: WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE,
        });

        cleanupGate.resolve();
        await stop;
        expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(false);
        expect(svc.workspaceStopRecords.has(taskId)).toBe(false);
        expect(entryOf(config, taskId)).toMatchObject({
          taskStatus: "interrupted",
          taskAttemptId: fresh,
        });
        expect(svc.attemptSettlementByTaskId.get(taskId)).toMatchObject({
          attemptId: fresh,
          phase: "settled",
          source: "stop-settled",
        });
        expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
          kind: "terminal-no-report",
        });
        expect(taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })).toEqual({
          kind: "refused",
          message: TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE,
        });
        // ...and that settlement proves the next reawaken's lineage.
        expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
        expect(svc.ownedAttemptByTaskId.get(taskId)).toMatchObject({ receiptEligible: true });
        expect(entryOf(config, taskId)?.taskAttemptUnproven).toBeUndefined();
      }
    );

    test("a send admitted in the CAS→owner gap binds to the committed id and is drained by the Stop before it releases", async () => {
      const { config, taskService, svc, taskId, reawaken, gate, cleanupGate } =
        await reawakenUnderStopRace("after-durable");
      // The fresh id is durable and visible; the fence binds a concurrent send to it (unowned —
      // nobody owns it yet) rather than refusing or binding to the predecessor.
      const fresh = entryOf(config, taskId)!.taskAttemptId!;
      const gapSend = admitted(
        taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "automatic" })
      );
      const sends = [...svc.admittedSendsByTaskId.get(taskId)!];
      expect(sends.map((s) => s.attemptId)).toEqual([fresh]);
      expect(sends[0].attempt).toBeUndefined();
      gate.resolve();
      expect(await reawaken).toBe(true);
      // Same id, now owned; the pending obligation stays valid.
      expect(gapSend.admissionStale()).toBe(false);
      // The Stop captures the pending obligation and cannot release until it is dispositioned.
      const stop = taskService.terminateAllDescendantAgentTasks(rootId);
      await waitForCondition(() => svc.workspaceStopRecords.has(taskId));
      expect(svc.workspaceStopRecords.get(taskId)!.pendingAdmissions.size).toBe(1);
      expect(gapSend.admissionStale()).toBe(true);
      await settle();
      await settle();
      expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(true);
      cleanupGate.resolve();
      await settle();
      await settle();
      // Cleanup done, yet the record still waits for the pending obligation's disposition.
      expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(true);
      gapSend.onDisposed("refused");
      await stop;
      expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(false);
      expect(svc.attemptSettlementByTaskId.get(taskId)).toMatchObject({
        attemptId: fresh,
        phase: "settled",
      });
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
        kind: "terminal-no-report",
      });
    });

    test("a Stop that completes while a reawaken is still evaluating overtakes it: refused, nothing rotated or owned; a fresh reawaken then proceeds", async () => {
      const taskId = "reawaken-overtaken";
      const previous = "att_00000000000000b2";
      const { config } = await setupTree([
        { id: taskId, overrides: { taskStatus: "interrupted", taskAttemptId: previous } },
      ]);
      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      shortenTerminationTimers();
      const original = svc.evaluateAttemptLineage.bind(taskService);
      const gate = Promise.withResolvers<void>();
      let parked = false;
      spyOn(svc, "evaluateAttemptLineage").mockImplementation(async (id, entry) => {
        if (!parked) {
          parked = true;
          await gate.promise;
        }
        return original(id, entry);
      });
      const reawaken = taskService.markInterruptedTaskRunning(taskId);
      // Outside the critical section: a real Stop runs fully to completion.
      await taskService.terminateAllDescendantAgentTasks(rootId);
      expect(svc.workspaceStopRecords.has(taskId)).toBe(false);
      gate.resolve();
      expect(await reawaken).toBe(false);
      expect(entryOf(config, taskId)).toMatchObject({
        taskStatus: "interrupted",
        taskAttemptId: previous,
      });
      expect(svc.ownedAttemptByTaskId.has(taskId)).toBe(false);
      expect(svc.currentAttemptIdByTaskId.has(taskId)).toBe(false);
      // The predecessor is closed by that Stop; a recovery initiated afterwards is a new decision.
      expect(taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })).toEqual({
        kind: "refused",
        message: TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE,
      });
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      expect(entryOf(config, taskId)?.taskAttemptId).not.toBe(previous);
    });

    test("a successor published by a writer outside the mutex after the commit is never overwritten by the delayed install", async () => {
      const { config, taskService, svc, taskId, reawaken, gate } =
        await reawakenUnderStopRace("after-durable");
      const committed = entryOf(config, taskId)!.taskAttemptId!;
      // Another writer (a reactivation under its own locks, another backend) rotates the row
      // again while the reawaken is paused after its commit.
      const successor = "att_00000000000000b3";
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const ws = project.workspaces.find((w) => w.id === taskId);
          if (ws) ws.taskAttemptId = successor;
        }
        return cfg;
      });
      gate.resolve();
      expect(await reawaken).toBe(false);
      expect(entryOf(config, taskId)?.taskAttemptId).toBe(successor);
      expect(svc.ownedAttemptByTaskId.has(taskId)).toBe(false);
      expect(svc.currentAttemptIdByTaskId.has(taskId)).toBe(false);
      expect(committed).not.toBe(successor);
      // Nothing of the successor's admission is touched: the fence binds to it, unowned.
      const token = admitted(
        taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })
      );
      expect([...svc.admittedSendsByTaskId.get(taskId)!].map((s) => s.attemptId)).toEqual([
        successor,
      ]);
      token.onDisposed("no-work");
    });

    test("a throwing CAS releases the mutex and installs no ownership", async () => {
      const taskId = "reawaken-cas-throws";
      const previous = "att_00000000000000b4";
      const { config } = await setupTree([
        { id: taskId, overrides: { taskStatus: "interrupted", taskAttemptId: previous } },
      ]);
      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      shortenTerminationTimers();
      spyOn(svc, "editActiveWorkspaceEntry").mockImplementation(() =>
        Promise.reject(new Error("registry write failed"))
      );
      const outcome = await taskService.markInterruptedTaskRunning(taskId).then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );
      expect(outcome).toBe("registry write failed");
      expect(svc.ownedAttemptByTaskId.has(taskId)).toBe(false);
      expect(svc.currentAttemptIdByTaskId.has(taskId)).toBe(false);
      expect(entryOf(config, taskId)?.taskAttemptId).toBe(previous);
      // The mutex is free again: a cascade's Phase A (which needs it) runs to completion.
      await taskService.terminateAllDescendantAgentTasks(rootId);
      expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(false);
    });

    test.each(["deleted", "unreadable"] as const)(
      "a %s registry row never revives this process's remembered id: its tokens read stale",
      async (row) => {
        const taskId = "mirror-no-revival";
        const { config } = await setupTree([
          {
            id: taskId,
            overrides: { taskStatus: "interrupted", taskAttemptId: "att_00000000000000d3" },
          },
        ]);
        const { taskService } = createHarness(config);
        const svc = internals(taskService);
        expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
        const owned = entryOf(config, taskId)!.taskAttemptId!;
        const token = admitted(
          taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })
        );
        expect(token.admissionStale()).toBe(false);
        const load =
          row === "unreadable"
            ? spyOn(config, "loadConfigOrDefault").mockImplementation(
                () =>
                  ({ projects: new Map() }) as unknown as ReturnType<Config["loadConfigOrDefault"]>
              )
            : undefined;
        try {
          if (row === "deleted") await config.removeWorkspace(taskId);
          expect(svc.currentAttemptIdByTaskId.get(taskId)).toBe(owned);
          expect(token.admissionStale()).toBe(true);
        } finally {
          load?.mockRestore();
          token.onDisposed("refused");
        }
      }
    );

    test("the fence and its tokens follow the persisted id when another writer rotated it behind this process's mirror", async () => {
      const taskId = "foreign-rotation";
      const { config } = await setupTree([
        {
          id: taskId,
          overrides: { taskStatus: "interrupted", taskAttemptId: "att_00000000000000d1" },
        },
      ]);
      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      const owned = entryOf(config, taskId)!.taskAttemptId!;
      expect(svc.currentAttemptIdByTaskId.get(taskId)).toBe(owned);
      const beforeRotation = admitted(
        taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })
      );
      expect(beforeRotation.admissionStale()).toBe(false);

      // Another process re-drives the task: its CAS rotates the persisted id while this
      // process's mirror still names the attempt it owns.
      const foreign = "att_00000000000000d2";
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const ws = project.workspaces.find((w) => w.id === taskId);
          if (ws) {
            ws.taskAttemptId = foreign;
            ws.taskAttemptUnproven = true;
          }
        }
        return cfg;
      });
      expect(svc.currentAttemptIdByTaskId.get(taskId)).toBe(owned);

      // The token of the superseded attempt is revoked; a new send binds to the persisted id,
      // unowned (this process owns a different attempt).
      expect(beforeRotation.admissionStale()).toBe(true);
      beforeRotation.onDisposed("refused");
      const afterRotation = admitted(
        taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })
      );
      const sends = [...svc.admittedSendsByTaskId.get(taskId)!];
      expect(sends).toHaveLength(1);
      expect(sends[0].attemptId).toBe(foreign);
      expect(sends[0].attempt).toBeUndefined();
      expect(afterRotation.admissionStale()).toBe(false);
      afterRotation.onDisposed("no-work");
    });

    test("a direct (unqueued) create owns its attempt as the first admission by construction; a Stop settles it", async () => {
      const spawnedId = "directchild01";
      const { config } = await setupTree([]);
      stubStableIds(config, [spawnedId]);
      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      shortenTerminationTimers();
      const created = await taskService.create({
        parentWorkspaceId: rootId,
        kind: "agent",
        agentId: "explore",
        prompt: "go",
        title: "Direct",
        isolation: "none",
      });
      expect(created).toMatchObject({
        success: true,
        data: { taskId: spawnedId, status: "running" },
      });
      const entry = entryOf(config, spawnedId);
      expect(entry?.taskAttemptId).toMatch(ATTEMPT_ID);
      expect(entry?.taskAttemptUnproven).toBeUndefined();
      expect(svc.ownedAttemptByTaskId.get(spawnedId)).toMatchObject({
        source: "launch",
        attemptId: entry!.taskAttemptId,
        receiptEligible: true,
      });
      expect(await taskService.readAttemptOutcome(spawnedId, requesting)).toEqual({
        kind: "live",
        executionId: spawnedId,
      });
      // A Stop settles the owned attempt (terminal without report) instead of only closing an
      // unowned id, and that settlement proves the next reawaken's lineage.
      await taskService.terminateAllDescendantAgentTasks(rootId);
      expect(await taskService.readAttemptOutcome(spawnedId, requesting)).toEqual({
        kind: "terminal-no-report",
      });
      expect(await taskService.markInterruptedTaskRunning(spawnedId)).toBe(true);
      expect(svc.ownedAttemptByTaskId.get(spawnedId)).toMatchObject({
        source: "reawaken",
        receiptEligible: true,
      });
      expect(entryOf(config, spawnedId)?.taskAttemptUnproven).toBeUndefined();
    });

    test.each(["pending", "admitted", "pending-outlives", "admitted-outlives"] as const)(
      "a direct create whose launch fails closes and drains its attempt and keeps the published workspace as an interrupted one (%s racing send); an owner outliving the bound defers settlement to its own end",
      async (racing) => {
        const outlives = racing.endsWith("-outlives");
        const spawnedId = {
          pending: "directfail001",
          admitted: "directfail002",
          "pending-outlives": "directfail003",
          "admitted-outlives": "directfail004",
        }[racing];
        const { config } = await setupTree([]);
        stubStableIds(config, [spawnedId]);
        shortenTerminationTimers();
        const order: string[] = [];
        const racingTurn = Symbol("racing-turn");
        let racingToken: TurnAdmissionToken | undefined;
        let liveTurn: symbol | undefined;
        const host = hostWithTurnEvents({
          sendMessage: mock((workspaceId: string) => {
            // The entry is persisted and announced, so a concurrent (user/peer) send reaches the
            // fence while the launch send is in flight and is admitted under the launch's attempt:
            // still in its own preflight (pending) or already the live turn (admitted) when the
            // launch fails.
            racingToken = admitted(
              taskService.admitTaskWorkspaceTurn(workspaceId, { acceptanceOrigin: "manual" })
            );
            if (racing.startsWith("admitted")) {
              racingToken.onAdmitted(racingTurn);
              liveTurn = racingTurn;
            }
            return Promise.resolve(Err({ type: "unknown", raw: "provider unavailable" }));
          }),
          clearQueue: mock(() => {
            order.push("clearQueue");
            // The racing send's next gate refuses it once its attempt is closed (its host disposes
            // the obligation); a pending debt settles only through that disposal. In the
            // outliving variant that host is stuck in a long preflight and gets there late.
            if (racing === "pending" && racingToken?.admissionStale() === true) {
              racingToken.onDisposed("refused");
            }
            return Ok(undefined);
          }),
          getActiveTurnGeneration: mock(() => liveTurn),
        });
        const settleRacingTurn = (workspaceId: string) => {
          const turn = liveTurn;
          if (turn == null) return;
          liveTurn = undefined;
          host.settleTurn(workspaceId, turn);
        };
        const stopStream = mock((workspaceId: string) => {
          order.push("stopStream");
          // The stopped turn settles like a real coordinator's idle transition — unless the
          // stream hangs (outliving variant), in which case only its later settlement counts.
          if (racing === "admitted") settleRacingTurn(workspaceId);
          return Promise.resolve(Ok(undefined));
        });
        const { aiService } = createAIServiceMocks(config, { stopStream });
        const { taskService } = createHarness(config, {
          aiService,
          workspaceService: host.workspaceService,
        });
        const svc = internals(taskService);
        const rollbackSpy = spyOn(svc, "rollbackFailedTaskCreate").mockImplementation(() => {
          order.push("rollback");
          return Promise.resolve();
        });
        try {
          const created = await taskService.create({
            parentWorkspaceId: rootId,
            kind: "agent",
            agentId: "explore",
            prompt: "go",
            title: "Direct",
            isolation: "none",
          });
          expect(created.success).toBe(false);
          if (created.success) throw new Error("unreachable");
          expect(created.error).toContain("provider unavailable");
          expect(racingToken).toBeDefined();
          // A pending obligation reads stale from the closure on (and a discharged one always
          // does); an admitted one belongs to its turn — captured by the stop record — until that
          // turn settles, so the still-live turn's token is the one exception.
          expect(racingToken?.admissionStale()).toBe(racing !== "admitted-outlives");
          // Whatever happens next, create released the capacity mutex: a hung owner never pins
          // task creation.
          const lock = await raceWithTimeout(taskService.acquireTaskCreationLock(), 1_000);
          await lock[Symbol.asyncDispose]();
          // The published workspace is never deleted underneath the racing send: closure and the
          // attempt's stop cascade (queue cleared, stream stopped) run, and the row stays as the
          // durable marker — interrupted with its launch error, removable like any other.
          expect(order).toEqual(["clearQueue", "stopStream"]);
          expect(rollbackSpy).not.toHaveBeenCalled();
          expect(entryOf(config, spawnedId)?.taskStatus).toBe("interrupted");
          expect(entryOf(config, spawnedId)?.taskLaunchError).toContain("provider unavailable");
          if (!outlives) {
            // The captured owners settled within the bound: record released, attempt settled.
            expect(taskService.isWorkspaceStopInProgress(spawnedId)).toBe(false);
            expect(svc.admittedSendsByTaskId.has(spawnedId)).toBe(false);
            expect(svc.attemptSettlementByTaskId.get(spawnedId)).toMatchObject({
              phase: "settled",
            });
            expect(await taskService.readAttemptOutcome(spawnedId, requesting)).toEqual({
              kind: "terminal-no-report",
            });
            return;
          }
          // The captured owner outlived the bound: NO settlement proof — the latch holds and the
          // attempt reads cleanup-pending until that owner's own settlement.
          expect(svc.attemptSettlementByTaskId.get(spawnedId)).toMatchObject({
            phase: "closing",
            source: "launch-failed",
          });
          expect((await taskService.readAttemptOutcome(spawnedId, requesting)).kind).toBe(
            "cleanup-pending"
          );
          expect(taskService.isWorkspaceStopInProgress(spawnedId)).toBe(true);
          expect(
            taskService.admitTaskWorkspaceTurn(spawnedId, { acceptanceOrigin: "manual" })
          ).toEqual({
            kind: "refused",
            message: WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE,
          });
          // Only the owner's actual settlement releases the record and settles the attempt.
          if (racing === "pending-outlives") racingToken?.onDisposed("refused");
          else settleRacingTurn(spawnedId);
          expect(taskService.isWorkspaceStopInProgress(spawnedId)).toBe(false);
          expect(svc.workspaceStopRecords.has(spawnedId)).toBe(false);
          expect(svc.attemptSettlementByTaskId.get(spawnedId)).toMatchObject({
            phase: "settled",
            source: "stop-settled",
          });
          expect(svc.admittedSendsByTaskId.has(spawnedId)).toBe(false);
          expect(await taskService.readAttemptOutcome(spawnedId, requesting)).toEqual({
            kind: "terminal-no-report",
          });
          // Deferred means deferred: the interrupted workspace remains for the user or parent to
          // remove; nothing deletes it behind their back.
          expect(rollbackSpy).not.toHaveBeenCalled();
          expect(entryOf(config, spawnedId)?.taskStatus).toBe("interrupted");
        } finally {
          rollbackSpy.mockRestore();
        }
      }
    );

    // ---------------------------------------------------------------------------------------------
    // Direct create vs. another writer (a second backend on the same root — its startup re-drive or
    // reawaken rotates the published row A → B while this launch is still in flight). The launch
    // is decided for A: it never dispatches under B, and its failure never touches B's row, queue
    // or stream; only A's own obligations are accounted for.
    // ---------------------------------------------------------------------------------------------
    const FOREIGN_ATTEMPT_ID = "att_00000000000000b2";
    /** The other backend's re-admission of the row: fresh unproven id, running (a reawaken). */
    async function rotateRowElsewhere(otherBackend: Config, workspaceId: string): Promise<void> {
      await otherBackend.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const ws = project.workspaces.find((w) => w.id === workspaceId);
          if (ws) {
            ws.taskAttemptId = FOREIGN_ATTEMPT_ID;
            ws.taskAttemptUnproven = true;
            ws.taskStatus = "running";
            delete ws.taskLaunchError;
          }
        }
        return cfg;
      });
    }

    test("a direct create whose row another writer re-admitted before the launch admission refuses to dispatch under the successor and leaves that row alone", async () => {
      const spawnedId = "directforeign1";
      const { config } = await setupTree([]);
      stubStableIds(config, [spawnedId]);
      const otherBackend = await createTestConfig(rootDir);
      const host = createWorkspaceServiceMocks();
      const { taskService } = createHarness(config, { workspaceService: host.workspaceService });
      const svc = internals(taskService);
      let mintedAttemptId: string | undefined;
      const emitOriginal = svc.emitWorkspaceMetadata.bind(taskService);
      spyOn(svc, "emitWorkspaceMetadata").mockImplementation(async (id: string) => {
        // The entry is persisted and about to be announced; the other writer's rotation lands
        // in the announcement's own await, before this launch binds its send.
        if (id === spawnedId && mintedAttemptId == null) {
          mintedAttemptId = entryOf(config, spawnedId)?.taskAttemptId;
          await rotateRowElsewhere(otherBackend, spawnedId);
        }
        return emitOriginal(id);
      });
      const rollbackSpy = spyOn(svc, "rollbackFailedTaskCreate");
      try {
        const created = await taskService.create({
          parentWorkspaceId: rootId,
          kind: "agent",
          agentId: "explore",
          prompt: "go",
          title: "Foreign",
          isolation: "none",
        });
        expect(created).toEqual(Err(SEND_ADMISSION_STALE_MESSAGE));
        expect(mintedAttemptId).toMatch(ATTEMPT_ID);
        // No prompt went out under B, and B's row is exactly as its writer left it.
        expect(host.sendMessage).not.toHaveBeenCalled();
        expect(rollbackSpy).not.toHaveBeenCalled();
        expect(entryOf(config, spawnedId)).toMatchObject({
          taskStatus: "running",
          taskAttemptId: FOREIGN_ATTEMPT_ID,
        });
        expect(entryOf(config, spawnedId)?.taskLaunchError).toBeUndefined();
        expect(taskService.isWorkspaceStopInProgress(spawnedId)).toBe(false);
        expect(svc.workspaceStopRecords.has(spawnedId)).toBe(false);
        // This process still owns A; idle under it, the launch failure settles exactly A.
        expect(svc.ownedAttemptByTaskId.get(spawnedId)?.attemptId).toBe(mintedAttemptId);
        expect(svc.attemptSettlementByTaskId.get(spawnedId)).toMatchObject({
          attemptId: mintedAttemptId,
          phase: "settled",
          source: "launch-failed",
        });
        // B's row stays open to its own writer's sends (bound unowned here).
        expect(
          taskService.admitTaskWorkspaceTurn(spawnedId, { acceptanceOrigin: "manual" }).kind
        ).toBe("admitted");
      } finally {
        rollbackSpy.mockRestore();
      }
    });

    test.each([
      ["before the marker's CAS", "idle"],
      ["before the marker's CAS", "live"],
      ["after the marker committed", "idle"],
      ["after the marker committed", "live"],
    ] as const)(
      "a direct launch failure whose row another writer re-admitted %s (A %s) writes no marker, stops nothing and settles A only when nothing runs under it",
      async (rotateAt, liveness) => {
        const spawnedId = rotateAt.startsWith("before")
          ? liveness === "idle"
            ? "directforeign2"
            : "directforeign3"
          : liveness === "idle"
            ? "directforeign4"
            : "directforeign5";
        const { config } = await setupTree([]);
        stubStableIds(config, [spawnedId]);
        const otherBackend = await createTestConfig(rootDir);
        let racingToken: TurnAdmissionToken | undefined;
        let launchSendFailed = false;
        const host = createWorkspaceServiceMocks({
          sendMessage: mock((workspaceId: string) => {
            if (liveness === "live") {
              // A user send admitted under A while the launch send is in flight (still in its
              // own preflight when the launch fails).
              racingToken = admitted(
                taskService.admitTaskWorkspaceTurn(workspaceId, { acceptanceOrigin: "manual" })
              );
            }
            launchSendFailed = true;
            return Promise.resolve(Err({ type: "unknown", raw: "provider unavailable" }));
          }),
        });
        const stopStream = mock(() => Promise.resolve(Ok(undefined)));
        const { aiService } = createAIServiceMocks(config, { stopStream });
        const { taskService } = createHarness(config, {
          aiService,
          workspaceService: host.workspaceService,
        });
        const svc = internals(taskService);
        let mintedAttemptId: string | undefined;
        let rotated = false;
        const editOriginal = taskService.editWorkspaceEntry.bind(taskService);
        spyOn(taskService, "editWorkspaceEntry").mockImplementation(async (...args) => {
          const [id] = args;
          // The launch failure's marker write is the first edit of this row after the send failed.
          if (id !== spawnedId || !launchSendFailed || rotated) return editOriginal(...args);
          rotated = true;
          mintedAttemptId = entryOf(config, spawnedId)?.taskAttemptId;
          if (rotateAt.startsWith("before")) {
            await rotateRowElsewhere(otherBackend, spawnedId);
            return editOriginal(...args);
          }
          const result = await editOriginal(...args);
          expect(entryOf(config, spawnedId)?.taskStatus).toBe("interrupted");
          await rotateRowElsewhere(otherBackend, spawnedId);
          return result;
        });
        const rollbackSpy = spyOn(svc, "rollbackFailedTaskCreate");
        try {
          const created = await taskService.create({
            parentWorkspaceId: rootId,
            kind: "agent",
            agentId: "explore",
            prompt: "go",
            title: "Foreign",
            isolation: "none",
          });
          expect(created.success).toBe(false);
          if (created.success) throw new Error("unreachable");
          expect(created.error).toContain("provider unavailable");
          expect(rotated).toBe(true);
          expect(mintedAttemptId).toMatch(ATTEMPT_ID);
          // B's row is its writer's: no marker of ours, no deletion, no latch, no stop record.
          expect(rollbackSpy).not.toHaveBeenCalled();
          expect(host.clearQueue).not.toHaveBeenCalled();
          expect(stopStream).not.toHaveBeenCalled();
          expect(entryOf(config, spawnedId)).toMatchObject({
            taskStatus: "running",
            taskAttemptId: FOREIGN_ATTEMPT_ID,
          });
          expect(entryOf(config, spawnedId)?.taskLaunchError).toBeUndefined();
          expect(taskService.isWorkspaceStopInProgress(spawnedId)).toBe(false);
          expect(svc.workspaceStopRecords.has(spawnedId)).toBe(false);
          expect(svc.ownedAttemptByTaskId.get(spawnedId)?.attemptId).toBe(mintedAttemptId);
          if (liveness === "idle") {
            expect(svc.attemptSettlementByTaskId.get(spawnedId)).toMatchObject({
              attemptId: mintedAttemptId,
              phase: "settled",
              source: "launch-failed",
            });
            return;
          }
          // A's own obligation is still in its preflight: no settlement proof is minted for it;
          // it reads stale (the row no longer names A) and settles through its own disposal —
          // which still proves nothing about A as a whole (no owner watches a superseded attempt).
          expect(racingToken?.admissionStale()).toBe(true);
          expect(svc.attemptSettlementByTaskId.get(spawnedId)).toMatchObject({
            attemptId: mintedAttemptId,
            phase: "closing",
            source: "launch-failed",
          });
          racingToken?.onDisposed("refused");
          expect(svc.admittedSendsByTaskId.has(spawnedId)).toBe(false);
          expect(svc.attemptSettlementByTaskId.get(spawnedId)).toMatchObject({
            phase: "closing",
          });
          expect(entryOf(config, spawnedId)).toMatchObject({
            taskStatus: "running",
            taskAttemptId: FOREIGN_ATTEMPT_ID,
          });
        } finally {
          rollbackSpy.mockRestore();
        }
      }
    );

    test("a direct launch failure whose row another writer re-admits during its stop cascade finishes settling A and leaves B's row alone", async () => {
      const spawnedId = "directforeign6";
      const { config } = await setupTree([]);
      stubStableIds(config, [spawnedId]);
      shortenTerminationTimers();
      const otherBackend = await createTestConfig(rootDir);
      const racingTurn = Symbol("racing-turn");
      let racingToken: TurnAdmissionToken | undefined;
      let liveTurn: symbol | undefined;
      const host = hostWithTurnEvents({
        sendMessage: mock((workspaceId: string) => {
          // A user send admitted under A is already the live turn when the launch fails.
          racingToken = admitted(
            taskService.admitTaskWorkspaceTurn(workspaceId, { acceptanceOrigin: "manual" })
          );
          racingToken.onAdmitted(racingTurn);
          liveTurn = racingTurn;
          return Promise.resolve(Err({ type: "unknown", raw: "provider unavailable" }));
        }),
        getActiveTurnGeneration: mock(() => liveTurn),
      });
      // Phase B targets A's captured turn; the other writer's rotation lands in this very await
      // and the stopped turn hangs past the bound (the cleanup wait is abandoned at the shortened
      // deadline, so the rotation is awaited explicitly below before the row is read).
      const rotation = Promise.withResolvers<void>();
      const stopStream = mock(async () => {
        await rotateRowElsewhere(otherBackend, spawnedId);
        rotation.resolve();
        return Ok(undefined);
      });
      const { aiService } = createAIServiceMocks(config, { stopStream });
      const { taskService } = createHarness(config, {
        aiService,
        workspaceService: host.workspaceService,
      });
      const svc = internals(taskService);
      const rollbackSpy = spyOn(svc, "rollbackFailedTaskCreate");
      try {
        const created = await taskService.create({
          parentWorkspaceId: rootId,
          kind: "agent",
          agentId: "explore",
          prompt: "go",
          title: "Foreign",
          isolation: "none",
        });
        expect(created.success).toBe(false);
        expect(stopStream).toHaveBeenCalledTimes(1);
        await raceWithTimeout(rotation.promise, 5_000);
        const mintedAttemptId = svc.ownedAttemptByTaskId.get(spawnedId)?.attemptId;
        expect(mintedAttemptId).toMatch(ATTEMPT_ID);
        // The captured owner outlived the bound: the latch holds for A's turn, and B's row —
        // written after our marker — is untouched (no deletion, no second marker).
        expect(rollbackSpy).not.toHaveBeenCalled();
        expect(svc.workspaceStopRecords.get(spawnedId)).toMatchObject({
          attemptId: mintedAttemptId,
        });
        expect(entryOf(config, spawnedId)).toMatchObject({
          taskStatus: "running",
          taskAttemptId: FOREIGN_ATTEMPT_ID,
        });
        expect(svc.attemptSettlementByTaskId.get(spawnedId)).toMatchObject({
          attemptId: mintedAttemptId,
          phase: "closing",
          source: "launch-failed",
        });
        // Only A's turn settling releases the record and settles A; B's row stays as it was.
        liveTurn = undefined;
        host.settleTurn(spawnedId, racingTurn);
        expect(taskService.isWorkspaceStopInProgress(spawnedId)).toBe(false);
        expect(svc.workspaceStopRecords.has(spawnedId)).toBe(false);
        expect(svc.attemptSettlementByTaskId.get(spawnedId)).toMatchObject({
          attemptId: mintedAttemptId,
          phase: "settled",
          source: "stop-settled",
        });
        expect(rollbackSpy).not.toHaveBeenCalled();
        expect(entryOf(config, spawnedId)).toMatchObject({
          taskStatus: "running",
          taskAttemptId: FOREIGN_ATTEMPT_ID,
        });
      } finally {
        rollbackSpy.mockRestore();
      }
    });

    test.each(["id", "status"] as const)(
      "startup re-drive refuses to overwrite a row whose %s moved after the recovery snapshot",
      async (moved) => {
        const taskId = "redrive-moved";
        const snapshot = "att_00000000000000e1";
        const foreign = "att_00000000000000e2";
        const { config } = await setupTree([
          { id: taskId, overrides: { taskStatus: "running", taskAttemptId: snapshot } },
        ]);
        const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
        const { taskService } = createHarness(config, { workspaceService });
        const svc = internals(taskService);
        const moveRow = () =>
          config.editConfig((cfg) => {
            for (const project of cfg.projects.values()) {
              const ws = project.workspaces.find((w) => w.id === taskId);
              if (!ws) continue;
              // Another process admitted the task (id) or stopped it (status) meanwhile.
              if (moved === "id") ws.taskAttemptId = foreign;
              else ws.taskStatus = "interrupted";
            }
            return cfg;
          });
        if (moved === "id") {
          // Lands during the recovery awaits that precede the rotation.
          const admit = svc.admitTaskDesktopRecovery.bind(taskService);
          spyOn(svc, "admitTaskDesktopRecovery").mockImplementation(async (id) => {
            await moveRow();
            return admit(id);
          });
        } else {
          // Lands between the dispatcher's status re-read and the rotating CAS.
          const edit = taskService.editWorkspaceEntry.bind(taskService);
          spyOn(taskService, "editWorkspaceEntry").mockImplementation(async (...args) => {
            if (args[0] === taskId) await moveRow();
            return edit(...args);
          });
        }
        await taskService.recoverInterruptedTasks();
        const entry = entryOf(config, taskId);
        expect(entry?.taskAttemptId).toBe(moved === "id" ? foreign : snapshot);
        expect(entry?.taskStatus).toBe(moved === "id" ? "running" : "interrupted");
        expect(entry?.taskAttemptUnproven).toBeUndefined();
        expect(sendMessage.mock.calls.filter((call) => call[0] === taskId)).toHaveLength(0);
        expect(svc.currentAttemptIdByTaskId.has(taskId)).toBe(false);
      }
    );

    test("a settlement receipt naming another parent proves nothing", async () => {
      const taskId = "reawaken-wrong-parent";
      const attemptId = "att_00000000000000f9";
      const { config } = await setupTree([
        { id: taskId, overrides: { taskStatus: "interrupted", taskAttemptId: attemptId } },
      ]);
      // The parent's expected path holds a receipt copied from another parent's session dir.
      expect(
        (
          await writeSubagentAttemptSettlementReceipt({
            ownerWorkspaceSessionDirs: [path.join(config.sessionsDir, rootId)],
            receipt: {
              taskId,
              attemptId,
              parentWorkspaceId: "another-parent",
              source: "idle-settled",
              settledAt: "2026-09-18T00:00:00.000Z",
            },
          })
        ).success
      ).toBe(true);
      const { taskService } = createHarness(config);
      const svc = internals(taskService);
      expect((await svc.evaluateAttemptLineage(taskId, entryOf(config, taskId)!)).proven).toBe(
        false
      );
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      expect(svc.ownedAttemptByTaskId.get(taskId)?.receiptEligible).toBe(false);
      expect(entryOf(config, taskId)?.taskAttemptUnproven).toBe(true);
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
      svc.closeAttemptAdmission(owned, attemptId, undefined, "test");
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

    test("a parent Stop cascade settles a reactivation-owned continuation: the captured execution is interrupted and the latch drops once its turn settles", async () => {
      // Remote UAT (round 3, criterion 6): a parent hard Stop landing on a child reawakened via
      // task_send_message (reactivation → WorkspaceTurnManager continuation) held the child's stop
      // latch until restart. The cascade's stream stop is a "system" abort, which never settles a
      // live continuation handle, so the record's captured execution never read settled.
      const taskId = "cascade-reactivated";
      const { config } = await setupTree([
        {
          id: taskId,
          overrides: { taskStatus: "interrupted", taskAttemptId: "att_0000000000000901" },
        },
      ]);
      const turn = Symbol("reactivated-turn");
      let activeTurn: symbol | undefined;
      const harness: { taskService?: TaskService } = {};
      const stopStream = mock(
        (_id: string): Promise<Result<void>> => Promise.resolve(Ok(undefined))
      );
      const { aiService } = createAIServiceMocks(config, { stopStream });
      const host = hostWithTurnEvents({
        getActiveTurnGeneration: mock(() => activeTurn),
        // The real WorkspaceService accepts the continuation prompt (live handle → running
        // mirror), mints the task-attempt obligation at its handoff and reports the admitted
        // streaming generation; the fake host does the same for the reactivation send.
        sendMessage: mock(
          async (
            ...args: Parameters<WorkspaceHost["sendMessage"]>
          ): ReturnType<WorkspaceHost["sendMessage"]> => {
            await args[3]?.onAccepted?.();
            const token = admitted(
              harness.taskService!.admitTaskWorkspaceTurn(args[0], {
                acceptanceOrigin: "automatic",
              })
            );
            token.onAdmitted(turn);
            activeTurn = turn;
            return Ok(undefined);
          }
        ),
      });
      const { taskService } = createHarness(config, {
        aiService,
        workspaceService: host.workspaceService,
      });
      harness.taskService = taskService;
      const svc = internals(taskService);
      shortenTerminationTimers();

      const reactivated = await taskService.sendMessageToDescendantAgentTask(
        rootId,
        taskId,
        "continue",
        "tool-end"
      );
      expect(reactivated).toMatchObject({ success: true, data: { delivery: "reactivated" } });
      expect(svc.ownedAttemptByTaskId.get(taskId)?.source).toBe("reactivation");
      const reactivatedEntry = entryOf(config, taskId);
      const handleId = reactivatedEntry?.taskExecutionId;
      expect(handleId).toMatch(/^wst_/);
      expect(reactivatedEntry?.taskExecutionStatus).toBe("running");

      await taskService.terminateAllDescendantAgentTasks(rootId);
      const record = svc.workspaceStopRecords.get(taskId)!;
      expect(record.capturedExecutionId).toBe(handleId);
      // The shortened deadlines let the cascade return while its cleanup (handle interrupt +
      // stream stop) is still in flight; ownership stays with that cleanup, so wait for it.
      await waitForCondition(() => record.cleanupInFlight === 0);
      // The cascade itself settles the execution it captured: handle + mirror read interrupted
      // and the live registration is gone, so the stop is admission-visible.
      expect(entryOf(config, taskId)).toMatchObject({
        taskExecutionId: handleId,
        taskExecutionStatus: "interrupted",
      });
      expect(record.executionSettled).toBe(true);
      // Only the streaming generation is still owed; its settlement releases the latch.
      expect(record.capturedTurns.has(turn)).toBe(true);
      expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(true);
      activeTurn = undefined;
      host.settleTurn(taskId, turn);
      await settle();
      expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(false);
      expect(svc.admittedSendsByTaskId.get(taskId)).toBeUndefined();
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
        kind: "terminal-no-report",
      });
      // The stop is not permanent: a later reawaken mints a fresh id and is admitted again.
      expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
      const fresh = taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" });
      expect(fresh.kind).toBe("admitted");
      if (fresh.kind === "admitted") fresh.token.onDisposed("no-work");
    });

    test("a Stop requested while a reactivation is paused after its commit cannot capture before the owner installs; a reactivation during a Stop is refused before publishing", async () => {
      const taskId = "reactivation-stop-race";
      const previous = "att_0000000000000902";
      const { config } = await setupTree([
        { id: taskId, overrides: { taskStatus: "interrupted", taskAttemptId: previous } },
      ]);
      const cleanupGate = Promise.withResolvers<void>();
      const { aiService } = createAIServiceMocks(config, {
        stopStream: mock(() => cleanupGate.promise.then(() => Ok(undefined))),
      });
      // The real WorkspaceService fences the continuation send at its handoff; the fake host does
      // the same so a send refused by the cascade's latch fails createWorkspaceTurn as in product.
      const harness: { taskService?: TaskService } = {};
      const { workspaceService } = createWorkspaceServiceMocks({
        sendMessage: mock(
          async (
            ...args: Parameters<WorkspaceHost["sendMessage"]>
          ): ReturnType<WorkspaceHost["sendMessage"]> => {
            const admission = harness.taskService!.admitTaskWorkspaceTurn(args[0], {
              acceptanceOrigin: "automatic",
            });
            if (admission.kind === "refused") {
              return Err({ type: "unknown", raw: admission.message });
            }
            if (admission.kind === "admitted") admission.token.onDisposed("no-work");
            await args[3]?.onAccepted?.();
            return Ok(undefined);
          }
        ),
      });
      const { taskService } = createHarness(config, { aiService, workspaceService });
      harness.taskService = taskService;
      const svc = internals(taskService);
      // Pause the reactivation inside its critical section, right after its commit is durable.
      const gate = Promise.withResolvers<void>();
      const paused = Promise.withResolvers<void>();
      let raced = false;
      const edit = taskService.editWorkspaceEntry.bind(taskService);
      spyOn(taskService, "editWorkspaceEntry").mockImplementation(async (id, updater, options) => {
        const result = await edit(id, updater, options);
        if (id === taskId && !raced && entryOf(config, taskId)?.taskAttemptId !== previous) {
          raced = true;
          paused.resolve();
          await gate.promise;
        }
        return result;
      });
      const reactivation = taskService.sendMessageToDescendantAgentTask(
        rootId,
        taskId,
        "continue",
        "tool-end"
      );
      await paused.promise;
      const fresh = entryOf(config, taskId)!.taskAttemptId!;
      expect(fresh).not.toBe(previous);
      const stop = taskService.terminateAllDescendantAgentTasks(rootId);
      await settle();
      await settle();
      // Phase A blocks on the mutex: nothing captured, nothing latched, no owner yet.
      expect(svc.workspaceStopRecords.has(taskId)).toBe(false);
      expect(svc.ownedAttemptByTaskId.has(taskId)).toBe(false);
      gate.resolve();
      // createWorkspaceTurn runs after the section, behind the cascade's Phase A in the mutex
      // queue: its send meets the latch, so the reactivation fails after publishing — and the
      // attempt it published is owned and captured owned by the cascade.
      expect(await reactivation).toMatchObject({
        success: false,
        error: { code: "send_failed" },
      });
      await waitForCondition(() => svc.workspaceStopRecords.has(taskId));
      expect(svc.workspaceStopRecords.get(taskId)).toMatchObject({
        attemptId: fresh,
        ownedAttempt: svc.ownedAttemptByTaskId.get(taskId),
      });
      expect(svc.ownedAttemptByTaskId.get(taskId)?.source).toBe("reactivation");
      cleanupGate.resolve();
      await stop;
      await waitForCondition(() => !taskService.isWorkspaceStopInProgress(taskId));
      expect(svc.attemptSettlementByTaskId.get(taskId)).toMatchObject({
        attemptId: fresh,
        phase: "settled",
        source: "stop-settled",
      });
      expect(await taskService.readAttemptOutcome(taskId, requesting)).toEqual({
        kind: "terminal-no-report",
      });
    });

    test("a reactivation while a Stop is in progress is refused before it publishes an attempt", async () => {
      const taskId = "reactivation-during-stop";
      const previous = "att_0000000000000903";
      const { config } = await setupTree([
        { id: taskId, overrides: { taskStatus: "interrupted", taskAttemptId: previous } },
      ]);
      const cleanupGate = Promise.withResolvers<void>();
      const { aiService } = createAIServiceMocks(config, {
        stopStream: mock(() => cleanupGate.promise.then(() => Ok(undefined))),
      });
      const { taskService } = createHarness(config, { aiService });
      const svc = internals(taskService);
      const stop = taskService.terminateAllDescendantAgentTasks(rootId);
      await waitForCondition(() => svc.workspaceStopRecords.has(taskId));
      expect(
        await taskService.sendMessageToDescendantAgentTask(rootId, taskId, "again", "tool-end")
      ).toEqual({
        success: false,
        error: { code: "send_failed", message: WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE },
      });
      // Nothing published: the cascade's record still names the predecessor it captured.
      expect(entryOf(config, taskId)?.taskAttemptId).toBe(previous);
      expect(svc.ownedAttemptByTaskId.has(taskId)).toBe(false);
      expect(svc.workspaceStopRecords.get(taskId)?.attemptId).toBe(previous);
      cleanupGate.resolve();
      await stop;
      // Once settled, a reactivation proceeds under a fresh id.
      expect(
        await taskService.sendMessageToDescendantAgentTask(rootId, taskId, "again", "tool-end")
      ).toMatchObject({ success: true, data: { delivery: "reactivated" } });
      expect(entryOf(config, taskId)?.taskAttemptId).not.toBe(previous);
    });

    test.each([undefined, "not-an-attempt-id"])(
      "a retired task refuses sends even when its attempt id is %p",
      async (taskAttemptId) => {
        const taskId = "retired-partial-state";
        const claim = {
          runId: "wfr_9",
          stepId: "s",
          inputHash: "h",
          childTaskId: taskId,
          attemptId: "att_0000000000000901",
          mode: "no-report" as const,
          at: "2026-09-18T00:00:00.000Z",
        };
        const { config } = await setupTree([
          {
            id: taskId,
            overrides: { taskStatus: "interrupted", taskAttemptId, taskAttemptRetiredBy: claim },
          },
        ]);
        const { taskService } = createHarness(config);
        expect(taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" })).toEqual({
          kind: "refused",
          message: retiredAttemptMessage(claim),
        });
        expect(internals(taskService).admittedSendsByTaskId.has(taskId)).toBe(false);
      }
    );

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

  // ---------------------------------------------------------------------------------------------
  // Startup re-drive of an awaiting_report task against the REAL host (WorkspaceService +
  // AgentSession + MessageQueue; only the AI stream is mocked): the completion prompt is decided
  // for the attempt the re-drive rotated (R) and must never dispatch bound to an attempt another
  // writer admitted during the prompt helper's own awaits (R → B).
  // ---------------------------------------------------------------------------------------------
  describe("startup completion prompt fence (real host)", () => {
    test.each(["re-admitted by another writer during the prompt's awaits", "untouched"] as const)(
      "the awaiting_report re-drive's completion prompt binds only to the attempt it rotated (row %s)",
      async (row) => {
        const rotatedElsewhere = row !== "untouched";
        const taskId = rotatedElsewhere ? "redriveforeign1" : "redriveforeign2";
        const initialAttemptId = "att_00000000000000a3";
        const foreignAttemptId = "att_00000000000000b3";
        const { config } = await setupTree([
          {
            id: taskId,
            overrides: { taskStatus: "awaiting_report", taskAttemptId: initialAttemptId },
            inProjectDir: true,
          },
        ]);
        const otherBackend = await createTestConfig(rootDir);
        const historyService = new HistoryService(config);
        const aiEmitter = new EventEmitter();
        const completions: Array<ReturnType<typeof Promise.withResolvers<TurnCompletion>>> = [];
        const streamStarts: Array<Array<{ attemptId: string; state: string; owned: boolean }>> = [];
        // Filled once the TaskService exists; the stream mock below reads it at stream start.
        const ledger: { svc?: Internals } = {};
        const sessionHarness = await createAgentSessionHarness({
          workspaceId: taskId,
          config,
          historyService,
          aiEmitter,
          aiServiceOverrides: {
            isStreaming: () => completions.length > 0,
            getWorkspaceMetadata: mock(async (workspaceId: string) => {
              const all = await config.getAllWorkspaceMetadata();
              const found = all.find((m) => m.id === workspaceId);
              return found ? Ok(found) : Err("not found");
            }),
            streamMessage: mock(() => {
              const completion = Promise.withResolvers<TurnCompletion>();
              completions.push(completion);
              const messageId = `assistant-${completions.length}`;
              // Which obligations (and whose) the stream starts under.
              streamStarts.push(
                [...(ledger.svc?.admittedSendsByTaskId.get(taskId) ?? [])].map((send) => ({
                  attemptId: send.attemptId,
                  state: send.state,
                  owned: ledger.svc?.ownedAttemptByTaskId.get(taskId)?.attemptId === send.attemptId,
                }))
              );
              aiEmitter.emit("stream-start", {
                type: "stream-start",
                workspaceId: taskId,
                messageId,
                model: "openai:gpt-5.2",
                startTime: Date.now(),
              });
              return Promise.resolve(Ok({ messageId, completion: completion.promise }));
            }),
            stopStream: mock(() => {
              completions.at(-1)?.resolve({ status: "aborted", abortReason: "user" });
              return Promise.resolve(Ok(undefined));
            }),
          },
        });
        const backgroundProcessManager = Object.assign(new EventEmitter(), {
          cleanup: mock(() => Promise.resolve()),
          hasRunningBackgroundProcesses: mock(() => false),
          hasOrphanedRunningBackgroundProcesses: mock(() => Promise.resolve(false)),
          setMessageQueued: mock(() => undefined),
        }) as unknown as BackgroundProcessManager;
        const initStateManager = {
          on: mock(() => undefined),
          off: mock(() => undefined),
          getInitState: mock(() => undefined),
          waitForInit: mock(() => Promise.resolve()),
          clearInMemoryState: mock(() => undefined),
        } as unknown as InitStateManager;
        const aiService = sessionHarness.aiService as unknown as AIService;
        const workspaceService = new WorkspaceService(
          config,
          historyService,
          aiService,
          new ContextManagementService({ config, historyService, aiService }),
          initStateManager,
          new ExtensionMetadataService(path.join(config.rootDir, "fence-extension-metadata.json")),
          backgroundProcessManager
        );
        (workspaceService as unknown as { sessions: Map<string, unknown> }).sessions.set(
          taskId,
          sessionHarness.session
        );
        const { taskService } = createHarness(config, {
          aiService,
          workspaceService: workspaceService as unknown as WorkspaceHost,
        });
        const svc = internals(taskService);
        ledger.svc = svc;
        workspaceService.setAgentTaskIntegration(
          taskService as unknown as Parameters<WorkspaceService["setAgentTaskIntegration"]>[0]
        );
        let rotatedAttemptId: string | undefined;
        let rotatedForeign = false;
        const editOriginal = taskService.editWorkspaceEntry.bind(taskService);
        spyOn(taskService, "editWorkspaceEntry").mockImplementation(async (...args) => {
          const [id] = args;
          if (id === taskId) {
            const current = entryOf(config, taskId)?.taskAttemptId;
            if (rotatedAttemptId == null && current === initialAttemptId) {
              // The re-drive's own CAS (rotateAttemptForStartupRedrive): let it commit, note R.
              const result = await editOriginal(...args);
              rotatedAttemptId = entryOf(config, taskId)?.taskAttemptId;
              return result;
            }
            if (rotatedElsewhere && !rotatedForeign && rotatedAttemptId != null) {
              // The prompt helper's first owned write after the rotation (its recovery-budget
              // charge) is where the other backend's admission of the same row lands first.
              rotatedForeign = true;
              await otherBackend.editConfig((cfg) => {
                for (const project of cfg.projects.values()) {
                  const ws = project.workspaces.find((w) => w.id === taskId);
                  if (ws) {
                    ws.taskAttemptId = foreignAttemptId;
                    ws.taskAttemptUnproven = true;
                  }
                }
                return cfg;
              });
            }
          }
          return editOriginal(...args);
        });
        try {
          await taskService.recoverInterruptedTasks();
          expect(rotatedAttemptId).toMatch(ATTEMPT_ID);
          expect(rotatedAttemptId).not.toBe(initialAttemptId);
          if (rotatedElsewhere) {
            expect(rotatedForeign).toBe(true);
            // No prompt reached the stream, nothing is bound to B, R's obligation was disposed
            // at the refusal, and B's row (budget included) is exactly as its writer left it.
            expect(streamStarts).toHaveLength(0);
            expect(svc.admittedSendsByTaskId.has(taskId)).toBe(false);
            expect(entryOf(config, taskId)).toMatchObject({
              taskStatus: "awaiting_report",
              taskAttemptId: foreignAttemptId,
              taskAttemptUnproven: true,
            });
            expect(entryOf(config, taskId)?.taskRecoveryAttempts).toBeUndefined();
            expect(completions).toHaveLength(0);
            return;
          }
          // Control: the prompt is issued exactly once, admitted under R (unowned: a re-drive is
          // never this process's attempt), and the budget was charged to R's row.
          await waitForCondition(() => streamStarts.length === 1);
          expect(streamStarts[0]).toEqual([
            { attemptId: rotatedAttemptId!, state: "admitted", owned: false },
          ]);
          expect(entryOf(config, taskId)).toMatchObject({
            taskStatus: "awaiting_report",
            taskAttemptId: rotatedAttemptId,
            taskRecoveryAttempts: 1,
          });
        } finally {
          for (const completion of completions) {
            completion.resolve({ status: "aborted", abortReason: "user" });
          }
          await sessionHarness.session.dispose();
          await sessionHarness.cleanup();
        }
      },
      20_000
    );
  });
});
