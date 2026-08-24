import { describe, expect, test, mock, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { WorkspaceService, generateForkBranchName, generateForkTitle } from "./workspaceService";
import type { IdleCompactionOutcome } from "./idleCompactionService";
import type { AgentSession } from "./agentSession";
import { createAgentSessionHarness } from "./agentSession.testHarness";
import type { AutoCompactionUsageState } from "@/common/utils/compaction/autoCompactionCheck";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { askUserQuestionManager } from "./askUserQuestionManager";
import { WorkspaceLifecycleHooks } from "./workspaceLifecycleHooks";
import { EventEmitter } from "events";
import { existsSync } from "fs";
import * as fsPromises from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { Err, Ok, type Result } from "@/common/types/result";
import { SCRATCH_PROJECT_CONFIG_KEY } from "@/common/constants/scratch";
import type { SendMessageError } from "@/common/types/errors";
import type { ProjectsConfig } from "@/common/types/project";
import type { Config } from "@/node/config";
import type { HistoryService } from "./historyService";
import { createTestHistoryService } from "./testHistoryService";
import type { SessionTimingService } from "./sessionTimingService";
import { SessionUsageService } from "./sessionUsageService";
import type { AIService } from "./aiService";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ExperimentsService } from "./experimentsService";
import {
  awaitPendingBranchSummary,
  startAbandonedBranchSummaryInBackground,
  type BranchSummaryAiService,
} from "./branchSummary";
import type { InitStateManager, InitStatus } from "./initStateManager";
import {
  ExtensionMetadataService,
  type ExtensionMetadataStreamingUpdate,
} from "./ExtensionMetadataService";
import type {
  FrontendWorkspaceMetadata,
  WorkspaceActivitySnapshot,
  WorkspaceMetadata,
} from "@/common/types/workspace";
import type { TaskService } from "./taskService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import { BashMonitorRegistryStore } from "./bashMonitorRegistryStore";
import { BashMonitorWakeStore, buildBashMonitorWakeMetadata } from "./bashMonitorWakeStore";
import type { TerminalService } from "@/node/services/terminalService";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import type { WorktreeArchiveSnapshot } from "@/common/schemas/project";
import type { BashToolResult } from "@/common/types/tools";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { createMuxMessage } from "@/common/types/message";
import { buildStagedAttachmentNotice } from "@/browser/features/ChatInput/stagedAttachments";
import {
  WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE,
  WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE,
} from "@/common/utils/workflowRunMessages";
import { getPlanFilePath } from "@/common/utils/planStorage";
import * as todoStorageModule from "@/node/services/todos/todoStorage";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as bashToolModule from "@/node/services/tools/bash";
import * as forkOrchestratorModule from "@/node/services/utils/forkOrchestrator";
import * as runtimeExecHelpers from "@/node/utils/runtime/helpers";
import * as removeManagedGitWorktreeModule from "@/node/worktree/removeManagedGitWorktree";
import * as workspaceTitleGenerator from "./workspaceTitleGenerator";
import { WorkflowRunStore } from "./workflows/WorkflowRunStore";
import { WorkspaceGoalService } from "./workspaceGoalService";
import { IdleDispatcher } from "./idleDispatcher";
import type { GoalRecordV1 } from "@/common/types/goal";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import {
  hasBudgetedResumableGoal,
  modelHasPricingData,
  UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
} from "@/common/utils/goals/budgetPricing";
// Shared `drainPendingDispatches` + `waitForCondition` helpers live in
// `./testDispatchHelpers` (Coder-agents-review P3 DEREM-41 + nit DEREM-48 +
// nit DEREM-50) — import instead of defining local copies.
import { drainPendingDispatches, waitForCondition } from "./testDispatchHelpers";
import { sandboxHostService } from "./sandbox/sandboxHostService";

// Helper to access private renamingWorkspaces set
function addToRenamingWorkspaces(service: WorkspaceService, workspaceId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  (service as any).renamingWorkspaces.add(workspaceId);
}

// Helper to access private archivingWorkspaces set
function addToArchivingWorkspaces(service: WorkspaceService, workspaceId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  (service as any).archivingWorkspaces.add(workspaceId);
}

async function withTempMuxRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const originalMuxRoot = process.env.MUX_ROOT;
  const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-plan-"));
  process.env.MUX_ROOT = tempRoot;

  try {
    return await fn(tempRoot);
  } finally {
    if (originalMuxRoot === undefined) {
      delete process.env.MUX_ROOT;
    } else {
      process.env.MUX_ROOT = originalMuxRoot;
    }
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
}

async function writePlanFile(
  root: string,
  projectName: string,
  workspaceName: string
): Promise<string> {
  const planFile = getPlanFilePath(workspaceName, projectName, root);
  await fsPromises.mkdir(path.dirname(planFile), { recursive: true });
  await fsPromises.writeFile(planFile, "# Plan\n");
  return planFile;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// NOTE: This test file uses bun:test mocks (not Jest).

const mockInitStateManager: Partial<InitStateManager> = {
  on: mock(() => undefined as unknown as InitStateManager),
  off: mock(() => undefined as unknown as InitStateManager),
  getInitState: mock(() => undefined),
  waitForInit: mock(() => Promise.resolve()),
  clearInMemoryState: mock(() => undefined),
};
const mockExtensionMetadataService: Partial<ExtensionMetadataService> = {
  setStreaming: mock(() =>
    Promise.resolve({
      recency: Date.now(),
      streaming: false,
      lastModel: null,
      lastThinkingLevel: null,
      agentStatus: null,
    })
  ),
  updateRecency: mock(() =>
    Promise.resolve({
      recency: Date.now(),
      streaming: false,
      lastModel: null,
      lastThinkingLevel: null,
      agentStatus: null,
    })
  ),
};
const mockBackgroundProcessManager: Partial<BackgroundProcessManager> = {
  cleanup: mock(() => Promise.resolve()),
};

type WorkspaceServiceArgs = ConstructorParameters<typeof WorkspaceService>;

function createMockAIService(overrides: Partial<AIService> = {}): AIService {
  return {
    on: mock(() => undefined),
    off: mock(() => undefined),
    isStreaming: mock(() => false),
    ...overrides,
  } as unknown as AIService;
}

function createWorkspaceServiceForTest(options: {
  config: Partial<Config> | Config;
  historyService?: HistoryService;
  aiService?: AIService;
  initStateManager?: InitStateManager;
  extensionMetadata?: ExtensionMetadataService;
  backgroundProcessManager?: BackgroundProcessManager;
  sessionUsageService?: WorkspaceServiceArgs[6];
  policyService?: WorkspaceServiceArgs[7];
  telemetryService?: WorkspaceServiceArgs[8];
  experimentsService?: WorkspaceServiceArgs[9];
  sessionTimingService?: WorkspaceServiceArgs[10];
}): WorkspaceService {
  // Test helpers often don't exercise HistoryService; use a narrow stub for those cases.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const defaultHistoryService: HistoryService = {} as HistoryService;
  return new WorkspaceService(
    options.config as Config,
    options.historyService ?? defaultHistoryService,
    options.aiService ?? createMockAIService(),
    options.initStateManager ?? (mockInitStateManager as InitStateManager),
    options.extensionMetadata ?? (mockExtensionMetadataService as ExtensionMetadataService),
    options.backgroundProcessManager ?? (mockBackgroundProcessManager as BackgroundProcessManager),
    options.sessionUsageService,
    options.policyService,
    options.telemetryService,
    options.experimentsService,
    options.sessionTimingService
  );
}

async function setWorkspaceGoalOk(
  goalService: WorkspaceGoalService,
  input: Parameters<WorkspaceGoalService["setGoal"]>[0]
): Promise<GoalRecordV1> {
  const result = await goalService.setGoal(input);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(`Expected goal set to succeed, got ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

function createFrontendWorkspaceMetadata(
  overrides: Partial<FrontendWorkspaceMetadata> & Pick<FrontendWorkspaceMetadata, "id" | "name">
): FrontendWorkspaceMetadata {
  return {
    ...overrides,
    id: overrides.id,
    name: overrides.name,
    projectName: overrides.projectName ?? "project",
    projectPath: overrides.projectPath ?? "/tmp/project",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    runtimeConfig: overrides.runtimeConfig ?? { type: "local" },
    namedWorkspacePath: overrides.namedWorkspacePath ?? `/tmp/${overrides.id}`,
  };
}

describe("WorkspaceService.stageAttachment", () => {
  test("waits for workspace init before writing into the workspace", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "stage-attachment-init";
    // Local runtime resolves the execution path to the project dir itself.
    const projectPath = path.join(config.rootDir, "project");
    const workspacePath = projectPath;
    try {
      await fsPromises.mkdir(workspacePath, { recursive: true });
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "stage-attachment-init",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
        namedWorkspacePath: workspacePath,
      });

      let releaseInit: () => void = () => undefined;
      const initGate = new Promise<void>((resolve) => {
        releaseInit = resolve;
      });
      let barrierReached: () => void = () => undefined;
      const barrierReachedGate = new Promise<void>((resolve) => {
        barrierReached = resolve;
      });
      const waitForInit = mock(() => {
        barrierReached();
        return initGate;
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        initStateManager: {
          ...mockInitStateManager,
          waitForInit,
        } as unknown as InitStateManager,
      });

      const stagePromise = workspaceService.stageAttachment({
        workspaceId,
        filename: "notes.md",
        mediaType: "text/markdown",
        sizeBytes: 8,
        dataBase64: Buffer.from("markdown").toString("base64"),
      });

      // Staging must block on the init barrier before any workspace write.
      await barrierReachedGate;
      expect(waitForInit).toHaveBeenCalledWith(workspaceId);
      const entriesBeforeInit = await fsPromises.readdir(workspacePath);
      expect(entriesBeforeInit).toEqual([]);

      releaseInit();
      const result = await stagePromise;
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error);
      await fsPromises.access(path.join(workspacePath, result.data.stagedPath));
    } finally {
      await cleanup();
    }
  });
});

describe("WorkspaceService.setActiveTurnThinkingLevel", () => {
  test("returns accepted:false when the workspace has no session", () => {
    const workspaceService = createWorkspaceServiceForTest({ config: {} });
    // No session was ever created for this workspace: nothing is running, so
    // the mid-turn override is a no-op and persisted settings cover the next turn.
    const result = workspaceService.setActiveTurnThinkingLevel("unknown-workspace", "high");
    expect(result).toEqual(Ok({ accepted: false }));
  });
});

describe("WorkspaceService bash monitor wakes", () => {
  test("sends a synthetic wake and marks the record delivered when monitor output matches", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          return Ok(undefined);
        }
      );

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED one"],
        totalMatches: 1,
        timestamp: Date.now(),
      });

      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      expect(sendSpy.mock.calls[0][0]).toBe(workspaceId);
      expect(sendSpy.mock.calls[0][1]).toContain("A background bash monitor matched output.");
      expect(sendSpy.mock.calls[0][1]).toContain("FAILED one");
      expect(sendSpy.mock.calls[0][2]).toMatchObject({
        queueDispatchMode: "tool-end",
        // Compact display metadata drives the collapsed transcript card;
        // displayName falls back to processId when the payload omits it.
        muxMetadata: {
          type: "bash-monitor-wake",
          records: [
            { kind: "match", displayName: "proc-1", filter: "FAILED", filterExclude: false },
          ],
        },
      });
      expect(sendSpy.mock.calls[0][3]).toMatchObject({
        synthetic: true,
        agentInitiated: true,
        skipAutoResumeReset: true,
      });
      expect(sendSpy.mock.calls[0][3]?.requireIdle).toBeUndefined();
      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: { listPending: (id: string) => Promise<unknown[]> };
        }
      ).bashMonitorWakeStore;
      await waitForCondition(async () => (await wakeStore.listPending(workspaceId)).length === 0);
    } finally {
      await cleanup();
    }
  });

  test("explicit monitor cancellation supersedes a match racing persistence", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-cancel-race";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });
      const sendSpy = spyOn(workspaceService, "sendMessage").mockResolvedValue(Ok(undefined));
      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: BashMonitorWakeStore;
        }
      ).bashMonitorWakeStore;
      const markSupersededSpy = spyOn(wakeStore, "markSuperseded");

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-canceled",
        taskId: "bash:proc-canceled",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED stale"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 12,
      });
      backgroundProcessManager.emit("monitor:stopped", workspaceId, {
        processId: "proc-canceled",
        reason: "canceled",
      });

      await waitForCondition(() => markSupersededSpy.mock.calls.length > 0);
      await waitForCondition(async () => (await wakeStore.listPending(workspaceId)).length === 0);
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  test("canceled retirement finishes before a reused process ID can persist a new wake", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-cancel-generation";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });
      let deferDrains = true;
      spyOn(workspaceService, "hasPendingQueuedOrPreparingTurn").mockImplementation(
        () => deferDrains
      );
      spyOn(workspaceService, "waitForIdleAndNoQueuedMessages").mockImplementation(
        () => new Promise(() => undefined)
      );
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          return Ok(undefined);
        }
      );
      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: BashMonitorWakeStore;
        }
      ).bashMonitorWakeStore;

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "reused-proc",
        taskId: "bash:reused-proc",
        workspaceId,
        filter: "DONE",
        filterExclude: false,
        lines: ["OLD done"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 8,
      });
      await waitForCondition(async () => (await wakeStore.listPending(workspaceId)).length === 1);

      const supersedeStarted = createDeferred<void>();
      const releaseSupersede = createDeferred<void>();
      const originalMarkSuperseded = wakeStore.markSuperseded.bind(wakeStore);
      spyOn(wakeStore, "markSuperseded").mockImplementation(async (...args) => {
        supersedeStarted.resolve();
        await releaseSupersede.promise;
        return originalMarkSuperseded(...args);
      });

      backgroundProcessManager.emit("monitor:stopped", workspaceId, {
        processId: "reused-proc",
        reason: "canceled",
      });
      await supersedeStarted.promise;

      backgroundProcessManager.emit("monitor:armed", workspaceId, {
        processId: "reused-proc",
        taskId: "bash:reused-proc",
        workspaceId,
        displayName: "Reused Proc",
        filter: "DONE",
        filterExclude: false,
        script: "echo NEW done",
        createdAt: new Date().toISOString(),
      });
      deferDrains = false;
      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "reused-proc",
        taskId: "bash:reused-proc",
        workspaceId,
        filter: "DONE",
        filterExclude: false,
        lines: ["NEW done"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 8,
      });

      await drainPendingDispatches();
      expect(sendSpy).not.toHaveBeenCalled();

      releaseSupersede.resolve();
      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      expect(sendSpy.mock.calls[0][1]).toContain("NEW done");
      expect(sendSpy.mock.calls[0][1]).not.toContain("OLD done");
    } finally {
      await cleanup();
    }
  });

  test("explicit monitor cancellation retracts an already queued synthetic wake", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-cancel-queued";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => true) }),
      });
      spyOn(workspaceService, "isBusyForMessage").mockReturnValue(true);
      spyOn(workspaceService, "hasPendingQueuedOrPreparingTurn").mockReturnValue(false);
      type SendInternal = NonNullable<Parameters<WorkspaceService["sendMessage"]>[3]>;
      let onCanceled: SendInternal["onCanceled"] | undefined;
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          onCanceled = args[3]?.onCanceled;
          return Promise.resolve(Ok(undefined));
        }
      );
      const removeQueuedSpy = spyOn(
        workspaceService,
        "removeQueuedMessagesByDedupeKeyPrefix"
      ).mockImplementation((_ownerWorkspaceId, _prefix, options) => {
        void onCanceled?.(options?.cancelReason ?? "canceled");
        return Ok(1);
      });

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-queued",
        taskId: "bash:proc-queued",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED queued"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 13,
      });
      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      expect(sendSpy.mock.calls[0][3]).toMatchObject({
        removableQueueDedupeKey: true,
      });

      backgroundProcessManager.emit("monitor:stopped", workspaceId, {
        processId: "proc-queued",
        reason: "canceled",
      });

      await waitForCondition(() => removeQueuedSpy.mock.calls.length === 1);
      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: BashMonitorWakeStore;
        }
      ).bashMonitorWakeStore;
      await waitForCondition(async () => (await wakeStore.listPending(workspaceId)).length === 0);
      expect(removeQueuedSpy.mock.calls[0][1]).toStartWith("bash-monitor-wake:");
      expect(sendSpy).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });

  test("retracts a queued monitor wake once a later unfiltered read shows its match", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-shown-after-queue";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const seedWakeStore = new BashMonitorWakeStore(config);
      const shownRecord = await seedWakeStore.enqueueOrMergePending({
        processId: "proc-shown",
        taskId: "bash:proc-shown",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED shown"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 100,
      });
      await seedWakeStore.enqueueOrMergePending({
        processId: "proc-unshown",
        taskId: "bash:proc-unshown",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED unshown"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 200,
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
        getForegroundToolCallIds: mock(() => []),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => true) }),
      });
      let queueHasPendingMonitorWake = false;
      spyOn(workspaceService, "isBusyForMessage").mockReturnValue(true);
      spyOn(workspaceService, "hasPendingQueuedOrPreparingTurn").mockImplementation(
        () => queueHasPendingMonitorWake
      );
      spyOn(workspaceService, "waitForIdleAndNoQueuedMessages").mockImplementation(
        () => new Promise(() => undefined)
      );
      type SendInternal = NonNullable<Parameters<WorkspaceService["sendMessage"]>[3]>;
      let onCanceled: SendInternal["onCanceled"] | undefined;
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          onCanceled = args[3]?.onCanceled;
          queueHasPendingMonitorWake = true;
          return Promise.resolve(Ok(undefined));
        }
      );
      const removeQueuedSpy = spyOn(
        workspaceService,
        "removeQueuedMessagesByDedupeKeyPrefix"
      ).mockImplementation((_ownerWorkspaceId, _prefix, options) => {
        queueHasPendingMonitorWake = false;
        void onCanceled?.(options?.cancelReason ?? "canceled");
        return Ok(1);
      });

      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      expect(sendSpy.mock.calls[0][1]).toContain("FAILED shown");
      expect(sendSpy.mock.calls[0][1]).toContain("FAILED unshown");

      (backgroundProcessManager as EventEmitter).emit("output:shown", workspaceId, {
        processId: "proc-shown",
        processStartTime: Date.parse(shownRecord.createdAt) + 1,
        shownThroughOffset: 100,
      });
      expect(removeQueuedSpy).not.toHaveBeenCalled();

      (backgroundProcessManager as EventEmitter).emit("output:shown", workspaceId, {
        processId: "proc-shown",
        processStartTime: Date.parse(shownRecord.createdAt),
        shownThroughOffset: 99,
      });
      expect(removeQueuedSpy).not.toHaveBeenCalled();

      (backgroundProcessManager as EventEmitter).emit("output:shown", workspaceId, {
        processId: "proc-shown",
        processStartTime: Date.parse(shownRecord.createdAt),
        shownThroughOffset: 100,
      });

      await waitForCondition(() => removeQueuedSpy.mock.calls.length === 1);
      await waitForCondition(() => sendSpy.mock.calls.length === 2);
      expect(sendSpy.mock.calls[1][1]).not.toContain("FAILED shown");
      expect(sendSpy.mock.calls[1][1]).toContain("FAILED unshown");
    } finally {
      await cleanup();
    }
  });

  test("retains an earlier shown event while a later frontier query is pending", async () => {
    const { config, cleanup } = await createTestHistoryService();
    const releaseSecondCheck = createDeferred<void>();
    try {
      const workspaceId = "bash-monitor-shown-during-gate";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const wakeStore = new BashMonitorWakeStore(config);
      const shownRecord = await wakeStore.enqueueOrMergePending({
        processId: "a-shown",
        taskId: "bash:a-shown",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED shown"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 100,
      });
      await wakeStore.enqueueOrMergePending({
        processId: "b-unshown",
        taskId: "bash:b-unshown",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED unshown"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 200,
      });

      const secondCheckStarted = createDeferred<void>();
      let firstOutputShown = false;
      const getDeliveryState = mock(async (processId: string) => {
        if (processId === "a-shown") {
          return { status: "settled" as const, shownThroughOffset: firstOutputShown ? 100 : 0 };
        }
        secondCheckStarted.resolve();
        await releaseSecondCheck.promise;
        return { status: "settled" as const, shownThroughOffset: 0 };
      });
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
        getForegroundToolCallIds: mock(() => []),
        getMonitorWakeDeliveryState: getDeliveryState,
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => true) }),
      });
      spyOn(workspaceService, "isBusyForMessage").mockReturnValue(true);
      spyOn(workspaceService, "hasPendingQueuedOrPreparingTurn").mockReturnValue(false);
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          return Ok(undefined);
        }
      );

      await secondCheckStarted.promise;
      firstOutputShown = true;
      backgroundProcessManager.emit("output:shown", workspaceId, {
        processId: "a-shown",
        processStartTime: Date.parse(shownRecord.createdAt),
        shownThroughOffset: 100,
      });
      releaseSecondCheck.resolve();

      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      expect(sendSpy.mock.calls[0][1]).not.toContain("FAILED shown");
      expect(sendSpy.mock.calls[0][1]).toContain("FAILED unshown");
      expect(getDeliveryState.mock.calls.slice(0, 2).map(([processId]) => processId)).toEqual([
        "a-shown",
        "b-unshown",
      ]);
    } finally {
      releaseSecondCheck.resolve();
      await cleanup();
    }
  });

  test("unregisters pending wakes when a delivery-state query fails", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-delivery-gate-failure";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const wakeStore = new BashMonitorWakeStore(config);
      await wakeStore.enqueueOrMergePending({
        processId: "proc-failed-gate",
        taskId: "bash:proc-failed-gate",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED gate"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 100,
      });

      const getDeliveryState = mock(() => Promise.reject(new Error("delivery gate failed")));
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
        getForegroundToolCallIds: mock(() => []),
        getMonitorWakeDeliveryState: getDeliveryState,
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => true) }),
      });
      spyOn(workspaceService, "isBusyForMessage").mockReturnValue(true);
      spyOn(workspaceService, "hasPendingQueuedOrPreparingTurn").mockReturnValue(false);
      const sendSpy = spyOn(workspaceService, "sendMessage").mockResolvedValue(Ok(undefined));

      await waitForCondition(() => getDeliveryState.mock.calls.length === 1);
      await drainPendingDispatches();
      backgroundProcessManager.emit("monitor:stopped", workspaceId, {
        processId: "proc-failed-gate",
        reason: "canceled",
      });

      await waitForCondition(async () => (await wakeStore.listPending(workspaceId)).length === 0);
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  test("converts stale armed-monitor registry records into monitor-lost wakes at startup", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-restart-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      // Seed a stale registry record on disk before the service boots — as if a previous
      // Xum run armed a monitor and was then shut down/killed.
      const registryStore = new BashMonitorRegistryStore(config);
      await registryStore.upsert({
        processId: "proc-stale",
        taskId: "bash:proc-stale",
        workspaceId,
        displayName: "Tick Loop",
        filter: "NEVER_MATCHES",
        filterExclude: false,
        script: "while true; do echo tick; sleep 5; done",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          return Ok(undefined);
        }
      );

      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      expect(sendSpy.mock.calls[0][0]).toBe(workspaceId);
      const prompt = sendSpy.mock.calls[0][1];
      expect(prompt).toContain("bash:proc-stale (no longer awaitable — process was terminated)");
      expect(prompt).toContain("> while true; do echo tick; sleep 5; done");
      expect(prompt).not.toContain("task_await(");
      expect(sendSpy.mock.calls[0][3]).toMatchObject({ synthetic: true, agentInitiated: true });

      // Registry record consumed; wake delivered (nothing left pending).
      expect(await registryStore.listAll(workspaceId)).toHaveLength(0);
      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: { listPending: (id: string) => Promise<unknown[]> };
        }
      ).bashMonitorWakeStore;
      await waitForCondition(async () => (await wakeStore.listPending(workspaceId)).length === 0);
    } finally {
      await cleanup();
    }
  });

  test("startup recovery merges a stale registry record with a pending match wake", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-restart-merge-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      // A match wake was persisted but never delivered before shutdown…
      const seedWakeStore = new BashMonitorWakeStore(config);
      await seedWakeStore.enqueueOrMergePending({
        processId: "proc-stale",
        taskId: "bash:proc-stale",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED before shutdown"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 0,
      });
      // …and the monitor was still armed.
      const registryStore = new BashMonitorRegistryStore(config);
      await registryStore.upsert({
        processId: "proc-stale",
        taskId: "bash:proc-stale",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        script: "run-tests --watch",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      // The seeded match wake's updatedAt must be strictly before the service's boot
      // timestamp (ms precision), or recovery's live-record guard would skip the upgrade.
      await new Promise((resolve) => setTimeout(resolve, 5));

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          return Ok(undefined);
        }
      );

      // One message carries both the undelivered output and the termination notice.
      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      const prompt = sendSpy.mock.calls[0][1];
      expect(prompt).toContain("FAILED before shutdown");
      expect(prompt).toContain("bash:proc-stale (no longer awaitable — process was terminated)");
      expect(prompt).toContain("> run-tests --watch");
      expect(await registryStore.listAll(workspaceId)).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("startup recovery skips registry records armed after service construction", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-live-registry-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      // Record stamped in the future = armed by the live manager, not a stale leftover.
      const registryStore = new BashMonitorRegistryStore(config);
      await registryStore.upsert({
        processId: "proc-live",
        taskId: "bash:proc-live",
        workspaceId,
        filter: "READY",
        filterExclude: false,
        script: "echo hi",
        createdAt: new Date(Date.now() + 60_000).toISOString(),
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(() =>
        Promise.resolve(Ok(undefined))
      );

      // Give recovery a chance to run, then confirm it left the record alone.
      await waitForCondition(async () => (await registryStore.listAll(workspaceId)).length === 1);
      await drainPendingDispatches();
      expect(sendSpy).not.toHaveBeenCalled();
      expect(await registryStore.listAll(workspaceId)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test("re-arming a processId supersedes its pending monitor-lost wake", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-rearm-owner";
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      // Workspace intentionally absent from config: startup recovery finds nothing, and
      // no drain can race the assertion below (drains for unknown workspaces supersede,
      // but none is scheduled because the wake is seeded after construction).
      createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });

      const wakeStore = new BashMonitorWakeStore(config);
      await wakeStore.enqueueMonitorLost(
        {
          processId: "proc-1",
          taskId: "bash:proc-1",
          ownerWorkspaceId: workspaceId,
          filter: "ERROR",
          filterExclude: false,
          script: "echo hi",
        },
        Date.now() + 60_000 // treat everything as stale so the seed record is written
      );

      // Relaunching the same display_name after restart reuses the processId; the stale
      // "no longer awaitable" notice must not be delivered for the now-live task.
      backgroundProcessManager.emit("monitor:armed", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "ERROR",
        filterExclude: false,
        script: "echo hi",
        createdAt: new Date().toISOString(),
      });

      await waitForCondition(
        async () => (await wakeStore.get(workspaceId, "proc-1"))?.status === "superseded"
      );
    } finally {
      await cleanup();
    }
  });

  test("maintains the armed-monitor registry from manager events", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-registry-events-owner";
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });

      const registryStore = new BashMonitorRegistryStore(config);
      backgroundProcessManager.emit("monitor:armed", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "ERROR",
        filterExclude: false,
        script: "echo hi",
        createdAt: new Date().toISOString(),
      });
      await waitForCondition(async () => (await registryStore.listAll(workspaceId)).length === 1);

      backgroundProcessManager.emit("monitor:stopped", workspaceId, { processId: "proc-1" });
      await waitForCondition(async () => (await registryStore.listAll(workspaceId)).length === 0);
    } finally {
      await cleanup();
    }
  });

  test("re-emits workspace activity when the armed monitor count changes", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-activity";
      let activeMonitorCount = 1;
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
        getActiveMonitorCount: mock(() => activeMonitorCount),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const getSnapshot = mock(() => Promise.resolve(null));
      const extensionMetadata = {
        ...mockExtensionMetadataService,
        getSnapshot,
      } as unknown as ExtensionMetadataService;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        extensionMetadata,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });

      const events: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      workspaceService.on("activity", (event) => events.push(event));

      backgroundProcessManager.emit("change", workspaceId);
      await waitForCondition(() => events.length === 1);
      expect(events[0].workspaceId).toBe(workspaceId);
      expect(events[0].activity?.activeBashMonitorCount).toBe(1);
      expect(getSnapshot).toHaveBeenCalledTimes(1);

      // Same count after the previous emit settled: deduped synchronously,
      // so no extra snapshot read or emit.
      backgroundProcessManager.emit("change", workspaceId);
      expect(getSnapshot).toHaveBeenCalledTimes(1);

      activeMonitorCount = 0;
      backgroundProcessManager.emit("change", workspaceId);

      await waitForCondition(() => events.length === 2);
      // Monitor stopped with no other persisted activity: the snapshot clears entirely.
      expect(events[1].activity).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("retries the monitor-count activity emit after a failed snapshot read", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-activity-retry";
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
        getActiveMonitorCount: mock(() => 1),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const getSnapshot = mock(
        (): Promise<WorkspaceActivitySnapshot | null> =>
          Promise.reject(new Error("transient read failure"))
      );
      const extensionMetadata = {
        ...mockExtensionMetadataService,
        getSnapshot,
      } as unknown as ExtensionMetadataService;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        extensionMetadata,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });

      const events: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      workspaceService.on("activity", (event) => events.push(event));

      backgroundProcessManager.emit("change", workspaceId);
      await waitForCondition(() => getSnapshot.mock.calls.length === 1);
      expect(events.length).toBe(0);

      // The failed emit must not be recorded as delivered: the next change event
      // with the same count retries instead of being deduped.
      getSnapshot.mockImplementation(() => Promise.resolve(null));
      backgroundProcessManager.emit("change", workspaceId);

      await waitForCondition(() => events.length === 1);
      expect(events[0].activity?.activeBashMonitorCount).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("emits the zero-count clear even when the armed emit never succeeded", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-clear-after-failure";
      let activeMonitorCount = 1;
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
        getActiveMonitorCount: mock(() => activeMonitorCount),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const getSnapshot = mock(
        (): Promise<WorkspaceActivitySnapshot | null> =>
          Promise.reject(new Error("transient read failure"))
      );
      const extensionMetadata = {
        ...mockExtensionMetadataService,
        getSnapshot,
      } as unknown as ExtensionMetadataService;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        extensionMetadata,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });

      const events: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      workspaceService.on("activity", (event) => events.push(event));

      // Armed emit fails; renderers may still have bootstrapped count=1 via getActivityList.
      backgroundProcessManager.emit("change", workspaceId);
      await waitForCondition(() => getSnapshot.mock.calls.length === 1);
      expect(events.length).toBe(0);

      // Monitor stops: the unknown->0 transition must emit the clear rather than
      // treating the missing cache entry as an already-emitted zero.
      getSnapshot.mockImplementation(() => Promise.resolve(null));
      activeMonitorCount = 0;
      backgroundProcessManager.emit("change", workspaceId);

      await waitForCondition(() => events.length === 1);
      expect(events[0].workspaceId).toBe(workspaceId);
      expect(events[0].activity).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("does not dedupe a clear against a zero recorded before a failed armed emit", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-stale-zero";
      let activeMonitorCount = 0;
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
        getActiveMonitorCount: mock(() => activeMonitorCount),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const getSnapshot = mock(
        (): Promise<WorkspaceActivitySnapshot | null> => Promise.resolve(null)
      );
      const extensionMetadata = {
        ...mockExtensionMetadataService,
        getSnapshot,
      } as unknown as ExtensionMetadataService;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        extensionMetadata,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });

      const events: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      workspaceService.on("activity", (event) => events.push(event));

      // Monitorless churn records 0 as successfully emitted.
      backgroundProcessManager.emit("change", workspaceId);
      await waitForCondition(() => events.length === 1);

      // Armed transition fails to emit; renderers may still observe count=1 via
      // workspace.activity.list(). The stale recorded 0 must not survive.
      getSnapshot.mockImplementation(() => Promise.reject(new Error("transient read failure")));
      activeMonitorCount = 1;
      backgroundProcessManager.emit("change", workspaceId);
      await waitForCondition(() => getSnapshot.mock.calls.length === 2);
      expect(events.length).toBe(1);

      // Stop: 0 equals the pre-failure recorded 0, but the clear must still emit.
      getSnapshot.mockImplementation(() => Promise.resolve(null));
      activeMonitorCount = 0;
      backgroundProcessManager.emit("change", workspaceId);

      await waitForCondition(() => events.length === 2);
      expect(events[1].workspaceId).toBe(workspaceId);
      expect(events[1].activity).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("emits the clear when a stop races a still-pending armed emit", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-pending-race";
      let activeMonitorCount = 0;
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
        getActiveMonitorCount: mock(() => activeMonitorCount),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const getSnapshot = mock(
        (): Promise<WorkspaceActivitySnapshot | null> => Promise.resolve(null)
      );
      const extensionMetadata = {
        ...mockExtensionMetadataService,
        getSnapshot,
      } as unknown as ExtensionMetadataService;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        extensionMetadata,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });

      const events: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      workspaceService.on("activity", (event) => events.push(event));

      // Record 0 as the last successfully emitted count.
      backgroundProcessManager.emit("change", workspaceId);
      await waitForCondition(() => events.length === 1);

      // Armed emit hangs: its snapshot read stays pending while the stop arrives.
      let rejectArmedSnapshot: ((error: Error) => void) | undefined;
      getSnapshot.mockImplementation(
        () =>
          new Promise<WorkspaceActivitySnapshot | null>((_resolve, reject) => {
            rejectArmedSnapshot = reject;
          })
      );
      activeMonitorCount = 1;
      backgroundProcessManager.emit("change", workspaceId);
      await waitForCondition(() => rejectArmedSnapshot !== undefined);

      // Stop while the armed emit is in flight: the pre-emit delete means this 0 must
      // not dedupe against the previously recorded 0 — the clear still goes out.
      getSnapshot.mockImplementation(() => Promise.resolve(null));
      activeMonitorCount = 0;
      backgroundProcessManager.emit("change", workspaceId);

      await waitForCondition(() => events.length === 2);
      expect(events[1].activity).toBeNull();

      // The armed emit failing afterwards must not corrupt the recorded state: the
      // successfully emitted 0 stays recorded, and a later re-arm still emits.
      rejectArmedSnapshot?.(new Error("slow read failed"));
      await drainPendingDispatches();
      activeMonitorCount = 1;
      backgroundProcessManager.emit("change", workspaceId);
      await waitForCondition(() => events.length === 3);
      expect(events[2].activity?.activeBashMonitorCount).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("keeps the zero-count tombstone in getActivityList after a failed clear emit", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-tombstone-failed-clear";
      let activeMonitorCount = 1;
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
        getActiveMonitorCount: mock(() => activeMonitorCount),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const getSnapshot = mock(
        (): Promise<WorkspaceActivitySnapshot | null> => Promise.resolve(null)
      );
      const extensionMetadata = {
        ...mockExtensionMetadataService,
        getSnapshot,
        getAllSnapshots: mock(() => Promise.resolve(new Map<string, WorkspaceActivitySnapshot>())),
      } as unknown as ExtensionMetadataService;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        extensionMetadata,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });

      const events: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      workspaceService.on("activity", (event) => events.push(event));

      // Armed emit succeeds: renderers now show "watching".
      backgroundProcessManager.emit("change", workspaceId);
      await waitForCondition(() => events.length === 1);
      expect(events[0].activity?.activeBashMonitorCount).toBe(1);

      // Stop transition fails to emit (snapshot read rejects).
      getSnapshot.mockImplementation(() => Promise.reject(new Error("transient read failure")));
      activeMonitorCount = 0;
      backgroundProcessManager.emit("change", workspaceId);
      await waitForCondition(() => getSnapshot.mock.calls.length === 2);
      expect(events.length).toBe(1);

      // Reconnect bootstrap must still return the zero-count tombstone even though the
      // clear emit failed, so the renderer's stale "watching" snapshot gets replaced.
      const activityList = await workspaceService.getActivityList();
      const entry = activityList[workspaceId];
      expect(entry).toBeDefined();
      expect(entry.activeBashMonitorCount).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("keeps a zero-count tombstone in getActivityList after a monitor stops", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-tombstone";
      let activeMonitorCount = 1;
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
        getActiveMonitorCount: mock(() => activeMonitorCount),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const extensionMetadata = {
        ...mockExtensionMetadataService,
        getSnapshot: mock(() => Promise.resolve(null)),
        getAllSnapshots: mock(() => Promise.resolve(new Map<string, WorkspaceActivitySnapshot>())),
      } as unknown as ExtensionMetadataService;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        extensionMetadata,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });

      const events: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      workspaceService.on("activity", (event) => events.push(event));

      backgroundProcessManager.emit("change", workspaceId);
      await waitForCondition(() => events.length === 1);
      expect(events[0].activity?.activeBashMonitorCount).toBe(1);

      // Renderer disconnected: the monitor stops and the clear emit lands nowhere.
      activeMonitorCount = 0;
      backgroundProcessManager.emit("change", workspaceId);
      await waitForCondition(() => events.length === 2);

      // Reconnect bootstrap: the list must include a zero-count tombstone so the
      // renderer's last-known "watching" snapshot gets replaced rather than preserved.
      const activityList = await workspaceService.getActivityList();
      const entry = activityList[workspaceId];
      expect(entry).toBeDefined();
      expect(entry.activeBashMonitorCount).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("marks an accepted wake delivered when stream startup fails before provider start", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-accepted-startup-failure";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const aiService = Object.assign(new EventEmitter(), {
        isStreaming: mock(() => false),
      }) as unknown as AIService & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService,
      });
      const startupError: SendMessageError = { type: "unknown", raw: "startup failed" };
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          await args[3]?.onAcceptedPreStreamFailure?.(startupError);
          return Ok(undefined);
        }
      );

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED after accept"],
        totalMatches: 1,
        timestamp: Date.now(),
      });

      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: { listPending: (id: string) => Promise<unknown[]> };
        }
      ).bashMonitorWakeStore;
      expect(await wakeStore.listPending(workspaceId)).toHaveLength(0);

      aiService.emit("error", { workspaceId, error: "startup failed" });
      await drainPendingDispatches();
      expect(sendSpy).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });

  test("queues monitor wakes immediately for a session-backed streaming owner", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-streaming-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const getForegroundToolCallIds = mock(() => ["tool-call-1"]);
      const sendToBackground = mock(() => ({ success: true as const }));
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
        getForegroundToolCallIds,
        sendToBackground,
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => true) }),
      });
      spyOn(workspaceService, "isBusyForMessage").mockReturnValue(true);
      spyOn(workspaceService, "hasQueuedMessages").mockReturnValue(false);
      spyOn(workspaceService, "hasPendingQueuedOrPreparingTurn").mockReturnValue(false);
      const waitForIdleSpy = spyOn(
        workspaceService,
        "waitForIdleAndNoQueuedMessages"
      ).mockResolvedValue();
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          return Ok(undefined);
        }
      );

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED streaming"],
        totalMatches: 1,
        timestamp: Date.now(),
      });

      await waitForCondition(() => sendToBackground.mock.calls.length === 1);
      expect(sendSpy.mock.calls[0][2]).toMatchObject({ queueDispatchMode: "tool-end" });
      expect(sendSpy.mock.calls[0][3]?.requireIdle).toBeUndefined();
      expect(getForegroundToolCallIds).toHaveBeenCalledWith(workspaceId);
      expect(sendToBackground).toHaveBeenCalledWith("tool-call-1");
      expect(waitForIdleSpy).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  test("leaves monitor wakes pending and retries after idle when a busy queue send is rejected", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-busy-rejected-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => true) }),
      });
      spyOn(workspaceService, "isBusyForMessage").mockReturnValue(true);
      spyOn(workspaceService, "hasQueuedMessages").mockReturnValue(false);
      spyOn(workspaceService, "hasPendingQueuedOrPreparingTurn").mockReturnValue(false);
      const waitForIdleSpy = spyOn(
        workspaceService,
        "waitForIdleAndNoQueuedMessages"
      ).mockImplementation(() => new Promise(() => undefined));
      const sendSpy = spyOn(workspaceService, "sendMessage").mockResolvedValue(
        Err({ type: "unknown", raw: "busy rejection" })
      );

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED rejected"],
        totalMatches: 1,
        timestamp: Date.now(),
      });

      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      expect(waitForIdleSpy).toHaveBeenCalledWith(workspaceId);
      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: { listPending: (id: string) => Promise<unknown[]> };
        }
      ).bashMonitorWakeStore;
      expect(await wakeStore.listPending(workspaceId)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test("defers monitor wakes while the owner session is busy after streaming ends", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-completing-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });
      spyOn(workspaceService, "isBusyForMessage").mockReturnValue(true);
      spyOn(workspaceService, "hasPendingQueuedOrPreparingTurn").mockReturnValue(false);
      const waitForIdleSpy = spyOn(
        workspaceService,
        "waitForIdleAndNoQueuedMessages"
      ).mockImplementation(() => new Promise(() => undefined));
      const sendSpy = spyOn(workspaceService, "sendMessage").mockResolvedValue(Ok(undefined));

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED completing"],
        totalMatches: 1,
        timestamp: Date.now(),
      });

      await waitForCondition(() => waitForIdleSpy.mock.calls.length === 1);
      expect(sendSpy).not.toHaveBeenCalled();
      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: { listPending: (id: string) => Promise<unknown[]> };
        }
      ).bashMonitorWakeStore;
      expect(await wakeStore.listPending(workspaceId)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test("leaves idle rejected monitor wakes pending without scheduling a retry loop", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-idle-rejected-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });
      spyOn(workspaceService, "isBusyForMessage").mockReturnValue(false);
      spyOn(workspaceService, "hasPendingQueuedOrPreparingTurn").mockReturnValue(false);
      const waitForIdleSpy = spyOn(
        workspaceService,
        "waitForIdleAndNoQueuedMessages"
      ).mockResolvedValue();
      const sendSpy = spyOn(workspaceService, "sendMessage").mockResolvedValue(
        Err({ type: "unknown", raw: "idle rejection" })
      );

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED idle rejected"],
        totalMatches: 1,
        timestamp: Date.now(),
      });

      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      expect(waitForIdleSpy).not.toHaveBeenCalled();
      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: { listPending: (id: string) => Promise<unknown[]> };
        }
      ).bashMonitorWakeStore;
      expect(await wakeStore.listPending(workspaceId)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test("marks an accepted monitor wake delivered when sendMessage fails after acceptance", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-startup-failure-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          return Err({ type: "unknown", raw: "startup failed" });
        }
      );

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED startup"],
        totalMatches: 1,
        timestamp: Date.now(),
      });

      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      await drainPendingDispatches();
      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: { listPending: (id: string) => Promise<unknown[]> };
        }
      ).bashMonitorWakeStore;
      expect(await wakeStore.listPending(workspaceId)).toHaveLength(0);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      sendSpy.mockRestore();
    } finally {
      await cleanup();
    }
  });

  test("marks a queued monitor wake delivered when accepted dispatch fails before stream start", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-queued-startup-failure-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => true) }),
      });
      spyOn(workspaceService, "isBusyForMessage").mockReturnValue(true);
      spyOn(workspaceService, "hasPendingQueuedOrPreparingTurn").mockReturnValue(false);
      spyOn(workspaceService, "waitForIdleAndNoQueuedMessages").mockImplementation(
        () => new Promise(() => undefined)
      );
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          await args[3]?.onAcceptedPreStreamFailure?.({ type: "unknown", raw: "startup failed" });
          return Ok(undefined);
        }
      );

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED queued startup"],
        totalMatches: 1,
        timestamp: Date.now(),
      });

      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      await drainPendingDispatches();
      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: { listPending: (id: string) => Promise<unknown[]> };
        }
      ).bashMonitorWakeStore;
      expect(await wakeStore.listPending(workspaceId)).toHaveLength(0);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      sendSpy.mockRestore();
    } finally {
      await cleanup();
    }
  });

  test("keeps an accepted monitor wake delivered when startup retry later starts streaming", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-startup-retry-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const aiService = Object.assign(new EventEmitter(), {
        isStreaming: mock(() => true),
      }) as unknown as AIService & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService,
      });
      spyOn(workspaceService, "isBusyForMessage").mockReturnValue(true);
      spyOn(workspaceService, "hasPendingQueuedOrPreparingTurn").mockReturnValue(false);
      spyOn(workspaceService, "waitForIdleAndNoQueuedMessages").mockImplementation(
        () => new Promise(() => undefined)
      );
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          await args[3]?.onAcceptedPreStreamFailure?.({
            type: "unknown",
            raw: "runtime not ready",
          });
          return Ok(undefined);
        }
      );

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED retry"],
        totalMatches: 1,
        timestamp: Date.now(),
      });

      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      aiService.emit("stream-start", { workspaceId, model: "openai:gpt-4o-mini" });

      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: { listPending: (id: string) => Promise<unknown[]> };
        }
      ).bashMonitorWakeStore;
      await waitForCondition(async () => (await wakeStore.listPending(workspaceId)).length === 0);
      sendSpy.mockRestore();
    } finally {
      await cleanup();
    }
  });

  test("marks an accepted monitor wake delivered after the stream starts", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-started-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const aiService = Object.assign(new EventEmitter(), {
        isStreaming: mock(() => true),
      }) as unknown as AIService & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService,
      });
      spyOn(workspaceService, "isBusyForMessage").mockReturnValue(true);
      spyOn(workspaceService, "hasPendingQueuedOrPreparingTurn").mockReturnValue(false);
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          aiService.emit("stream-start", { workspaceId, model: "openai:gpt-4o-mini" });
          return Ok(undefined);
        }
      );

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED started"],
        totalMatches: 1,
        timestamp: Date.now(),
      });

      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: { listPending: (id: string) => Promise<unknown[]> };
        }
      ).bashMonitorWakeStore;
      await waitForCondition(async () => (await wakeStore.listPending(workspaceId)).length === 0);
    } finally {
      await cleanup();
    }
  });

  test("retries the delivered transition after a transient wake-store failure", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-delivery-retry";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
        getForegroundToolCallIds: mock(() => []),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => true) }),
      });
      spyOn(workspaceService, "isBusyForMessage").mockReturnValue(true);
      spyOn(workspaceService, "hasPendingQueuedOrPreparingTurn").mockReturnValue(false);
      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: BashMonitorWakeStore;
        }
      ).bashMonitorWakeStore;
      const originalMarkDelivered = wakeStore.markDeliveredSnapshot.bind(wakeStore);
      let deliveryAttempts = 0;
      spyOn(wakeStore, "markDeliveredSnapshot").mockImplementation(async (...args) => {
        deliveryAttempts += 1;
        if (deliveryAttempts === 1) {
          throw new Error("injected wake-store failure");
        }
        return originalMarkDelivered(...args);
      });
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          return Ok(undefined);
        }
      );

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-retry",
        taskId: "bash:proc-retry",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED retry delivery"],
        totalMatches: 1,
        timestamp: Date.now(),
      });

      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      await waitForCondition(() => deliveryAttempts === 2);
      await waitForCondition(async () => (await wakeStore.listPending(workspaceId)).length === 0);
      expect(deliveryAttempts).toBe(2);
    } finally {
      await cleanup();
    }
  });

  test("accepted history suppresses redelivery while wake-store reconciliation keeps failing", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-accepted-recovery";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const seedStore = new BashMonitorWakeStore(config);
      const record = await seedStore.enqueueOrMergePending({
        processId: "proc-accepted",
        taskId: "bash:proc-accepted",
        workspaceId,
        filter: "DONE",
        filterExclude: false,
        lines: ["DONE accepted"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 13,
      });
      const malformedWake = createMuxMessage("malformed-wake", "user", "Malformed wake", {
        synthetic: true,
      });
      if (malformedWake.metadata) {
        (malformedWake.metadata as Record<string, unknown>).muxMetadata = {
          type: "bash-monitor-wake",
          records: null,
        };
      }
      const emptyIdentityWake = createMuxMessage(
        "empty-identity-wake",
        "user",
        "Empty identity wake",
        { synthetic: true }
      );
      if (emptyIdentityWake.metadata) {
        (emptyIdentityWake.metadata as Record<string, unknown>).muxMetadata = {
          type: "bash-monitor-wake",
          records: [{ processId: "", wakeUpdatedAt: "" }],
        };
      }
      await historyService.appendToHistory(workspaceId, emptyIdentityWake);
      await historyService.appendToHistory(workspaceId, malformedWake);
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("accepted-wake", "user", "Accepted monitor wake", {
          synthetic: true,
          muxMetadata: buildBashMonitorWakeMetadata([record]),
        })
      );

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });
      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: BashMonitorWakeStore;
        }
      ).bashMonitorWakeStore;
      const markDeliveredSpy = spyOn(wakeStore, "markDeliveredSnapshot").mockRejectedValue(
        new Error("injected persistent wake-store failure")
      );
      const sendSpy = spyOn(workspaceService, "sendMessage").mockResolvedValue(Ok(undefined));

      await waitForCondition(() => markDeliveredSpy.mock.calls.length > 0);
      await drainPendingDispatches();
      expect(sendSpy).not.toHaveBeenCalled();
      expect(await wakeStore.listPending(workspaceId)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test("canceled queued monitor wakes supersede only the canceled snapshot", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-canceled-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => true) }),
      });
      let queueHasPendingMonitorWake = false;
      spyOn(workspaceService, "isBusyForMessage").mockReturnValue(true);
      spyOn(workspaceService, "hasQueuedMessages").mockImplementation(
        () => queueHasPendingMonitorWake
      );
      spyOn(workspaceService, "hasPendingQueuedOrPreparingTurn").mockImplementation(
        () => queueHasPendingMonitorWake
      );
      spyOn(workspaceService, "waitForIdleAndNoQueuedMessages").mockImplementation(
        () => new Promise(() => undefined)
      );
      type SendInternal = NonNullable<Parameters<WorkspaceService["sendMessage"]>[3]>;
      let onCanceled: SendInternal["onCanceled"] | undefined;
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          onCanceled = args[3]?.onCanceled;
          queueHasPendingMonitorWake = true;
          return Promise.resolve(Ok(undefined));
        }
      );

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED first"],
        totalMatches: 1,
        timestamp: Date.now(),
      });
      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED second"],
        totalMatches: 2,
        timestamp: Date.now(),
      });
      await drainPendingDispatches();
      expect(sendSpy).toHaveBeenCalledTimes(1);

      if (onCanceled == null) throw new Error("Expected monitor wake onCanceled callback");
      await onCanceled("cleared by user");

      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: {
            listPending: (id: string) => Promise<Array<{ lines: string[]; status: string }>>;
          };
        }
      ).bashMonitorWakeStore;
      const pending = await wakeStore.listPending(workspaceId);
      expect(pending).toHaveLength(1);
      expect(pending[0].lines).toEqual(["FAILED second"]);
      expect(pending[0].status).toBe("pending");
    } finally {
      await cleanup();
    }
  });

  test("does not requeue a canceled monitor wake while supersession is still writing", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-cancel-race-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => true) }),
      });
      let queueHasPendingMonitorWake = false;
      spyOn(workspaceService, "isBusyForMessage").mockReturnValue(true);
      spyOn(workspaceService, "hasPendingQueuedOrPreparingTurn").mockImplementation(
        () => queueHasPendingMonitorWake
      );
      const idleDeferred = createDeferred<void>();
      spyOn(workspaceService, "waitForIdleAndNoQueuedMessages").mockImplementation(
        () => idleDeferred.promise
      );
      type SendInternal = NonNullable<Parameters<WorkspaceService["sendMessage"]>[3]>;
      let onCanceled: SendInternal["onCanceled"] | undefined;
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          onCanceled = args[3]?.onCanceled;
          queueHasPendingMonitorWake = true;
          return Promise.resolve(Ok(undefined));
        }
      );

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED first"],
        totalMatches: 1,
        timestamp: Date.now(),
      });
      await waitForCondition(() => sendSpy.mock.calls.length === 1);

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED second"],
        totalMatches: 2,
        timestamp: Date.now(),
      });
      await drainPendingDispatches();

      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: {
            markSupersededSnapshot: (...args: unknown[]) => Promise<boolean>;
            listPending: (id: string) => Promise<Array<{ lines: string[] }>>;
          };
        }
      ).bashMonitorWakeStore;
      const originalMarkSuperseded = wakeStore.markSupersededSnapshot.bind(wakeStore);
      const supersedeStarted = createDeferred<void>();
      const releaseSupersede = createDeferred<void>();
      spyOn(wakeStore, "markSupersededSnapshot").mockImplementation(async (...args: unknown[]) => {
        supersedeStarted.resolve();
        await releaseSupersede.promise;
        return originalMarkSuperseded(...args);
      });

      if (onCanceled == null) throw new Error("Expected monitor wake onCanceled callback");
      const cancelPromise = onCanceled("cleared by user");
      await supersedeStarted.promise;
      queueHasPendingMonitorWake = false;
      idleDeferred.resolve();

      await drainPendingDispatches();
      expect(sendSpy).toHaveBeenCalledTimes(1);

      releaseSupersede.resolve();
      await cancelPromise;
      const pending = await wakeStore.listPending(workspaceId);
      expect(pending).toHaveLength(1);
      expect(pending[0].lines).toEqual(["FAILED second"]);
    } finally {
      await cleanup();
    }
  });

  test("does not send monitor wakes when the owner workspace is missing", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({ config, backgroundProcessManager });
      const sendSpy = spyOn(workspaceService, "sendMessage").mockResolvedValue(Ok(undefined));

      backgroundProcessManager.emit("monitor:match", "missing-owner", {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId: "missing-owner",
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED one"],
        totalMatches: 1,
        timestamp: Date.now(),
      });

      await drainPendingDispatches();
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  test("drains monitor wakes after stream errors", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-error-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      let streaming = true;
      const aiService = Object.assign(new EventEmitter(), {
        isStreaming: mock(() => streaming),
      }) as unknown as AIService & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService,
      });
      const sendSpy = spyOn(workspaceService, "sendMessage").mockResolvedValue(Ok(undefined));

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED one"],
        totalMatches: 1,
        timestamp: Date.now(),
      });
      await drainPendingDispatches();
      expect(sendSpy).not.toHaveBeenCalled();

      streaming = false;
      aiService.emit("error", { workspaceId, error: "provider failed" });

      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      expect(sendSpy.mock.calls[0][1]).toContain("FAILED one");
    } finally {
      await cleanup();
    }
  });

  test("does not spin idle waiters when only aiService reports an owner stream", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-busy-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => true) }),
      });
      const waitForIdleSpy = spyOn(
        workspaceService,
        "waitForIdleAndNoQueuedMessages"
      ).mockImplementation(() => new Promise(() => undefined));

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED one"],
        totalMatches: 1,
        timestamp: Date.now(),
      });
      await drainPendingDispatches();
      expect(waitForIdleSpy).not.toHaveBeenCalled();

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED two"],
        totalMatches: 2,
        timestamp: Date.now(),
      });

      await drainPendingDispatches();
      expect(waitForIdleSpy).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });
  test("supersedes a monitor wake whose matched output was already shown by a concurrent read", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-shown-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      // The screenshot bug: a task_await already delivered "ALL DONE exit=0" inline, advancing the
      // settled shown-frontier to (or past) where the match ends. The drain must drop the wake
      // rather than re-report the same line. This fails without the drain gate (emit-time
      // suppression alone loses the race with the exit-flush).
      const getSettledShownThroughOffset = mock(() => Promise.resolve(100));
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
        getSettledShownThroughOffset,
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          return Ok(undefined);
        }
      );

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "ALL DONE|FAIL",
        filterExclude: false,
        lines: ["ALL DONE exit=0"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 100,
      });

      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: { listPending: (id: string) => Promise<unknown[]> };
        }
      ).bashMonitorWakeStore;
      // Positive signal that the drain reached the gate (without the gate this is never called, so
      // this wait times out and the test fails -- proving the assertion below is not vacuous).
      await waitForCondition(() => getSettledShownThroughOffset.mock.calls.length >= 1);
      // The gate supersedes the record (no longer pending) without ever building a wake message.
      await waitForCondition(async () => (await wakeStore.listPending(workspaceId)).length === 0);
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  test("delivers a monitor wake when the matched output has not yet been shown", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-unshown-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      // Shown-frontier sits behind the match: the agent has not seen this output, so deliver.
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
        getSettledShownThroughOffset: mock(() => Promise.resolve(40)),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          return Ok(undefined);
        }
      );

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED one"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 100,
      });

      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      expect(sendSpy.mock.calls[0][1]).toContain("FAILED one");
    } finally {
      await cleanup();
    }
  });

  test("delivers the wake when the manager cannot report a shown-frontier (fail open)", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-failopen-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      // Partial manager stub without getSettledShownThroughOffset (older manager / narrow stub).
      // Even with a matchedThroughOffset present, the gate must fail open and deliver rather than
      // silently drop the wake.
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          return Ok(undefined);
        }
      );

      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-1",
        taskId: "bash:proc-1",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED one"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 100,
      });

      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      expect(sendSpy.mock.calls[0][1]).toContain("FAILED one");
    } finally {
      await cleanup();
    }
  });

  test("supersedes only the shown records in a mixed pending batch", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-mixed-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      // Two undelivered match wakes for different processes: one already shown to the agent, one not.
      // Seed them on disk before the service boots so its startup recovery drains both in one pass.
      const seedWakeStore = new BashMonitorWakeStore(config);
      await seedWakeStore.enqueueOrMergePending({
        processId: "proc-shown",
        taskId: "bash:proc-shown",
        workspaceId,
        filter: "DONE",
        filterExclude: false,
        lines: ["SHOWN-ALREADY done"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 50,
      });
      await seedWakeStore.enqueueOrMergePending({
        processId: "proc-unshown",
        taskId: "bash:proc-unshown",
        workspaceId,
        filter: "DONE",
        filterExclude: false,
        lines: ["UNSHOWN done"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 100,
      });

      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
        // proc-shown: frontier past its match (superseded). proc-unshown: frontier behind (delivered).
        getSettledShownThroughOffset: mock((processId: string) =>
          Promise.resolve(processId === "proc-shown" ? 100 : 10)
        ),
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          return Ok(undefined);
        }
      );

      // Startup recovery schedules a single drain for the owner's pending records.
      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      const prompt = sendSpy.mock.calls[0][1];
      expect(prompt).toContain("UNSHOWN done");
      expect(prompt).not.toContain("SHOWN-ALREADY done");
      // Only the unshown record survives into the delivered batch.
      expect(sendSpy.mock.calls[0][2]).toMatchObject({
        muxMetadata: {
          type: "bash-monitor-wake",
          records: [{ kind: "match", displayName: "proc-unshown", filter: "DONE" }],
        },
      });

      const wakeStore = (
        workspaceService as unknown as {
          bashMonitorWakeStore: { listPending: (id: string) => Promise<unknown[]> };
        }
      ).bashMonitorWakeStore;
      // proc-shown superseded, proc-unshown delivered -> nothing left pending.
      await waitForCondition(async () => (await wakeStore.listPending(workspaceId)).length === 0);
    } finally {
      await cleanup();
    }
  });

  test("delivers unrelated monitor wakes while one process is blocked by task_await", async () => {
    const { config, cleanup } = await createTestHistoryService();
    let blockedReadReleased = false;
    let resolveBlockedRead: () => void = () => undefined;
    const releaseBlockedRead = () => {
      blockedReadReleased = true;
      resolveBlockedRead();
    };
    try {
      const workspaceId = "bash-monitor-blocked-process-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      const seedWakeStore = new BashMonitorWakeStore(config);
      await seedWakeStore.enqueueOrMergePending({
        processId: "proc-blocked",
        taskId: "bash:proc-blocked",
        workspaceId,
        filter: "DONE",
        filterExclude: false,
        lines: ["BLOCKED done"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 100,
      });
      await seedWakeStore.enqueueOrMergePending({
        processId: "proc-ready",
        taskId: "bash:proc-ready",
        workspaceId,
        filter: "DONE",
        filterExclude: false,
        lines: ["READY done"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 100,
      });

      const blockedReadSettled = new Promise<void>((resolve) => {
        resolveBlockedRead = resolve;
      });
      const getMonitorWakeDeliveryState = mock((processId: string) =>
        Promise.resolve(
          processId === "proc-blocked" && !blockedReadReleased
            ? ({ status: "blocked", readSettled: blockedReadSettled } as const)
            : ({ status: "settled", shownThroughOffset: 0 } as const)
        )
      );
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
        getMonitorWakeDeliveryState,
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          return Ok(undefined);
        }
      );

      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      expect(sendSpy.mock.calls[0][1]).toContain("READY done");
      expect(sendSpy.mock.calls[0][1]).not.toContain("BLOCKED done");

      releaseBlockedRead();
      await waitForCondition(() => sendSpy.mock.calls.length === 2);
      expect(sendSpy.mock.calls[1][1]).toContain("BLOCKED done");
    } finally {
      releaseBlockedRead();
      await cleanup();
    }
  });

  test("delivers a stale-instance wake even after a reused process ID was read past the match", async () => {
    const { config, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "bash-monitor-reused-id-owner";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath,
        createdAt: "2026-01-01T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });

      // A wake from a dead instance is still pending. Its process ID was reclaimed by a newer live
      // instance that has since been read past the match. The gate binds its shown-frontier query
      // to the record's createdAt (the origin instance started before it), so the manager reports
      // it cannot vouch (undefined) for a live process that started later -- the wake fails open and
      // delivers rather than being superseded against the unrelated instance's frontier.
      const getSettledShownThroughOffset = mock((_processId: string, _originNotAfterMs?: number) =>
        Promise.resolve<number | undefined>(undefined)
      );
      const backgroundProcessManager = Object.assign(new EventEmitter(), {
        cleanup: mock(() => Promise.resolve()),
        getSettledShownThroughOffset,
      }) as unknown as BackgroundProcessManager & EventEmitter;
      const workspaceService = createWorkspaceServiceForTest({
        config,
        backgroundProcessManager,
        aiService: createMockAIService({ isStreaming: mock(() => false) }),
      });
      const sendSpy = spyOn(workspaceService, "sendMessage").mockImplementation(
        async (...args: Parameters<WorkspaceService["sendMessage"]>) => {
          await args[3]?.onAccepted?.();
          return Ok(undefined);
        }
      );

      const beforeEnqueue = Date.now();
      backgroundProcessManager.emit("monitor:match", workspaceId, {
        processId: "proc-reused",
        taskId: "bash:proc-reused",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED stale"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 100,
      });

      await waitForCondition(() => sendSpy.mock.calls.length === 1);
      const afterDelivery = Date.now();
      expect(sendSpy.mock.calls[0][1]).toContain("FAILED stale");
      // The gate binds the query to the record's createdAt (a wall-clock ms stamped at enqueue),
      // not a persisted instance token -- so the forwarded origin bound falls in the enqueue window.
      const forwardedOrigin = getSettledShownThroughOffset.mock.calls[0][1];
      expect(typeof forwardedOrigin).toBe("number");
      expect(forwardedOrigin).toBeGreaterThanOrEqual(beforeEnqueue);
      expect(forwardedOrigin).toBeLessThanOrEqual(afterDelivery);
    } finally {
      await cleanup();
    }
  });
});

describe("WorkspaceService workflow activity", () => {
  test("caches active workflow run counts and updates emitted activity from status events", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const listStatusSnapshotsSpy = spyOn(WorkflowRunStore.prototype, "listRunStatusSnapshots");
    try {
      const workspaceId = "workflow-activity";
      const projectPath = path.join(config.rootDir, "project");
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-activity",
        projectName: "project",
        projectPath,
        createdAt: "2026-06-17T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        path.join(config.rootDir, "extensionMetadata.json")
      );
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir(workspaceId) });
      const definition = {
        name: "demo",
        description: "Demo workflow",
        scope: "global" as const,
        executable: true,
      };
      await runStore.createRun({
        id: "wfr_active",
        workspaceId,
        workflow: definition,
        source: "export default function workflow() { return {}; }",
        args: {},
        now: "2026-06-17T00:00:00.000Z",
      });
      await runStore.createRun({
        id: "wfr_nested",
        workspaceId,
        workflow: definition,
        source: "export default function workflow() { return {}; }",
        args: {},
        parentWorkflow: { runId: "wfr_active", stepId: "child", inputHash: "hash", depth: 0 },
        now: "2026-06-17T00:00:01.000Z",
      });

      expect((await workspaceService.getActivityList())[workspaceId]?.activeWorkflowRunIds).toEqual(
        ["wfr_active"]
      );
      expect((await workspaceService.getActivityList())[workspaceId]?.activeWorkflowRunCount).toBe(
        1
      );
      expect((await workspaceService.getActivityList())[workspaceId]?.activeWorkflowRunCount).toBe(
        1
      );
      expect(listStatusSnapshotsSpy).toHaveBeenCalledTimes(1);

      const activityEvents: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      workspaceService.on("activity", (event) => activityEvents.push(event));
      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_active",
        status: "completed",
      });
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunIds).toBeUndefined();
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBeUndefined();

      const clearedActivityList = await workspaceService.getActivityList();
      expect(clearedActivityList[workspaceId]).toBeDefined();
      expect(clearedActivityList[workspaceId]?.activeWorkflowRunCount).toBeUndefined();

      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_next",
        status: "running",
      });
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunIds).toEqual(["wfr_next"]);
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBe(1);
      await workspaceService.updateAgentStatus(workspaceId, {
        emoji: "🔄",
        message: "Still running workflow",
      });
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBe(1);

      workspaceService.emitWorkspaceActivity(workspaceId, {
        recency: Date.now(),
        streaming: false,
        lastModel: null,
        lastThinkingLevel: null,
      });
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBe(1);

      expect(listStatusSnapshotsSpy).toHaveBeenCalledTimes(1);
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      await cleanup();
    }
  });

  test("shares initial active workflow cache bootstrap across parallel status events", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const scanStarted = createDeferred<void>();
    const releaseScan = createDeferred<void>();
    const listStatusSnapshotsSpy = spyOn(
      WorkflowRunStore.prototype,
      "listRunStatusSnapshots"
    ).mockImplementation(async () => {
      scanStarted.resolve();
      await releaseScan.promise;
      return [];
    });

    try {
      const workspaceId = "workflow-activity-race";
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
      });
      const activityEvents: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      workspaceService.on("activity", (event) => activityEvents.push(event));

      const first = workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_first",
        status: "running",
      });
      await scanStarted.promise;
      const second = workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_second",
        status: "running",
      });

      releaseScan.resolve();
      await Promise.all([first, second]);

      expect(listStatusSnapshotsSpy).toHaveBeenCalledTimes(1);
      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBe(2);
      expect((await workspaceService.getActivityList())[workspaceId]?.activeWorkflowRunCount).toBe(
        2
      );
    } finally {
      listStatusSnapshotsSpy.mockRestore();
      releaseScan.resolve();
      await cleanup();
    }
  });

  test("emits current workflow count after overlapping metadata snapshot reads", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const firstSnapshotStarted = createDeferred<void>();
    const releaseFirstSnapshot = createDeferred<void>();
    const extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    const getSnapshotSpy = spyOn(extensionMetadata, "getSnapshot");

    try {
      const workspaceId = "workflow-activity-overlap";
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        extensionMetadata,
      });
      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_first",
        status: "running",
      });
      await workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_second",
        status: "running",
      });

      let shouldDelayNextSnapshot = true;
      getSnapshotSpy.mockImplementation(async (id: string) => {
        if (shouldDelayNextSnapshot) {
          shouldDelayNextSnapshot = false;
          firstSnapshotStarted.resolve();
          await releaseFirstSnapshot.promise;
        }
        return ExtensionMetadataService.prototype.getSnapshot.call(extensionMetadata, id);
      });
      const activityEvents: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      workspaceService.on("activity", (event) => activityEvents.push(event));

      const first = workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_first",
        status: "completed",
      });
      await firstSnapshotStarted.promise;
      const second = workspaceService.emitWorkflowRunActivity({
        workspaceId,
        runId: "wfr_second",
        status: "completed",
      });

      await second;
      releaseFirstSnapshot.resolve();
      await first;

      expect(activityEvents.at(-1)?.activity?.activeWorkflowRunCount).toBeUndefined();
      expect(
        (await workspaceService.getActivityList())[workspaceId]?.activeWorkflowRunCount
      ).toBeUndefined();
    } finally {
      getSnapshotSpy.mockRestore();
      releaseFirstSnapshot.resolve();
      await cleanup();
    }
  });
});

describe("WorkspaceService workflow invocation events", () => {
  test("emits workflow slash invocation rows through the active session chat stream", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-live-events";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-live-events",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });
      const session = workspaceService.getOrCreateSession(workspaceId);
      const events: WorkspaceChatMessage[] = [];
      const unsubscribe = session.onChatEvent(({ message }) => {
        events.push(message);
      });

      try {
        const persisted = await workspaceService.appendWorkflowRunInvocation({
          workspaceId,
          rawCommand: "/demo investigate live events",
          scriptPath: "./workflows/demo.js",
          args: { input: "investigate live events" },
          runId: "wfr_live_events",
          status: "running",
          result: null,
        });

        expect(persisted).toBe(true);
        expect(events).toHaveLength(2);
        const triggerMessage = events[0];
        const cardMessage = events[1];
        if (triggerMessage?.type !== "message" || cardMessage?.type !== "message") {
          throw new Error("Expected workflow invocation to emit message events");
        }
        expect(triggerMessage).toMatchObject({ role: "user", type: "message" });
        expect(triggerMessage.metadata?.muxMetadata).toEqual(
          expect.objectContaining({ type: WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE })
        );
        expect(cardMessage).toMatchObject({ role: "assistant", type: "message" });
        expect(cardMessage.metadata?.muxMetadata).toEqual(
          expect.objectContaining({ type: WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE })
        );
      } finally {
        unsubscribe();
        workspaceService.disposeSession(workspaceId);
      }
    } finally {
      await cleanup();
    }
  });

  test("keeps workflow invocations current across synthetic user continuations", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness";
    const runId = "wfr_currentness";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("synthetic-await", "user", "Call task_await", {
          timestamp: 1_100,
          synthetic: true,
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "Never mind, answer something else", {
          timestamp: 1_200,
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("counts workflow_resume output as the current invocation after manual supersession", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-resume";
    const runId = "wfr_currentness_resume";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-resume",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("manual-user", "user", "Never mind, answer something else", {
          timestamp: 1_100,
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);

      // An unrelated tool output mentioning the run does not re-establish the invocation.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-unrelated-tool", "assistant", "", { timestamp: 1_200 }, [
          {
            type: "dynamic-tool",
            toolCallId: "task-list-1",
            toolName: "task_list",
            state: "output-available",
            input: {},
            output: { status: "running", runId, result: null },
          },
        ])
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);

      // workflow_resume re-attaches the agent to the run, so the invocation counts as current
      // again and the terminal continuation would be delivered.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-resume", "assistant", "", { timestamp: 1_300 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-resume-1",
            toolName: "workflow_resume",
            state: "output-available",
            input: { run_id: runId, mode: "resume", run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);
      workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test.each(["workflow_run", "workflow_resume"] as const)(
    "treats terminal %s output as a consumed workflow result",
    async (toolName) => {
      const { config, historyService, cleanup } = await createTestHistoryService();
      const workspaceId = `workflow-terminal-${toolName}`;
      const runId = `wfr_terminal_${toolName}`;
      const projectPath = path.join(config.rootDir, "project");
      try {
        await config.addWorkspace(projectPath, {
          id: workspaceId,
          name: workspaceId,
          projectName: "project",
          projectPath,
          runtimeConfig: { type: "local" },
        });
        const workspaceService = createWorkspaceServiceForTest({
          config,
          historyService,
          aiService: createMockAIService({
            stopStream: mock(() => Promise.resolve(Ok(undefined))),
          }),
          extensionMetadata: new ExtensionMetadataService(
            path.join(config.rootDir, "extensionMetadata.json")
          ),
          initStateManager: {
            ...mockInitStateManager,
            off: mock(() => undefined as unknown as InitStateManager),
          } as unknown as InitStateManager,
        });

        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage(`assistant-${toolName}`, "assistant", "", { timestamp: 1_000 }, [
            {
              type: "dynamic-tool",
              toolCallId: `${toolName}-call-1`,
              toolName,
              state: "output-available",
              input:
                toolName === "workflow_run"
                  ? { script_path: "./workflows/demo.js", args: {}, run_in_background: false }
                  : { run_id: runId, mode: "resume", run_in_background: false },
              output: {
                status: "completed",
                runId,
                result: { reportMarkdown: "done" },
              },
            },
          ])
        );

        expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
        workspaceService.disposeSession(workspaceId);
      } finally {
        await cleanup();
      }
    }
  );

  test("keeps workflow invocations current across mid-stream auto-compaction requests", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-midstream-compact";
    const runId = "wfr_currentness_midstream_compact";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-midstream-compact",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("midstream-auto-compaction", "user", "Compacting to continue", {
          timestamp: 1_100,
          synthetic: true,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: {
              followUpContent: {
                text: "Continue",
                model: "openai:gpt-5.2",
                agentId: "exec",
                dispatchOptions: { source: "internal-resume" },
              },
            },
            source: "auto-compaction",
          },
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);
      workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("treats on-send compaction requests as manual workflow supersession", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-auto-compact";
    const runId = "wfr_currentness_auto_compact";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-auto-compact",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("auto-compaction", "user", "Compacting before a new user prompt", {
          timestamp: 1_100,
          synthetic: true,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: {},
            source: "auto-compaction",
          },
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("keeps workflow invocations current across compaction boundaries", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-boundary";
    const runId = "wfr_currentness_boundary";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-boundary",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      const persisted = await workspaceService.appendWorkflowRunInvocation({
        workspaceId,
        rawCommand: "/demo currentness boundary",
        scriptPath: "./workflows/demo.js",
        args: { input: "currentness boundary" },
        runId,
        status: "running",
        result: null,
      });
      expect(persisted).toBe(true);
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("boundary", "assistant", "Compacted summary", {
          timestamp: 2_000,
          compactionBoundary: true,
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);
      workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("treats reset boundaries as workflow supersession", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-reset";
    const runId = "wfr_currentness_reset";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-reset",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("reset-boundary", "assistant", "Context reset", {
          timestamp: 1_100,
          contextBoundaryKind: "reset",
        })
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("keeps workflow current after non-terminal task_await errors", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-error";
    const runId = "wfr_currentness_error";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-error",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage(
          "assistant-task-await-active-error",
          "assistant",
          "",
          { timestamp: 1_100 },
          [
            {
              type: "dynamic-tool",
              toolCallId: "task-await-1",
              toolName: "task_await",
              state: "output-available",
              input: { task_ids: [runId] },
              output: {
                results: [
                  {
                    taskId: runId,
                    status: "error",
                    error: "Interrupted",
                    run: { id: runId, status: "running" },
                  },
                ],
              },
            },
          ]
        )
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage(
          "assistant-task-await-failed-error",
          "assistant",
          "",
          { timestamp: 1_200 },
          [
            {
              type: "dynamic-tool",
              toolCallId: "task-await-2",
              toolName: "task_await",
              state: "output-available",
              input: { task_ids: [runId] },
              output: {
                results: [
                  {
                    taskId: runId,
                    status: "error",
                    error: "Workflow failed",
                    run: { id: runId, status: "failed" },
                  },
                ],
              },
            },
          ]
        )
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });

  test("marks workflow invocations consumed after terminal task_await results", async () => {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "workflow-currentness-consumed";
    const runId = "wfr_currentness_consumed";
    const projectPath = path.join(config.rootDir, "project");
    try {
      await config.addWorkspace(projectPath, {
        id: workspaceId,
        name: "workflow-currentness-consumed",
        projectName: "project",
        projectPath,
        runtimeConfig: { type: "local" },
      });
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          stopStream: mock(() => Promise.resolve(Ok(undefined))),
        }),
        extensionMetadata: new ExtensionMetadataService(
          path.join(config.rootDir, "extensionMetadata.json")
        ),
        initStateManager: {
          ...mockInitStateManager,
          off: mock(() => undefined as unknown as InitStateManager),
        } as unknown as InitStateManager,
      });

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-workflow-run", "assistant", "", { timestamp: 1_000 }, [
          {
            type: "dynamic-tool",
            toolCallId: "workflow-call-1",
            toolName: "workflow_run",
            state: "output-available",
            input: { script_path: "./workflows/demo.js", args: {}, run_in_background: true },
            output: { status: "running", runId, result: null },
          },
        ])
      );
      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(true);

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("assistant-task-await", "assistant", "", { timestamp: 1_100 }, [
          {
            type: "dynamic-tool",
            toolCallId: "task-await-1",
            toolName: "task_await",
            state: "output-available",
            input: { task_ids: [runId] },
            output: { results: [{ taskId: runId, status: "completed" }] },
          },
        ])
      );

      expect(await workspaceService.isWorkflowInvocationCurrent(workspaceId, runId)).toBe(false);
      workspaceService.disposeSession(workspaceId);
    } finally {
      await cleanup();
    }
  });
});

describe("WorkspaceService truncateHistory goal acknowledgment", () => {
  async function createServices(aiServiceOverride?: AIService) {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    const aiService =
      aiServiceOverride ??
      ({
        on: mock(() => undefined),
        isStreaming: mock(() => false),
      } as unknown as AIService);
    const initStateManager = {
      on: mock(() => undefined),
      getInitState: mock(() => null),
    } as unknown as InitStateManager;
    const workspaceService = new WorkspaceService(
      config,
      historyService,
      aiService,
      initStateManager,
      extensionMetadata,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
    const goalService = new WorkspaceGoalService(config, historyService, extensionMetadata);
    workspaceService.setWorkspaceGoalService(goalService);
    return { aiService, config, historyService, workspaceService, goalService, cleanup };
  }

  test("idle wait follows auto-retry startup into the resumed stream", async () => {
    const { workspaceService, cleanup } = await createServices();
    const workspaceId = "idle-wait-auto-retry-starting";
    const chatEvents = new EventEmitter();
    let busy = false;
    let pendingAutoRetry = true;
    const idleWaiters: Array<() => void> = [];
    const waitForIdle = mock(() => {
      if (!busy) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    });
    interface WaitSessionEvent {
      message: { type: string };
    }
    const session = {
      isBusy: mock(() => busy),
      hasQueuedMessages: mock(() => false),
      hasPendingAutoRetry: mock(() => pendingAutoRetry),
      waitForIdle,
      onChatEvent: mock((listener: (event: WaitSessionEvent) => void) => {
        chatEvents.on("chat-event", listener);
        return () => chatEvents.off("chat-event", listener);
      }),
    } as unknown as AgentSession;
    const internalWorkspaceService = workspaceService as unknown as {
      sessions: Map<string, AgentSession>;
    };

    try {
      internalWorkspaceService.sessions.set(workspaceId, session);
      let resolved = false;
      const waitPromise = workspaceService.waitForIdleAndNoQueuedMessages(workspaceId).then(() => {
        resolved = true;
      });
      await Promise.resolve();

      chatEvents.emit("chat-event", { message: { type: "auto-retry-starting" } });
      await Promise.resolve();
      expect(resolved).toBe(false);

      busy = true;
      chatEvents.emit("chat-event", { message: { type: "stream-lifecycle" } });
      await waitForCondition(() => idleWaiters.length === 1);
      expect(resolved).toBe(false);

      busy = false;
      pendingAutoRetry = false;
      idleWaiters.splice(0).forEach((resolve) => resolve());
      await waitPromise;

      expect(resolved).toBe(true);
      expect(waitForIdle).toHaveBeenCalledTimes(1);
    } finally {
      internalWorkspaceService.sessions.delete(workspaceId);
      await cleanup();
    }
  });

  test("destructive clear waits for startup monitor recovery discovery", async () => {
    const { historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "clear-waits-for-monitor-recovery";
    const recovery = createDeferred<void>();
    const internal = workspaceService as unknown as {
      bashMonitorRecoveryPromise: Promise<void>;
    };
    internal.bashMonitorRecoveryPromise = recovery.promise;
    const truncateSpy = spyOn(historyService, "truncateHistory").mockResolvedValue(Ok([]));

    try {
      const clearPromise = workspaceService.truncateHistory(workspaceId, 1.0);
      await drainPendingDispatches();
      expect(truncateSpy).not.toHaveBeenCalled();

      recovery.resolve();
      expect(await clearPromise).toEqual(Ok(undefined));
      expect(truncateSpy).toHaveBeenCalledTimes(1);
    } finally {
      recovery.resolve();
      truncateSpy.mockRestore();
      await cleanup();
    }
  });

  test("full chat clear preserves the goal and requires user acknowledgment", async () => {
    const { config, historyService, workspaceService, goalService, cleanup } =
      await createServices();
    const workspaceId = "clear-goal-workspace";
    try {
      await config.addWorkspace("/tmp/clear-goal-project", {
        id: workspaceId,
        name: "clear-goal-workspace",
        projectName: "clear-goal-project",
        projectPath: "/tmp/clear-goal-project",
        runtimeConfig: { type: "local" },
      });
      const created = await setWorkspaceGoalOk(goalService, {
        workspaceId,
        objective: "Keep pursuing the objective",
      });
      const appendResult = await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("clear-goal-message", "user", "please remember this", {})
      );
      expect(appendResult.success).toBe(true);

      const nowSpy = spyOn(Date, "now").mockReturnValue(1_234_567);
      try {
        const result = await workspaceService.truncateHistory(workspaceId, 1.0);
        expect(result.success).toBe(true);
      } finally {
        nowSpy.mockRestore();
      }

      expect(await goalService.getGoal(workspaceId)).toMatchObject({
        goalId: created.goalId,
        objective: created.objective,
        requireUserAcknowledgmentSinceMs: 1_234_567,
      });
    } finally {
      await cleanup();
    }
  });

  test("full chat clear retires pending monitor wakes before deleting acceptance proof", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "clear-pending-monitor-wake";
    try {
      await config.addWorkspace("/tmp/clear-monitor-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "clear-monitor-project",
        projectPath: "/tmp/clear-monitor-project",
        runtimeConfig: { type: "local" },
      });
      const wakeStore = new BashMonitorWakeStore(config);
      const record = await wakeStore.enqueueOrMergePending({
        processId: "clear-proc",
        taskId: "bash:clear-proc",
        workspaceId,
        filter: "DONE",
        filterExclude: false,
        lines: ["DONE before clear"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 17,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("accepted-before-clear", "user", "Accepted wake", {
          synthetic: true,
          muxMetadata: buildBashMonitorWakeMetadata([record]),
        })
      );

      const result = await workspaceService.truncateHistory(workspaceId, 1.5);

      expect(result.success).toBe(true);
      expect(await wakeStore.listPending(workspaceId)).toEqual([]);
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history).toEqual(Ok([]));
    } finally {
      await cleanup();
    }
  });

  test("partial truncation that deletes every row retires accepted monitor wakes", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "partial-truncation-deletes-all-monitor-wake";
    try {
      await config.addWorkspace("/tmp/partial-delete-all-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "partial-delete-all-project",
        projectPath: "/tmp/partial-delete-all-project",
        runtimeConfig: { type: "local" },
      });
      const wakeStore = new BashMonitorWakeStore(config);
      const record = await wakeStore.enqueueOrMergePending({
        processId: "partial-delete-proc",
        taskId: "bash:partial-delete-proc",
        workspaceId,
        filter: "DONE",
        filterExclude: false,
        lines: ["DONE before partial deletion"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 29,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("partial-delete-accepted", "user", "Accepted wake", {
          synthetic: true,
          muxMetadata: buildBashMonitorWakeMetadata([record]),
        })
      );

      const result = await workspaceService.truncateHistory(workspaceId, 0.75);

      expect(result.success).toBe(true);
      expect(await wakeStore.listPending(workspaceId)).toEqual([]);
      expect(await historyService.getHistoryFromLatestBoundary(workspaceId)).toEqual(Ok([]));
    } finally {
      await cleanup();
    }
  });

  test("history scan failure blocks destructive clear without retiring wakes", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "clear-history-scan-failure";
    try {
      await config.addWorkspace("/tmp/clear-history-scan-failure-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "clear-history-scan-failure-project",
        projectPath: "/tmp/clear-history-scan-failure-project",
        runtimeConfig: { type: "local" },
      });
      const wakeStore = new BashMonitorWakeStore(config);
      await wakeStore.enqueueOrMergePending({
        processId: "scan-failure-proc",
        taskId: "bash:scan-failure-proc",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED before scan"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 19,
      });
      const iterateSpy = spyOn(historyService, "iterateFullHistory").mockResolvedValue(
        Err("injected history scan failure")
      );

      const result = await workspaceService.truncateHistory(workspaceId, 1.0);

      expect(result).toEqual(
        Err("Cannot clear history while monitor wake acceptance cannot be verified.")
      );
      expect(await wakeStore.listPending(workspaceId)).toHaveLength(1);
      iterateSpy.mockRestore();
    } finally {
      await cleanup();
    }
  });

  test("failed full clear restores pending monitor wakes", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "failed-clear-restores-monitor-wake";
    try {
      await config.addWorkspace("/tmp/failed-clear-monitor-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "failed-clear-monitor-project",
        projectPath: "/tmp/failed-clear-monitor-project",
        runtimeConfig: { type: "local" },
      });
      const wakeStore = new BashMonitorWakeStore(config);
      await wakeStore.enqueueOrMergePending({
        processId: "failed-clear-proc",
        taskId: "bash:failed-clear-proc",
        workspaceId,
        filter: "FAILED",
        filterExclude: false,
        lines: ["FAILED before clear"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 20,
      });
      const truncateSpy = spyOn(historyService, "truncateHistory").mockResolvedValue(
        Err("injected clear failure")
      );

      const result = await workspaceService.truncateHistory(workspaceId, 1.0);

      expect(result).toEqual(Err("injected clear failure"));
      expect(await wakeStore.listPending(workspaceId)).toHaveLength(1);
      truncateSpy.mockRestore();
    } finally {
      await cleanup();
    }
  });

  test("partially committed clear keeps an accepted wake retired", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "partial-clear-keeps-accepted-retired";
    try {
      await config.addWorkspace("/tmp/partial-clear-monitor-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "partial-clear-monitor-project",
        projectPath: "/tmp/partial-clear-monitor-project",
        runtimeConfig: { type: "local" },
      });
      const wakeStore = new BashMonitorWakeStore(config);
      const record = await wakeStore.enqueueOrMergePending({
        processId: "partial-clear-proc",
        taskId: "bash:partial-clear-proc",
        workspaceId,
        filter: "DONE",
        filterExclude: false,
        lines: ["DONE before partial clear"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 25,
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("partial-clear-accepted", "user", "Accepted wake", {
          synthetic: true,
          muxMetadata: buildBashMonitorWakeMetadata([record]),
        })
      );
      const originalTruncate = historyService.truncateHistory.bind(historyService);
      const truncateSpy = spyOn(historyService, "truncateHistory").mockImplementation(
        async (...args) => {
          const result = await originalTruncate(...args);
          expect(result.success).toBe(true);
          return Err("injected post-clear failure");
        }
      );

      const result = await workspaceService.truncateHistory(workspaceId, 1.0);

      expect(result).toEqual(Err("injected post-clear failure"));
      expect(await wakeStore.listPending(workspaceId)).toEqual([]);
      truncateSpy.mockRestore();
    } finally {
      await cleanup();
    }
  });

  test("destructive history replacement retires pending monitor wakes", async () => {
    const { config, workspaceService, cleanup } = await createServices();
    const workspaceId = "replace-pending-monitor-wake";
    try {
      await config.addWorkspace("/tmp/replace-monitor-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "replace-monitor-project",
        projectPath: "/tmp/replace-monitor-project",
        runtimeConfig: { type: "local" },
      });
      const wakeStore = new BashMonitorWakeStore(config);
      await wakeStore.enqueueOrMergePending({
        processId: "replace-proc",
        taskId: "bash:replace-proc",
        workspaceId,
        filter: "DONE",
        filterExclude: false,
        lines: ["DONE before replace"],
        totalMatches: 1,
        timestamp: Date.now(),
        matchedThroughOffset: 19,
      });

      const result = await workspaceService.replaceHistory(
        workspaceId,
        createMuxMessage("replacement-summary", "assistant", "Replacement summary", {})
      );

      expect(result.success).toBe(true);
      expect(await wakeStore.listPending(workspaceId)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("full chat clear without a goal does not create goal state", async () => {
    const { config, workspaceService, goalService, cleanup } = await createServices();
    const workspaceId = "clear-without-goal-workspace";
    try {
      await config.addWorkspace("/tmp/clear-without-goal-project", {
        id: workspaceId,
        name: "clear-without-goal-workspace",
        projectName: "clear-without-goal-project",
        projectPath: "/tmp/clear-without-goal-project",
        runtimeConfig: { type: "local" },
      });

      const result = await workspaceService.truncateHistory(workspaceId, 1.0);

      expect(result.success).toBe(true);
      expect(await goalService.getGoal(workspaceId)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test("context reset appends a boundary and preserves transcript history", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-preserves-history";
    try {
      await config.addWorkspace("/tmp/context-reset-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-project",
        projectPath: "/tmp/context-reset-project",
        runtimeConfig: { type: "local" },
      });
      expect(
        (
          await historyService.appendToHistory(
            workspaceId,
            createMuxMessage("pre-reset-user", "user", "before reset", {})
          )
        ).success
      ).toBe(true);

      const result = await workspaceService.resetContext(workspaceId);

      expect(result).toEqual({ success: true, data: "reset" });
      const activeWindow = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(activeWindow.success).toBe(true);
      const activeIds = activeWindow.success ? activeWindow.data.map((message) => message.id) : [];
      expect(activeIds).toHaveLength(1);
      expect(activeIds[0]?.startsWith("context-reset-")).toBe(true);
      expect(
        activeWindow.success ? activeWindow.data[0]?.metadata?.contextBoundaryKind : undefined
      ).toBe("reset");

      const allMessages: string[] = [];
      const iterateResult = await historyService.iterateFullHistory(
        workspaceId,
        "forward",
        (messages) => {
          allMessages.push(...messages.map((message) => message.id));
        }
      );
      expect(iterateResult.success).toBe(true);
      expect(allMessages).toHaveLength(2);
      expect(allMessages[0]).toBe("pre-reset-user");
      expect(allMessages[1]?.startsWith("context-reset-")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("start-here replacement does not auto-compact the next send from stale usage", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "start-here-clears-usage-state";
    const streamMessage = mock((..._args: unknown[]) => Promise.resolve(Ok(undefined)));
    const harness = await createAgentSessionHarness({
      workspaceId,
      config,
      historyService,
      aiServiceOverrides: {
        streamMessage: streamMessage as unknown as AIService["streamMessage"],
      },
    });
    try {
      await config.addWorkspace("/tmp/start-here-usage-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "start-here-usage-project",
        projectPath: "/tmp/start-here-usage-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-start-here-user", "user", "long conversation", {})
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-start-here-assistant", "assistant", "long reply", {
          model: "openai:gpt-4o",
          contextUsage: { inputTokens: 95_000, outputTokens: 200, totalTokens: 95_200 },
        })
      );

      (workspaceService as unknown as { sessions: Map<string, AgentSession> }).sessions.set(
        workspaceId,
        harness.session
      );
      (harness.session as unknown as { lastUsageState?: AutoCompactionUsageState }).lastUsageState =
        {
          lastContextUsage: createDisplayUsage(
            { inputTokens: 95_000, outputTokens: 200, totalTokens: 95_200 },
            "openai:gpt-4o"
          ),
        };

      expect(
        (
          await workspaceService.replaceHistory(
            workspaceId,
            createMuxMessage("start-here-summary", "assistant", "Start Here summary", {
              compacted: "user",
            }),
            { mode: "append-compaction-boundary" }
          )
        ).success
      ).toBe(true);
      expect(
        (
          await harness.session.sendMessage("follow-up after start here", {
            model: "openai:gpt-4o",
            agentId: "exec",
          })
        ).success
      ).toBe(true);

      const activeWindow = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(activeWindow.success).toBe(true);
      const activeMessages = activeWindow.success ? activeWindow.data : [];
      expect(
        activeMessages.filter(
          (message) => message.metadata?.muxMetadata?.type === "compaction-request"
        )
      ).toHaveLength(0);
      expect(activeMessages.find((message) => message.role === "user")?.parts[0]).toMatchObject({
        type: "text",
        text: "follow-up after start here",
      });
      expect(streamMessage).toHaveBeenCalledTimes(1);
    } finally {
      harness.session.dispose();
      await cleanup();
    }
  });

  test("context reset is a no-op when repeated without provider-eligible messages", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-noop";
    try {
      await config.addWorkspace("/tmp/context-reset-noop-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-noop-project",
        projectPath: "/tmp/context-reset-noop-project",
        runtimeConfig: { type: "local" },
      });
      expect(
        (
          await historyService.appendToHistory(
            workspaceId,
            createMuxMessage("pre-reset-user", "user", "before reset", {})
          )
        ).success
      ).toBe(true);

      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "reset",
      });
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "noop",
      });

      let boundaryCount = 0;
      const iterateResult = await historyService.iterateFullHistory(
        workspaceId,
        "forward",
        (messages) => {
          boundaryCount += messages.filter(
            (message) => message.metadata?.contextBoundaryKind === "reset"
          ).length;
        }
      );
      expect(iterateResult.success).toBe(true);
      expect(boundaryCount).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test("context reset discards persisted post-compaction carryover", async () => {
    // An RLM compaction persists cumulative read-file paths / loaded skills
    // (post-compaction.json). A reset starts a NEW context segment: without
    // discarding that state, a later turn would inject PRE-reset read paths
    // (even in a fresh session after a restart), resurrecting context the
    // reset was meant to discard.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-post-compaction";
    try {
      await config.addWorkspace("/tmp/context-reset-post-compaction-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-post-compaction-project",
        projectPath: "/tmp/context-reset-post-compaction-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      const sessionDir = config.getSessionDir(workspaceId);
      await fsPromises.mkdir(sessionDir, { recursive: true });
      const pendingStatePath = path.join(sessionDir, "post-compaction.json");
      await fsPromises.writeFile(
        pendingStatePath,
        JSON.stringify({
          version: 1,
          createdAt: Date.now(),
          diffs: [],
          loadedSkills: [],
          readFiles: ["/tmp/pre-reset-read.ts"],
        })
      );

      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "reset",
      });

      const stateExists = await fsPromises.access(pendingStatePath).then(
        () => true,
        () => false
      );
      expect(stateExists).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("context reset fails when the post-compaction carryover discard is not durable", async () => {
    // Best-effort deletion of post-compaction.json swallowed unlink failures
    // while resetContext still reported success — after a restart the stale
    // file re-injects PRE-reset read paths/skills/diffs. The discard must be
    // durable-or-fail, matching the sandbox invalidation posture.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-carryover-not-durable";
    try {
      await config.addWorkspace("/tmp/context-reset-carryover-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-carryover-project",
        projectPath: "/tmp/context-reset-carryover-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      // Deterministic unlink failure: a DIRECTORY at the pending-state path
      // fails unlink with EISDIR (read errors are swallowed at load, so this
      // models exactly the stale-undeletable-file case).
      const pendingStatePath = path.join(config.getSessionDir(workspaceId), "post-compaction.json");
      await fsPromises.mkdir(pendingStatePath, { recursive: true });

      const result = await workspaceService.resetContext(workspaceId);
      expect(result.success).toBe(false);
      expect(result.success ? "" : result.error).toContain("post-compaction carryover");
    } finally {
      await cleanup();
    }
  });

  test("context reset fails when the sandbox invalidation is not durable", async () => {
    // The reset's kernel-vars invalidation is only durable once the
    // empty-snapshot tombstone publishes; the in-memory reset-pending guard
    // dies with the process. Reporting Ok on a failed publish would hide that
    // a restart can resurrect the cleared (potentially sensitive) vars, so
    // the failure must reach the caller as a partial-failure error.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-sandbox-invalidation";
    try {
      await config.addWorkspace("/tmp/context-reset-sandbox-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-sandbox-project",
        projectPath: "/tmp/context-reset-sandbox-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      const discardSpy = spyOn(sandboxHostService, "discardScope").mockImplementationOnce(() =>
        Promise.reject(new Error("journal write failed"))
      );

      try {
        const result = await workspaceService.resetContext(workspaceId);
        expect(result.success).toBe(false);
        expect(result.success ? "" : result.error).toContain("durably invalidated");
        expect(result.success ? "" : result.error).toContain("journal write failed");

        // A retry reaches the no-op branch (the boundary row already
        // landed) — it must RE-ATTEMPT the pending cleanup, not report
        // success while the invalidation is still not durable: a restart
        // could otherwise restore pre-reset kernel vars across the boundary.
        discardSpy.mockImplementationOnce(() => Promise.reject(new Error("journal write failed")));
        const retry = await workspaceService.resetContext(workspaceId);
        expect(retry.success).toBe(false);
        expect(retry.success ? "" : retry.error).toContain("durably invalidated");
      } finally {
        discardSpy.mockRestore();
      }

      // Once cleanup succeeds, the retry settles as a clean noop (the
      // chat-side boundary already applied; the real discard re-runs and
      // lands durably).
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "noop",
      });
    } finally {
      await cleanup();
    }
  });

  test("full history clear durably discards sandbox kernel state", async () => {
    // A full /clear removes the transcript; kernel vars DERIVED from it (and
    // restorable from the latest durable snapshot after a restart) must not
    // stay readable through the sandbox — same invalidation boundary as
    // resetContext. Partial truncation keeps context, so it must NOT discard.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "full-clear-sandbox-discard";
    try {
      await config.addWorkspace("/tmp/full-clear-sandbox-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "full-clear-sandbox-project",
        projectPath: "/tmp/full-clear-sandbox-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", "before clear", {})
      );
      const discardSpy = spyOn(sandboxHostService, "discardScope").mockImplementation(() =>
        Promise.resolve()
      );
      try {
        expect(await workspaceService.truncateHistory(workspaceId, 0.5)).toEqual({
          success: true,
          data: undefined,
        });
        expect(discardSpy).not.toHaveBeenCalled();

        expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
          success: true,
          data: undefined,
        });
        expect(discardSpy).toHaveBeenCalledTimes(1);

        // Same partial-failure posture as resetContext: history IS cleared,
        // but a non-durable invalidation must fail the operation (a restart
        // could otherwise resurrect the cleared vars from the snapshot).
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage("pre-clear-user-2", "user", "before second clear", {})
        );
        discardSpy.mockImplementationOnce(() => Promise.reject(new Error("journal write failed")));
        const failed = await workspaceService.truncateHistory(workspaceId);
        expect(failed.success).toBe(false);
        expect(failed.success ? "" : failed.error).toContain("durably invalidated");
      } finally {
        discardSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context-discarding mutations drain in-flight refine passes", async () => {
    // A streaming refine pass distills the current transcript; reset and
    // full clear discard it, so both must cancel + drain the pass before
    // mutating (a late proposal would otherwise describe discarded context).
    // Partial truncation keeps context and must NOT drain.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "clear-drains-refine";
    try {
      await config.addWorkspace("/tmp/clear-drains-refine-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "clear-drains-refine-project",
        projectPath: "/tmp/clear-drains-refine-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", "before clear", {})
      );
      const drained: string[] = [];
      workspaceService.setRefinePassCanceller({
        cancelInFlightRefinePass: (id) => {
          drained.push(id);
          return Promise.resolve();
        },
      });

      expect((await workspaceService.truncateHistory(workspaceId, 0.5)).success).toBe(true);
      expect(drained).toHaveLength(0);

      expect((await workspaceService.truncateHistory(workspaceId)).success).toBe(true);
      expect(drained).toEqual([workspaceId]);

      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      expect((await workspaceService.resetContext(workspaceId)).success).toBe(true);
      expect(drained).toEqual([workspaceId, workspaceId]);
    } finally {
      await cleanup();
    }
  });

  test("context-discarding mutations block send admission across their awaits (r40)", async () => {
    // SECURITY: a full clear awaits the refine drain + cross-process lock
    // BETWEEN its busy check and the truncation. A send admitted during that
    // window would snapshot the pre-clear transcript and stream across the
    // clear, repopulating the cleared context — so the mutation publishes an
    // admission guard BEFORE its first await: new sends reject at the door
    // and concurrent mutations are refused.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "clear-blocks-sends";
    try {
      await config.addWorkspace("/tmp/clear-blocks-sends-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "clear-blocks-sends-project",
        projectPath: "/tmp/clear-blocks-sends-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", "before clear", {})
      );
      const drainStarted = createDeferred<void>();
      const releaseDrain = createDeferred<void>();
      workspaceService.setRefinePassCanceller({
        cancelInFlightRefinePass: async () => {
          drainStarted.resolve();
          await releaseDrain.promise;
        },
      });

      const clearPromise = workspaceService.truncateHistory(workspaceId);
      await drainStarted.promise;

      // Mid-await: the guard is already published.
      const sendResult = await workspaceService.sendMessage(workspaceId, "hello", {
        model: "anthropic:claude-sonnet-4-6",
        thinkingLevel: "off",
        toolPolicy: [],
        agentId: "exec",
      });
      expect(sendResult).toEqual({
        success: false,
        error: {
          type: "unknown",
          raw: "Workspace history is being cleared or reset. Please wait and try again.",
        },
      });
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: false,
        error: "A context reset or clear is already in progress for this workspace.",
      });

      releaseDrain.resolve();
      expect(await clearPromise).toEqual({ success: true, data: undefined });
      // Guard released: a follow-up mutation is admitted again.
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "noop",
      });
    } finally {
      await cleanup();
    }
  });

  test("full clear fails closed when a turn starts during its awaits (r40)", async () => {
    // A turn start that bypasses send admission (in-turn compaction retries
    // crossing a transient idle gap) can begin streaming while the clear sits
    // in its refine drain/lock awaits. The busy recheck under the guard +
    // lock must fail the mutation instead of truncating under a live stream.
    let streaming = false;
    const aiService = {
      on: mock(() => undefined),
      isStreaming: mock(() => streaming),
    } as unknown as AIService;
    const { config, historyService, workspaceService, cleanup } = await createServices(aiService);
    const workspaceId = "clear-recheck-busy";
    try {
      await config.addWorkspace("/tmp/clear-recheck-busy-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "clear-recheck-busy-project",
        projectPath: "/tmp/clear-recheck-busy-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", "before clear", {})
      );
      workspaceService.setRefinePassCanceller({
        cancelInFlightRefinePass: () => {
          // A stream starts exactly inside the mutation's await window.
          streaming = true;
          return Promise.resolve();
        },
      });

      const result = await workspaceService.truncateHistory(workspaceId);
      expect(result).toEqual({
        success: false,
        error:
          "Cannot truncate history while a turn is active. Press Esc to stop the stream first.",
      });
      // Failed closed: nothing was truncated under the live stream.
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success ? history.data : []).toHaveLength(1);

      // Once the stream ends, the clear (and its admission guard) work again.
      streaming = false;
      workspaceService.setRefinePassCanceller({
        cancelInFlightRefinePass: () => Promise.resolve(),
      });
      expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
        success: true,
        data: undefined,
      });
    } finally {
      await cleanup();
    }
  });

  test("acquireIdleTurnExclusion refuses busy workspaces and blocks turn admission while held (r40)", async () => {
    // /refine publication rides this exclusion: it must fail closed when a
    // turn is active and, while held, refuse new turn admission so the
    // published row cannot land inside a PREPARING snapshot window.
    let streaming = true;
    const aiService = {
      on: mock(() => undefined),
      isStreaming: mock(() => streaming),
    } as unknown as AIService;
    const { config, workspaceService, cleanup } = await createServices(aiService);
    const workspaceId = "refine-turn-exclusion";
    try {
      await config.addWorkspace("/tmp/refine-turn-exclusion-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "refine-turn-exclusion-project",
        projectPath: "/tmp/refine-turn-exclusion-project",
        runtimeConfig: { type: "local" },
      });

      expect(workspaceService.acquireIdleTurnExclusion(workspaceId)).toEqual({
        success: false,
        error: "a turn is preparing or streaming",
      });

      streaming = false;
      const exclusion = workspaceService.acquireIdleTurnExclusion(workspaceId);
      expect(exclusion.success).toBe(true);
      if (!exclusion.success) return;
      try {
        const sendResult = await workspaceService.sendMessage(workspaceId, "hello", {
          model: "anthropic:claude-sonnet-4-6",
          thinkingLevel: "off",
          toolPolicy: [],
          agentId: "exec",
        });
        expect(sendResult).toEqual({
          success: false,
          error: {
            type: "unknown",
            raw: "Workspace history is being cleared or reset. Please wait and try again.",
          },
        });
      } finally {
        exclusion.data[Symbol.dispose]();
      }
    } finally {
      await cleanup();
    }
  });

  test("acquireIdleTurnExclusion refuses while a send is in its pre-admission window (r41)", async () => {
    // Release-before-resume: a send past the entry check may have already
    // persisted its user row while the session still looks idle. If refine
    // published and released here, the proposal row would land after that
    // user row and enter the send's request as a trailing foreign assistant
    // row — the exclusion must refuse instead.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "refine-preflight-send";
    try {
      await config.addWorkspace("/tmp/refine-preflight-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "refine-preflight-project",
        projectPath: "/tmp/refine-preflight-project",
        runtimeConfig: { type: "local" },
      });

      const appendReached = createDeferred<void>();
      const releaseAppend = createDeferred<void>();
      const originalAppend = historyService.appendToHistory.bind(historyService);
      const appendSpy = spyOn(historyService, "appendToHistory").mockImplementationOnce(
        async (...args: Parameters<HistoryService["appendToHistory"]>) => {
          appendReached.resolve();
          await releaseAppend.promise;
          return originalAppend(...args);
        }
      );
      try {
        const sendPromise = workspaceService.sendMessage(workspaceId, "hello", {
          model: "anthropic:claude-sonnet-4-6",
          thinkingLevel: "off",
          toolPolicy: [],
          agentId: "exec",
        });
        await appendReached.promise;

        expect(workspaceService.acquireIdleTurnExclusion(workspaceId)).toEqual({
          success: false,
          error: "a send is being admitted",
        });

        releaseAppend.resolve();
        // The send fails at stream startup (no provider in this fixture) —
        // only its settled outcome matters here.
        await sendPromise;

        // Preflight released: the exclusion is available again.
        const exclusion = workspaceService.acquireIdleTurnExclusion(workspaceId);
        expect(exclusion.success).toBe(true);
        if (exclusion.success) {
          exclusion.data[Symbol.dispose]();
        }
      } finally {
        appendSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context mutations are refused while a send is in its pre-admission window (r42)", async () => {
    // SECURITY: a send past the entry check may have passed its pre-persist
    // gate but not yet appended its rows (family payload + user row). A
    // mutation committing in that window would leave those rows — composed
    // against, and possibly influenced by, the discarded context — durably in
    // the fresh transcript: the epoch gate blocks the send's stream but
    // cannot un-append. The mutation must refuse while the send is in
    // preflight, and succeed again once it settles.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "mutation-refuses-preflight";
    try {
      await config.addWorkspace("/tmp/mutation-refuses-preflight-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "mutation-refuses-preflight-project",
        projectPath: "/tmp/mutation-refuses-preflight-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", "before clear", {})
      );

      // Park the send at its user-row append: past every entry check and the
      // pre-persist gate, strictly before its rows land.
      const appendReached = createDeferred<void>();
      const releaseAppend = createDeferred<void>();
      const originalAppend = historyService.appendToHistory.bind(historyService);
      const appendSpy = spyOn(historyService, "appendToHistory").mockImplementationOnce(
        async (...args: Parameters<HistoryService["appendToHistory"]>) => {
          appendReached.resolve();
          await releaseAppend.promise;
          return originalAppend(...args);
        }
      );
      try {
        const sendPromise = workspaceService.sendMessage(workspaceId, "hello", {
          model: "anthropic:claude-sonnet-4-6",
          thinkingLevel: "off",
          toolPolicy: [],
          agentId: "exec",
        });
        await appendReached.promise;

        expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
          success: false,
          error: "Cannot truncate history while a message is being sent. Try again in a moment.",
        });
        expect(await workspaceService.resetContext(workspaceId)).toEqual({
          success: false,
          error: "Cannot reset context while a message is being sent. Try again in a moment.",
        });

        releaseAppend.resolve();
        // The send fails at stream startup (no provider in this fixture) —
        // only its settled outcome matters here.
        await sendPromise;

        // Preflight settled: the clear is admitted and discards everything,
        // including the send's rows — nothing straddles the mutation.
        expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
          success: true,
          data: undefined,
        });
        const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(history.success ? history.data : ["unexpected"]).toHaveLength(0);
      } finally {
        appendSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context mutations and refine exclusion refuse while mid-stream compaction is pending (r43)", async () => {
    // interruptForCompaction stops the original stream, waits for idle, then
    // calls AgentSession.sendMessage directly — bypassing WorkspaceService
    // entry accounting. During that window the session looks idle, so
    // mutations and refine publication must treat pending mid-stream
    // compaction as turn work and refuse.
    const { config, workspaceService, cleanup } = await createServices();
    const workspaceId = "midstream-compaction-guard";
    try {
      await config.addWorkspace("/tmp/midstream-compaction-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "midstream-compaction-project",
        projectPath: "/tmp/midstream-compaction-project",
        runtimeConfig: { type: "local" },
      });
      const session = workspaceService.getOrCreateSession(workspaceId);
      const pendingSpy = spyOn(session, "hasActiveOrPendingTurnWork").mockReturnValue(true);
      try {
        expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
          success: false,
          error:
            "Cannot truncate history while a turn is active. Press Esc to stop the stream first.",
        });
        expect(await workspaceService.resetContext(workspaceId)).toEqual({
          success: false,
          error: "Cannot reset context while a turn is active. Press Esc to stop the stream first.",
        });
        expect(workspaceService.acquireIdleTurnExclusion(workspaceId)).toEqual({
          success: false,
          error: "a turn is preparing or streaming",
        });
      } finally {
        pendingSpy.mockRestore();
      }
      // Window closed: mutations are admitted again.
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "noop",
      });
    } finally {
      await cleanup();
    }
  });

  /**
   * Seed a fork-shaped history and drive a background abandoned-branch
   * summary until its row is durably appended, leaving the registration
   * settled but unconsumed (the r43/r44 scenario: settled before the fork's
   * first send). History ends up with 3 rows: m1, m2, summary.
   */
  async function seedSettledBranchSummaryRegistration(
    historyService: HistoryService,
    workspaceId: string
  ): Promise<void> {
    // Fork shape: kept rows end at the guard tail; the abandoned branch is
    // meaty enough to clear the summarization threshold.
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("m1", "user", "original question", { timestamp: 1 })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("m2", "assistant", "branch point answer", { timestamp: 2 })
    );
    const filler = "investigated the flaky test and traced the race ".repeat(200);
    const abandonedMessages = [
      createMuxMessage("abandoned-user", "user", `Please fix this: ${filler}`, { timestamp: 3 }),
      createMuxMessage("abandoned-assistant", "assistant", `Findings: ${filler}`, {
        timestamp: 4,
      }),
    ];
    const summaryAiService: BranchSummaryAiService = {
      createModelWithPinnedMetadata: (modelString: string) =>
        Promise.resolve(
          Ok({
            model: new MockLanguageModelV3({
              doStream: () =>
                Promise.resolve({
                  stream: simulateReadableStream({
                    chunks: [
                      { type: "text-start", id: "t1" },
                      { type: "text-delta", id: "t1", delta: "Abandoned: explored a race." },
                      { type: "text-end", id: "t1" },
                      {
                        type: "finish",
                        finishReason: { unified: "stop", raw: "stop" },
                        usage: {
                          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                          outputTokens: { total: 5, text: 5, reasoning: 0 },
                        },
                      } satisfies LanguageModelV3StreamPart,
                    ] satisfies LanguageModelV3StreamPart[],
                  }),
                }),
            }),
            metadataModel: modelString,
          })
        ) as ReturnType<BranchSummaryAiService["createModelWithPinnedMetadata"]>,
      getWorkspaceMetadata: () =>
        Promise.resolve(Ok({ aiSettings: { model: "anthropic:claude-haiku-4-5" } })) as ReturnType<
          BranchSummaryAiService["getWorkspaceMetadata"]
        >,
    };
    await startAbandonedBranchSummaryInBackground({
      historyService,
      aiService: summaryAiService,
      workspaceId,
      abandonedMessages,
      experiments: { rlm: true, programmaticToolCalling: true },
      guardTailMessageId: "m2",
    });
    // Wait for the background generation to append + settle WITHOUT
    // consuming the registration.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (history.success && history.data.length === 3) return;
      if (Date.now() > deadline) {
        throw new Error("branch summary row never appended");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  test("a full clear drops a settled-but-unconsumed branch-summary registration (r43)", async () => {
    // A fork's summary can append and settle before the fork's first send;
    // the registration stays consumable so that send can emit the row. A
    // full clear deletes the row — the registration must be dropped with it,
    // or the next send re-emits the discarded summary into the live
    // transcript (absent from history after reload).
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "clear-drops-summary-registration";
    try {
      await config.addWorkspace("/tmp/clear-drops-summary-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "clear-drops-summary-project",
        projectPath: "/tmp/clear-drops-summary-project",
        runtimeConfig: { type: "local" },
      });
      await seedSettledBranchSummaryRegistration(historyService, workspaceId);

      expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
        success: true,
        data: undefined,
      });

      // The registration went with the row: nothing left to re-emit.
      expect(await awaitPendingBranchSummary(workspaceId)).toBeNull();
      const cleared = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(cleared.success ? cleared.data : ["unexpected"]).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("a failed full clear retains the settled branch-summary registration (r44)", async () => {
    // The registration is dropped only AFTER the truncation commits: dropping
    // it first and then failing the write would leave the durable summary row
    // in history with nothing left to emit it — the provider would see
    // assistant context the user cannot see until a reload.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "failed-clear-retains-registration";
    try {
      await config.addWorkspace("/tmp/failed-clear-retains-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "failed-clear-retains-project",
        projectPath: "/tmp/failed-clear-retains-project",
        runtimeConfig: { type: "local" },
      });
      await seedSettledBranchSummaryRegistration(historyService, workspaceId);

      const truncateSpy = spyOn(historyService, "truncateHistory").mockImplementationOnce(() =>
        Promise.resolve(Err("disk full"))
      );
      try {
        expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
          success: false,
          error: "disk full",
        });
      } finally {
        truncateSpy.mockRestore();
      }

      // The registration survived the failed clear: the next send still
      // consumes and emits the row, which remains in history.
      const summary = await awaitPendingBranchSummary(workspaceId);
      expect(summary).not.toBeNull();
      const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
      expect(history.success).toBe(true);
      if (history.success) {
        expect(history.data.some((row) => row.id === summary?.id)).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  test("context-discarding mutations drop pending partials so retries cannot replay them (r41)", async () => {
    // A retry scheduled during backoff would fire after the guard releases,
    // commit the pre-mutation partial, and stream a request derived from the
    // discarded context — mutations must durably drop that state first, and
    // fail closed when they cannot.
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "clear-discards-partial";
    try {
      await config.addWorkspace("/tmp/clear-discards-partial-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "clear-discards-partial-project",
        projectPath: "/tmp/clear-discards-partial-project",
        runtimeConfig: { type: "local" },
      });
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-clear-user", "user", "before clear", {})
      );
      const seedPartial = () =>
        historyService.writePartial(
          workspaceId,
          createMuxMessage("partial-1", "assistant", "pre-mutation partial", {})
        );

      // getOrCreateSession must exist for the discard hook to run.
      await seedPartial();
      expect(await workspaceService.truncateHistory(workspaceId)).toEqual({
        success: true,
        data: undefined,
      });
      expect(await historyService.readPartial(workspaceId)).toBeNull();

      // Reset drops the partial too — even on its no-op branch the discard
      // runs before the history read, so stale retry state cannot survive.
      await seedPartial();
      expect(await workspaceService.resetContext(workspaceId)).toEqual({
        success: true,
        data: "noop",
      });
      expect(await historyService.readPartial(workspaceId)).toBeNull();

      // Fail closed: an undeletable partial blocks the clear.
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("post-clear-user", "user", "again", {})
      );
      await seedPartial();
      const deleteSpy = spyOn(historyService, "deletePartial").mockImplementationOnce(() =>
        Promise.resolve(Err("disk full"))
      );
      try {
        const blocked = await workspaceService.truncateHistory(workspaceId);
        expect(blocked).toEqual({
          success: false,
          error: "Cannot clear history: pending retry state could not be discarded (disk full)",
        });
        // Nothing was truncated.
        const history = await historyService.getHistoryFromLatestBoundary(workspaceId);
        expect(history.success ? history.data : []).toHaveLength(1);
      } finally {
        deleteSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context reset surfaces active-context history read failures", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-history-read-fails";
    try {
      await config.addWorkspace("/tmp/context-reset-history-read-fails-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-history-read-fails-project",
        projectPath: "/tmp/context-reset-history-read-fails-project",
        runtimeConfig: { type: "local" },
      });
      const historySpy = spyOn(
        historyService,
        "getHistoryFromLatestBoundary"
      ).mockResolvedValueOnce(Err("read failed"));

      try {
        const result = await workspaceService.resetContext(workspaceId);

        expect(result).toEqual({
          success: false,
          error: "Failed to read active context before reset: read failed",
        });
      } finally {
        historySpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context reset rejects active streams", async () => {
    const aiService = {
      on: mock(() => undefined),
      isStreaming: mock(() => true),
    } as unknown as AIService;
    const { config, workspaceService, cleanup } = await createServices(aiService);
    const workspaceId = "context-reset-active-stream";
    try {
      await config.addWorkspace("/tmp/context-reset-active-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-active-project",
        projectPath: "/tmp/context-reset-active-project",
        runtimeConfig: { type: "local" },
      });

      const result = await workspaceService.resetContext(workspaceId);

      expect(result.success).toBe(false);
      expect(result.success ? undefined : result.error).toBe(
        "Cannot reset context while a turn is active. Press Esc to stop the stream first."
      );
    } finally {
      await cleanup();
    }
  });

  test("context reset rejects queued or preparing turns", async () => {
    const { config, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-queued-turn";
    try {
      await config.addWorkspace("/tmp/context-reset-queued-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-queued-project",
        projectPath: "/tmp/context-reset-queued-project",
        runtimeConfig: { type: "local" },
      });
      const pendingSpy = spyOn(
        workspaceService,
        "hasPendingQueuedOrPreparingTurn"
      ).mockReturnValueOnce(true);

      try {
        const result = await workspaceService.resetContext(workspaceId);

        expect(result.success).toBe(false);
        expect(result.success ? undefined : result.error).toBe(
          "Cannot reset context while queued user input is pending. Send or clear the queued message first."
        );
      } finally {
        pendingSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context reset preserves plan files", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-preserves-plan-file";
    const projectName = "context-reset-preserves-plan-project";
    try {
      await config.addWorkspace(`/tmp/${projectName}`, {
        id: workspaceId,
        name: workspaceId,
        projectName,
        projectPath: `/tmp/${projectName}`,
        runtimeConfig: { type: "local" },
      });
      const planFile = await writePlanFile(config.rootDir, projectName, workspaceId);
      expect(
        (
          await historyService.appendToHistory(
            workspaceId,
            createMuxMessage("pre-reset-user", "user", "before reset", {})
          )
        ).success
      ).toBe(true);

      const result = await workspaceService.resetContext(workspaceId);

      expect(result).toEqual({ success: true, data: "reset" });
      await fsPromises.access(planFile);
    } finally {
      await cleanup();
    }
  });

  test("context reset does not clear plan files when boundary append fails", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-append-fails";
    try {
      await config.addWorkspace("/tmp/context-reset-append-fails-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-append-fails-project",
        projectPath: "/tmp/context-reset-append-fails-project",
        runtimeConfig: { type: "local" },
      });
      const planFile = await writePlanFile(
        config.rootDir,
        "context-reset-append-fails-project",
        workspaceId
      );
      const seedResult = await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      expect(seedResult.success).toBe(true);
      const appendSpy = spyOn(historyService, "appendToHistory").mockResolvedValueOnce(
        Err("disk full")
      );

      try {
        const result = await workspaceService.resetContext(workspaceId);

        expect(result.success).toBe(false);
        expect(result.success ? undefined : result.error).toBe(
          "Failed to append context reset boundary: disk full"
        );
        await fsPromises.access(planFile);
      } finally {
        appendSpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context reset remains successful when post-boundary goal acknowledgment fails", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-goal-ack-fails";
    try {
      await config.addWorkspace("/tmp/context-reset-goal-ack-fails-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-goal-ack-fails-project",
        projectPath: "/tmp/context-reset-goal-ack-fails-project",
        runtimeConfig: { type: "local" },
      });
      workspaceService.setWorkspaceGoalService({
        requireUserAcknowledgment: mock(() => Promise.reject(new Error("goal write failed"))),
      } as unknown as WorkspaceGoalService);
      const seedResult = await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("pre-reset-user", "user", "before reset", {})
      );
      expect(seedResult.success).toBe(true);

      const result = await workspaceService.resetContext(workspaceId);

      expect(result).toEqual({ success: true, data: "reset" });
    } finally {
      await cleanup();
    }
  });

  test("context reset rejects duplicate resets and sends while a reset is in progress", async () => {
    const { config, historyService, workspaceService, cleanup } = await createServices();
    const workspaceId = "context-reset-reentrancy";
    try {
      await config.addWorkspace("/tmp/context-reset-reentrancy-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-reentrancy-project",
        projectPath: "/tmp/context-reset-reentrancy-project",
        runtimeConfig: { type: "local" },
      });
      const historyDeferred =
        createDeferred<Awaited<ReturnType<HistoryService["getHistoryFromLatestBoundary"]>>>();
      const historySpy = spyOn(
        historyService,
        "getHistoryFromLatestBoundary"
      ).mockImplementationOnce(() => historyDeferred.promise);

      try {
        const firstReset = workspaceService.resetContext(workspaceId);
        await Promise.resolve();

        const duplicateReset = await workspaceService.resetContext(workspaceId);
        expect(duplicateReset).toEqual({
          success: false,
          error: "A context reset or clear is already in progress for this workspace.",
        });

        const sendResult = await workspaceService.sendMessage(workspaceId, "hello", {
          model: "anthropic:claude-sonnet-4-6",
          thinkingLevel: "off",
          toolPolicy: [],
          agentId: "exec",
        });
        expect(sendResult).toEqual({
          success: false,
          error: {
            type: "unknown",
            raw: "Workspace history is being cleared or reset. Please wait and try again.",
          },
        });

        historyDeferred.resolve(Ok([]));
        expect(await firstReset).toEqual({ success: true, data: "noop" });
      } finally {
        historySpy.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });

  test("context reset preserves the goal and requires user acknowledgment", async () => {
    const { config, historyService, workspaceService, goalService, cleanup } =
      await createServices();
    const workspaceId = "context-reset-goal-workspace";
    try {
      await config.addWorkspace("/tmp/context-reset-goal-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "context-reset-goal-project",
        projectPath: "/tmp/context-reset-goal-project",
        runtimeConfig: { type: "local" },
      });
      const created = await setWorkspaceGoalOk(goalService, {
        workspaceId,
        objective: "Keep pursuing the objective",
      });
      expect(
        (
          await historyService.appendToHistory(
            workspaceId,
            createMuxMessage("pre-reset-user", "user", "before reset", {})
          )
        ).success
      ).toBe(true);

      const nowSpy = spyOn(Date, "now").mockReturnValue(1_234_568);
      try {
        const result = await workspaceService.resetContext(workspaceId);
        expect(result.success).toBe(true);
      } finally {
        nowSpy.mockRestore();
      }

      expect(await goalService.getGoal(workspaceId)).toMatchObject({
        goalId: created.goalId,
        objective: created.objective,
        requireUserAcknowledgmentSinceMs: 1_234_568,
      });
    } finally {
      await cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // Codex P1 (PRRT_kwDOPxxmWM5_ucm2): the WorkspaceService stream-abort
  // listener must NOT replay queued goal mutations on user-aborted streams.
  // `applyPendingAfterStreamEnd` consumes `pendingGoalMutations` synchronously
  // before its first await, while `recordUserStoppedStream` (which clears the
  // map) runs later in the AgentSession listener — so without an explicit
  // skip, a user who interrupted a stream mid-objective-edit would still see
  // the queued edit committed, defeating the stop-to-cancel safety contract
  // (DEREM-18).
  // ---------------------------------------------------------------------------
  test("user-aborted streams do NOT replay queued goal mutations", async () => {
    const aiEmitter = new EventEmitter();
    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock(() => false),
    }) as unknown as AIService;
    const { config, workspaceService, goalService, cleanup } = await createServices(aiService);
    const workspaceId = "user-abort-discards-mutation";
    try {
      await config.addWorkspace("/tmp/user-abort-test-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath: "/tmp/user-abort-test-project",
        runtimeConfig: { type: "local" },
      });
      // Voids the unused-var warning; workspaceService just needs to exist.
      void workspaceService;

      const created = await setWorkspaceGoalOk(goalService, {
        workspaceId,
        objective: "Original objective",
      });

      // Queue a mid-stream mutation (the real flow goes through
      // setGoal-while-streaming; we override the private streaming check
      // directly to avoid plumbing an entire AgentSession into this test).
      const goalServiceAccess = goalService as unknown as {
        isWorkspaceStreaming: (workspaceId: string) => Promise<boolean>;
      };
      const isStreamingOriginal = goalServiceAccess.isWorkspaceStreaming;
      goalServiceAccess.isWorkspaceStreaming = () => Promise.resolve(true);
      try {
        const queued = await goalService.setGoal({
          workspaceId,
          objective: "Should be dropped on user abort",
          expectedGoalId: created.goalId,
        });
        expect(queued.success).toBe(true);
      } finally {
        goalServiceAccess.isWorkspaceStreaming = isStreamingOriginal;
      }

      // Mirror the real AgentSession listener: when abortReason === "user",
      // `recordUserStoppedStream` clears `pendingGoalMutations`. The
      // WorkspaceService stream-abort listener fires synchronously on the
      // emit below, before this clear — so the new gate inside that listener
      // is what prevents the replay.
      aiService.emit("stream-abort", {
        type: "stream-abort",
        workspaceId,
        messageId: "msg",
        abortReason: "user",
        metadata: { duration: 1 },
        abandonPartial: true,
      });
      await goalService.recordUserStoppedStream(workspaceId);

      // Drain pending microtasks to give any racing
      // applyPendingAfterStreamEnd a chance to fire.
      await drainPendingDispatches();

      const persisted = await goalService.getGoal(workspaceId);
      expect(persisted?.objective).toBe("Original objective");
    } finally {
      await cleanup();
    }
  });

  // A goal set mid-stream is held as optimistic state until stream-end
  // persistence, so goal.json keeps the pre-stream goal. Non-goal activity
  // emits (status_set/todo_write/recency) read that persisted goal and, before
  // this overlay, replaced the activity snapshot with the stale goal — the Goal
  // tab flickered back to the old goal until the next goal read. The overlay
  // keeps the optimistic goal visible, and clears once the goal service drops
  // the pending mutation (abort / stream-end).
  test("mid-stream activity emits surface the optimistic goal, then revert on user abort", async () => {
    const aiEmitter = new EventEmitter();
    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock(() => false),
    }) as unknown as AIService;
    const { config, workspaceService, goalService, cleanup } = await createServices(aiService);
    const workspaceId = "midstream-goal-overlay";
    try {
      await config.addWorkspace("/tmp/midstream-goal-overlay-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath: "/tmp/midstream-goal-overlay-project",
        runtimeConfig: { type: "local" },
      });

      const created = await setWorkspaceGoalOk(goalService, {
        workspaceId,
        objective: "Pre-stream goal",
      });

      // Queue a goal set mid-stream (publishes an optimistic, pendingPersistence
      // snapshot without persisting goal.json).
      const goalServiceAccess = goalService as unknown as {
        isWorkspaceStreaming: (workspaceId: string) => Promise<boolean>;
      };
      const isStreamingOriginal = goalServiceAccess.isWorkspaceStreaming;
      goalServiceAccess.isWorkspaceStreaming = () => Promise.resolve(true);
      try {
        const queued = await goalService.setGoal({
          workspaceId,
          objective: "Optimistic mid-stream goal",
          expectedGoalId: created.goalId,
        });
        expect(queued.success).toBe(true);
      } finally {
        goalServiceAccess.isWorkspaceStreaming = isStreamingOriginal;
      }

      // The durable goal.json still holds the pre-stream goal.
      expect((await goalService.getGoal(workspaceId))?.objective).toBe("Pre-stream goal");

      const activityEvents: Array<{
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }> = [];
      const listener = (event: {
        workspaceId: string;
        activity: WorkspaceActivitySnapshot | null;
      }) => activityEvents.push(event);
      workspaceService.on("activity", listener);
      try {
        // A non-goal activity emit reads persisted metadata (still the pre-stream
        // goal) but must surface the optimistic goal so the Goal tab is stable.
        await workspaceService.updateAgentStatus(workspaceId, { emoji: "🛠️", message: "Working" });
        expect(activityEvents.at(-1)?.activity?.goal).toMatchObject({
          objective: "Optimistic mid-stream goal",
          pendingPersistence: true,
        });

        // The bootstrap path (renderer reconnect/reload) builds straight from
        // persisted metadata, so it must apply the same overlay.
        const listed = await workspaceService.getActivityList();
        expect(listed[workspaceId]?.goal).toMatchObject({
          objective: "Optimistic mid-stream goal",
          pendingPersistence: true,
        });

        // User aborts: the goal service drops the queued mutation and reverts the
        // panel to the persisted goal. Subsequent activity emits must show that
        // reverted goal, not the discarded optimistic one.
        await goalService.recordUserStoppedStream(workspaceId);
        await workspaceService.updateAgentStatus(workspaceId, { emoji: "💤", message: "Idle" });
        expect(activityEvents.at(-1)?.activity?.goal).toMatchObject({
          goalId: created.goalId,
          objective: "Pre-stream goal",
        });
        expect(activityEvents.at(-1)?.activity?.goal?.pendingPersistence).toBeUndefined();
      } finally {
        workspaceService.off("activity", listener);
      }
    } finally {
      await cleanup();
    }
  });

  test("WorkspaceService stream-abort listener leaves queued goal mutations for AgentSession", async () => {
    // Non-user abort goal mutation drains happen in AgentSession after abort
    // accounting. WorkspaceService must not drain here, or the aborted
    // in-flight stream can be charged to the replacement goal.
    const aiEmitter = new EventEmitter();
    const aiService = Object.assign(aiEmitter, {
      isStreaming: mock(() => false),
    }) as unknown as AIService;
    const { config, workspaceService, goalService, cleanup } = await createServices(aiService);
    const workspaceId = "system-abort-replays-mutation";
    try {
      await config.addWorkspace("/tmp/system-abort-test-project", {
        id: workspaceId,
        name: workspaceId,
        projectName: "project",
        projectPath: "/tmp/system-abort-test-project",
        runtimeConfig: { type: "local" },
      });
      void workspaceService;

      const created = await setWorkspaceGoalOk(goalService, {
        workspaceId,
        objective: "Original objective",
      });

      const goalServiceAccess = goalService as unknown as {
        isWorkspaceStreaming: (workspaceId: string) => Promise<boolean>;
      };
      const isStreamingOriginal = goalServiceAccess.isWorkspaceStreaming;
      goalServiceAccess.isWorkspaceStreaming = () => Promise.resolve(true);
      try {
        const queued = await goalService.setGoal({
          workspaceId,
          objective: "Should commit on system abort",
          expectedGoalId: created.goalId,
        });
        expect(queued.success).toBe(true);
      } finally {
        goalServiceAccess.isWorkspaceStreaming = isStreamingOriginal;
      }

      aiService.emit("stream-abort", {
        type: "stream-abort",
        workspaceId,
        messageId: "msg",
        abortReason: "system",
        metadata: { duration: 1 },
        abandonPartial: false,
      });

      // Drain pending microtasks to prove WorkspaceService did not consume the
      // queued mutation before AgentSession has a chance to account the abort.
      await drainPendingDispatches();

      const persisted = await goalService.getGoal(workspaceId);
      expect(persisted?.objective).toBe("Original objective");
    } finally {
      await cleanup();
    }
  });
});

describe("WorkspaceService initialize", () => {
  let workspaceService: WorkspaceService;
  let config: Config;

  beforeEach(() => {
    config = {
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
    } as unknown as Config;

    const aiService = {
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    workspaceService = createWorkspaceServiceForTest({
      config,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  test("schedules startup recovery for non-task, non-archived chats", async () => {
    const liveWorkspace = createFrontendWorkspaceMetadata({
      id: "live-ws",
      name: "Live Workspace",
    });
    const taskWorkspace = createFrontendWorkspaceMetadata({
      id: "task-ws",
      name: "Task Workspace",
      taskStatus: "running",
    });
    const archivedWorkspace = createFrontendWorkspaceMetadata({
      id: "archived-ws",
      name: "Archived Workspace",
      archivedAt: "2026-03-20T00:00:00.000Z",
    });

    config.getAllWorkspaceMetadata = mock(() =>
      Promise.resolve([liveWorkspace, taskWorkspace, archivedWorkspace])
    ) as unknown as Config["getAllWorkspaceMetadata"];

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    const startStartupRecoverySpy = spyOn(startupAccess, "startStartupRecovery").mockImplementation(
      () => undefined
    );

    await workspaceService.initialize();

    expect(startStartupRecoverySpy).toHaveBeenCalledTimes(1);
    expect(startStartupRecoverySpy).toHaveBeenCalledWith("live-ws");
  });

  test("swallows startup metadata lookup failures", async () => {
    config.getAllWorkspaceMetadata = mock(() =>
      Promise.reject(new Error("config unavailable"))
    ) as unknown as Config["getAllWorkspaceMetadata"];

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    const startStartupRecoverySpy = spyOn(startupAccess, "startStartupRecovery");

    await workspaceService.initialize();

    expect(startStartupRecoverySpy).not.toHaveBeenCalled();
  });

  test("preserves scratch workdirs when config cannot be loaded", async () => {
    const { config: realConfig, historyService, cleanup } = await createTestHistoryService();
    const scratchPath = path.join(realConfig.rootDir, "scratch", "existing-scratch");
    await fsPromises.mkdir(scratchPath, { recursive: true });
    await fsPromises.writeFile(path.join(realConfig.rootDir, "config.json"), "{invalid-json");

    const aiService = {
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
    const service = createWorkspaceServiceForTest({
      config: realConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    try {
      await service.initialize();
      expect(await fsPromises.stat(scratchPath).then(() => true)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("removes stale orphaned session directories but keeps referenced and recent ones", async () => {
    const { config: realConfig, historyService, cleanup } = await createTestHistoryService();
    await realConfig.editConfig((cfg) => {
      cfg.projects.set("/tmp/proj", {
        workspaces: [
          { path: "/tmp/proj/known-ws", id: "known-ws", name: "known-ws" },
          // Legacy entry without a stable ID: its session dir is keyed by "<project>-<workspace>".
          { path: "/tmp/proj/legacy-branch" },
        ],
      });
      return cfg;
    });

    const sessionDirFor = (id: string) => path.join(realConfig.sessionsDir, id);
    const knownDir = sessionDirFor("known-ws");
    const legacyDir = sessionDirFor("proj-legacy-branch");
    // Unreferenced in config (the load-time migration removed the legacy Chat
    // with Xum entry) but exempt from reaping so downgrades keep the history.
    const muxChatDir = sessionDirFor("mux-chat");
    const staleOrphanDir = sessionDirFor("stale-orphan-ws");
    const freshOrphanDir = sessionDirFor("fresh-orphan-ws");
    for (const dir of [knownDir, legacyDir, muxChatDir, staleOrphanDir, freshOrphanDir]) {
      await fsPromises.mkdir(dir, { recursive: true });
    }
    // Backdate everything except the fresh orphan past the grace window, proving
    // retention comes from config references rather than directory age.
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const dir of [knownDir, legacyDir, muxChatDir, staleOrphanDir]) {
      await fsPromises.utimes(dir, staleTime, staleTime);
    }

    const aiService = {
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
    const service = createWorkspaceServiceForTest({
      config: realConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
    const startupAccess = service as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    spyOn(startupAccess, "startStartupRecovery").mockImplementation(() => undefined);

    const exists = (dir: string) =>
      fsPromises.stat(dir).then(
        () => true,
        () => false
      );

    try {
      await service.initialize();
      expect(await exists(knownDir)).toBe(true);
      expect(await exists(legacyDir)).toBe(true);
      expect(await exists(muxChatDir)).toBe(true);
      expect(await exists(freshOrphanDir)).toBe(true);
      expect(await exists(staleOrphanDir)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("preserves orphaned session directories when config cannot be loaded", async () => {
    const { config: realConfig, historyService, cleanup } = await createTestHistoryService();
    const orphanDir = path.join(realConfig.sessionsDir, "stale-orphan-ws");
    await fsPromises.mkdir(orphanDir, { recursive: true });
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fsPromises.utimes(orphanDir, staleTime, staleTime);
    await fsPromises.writeFile(path.join(realConfig.rootDir, "config.json"), "{invalid-json");

    const aiService = {
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
    const service = createWorkspaceServiceForTest({
      config: realConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    try {
      await service.initialize();
      expect(await fsPromises.stat(orphanDir).then(() => true)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("removes DevTools logs for archived workspaces at startup", async () => {
    const liveWorkspace = createFrontendWorkspaceMetadata({
      id: "live-ws",
      name: "Live Workspace",
    });
    const archivedWorkspace = createFrontendWorkspaceMetadata({
      id: "archived-ws",
      name: "Archived Workspace",
      archivedAt: "2026-03-20T00:00:00.000Z",
    });
    config.getAllWorkspaceMetadata = mock(() =>
      Promise.resolve([liveWorkspace, archivedWorkspace])
    ) as unknown as Config["getAllWorkspaceMetadata"];

    const removeWorkspaceData = mock(() => Promise.resolve());
    workspaceService.setDevToolsService({ removeWorkspaceData });

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
    };
    spyOn(startupAccess, "startStartupRecovery").mockImplementation(() => undefined);

    await workspaceService.initialize();

    expect(removeWorkspaceData).toHaveBeenCalledTimes(1);
    expect(removeWorkspaceData).toHaveBeenCalledWith("archived-ws");
  });

  test("disposes transient startup-recovery sessions that go idle", async () => {
    const dispose = mock(() => undefined);
    const fakeSession = {
      runStartupRecovery: mock(() => Promise.resolve()),
      shouldRetainAfterStartupRecovery: mock(() => false),
      scheduleStartupRecovery: mock(() => undefined),
      dispose,
    } as unknown as AgentSession;

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
      createSession: (workspaceId: string) => AgentSession;
      sessions: Map<string, AgentSession>;
    };
    const createSessionSpy = spyOn(startupAccess, "createSession").mockImplementation(
      () => fakeSession
    );

    startupAccess.startStartupRecovery("live-ws");
    await Promise.resolve();
    await Promise.resolve();

    expect(createSessionSpy).toHaveBeenCalledWith("live-ws");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(startupAccess.sessions.has("live-ws")).toBe(false);
  });

  test("retains transient startup-recovery sessions when recovery stays active", async () => {
    const dispose = mock(() => undefined);
    const onChatEvent = mock(() => () => undefined);
    const onMetadataEvent = mock(() => () => undefined);
    const fakeSession = {
      runStartupRecovery: mock(() => Promise.resolve()),
      shouldRetainAfterStartupRecovery: mock(() => true),
      scheduleStartupRecovery: mock(() => undefined),
      onChatEvent,
      onMetadataEvent,
      dispose,
    } as unknown as AgentSession;

    const startupAccess = workspaceService as unknown as {
      startStartupRecovery: (workspaceId: string) => void;
      createSession: (workspaceId: string) => AgentSession;
      sessions: Map<string, AgentSession>;
    };
    spyOn(startupAccess, "createSession").mockImplementation(() => fakeSession);

    startupAccess.startStartupRecovery("live-ws");
    await Promise.resolve();
    await Promise.resolve();

    expect(dispose).not.toHaveBeenCalled();
    expect(startupAccess.sessions.get("live-ws")).toBe(fakeSession);
  });

  test("claims transient startup-recovery sessions instead of creating duplicates", () => {
    const onChatEvent = mock(() => () => undefined);
    const onMetadataEvent = mock(() => () => undefined);
    const fakeSession = {
      onChatEvent,
      onMetadataEvent,
    } as unknown as AgentSession;

    const startupAccess = workspaceService as unknown as {
      transientStartupRecoverySessions: Map<string, AgentSession>;
      sessions: Map<string, AgentSession>;
      getOrCreateSession: (workspaceId: string) => AgentSession;
      createSession: (workspaceId: string) => AgentSession;
    };
    startupAccess.transientStartupRecoverySessions.set("live-ws", fakeSession);
    const createSessionSpy = spyOn(startupAccess, "createSession");

    const claimedSession = startupAccess.getOrCreateSession("live-ws");

    expect(claimedSession).toBe(fakeSession);
    expect(startupAccess.transientStartupRecoverySessions.has("live-ws")).toBe(false);
    expect(startupAccess.sessions.get("live-ws")).toBe(fakeSession);
    expect(createSessionSpy).not.toHaveBeenCalled();
  });
});

describe("WorkspaceService rename lock", () => {
  let workspaceService: WorkspaceService;
  let mockAIService: AIService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    // Create minimal mocks for the services
    mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve({ success: false, error: "not found" })),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("sendMessage returns error when workspace is being renamed", async () => {
    const workspaceId = "test-workspace";

    addToRenamingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.sendMessage(workspaceId, "test message", {
      model: "test-model",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const error = result.error;
      // Error is SendMessageError which has a discriminated union
      expect(typeof error === "object" && error.type === "unknown").toBe(true);
      if (typeof error === "object" && error.type === "unknown") {
        expect(error.raw).toContain("being renamed");
      }
    }
  });

  test("resumeStream returns error when workspace is being renamed", async () => {
    const workspaceId = "test-workspace";

    addToRenamingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.resumeStream(workspaceId, {
      model: "test-model",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const error = result.error;
      // Error is SendMessageError which has a discriminated union
      expect(typeof error === "object" && error.type === "unknown").toBe(true);
      if (typeof error === "object" && error.type === "unknown") {
        expect(error.raw).toContain("being renamed");
      }
    }
  });

  test("rename returns error when workspace is streaming", async () => {
    const workspaceId = "test-workspace";

    // Mock isStreaming to return true
    (mockAIService.isStreaming as ReturnType<typeof mock>).mockReturnValue(true);

    const result = await workspaceService.rename(workspaceId, "new-name");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("stream is active");
    }
  });
});

describe("WorkspaceService sendMessage status clearing", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let fakeSession: {
    isBusy: ReturnType<typeof mock>;
    hasQueuedMessages: ReturnType<typeof mock>;
    hasQueuedOrDispatchingEntry: ReturnType<typeof mock>;
    dropQueuedMessageWithOnlyDedupeKey: ReturnType<typeof mock>;
    queueMessage: ReturnType<typeof mock>;
    sendMessage: ReturnType<typeof mock>;
    resumeStream: ReturnType<typeof mock>;
  };

  beforeEach(async () => {
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => ({
        workspacePath: "/tmp/test/workspace",
        projectPath: "/tmp/test/project",
      })),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };

    const mockExtensionMetadata: Partial<ExtensionMetadataService> = {
      updateRecency: mock(() =>
        Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        })
      ),
      setStreaming: mock(() =>
        Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        })
      ),
      setAgentStatus: mock(() =>
        Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        })
      ),
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      extensionMetadata: mockExtensionMetadata as ExtensionMetadataService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    fakeSession = {
      isBusy: mock(() => true),
      hasQueuedMessages: mock(() => false),
      hasQueuedOrDispatchingEntry: mock(() => false),
      dropQueuedMessageWithOnlyDedupeKey: mock(() => false),
      queueMessage: mock(() => "tool-end" as const),
      sendMessage: mock(() => Promise.resolve(Ok(undefined))),
      resumeStream: mock(() => Promise.resolve(Ok({ started: true }))),
    };

    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = mock(() => fakeSession as unknown as AgentSession);

    (
      workspaceService as unknown as {
        maybePersistAISettingsFromOptions: (
          workspaceId: string,
          options: unknown,
          source: "send" | "resume"
        ) => Promise<void>;
      }
    ).maybePersistAISettingsFromOptions = mock(() => Promise.resolve());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("delegates manual pricing rejections to AgentSession so user input is preserved", async () => {
    fakeSession.isBusy.mockReturnValue(false);
    const pricingError: SendMessageError = { type: "unknown", raw: "unpriced model" };
    workspaceService.setWorkspaceGoalService({
      assertPricedModelForBudgetedGoal: mock(() => Promise.resolve(Err(pricingError))),
    } as unknown as WorkspaceGoalService);
    fakeSession.sendMessage.mockResolvedValue(Err(pricingError));

    const result = await workspaceService.sendMessage("test-workspace", "please stop", {
      model: "custom:unpriced-model",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    expect(fakeSession.sendMessage).toHaveBeenCalledTimes(1);
    expect(fakeSession.sendMessage).toHaveBeenCalledWith(
      "please stop",
      expect.objectContaining({ model: "custom:unpriced-model", agentId: "exec" }),
      expect.objectContaining({ synthetic: undefined })
    );
  });

  test("does not clear persisted agent status directly for non-synthetic sends", async () => {
    const updateAgentStatus = spyOn(
      workspaceService as unknown as {
        updateAgentStatus: (workspaceId: string, status: null) => Promise<void>;
      },
      "updateAgentStatus"
    ).mockResolvedValue(undefined);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(updateAgentStatus).not.toHaveBeenCalled();
  });

  test("does not clear persisted agent status directly for synthetic sends", async () => {
    const updateAgentStatus = spyOn(
      workspaceService as unknown as {
        updateAgentStatus: (workspaceId: string, status: null) => Promise<void>;
      },
      "updateAgentStatus"
    ).mockResolvedValue(undefined);

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "hello",
      {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
      },
      {
        synthetic: true,
      }
    );

    expect(result.success).toBe(true);
    expect(updateAgentStatus).not.toHaveBeenCalled();
  });

  test("sendMessage restores interrupted task status before successful send", async () => {
    fakeSession.isBusy.mockReturnValue(false);

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setTaskService({
      markInterruptedTaskRunning,
      restoreInterruptedTaskAfterResumeFailure,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");
    expect(restoreInterruptedTaskAfterResumeFailure).not.toHaveBeenCalled();
  });

  test("sendMessage restores interrupted status when accepted edit startup fails later", async () => {
    fakeSession.isBusy.mockReturnValue(false);

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setTaskService({
      markInterruptedTaskRunning,
      restoreInterruptedTaskAfterResumeFailure,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const startupFailureHandled = createDeferred<void>();
    fakeSession.sendMessage.mockImplementation(
      (
        _message: string,
        _options: unknown,
        internal?: {
          onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
        }
      ) => {
        void Promise.resolve().then(async () => {
          await internal?.onAcceptedPreStreamFailure?.({
            type: "runtime_start_failed",
            message: "Runtime is starting",
          });
          startupFailureHandled.resolve();
        });
        return Promise.resolve(Ok(undefined));
      }
    );

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
      editMessageId: "user-123",
    });

    expect(result.success).toBe(true);
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");

    await startupFailureHandled.promise;
    expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledWith("test-workspace");
  });

  test("resumeStream restores interrupted task status before successful resume", async () => {
    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setTaskService({
      markInterruptedTaskRunning,
      restoreInterruptedTaskAfterResumeFailure,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const result = await workspaceService.resumeStream("test-workspace", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");
    expect(restoreInterruptedTaskAfterResumeFailure).not.toHaveBeenCalled();
  });

  test("resumeStream keeps interrupted task status when no stream starts", async () => {
    fakeSession.resumeStream.mockResolvedValue(Ok({ started: false }));

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setTaskService({
      markInterruptedTaskRunning,
      restoreInterruptedTaskAfterResumeFailure,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const result = await workspaceService.resumeStream("test-workspace", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.started).toBe(false);
    }
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");
    expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledWith("test-workspace");
  });

  test("resumeStream does not start interrupted tasks while still busy", async () => {
    const getAgentTaskStatus = mock(() => "interrupted" as const);
    const markInterruptedTaskRunning = mock(() => Promise.resolve(false));
    workspaceService.setTaskService({
      getAgentTaskStatus,
      markInterruptedTaskRunning,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const result = await workspaceService.resumeStream("test-workspace", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    if (!result.success && result.error.type === "unknown") {
      expect(result.error.raw).toContain("Interrupted task is still winding down");
    }
    expect(getAgentTaskStatus).toHaveBeenCalledWith("test-workspace");
    expect(markInterruptedTaskRunning).not.toHaveBeenCalled();
    expect(fakeSession.resumeStream).not.toHaveBeenCalled();
  });

  test("sendMessage does not queue interrupted tasks while still busy", async () => {
    const getAgentTaskStatus = mock(() => "interrupted" as const);
    const markInterruptedTaskRunning = mock(() => Promise.resolve(false));
    workspaceService.setTaskService({
      getAgentTaskStatus,
      markInterruptedTaskRunning,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    if (!result.success && result.error.type === "unknown") {
      expect(result.error.raw).toContain("Interrupted task is still winding down");
    }
    expect(getAgentTaskStatus).toHaveBeenCalledWith("test-workspace");
    expect(markInterruptedTaskRunning).not.toHaveBeenCalled();
    expect(fakeSession.queueMessage).not.toHaveBeenCalled();
  });

  test("queued user messages reset auto-resume state", async () => {
    fakeSession.isBusy.mockReturnValue(true);

    const resetAutoResumeCount = mock(() => undefined);
    workspaceService.setTaskService({
      getAgentTaskStatus: mock(() => "running" as const),
      resetAutoResumeCount,
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalled();
    expect(resetAutoResumeCount).toHaveBeenCalledWith("test-workspace");
  });

  test("synthetic queued auto-resume messages preserve auto-resume state", async () => {
    fakeSession.isBusy.mockReturnValue(true);

    const resetAutoResumeCount = mock(() => undefined);
    workspaceService.setTaskService({
      getAgentTaskStatus: mock(() => "running" as const),
      resetAutoResumeCount,
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "await background work",
      {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
      },
      { skipAutoResumeReset: true, synthetic: true, agentInitiated: true }
    );

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalled();
    expect(resetAutoResumeCount).not.toHaveBeenCalled();
  });

  test("strips stale workspace-turn correlation behind an earlier queued entry", async () => {
    fakeSession.hasQueuedOrDispatchingEntry.mockReturnValue(true);
    const onCanceled = mock(() => undefined);
    const onAcceptedPreStreamFailure = mock(() => undefined);
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_stale_progress",
      ownerWorkspaceId: "owner-workspace",
      turnId: "turn-stale-progress",
    };

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "nested progress",
      { model: "openai:gpt-4o-mini", agentId: "exec", muxMetadata },
      {
        synthetic: true,
        agentInitiated: true,
        workspaceTurnContinuation: true,
        onCanceled,
        onAcceptedPreStreamFailure,
      }
    );

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalledWith(
      "nested progress",
      expect.not.objectContaining({ muxMetadata }),
      expect.objectContaining({
        onCanceled: undefined,
        onAcceptedPreStreamFailure: undefined,
      })
    );
  });

  test("keeps workspace-turn correlation for the next queued continuation", async () => {
    fakeSession.hasQueuedOrDispatchingEntry.mockReturnValue(false);
    const onCanceled = mock(() => undefined);
    const onAcceptedPreStreamFailure = mock(() => undefined);
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_next_progress",
      ownerWorkspaceId: "owner-workspace",
      turnId: "turn-next-progress",
    };

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "nested progress",
      { model: "openai:gpt-4o-mini", agentId: "exec", muxMetadata },
      {
        synthetic: true,
        agentInitiated: true,
        workspaceTurnContinuation: true,
        onCanceled,
        onAcceptedPreStreamFailure,
      }
    );

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalledWith(
      "nested progress",
      expect.objectContaining({ muxMetadata }),
      expect.objectContaining({ onCanceled, onAcceptedPreStreamFailure })
    );
  });

  test("synthetic queued sends leave a pending interactive question intact", async () => {
    fakeSession.isBusy.mockReturnValue(true);

    const questionPromise = askUserQuestionManager.registerPending("test-workspace", "tool-q1", [
      {
        question: "Proceed?",
        header: "Next",
        options: [
          { label: "Yes", description: "Continue" },
          { label: "No", description: "Stop" },
        ],
        multiSelect: false,
      },
    ]);
    // Attach handler before cleanup cancel so Bun does not flag an unhandled rejection.
    const settled = questionPromise.catch((error: unknown) => error);

    try {
      const result = await workspaceService.sendMessage(
        "test-workspace",
        "[Heartbeat] scheduled check-in",
        { model: "openai:gpt-4o-mini", agentId: "exec", queueDispatchMode: "turn-end" },
        { synthetic: true, skipAutoResumeReset: true }
      );

      expect(result.success).toBe(true);
      expect(fakeSession.queueMessage).toHaveBeenCalled();
      // A backend-initiated maintenance send is not a user response: the prompt survives.
      expect(askUserQuestionManager.getLatestPending("test-workspace")?.toolCallId).toBe("tool-q1");
    } finally {
      askUserQuestionManager.cancel("test-workspace", "tool-q1", "test cleanup");
      await settled;
    }
  });

  // The heartbeat caller's queue-emptiness check happens before sendMessage's internal
  // awaits (pricing gate, settings persistence), so a user send can queue in that window.
  // yieldToQueuedMessages re-checks at the enqueue point: queued messages own the slot.
  test("yieldToQueuedMessages drops the send when messages queued during preparation", async () => {
    fakeSession.isBusy.mockReturnValue(true);
    fakeSession.hasQueuedMessages.mockReturnValue(true);

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "[Heartbeat] scheduled check-in",
      { model: "openai:gpt-4o-mini", agentId: "exec", queueDispatchMode: "turn-end" },
      { synthetic: true, skipAutoResumeReset: true, yieldToQueuedMessages: true }
    );

    // Quiet success: the slot is consumed, but nothing is enqueued over the user's message.
    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).not.toHaveBeenCalled();
  });

  // The reverse race: a heartbeat queued first must not absorb a later real message —
  // MessageQueue batches texts under the first entry's muxMetadata, so input queued behind
  // a heartbeat would dispatch tagged as a heartbeat. New input supersedes the heartbeat.
  test("queued sends supersede a pending queued heartbeat before enqueueing", async () => {
    fakeSession.isBusy.mockReturnValue(true);
    fakeSession.dropQueuedMessageWithOnlyDedupeKey.mockReturnValue(true);

    const result = await workspaceService.sendMessage("test-workspace", "real user input", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(fakeSession.dropQueuedMessageWithOnlyDedupeKey).toHaveBeenCalledWith(
      "heartbeat-request"
    );
    // The user message still queues normally after the heartbeat is dropped.
    expect(fakeSession.queueMessage).toHaveBeenCalled();
  });

  test("a queued heartbeat send does not supersede itself", async () => {
    fakeSession.isBusy.mockReturnValue(true);

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "[Heartbeat] scheduled check-in",
      { model: "openai:gpt-4o-mini", agentId: "exec", queueDispatchMode: "turn-end" },
      {
        synthetic: true,
        skipAutoResumeReset: true,
        queueDedupeKey: "heartbeat-request",
        yieldToQueuedMessages: true,
      }
    );

    expect(result.success).toBe(true);
    expect(fakeSession.dropQueuedMessageWithOnlyDedupeKey).not.toHaveBeenCalled();
  });

  test("yieldToQueuedMessages still queues into an empty queue", async () => {
    fakeSession.isBusy.mockReturnValue(true);
    fakeSession.hasQueuedMessages.mockReturnValue(false);

    const result = await workspaceService.sendMessage(
      "test-workspace",
      "[Heartbeat] scheduled check-in",
      { model: "openai:gpt-4o-mini", agentId: "exec", queueDispatchMode: "turn-end" },
      { synthetic: true, skipAutoResumeReset: true, yieldToQueuedMessages: true }
    );

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalled();
  });

  test("non-synthetic queued sends cancel a pending interactive question", async () => {
    fakeSession.isBusy.mockReturnValue(true);

    const questionPromise = askUserQuestionManager.registerPending("test-workspace", "tool-q1", [
      {
        question: "Proceed?",
        header: "Next",
        options: [
          { label: "Yes", description: "Continue" },
          { label: "No", description: "Stop" },
        ],
        multiSelect: false,
      },
    ]);
    // Attach handler before the send cancels the question, avoiding an unhandled rejection.
    const settled = questionPromise.catch((error: unknown) => error);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(fakeSession.queueMessage).toHaveBeenCalled();
    // A real user message supersedes the question: it is canceled before queueing.
    expect(askUserQuestionManager.getLatestPending("test-workspace")).toBeNull();
    expect(await settled).toBeInstanceOf(Error);
  });

  test("backgrounds foreground task waits when queuing a tool-end message", async () => {
    fakeSession.isBusy.mockReturnValue(true);

    const backgroundForegroundWaitsForWorkspace = mock(() => 0);
    workspaceService.setTaskService({
      getAgentTaskStatus: mock(() => "running" as const),
      backgroundForegroundWaitsForWorkspace,
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(backgroundForegroundWaitsForWorkspace).toHaveBeenCalledWith("test-workspace");
    expect(fakeSession.queueMessage).toHaveBeenCalled();
  });

  test("does not background foreground task waits when queuing a turn-end message", async () => {
    fakeSession.isBusy.mockReturnValue(true);
    fakeSession.queueMessage.mockReturnValue("turn-end");

    const backgroundForegroundWaitsForWorkspace = mock(() => 0);
    workspaceService.setTaskService({
      getAgentTaskStatus: mock(() => "running" as const),
      backgroundForegroundWaitsForWorkspace,
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
      queueDispatchMode: "turn-end",
    });

    expect(result.success).toBe(true);
    expect(backgroundForegroundWaitsForWorkspace).not.toHaveBeenCalled();
    expect(fakeSession.queueMessage).toHaveBeenCalled();
  });

  test("does not background foreground task waits when queueMessage enqueues nothing", async () => {
    fakeSession.isBusy.mockReturnValue(true);
    fakeSession.queueMessage.mockReturnValue(null);

    const backgroundForegroundWaitsForWorkspace = mock(() => 0);
    workspaceService.setTaskService({
      getAgentTaskStatus: mock(() => "running" as const),
      backgroundForegroundWaitsForWorkspace,
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage("test-workspace", "   ", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(backgroundForegroundWaitsForWorkspace).not.toHaveBeenCalled();
  });

  test("backgrounds foreground task waits when effective queue mode is tool-end despite incoming turn-end", async () => {
    fakeSession.isBusy.mockReturnValue(true);
    // Incoming mode is turn-end but queue's effective mode is tool-end (sticky from prior enqueue)
    fakeSession.queueMessage.mockReturnValue("tool-end");

    const backgroundForegroundWaitsForWorkspace = mock(() => 0);
    workspaceService.setTaskService({
      getAgentTaskStatus: mock(() => "running" as const),
      backgroundForegroundWaitsForWorkspace,
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
      queueDispatchMode: "turn-end",
    });

    expect(result.success).toBe(true);
    expect(backgroundForegroundWaitsForWorkspace).toHaveBeenCalledWith("test-workspace");
    expect(fakeSession.queueMessage).toHaveBeenCalled();
  });

  test("sendMessage restores interrupted status when resumed send fails", async () => {
    fakeSession.isBusy.mockReturnValue(false);
    fakeSession.sendMessage.mockResolvedValue(
      Err({
        type: "unknown" as const,
        raw: "runtime startup failed after user turn persisted",
      })
    );

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setTaskService({
      markInterruptedTaskRunning,
      restoreInterruptedTaskAfterResumeFailure,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");
    expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledWith("test-workspace");
  });

  test("sendMessage restores interrupted status when resumed send throws", async () => {
    fakeSession.isBusy.mockReturnValue(false);
    fakeSession.sendMessage.mockRejectedValue(new Error("send explode"));

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setTaskService({
      markInterruptedTaskRunning,
      restoreInterruptedTaskAfterResumeFailure,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");
    expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledWith("test-workspace");
  });

  test("resumeStream restores interrupted status when resumed stream throws", async () => {
    fakeSession.resumeStream.mockRejectedValue(new Error("resume explode"));

    const markInterruptedTaskRunning = mock(() => Promise.resolve(true));
    const restoreInterruptedTaskAfterResumeFailure = mock(() => Promise.resolve());
    workspaceService.setTaskService({
      markInterruptedTaskRunning,
      restoreInterruptedTaskAfterResumeFailure,
      resetAutoResumeCount: mock(() => undefined),
    } as unknown as TaskService);

    const result = await workspaceService.resumeStream("test-workspace", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    expect(markInterruptedTaskRunning).toHaveBeenCalledWith("test-workspace");
    expect(restoreInterruptedTaskAfterResumeFailure).toHaveBeenCalledWith("test-workspace");
  });

  test("does not clear persisted agent status directly when direct send fails after turn acceptance", async () => {
    fakeSession.isBusy.mockReturnValue(false);
    fakeSession.sendMessage.mockResolvedValue(
      Err({
        type: "unknown" as const,
        raw: "runtime startup failed after user turn persisted",
      })
    );

    const updateAgentStatus = spyOn(
      workspaceService as unknown as {
        updateAgentStatus: (workspaceId: string, status: null) => Promise<void>;
      },
      "updateAgentStatus"
    ).mockResolvedValue(undefined);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    expect(updateAgentStatus).not.toHaveBeenCalled();
  });

  test("does not clear persisted agent status directly when direct send is rejected pre-acceptance", async () => {
    fakeSession.isBusy.mockReturnValue(false);
    fakeSession.sendMessage.mockResolvedValue(
      Err({
        type: "invalid_model_string" as const,
        message: "invalid model",
      })
    );

    const updateAgentStatus = spyOn(
      workspaceService as unknown as {
        updateAgentStatus: (workspaceId: string, status: null) => Promise<void>;
      },
      "updateAgentStatus"
    ).mockResolvedValue(undefined);

    const result = await workspaceService.sendMessage("test-workspace", "hello", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(false);
    expect(updateAgentStatus).not.toHaveBeenCalled();
  });

  test("registerSession clears persisted agent status for accepted user chat events", () => {
    const updateAgentStatus = spyOn(
      workspaceService as unknown as {
        updateAgentStatus: (workspaceId: string, status: null) => Promise<void>;
      },
      "updateAgentStatus"
    ).mockResolvedValue(undefined);

    const workspaceId = "listener-workspace";
    const sessionEmitter = new EventEmitter();
    const listenerSession = {
      onChatEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("chat-event", listener);
        return () => sessionEmitter.off("chat-event", listener);
      },
      onMetadataEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("metadata-event", listener);
        return () => sessionEmitter.off("metadata-event", listener);
      },
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      dispose: () => {},
    } as unknown as AgentSession;

    workspaceService.registerSession(workspaceId, listenerSession);

    sessionEmitter.emit("chat-event", {
      workspaceId,
      message: {
        type: "message",
        ...createMuxMessage("user-accepted", "user", "hello"),
      },
    });

    expect(updateAgentStatus).toHaveBeenCalledWith(workspaceId, null);
  });

  test("registerSession does not clear persisted agent status for synthetic user chat events", () => {
    const updateAgentStatus = spyOn(
      workspaceService as unknown as {
        updateAgentStatus: (workspaceId: string, status: null) => Promise<void>;
      },
      "updateAgentStatus"
    ).mockResolvedValue(undefined);

    const workspaceId = "synthetic-listener-workspace";
    const sessionEmitter = new EventEmitter();
    const listenerSession = {
      onChatEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("chat-event", listener);
        return () => sessionEmitter.off("chat-event", listener);
      },
      onMetadataEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("metadata-event", listener);
        return () => sessionEmitter.off("metadata-event", listener);
      },
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      dispose: () => {},
    } as unknown as AgentSession;

    workspaceService.registerSession(workspaceId, listenerSession);

    sessionEmitter.emit("chat-event", {
      workspaceId,
      message: {
        type: "message",
        ...createMuxMessage("user-synthetic", "user", "hello", { synthetic: true }),
      },
    });

    expect(updateAgentStatus).not.toHaveBeenCalled();
  });
});

describe("WorkspaceService pending auto-title", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let config: Config;
  let tempDir: string;
  let workspaceId: string;
  let projectPath: string;
  let workspacePath: string;
  let fakeSession: {
    isBusy: ReturnType<typeof mock>;
    queueMessage: ReturnType<typeof mock>;
    sendMessage: ReturnType<typeof mock>;
    resumeStream: ReturnType<typeof mock>;
  };

  beforeEach(async () => {
    ({
      config,
      tempDir,
      historyService,
      cleanup: cleanupHistory,
    } = await createTestHistoryService());

    workspaceId = "pending-auto-title-workspace";
    projectPath = path.join(tempDir, "project");
    workspacePath = path.join(projectPath, "fork-branch");
    await fsPromises.mkdir(projectPath, { recursive: true });
    await config.addWorkspace(projectPath, {
      id: workspaceId,
      name: "fork-branch",
      title: "Parent title (1)",
      pendingAutoTitle: true,
      projectName: "project",
      projectPath,
      createdAt: new Date().toISOString(),
      runtimeConfig: { type: "local" },
      namedWorkspacePath: workspacePath,
    });

    const metadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "fork-branch",
      title: "Parent title (1)",
      pendingAutoTitle: true,
      projectName: "project",
      projectPath,
      createdAt: new Date().toISOString(),
      runtimeConfig: { type: "local" },
      namedWorkspacePath: workspacePath,
    };
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(metadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockExtensionMetadata: Partial<ExtensionMetadataService> = {
      updateRecency: mock(() =>
        Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        })
      ),
      setStreaming: mock(() =>
        Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          agentStatus: null,
        })
      ),
    };

    workspaceService = new WorkspaceService(
      config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadata as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    fakeSession = {
      isBusy: mock(() => false),
      queueMessage: mock(() => "tool-end" as const),
      sendMessage: mock(() => Promise.resolve(Ok(undefined))),
      resumeStream: mock(() => Promise.resolve(Ok({ started: true }))),
    };

    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = mock(() => fakeSession as unknown as AgentSession);

    (
      workspaceService as unknown as {
        maybePersistAISettingsFromOptions: (
          workspaceId: string,
          options: unknown,
          source: "send" | "resume"
        ) => Promise<void>;
      }
    ).maybePersistAISettingsFromOptions = mock(() => Promise.resolve());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("sendMessage triggers fork auto-title after the first accepted continue message", async () => {
    const autoTitleSpy = spyOn(
      workspaceService as unknown as {
        maybeRunPendingAutoTitleFromMessage: (
          workspaceId: string,
          message: string
        ) => Promise<void>;
      },
      "maybeRunPendingAutoTitleFromMessage"
    ).mockResolvedValue(undefined);

    const result = await workspaceService.sendMessage(workspaceId, "Continue with auth hardening", {
      model: "openai:gpt-4o-mini",
      agentId: "exec",
    });

    expect(result.success).toBe(true);
    expect(autoTitleSpy).toHaveBeenCalledWith(workspaceId, "Continue with auth hardening");
  });

  test("concurrent sends only claim one pending auto-title generation", async () => {
    const releaseSend = createDeferred<Result<void, SendMessageError>>();
    fakeSession.sendMessage.mockImplementation(() => releaseSend.promise);
    const autoTitleSpy = spyOn(
      workspaceService as unknown as {
        maybeRunPendingAutoTitleFromMessage: (
          workspaceId: string,
          message: string
        ) => Promise<void>;
      },
      "maybeRunPendingAutoTitleFromMessage"
    ).mockResolvedValue(undefined);

    try {
      const firstSend = workspaceService.sendMessage(workspaceId, "First continue message", {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
      });
      const secondSend = workspaceService.sendMessage(workspaceId, "Second continue message", {
        model: "openai:gpt-4o-mini",
        agentId: "exec",
      });

      releaseSend.resolve(Ok(undefined));
      const [firstResult, secondResult] = await Promise.all([firstSend, secondSend]);

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      expect(autoTitleSpy).toHaveBeenCalledTimes(1);
      expect(autoTitleSpy).toHaveBeenCalledWith(workspaceId, "First continue message");
    } finally {
      autoTitleSpy.mockRestore();
    }
  });

  test("sendMessage only launches one pending auto-title generation at a time", async () => {
    const generationStarted = createDeferred<void>();
    const releaseGeneration = createDeferred<void>();
    const autoTitleSpy = spyOn(
      workspaceService as unknown as {
        maybeRunPendingAutoTitleFromMessage: (
          workspaceId: string,
          message: string
        ) => Promise<void>;
      },
      "maybeRunPendingAutoTitleFromMessage"
    ).mockImplementation(async () => {
      generationStarted.resolve();
      await releaseGeneration.promise;
    });

    try {
      const firstResult = await workspaceService.sendMessage(
        workspaceId,
        "First continue message",
        {
          model: "openai:gpt-4o-mini",
          agentId: "exec",
        }
      );
      expect(firstResult.success).toBe(true);
      await generationStarted.promise;

      const secondResult = await workspaceService.sendMessage(
        workspaceId,
        "Second continue message",
        {
          model: "openai:gpt-4o-mini",
          agentId: "exec",
        }
      );
      expect(secondResult.success).toBe(true);
      expect(autoTitleSpy).toHaveBeenCalledTimes(1);

      releaseGeneration.resolve();
      await Promise.resolve();
    } finally {
      autoTitleSpy.mockRestore();
    }
  });

  test("completing a pending auto-title replaces the fallback title and clears the state", async () => {
    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockResolvedValue(
      Ok({
        name: "auth-hardening-a1b2",
        title: "Harden auth flow",
        modelUsed: "openai:gpt-4o-mini",
      })
    );

    try {
      await (
        workspaceService as unknown as {
          maybeRunPendingAutoTitleFromMessage: (
            workspaceId: string,
            message: string
          ) => Promise<void>;
        }
      ).maybeRunPendingAutoTitleFromMessage(workspaceId, "Continue with auth hardening");

      const metadata = (await config.getAllWorkspaceMetadata()).find(
        (entry) => entry.id === workspaceId
      );
      expect(metadata?.title).toBe("Harden auth flow");
      expect(metadata?.pendingAutoTitle).toBeUndefined();
      expect(generateIdentitySpy.mock.calls[0]?.[0]).toBe("Continue with auth hardening");
    } finally {
      generateIdentitySpy.mockRestore();
    }
  });

  test("manual title edits cancel an in-flight auto-title before it can overwrite the title", async () => {
    const generationStarted = createDeferred<void>();
    const autoTitleResult =
      createDeferred<
        Awaited<ReturnType<typeof workspaceTitleGenerator.generateWorkspaceIdentity>>
      >();
    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockImplementation((_message, _candidates, _aiService) => {
      generationStarted.resolve();
      return autoTitleResult.promise;
    });

    try {
      const autoTitlePromise = (
        workspaceService as unknown as {
          maybeRunPendingAutoTitleFromMessage: (
            workspaceId: string,
            message: string
          ) => Promise<void>;
        }
      ).maybeRunPendingAutoTitleFromMessage(workspaceId, "Continue with auth hardening");

      await generationStarted.promise;

      const updateTitleResult = await workspaceService.updateTitle(workspaceId, "Manual title");
      expect(updateTitleResult.success).toBe(true);

      autoTitleResult.resolve(
        Ok({
          name: "auth-hardening-a1b2",
          title: "Harden auth flow",
          modelUsed: "openai:gpt-4o-mini",
        })
      );
      await autoTitlePromise;

      const metadata = (await config.getAllWorkspaceMetadata()).find(
        (entry) => entry.id === workspaceId
      );
      expect(metadata?.title).toBe("Manual title");
      expect(metadata?.pendingAutoTitle).toBeUndefined();
    } finally {
      generateIdentitySpy.mockRestore();
    }
  });
});

describe("WorkspaceService idle compaction dispatch", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("marks idle compaction send as synthetic when stream stays active", async () => {
    const workspaceId = "idle-ws";
    const sendMessage = mock(() => Promise.resolve(Ok(undefined)));
    const buildIdleCompactionSendOptions = mock(() =>
      Promise.resolve({ model: "openai:gpt-4o", agentId: "compact" })
    );

    let busyChecks = 0;
    const session = {
      isBusy: mock(() => {
        busyChecks += 1;
        return busyChecks >= 2;
      }),
    } as unknown as AgentSession;

    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).sendMessage = sendMessage;
    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).buildIdleCompactionSendOptions = buildIdleCompactionSendOptions;
    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = (_workspaceId: string) => session;

    await workspaceService.executeIdleCompaction(workspaceId);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      workspaceId,
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        skipAutoResumeReset: true,
        synthetic: true,
        requireIdle: true,
      })
    );

    const idleCompactingWorkspaces = (
      workspaceService as unknown as { idleCompactingWorkspaces: Set<string> }
    ).idleCompactingWorkspaces;
    expect(idleCompactingWorkspaces.has(workspaceId)).toBe(true);
  });

  test("does not mark idle compaction when send succeeds without active stream", async () => {
    const workspaceId = "idle-no-stream-ws";
    const sendMessage = mock(() => Promise.resolve(Ok(undefined)));
    const buildIdleCompactionSendOptions = mock(() =>
      Promise.resolve({ model: "openai:gpt-4o", agentId: "compact" })
    );

    const session = {
      isBusy: mock(() => false),
    } as unknown as AgentSession;

    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).sendMessage = sendMessage;
    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).buildIdleCompactionSendOptions = buildIdleCompactionSendOptions;
    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = (_workspaceId: string) => session;

    await workspaceService.executeIdleCompaction(workspaceId);

    const idleCompactingWorkspaces = (
      workspaceService as unknown as { idleCompactingWorkspaces: Set<string> }
    ).idleCompactingWorkspaces;
    expect(idleCompactingWorkspaces.has(workspaceId)).toBe(false);
  });

  test("propagates busy-skip errors", async () => {
    const workspaceId = "idle-busy-ws";
    const sendMessage = mock(() =>
      Promise.resolve(
        Err({
          type: "unknown" as const,
          raw: "Workspace is busy; idle-only send was skipped.",
        })
      )
    );
    const buildIdleCompactionSendOptions = mock(() =>
      Promise.resolve({ model: "openai:gpt-4o", agentId: "compact" })
    );

    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
      }
    ).sendMessage = sendMessage;
    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
      }
    ).buildIdleCompactionSendOptions = buildIdleCompactionSendOptions;

    // The busy-skip is an expected race, so it must not be reported as a failure
    // (otherwise two normal user-interaction races would suppress idle compaction).
    const outcomes: Array<{ workspaceId: string; outcome: IdleCompactionOutcome }> = [];
    workspaceService.setIdleCompactionOutcomeListener((id, outcome) =>
      outcomes.push({ workspaceId: id, outcome })
    );

    let executionError: unknown;
    try {
      await workspaceService.executeIdleCompaction(workspaceId);
    } catch (error) {
      executionError = error;
    }

    expect(executionError).toBeInstanceOf(Error);
    if (!(executionError instanceof Error)) {
      throw new Error("Expected idle compaction to throw when workspace is busy");
    }
    expect(executionError.message).toContain("idle-only send was skipped");
    expect(outcomes).toEqual([]);
  });

  test("reports a model_not_found outcome when the compaction model is invalid", async () => {
    const workspaceId = "idle-model-not-found-ws";
    const sendMessage = mock(() =>
      Promise.resolve(
        Err({
          type: "invalid_model_string" as const,
          message: "Invalid model string: openai:does-not-exist",
        })
      )
    );
    const buildIdleCompactionSendOptions = mock(() =>
      Promise.resolve({ model: "openai:does-not-exist", agentId: "compact" })
    );
    const session = { isBusy: mock(() => false) } as unknown as AgentSession;

    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).sendMessage = sendMessage;
    (
      workspaceService as unknown as {
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
      }
    ).buildIdleCompactionSendOptions = buildIdleCompactionSendOptions;
    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = () => session;

    const outcomes: Array<{ workspaceId: string; outcome: IdleCompactionOutcome }> = [];
    workspaceService.setIdleCompactionOutcomeListener((id, outcome) =>
      outcomes.push({ workspaceId: id, outcome })
    );

    let threw = false;
    try {
      await workspaceService.executeIdleCompaction(workspaceId);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(outcomes).toEqual([{ workspaceId, outcome: { success: false, modelNotFound: true } }]);
  });

  test("reports a non-model_not_found outcome for generic pre-stream failures", async () => {
    const workspaceId = "idle-generic-failure-ws";
    const sendMessage = mock(() => Promise.resolve(Err({ type: "unknown" as const, raw: "boom" })));
    const buildIdleCompactionSendOptions = mock(() =>
      Promise.resolve({ model: "openai:gpt-4o", agentId: "compact" })
    );
    const session = { isBusy: mock(() => false) } as unknown as AgentSession;

    (
      workspaceService as unknown as {
        sendMessage: typeof sendMessage;
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).sendMessage = sendMessage;
    (
      workspaceService as unknown as {
        buildIdleCompactionSendOptions: typeof buildIdleCompactionSendOptions;
      }
    ).buildIdleCompactionSendOptions = buildIdleCompactionSendOptions;
    (
      workspaceService as unknown as {
        getOrCreateSession: (workspaceId: string) => AgentSession;
      }
    ).getOrCreateSession = () => session;

    const outcomes: Array<{ workspaceId: string; outcome: IdleCompactionOutcome }> = [];
    workspaceService.setIdleCompactionOutcomeListener((id, outcome) =>
      outcomes.push({ workspaceId: id, outcome })
    );

    let threw = false;
    try {
      await workspaceService.executeIdleCompaction(workspaceId);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(outcomes).toEqual([{ workspaceId, outcome: { success: false, modelNotFound: false } }]);
  });

  test("prefers global compact thinking default over exec and activity fallbacks", async () => {
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/project/ws";

    type ThinkingLevel = Parameters<typeof enforceThinkingPolicy>[1];

    interface WorkspaceServiceIdleCompactionAccess {
      buildIdleCompactionSendOptions: (workspaceId: string) => Promise<{
        model: string;
        thinkingLevel: ThinkingLevel;
      }>;
      config: {
        findWorkspace: (
          workspaceId: string
        ) => { projectPath: string; workspacePath: string } | null;
        loadConfigOrDefault: () => {
          projects: Map<string, { workspaces: Array<Record<string, unknown>> }>;
          agentAiDefaults?: {
            compact?: {
              thinkingLevel?: ThinkingLevel;
            };
          };
        };
      };
      extensionMetadata: ExtensionMetadataService;
    }

    const svc = workspaceService as unknown as WorkspaceServiceIdleCompactionAccess;

    svc.config.findWorkspace = mock((workspaceId: string) =>
      workspaceId === "ws" ? { projectPath, workspacePath } : null
    );
    svc.config.loadConfigOrDefault = mock(() => ({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: "ws",
                path: workspacePath,
                name: "ws",
                aiSettingsByAgent: {
                  exec: { model: "openai:gpt-4o-mini", thinkingLevel: "low" },
                },
              },
            ],
          },
        ],
      ]),
      agentAiDefaults: {
        compact: { thinkingLevel: "high" as ThinkingLevel },
      },
    }));

    svc.extensionMetadata = {
      getSnapshot: mock(() => Promise.resolve({ lastThinkingLevel: "off" })),
    } as unknown as ExtensionMetadataService;

    const options = await svc.buildIdleCompactionSendOptions("ws");

    expect(options.thinkingLevel).toBe(enforceThinkingPolicy(options.model, "high"));
  });

  test("does not tag streaming=true snapshots as idle compaction", async () => {
    const workspaceId = "idle-streaming-true-no-tag";
    const snapshot = {
      recency: Date.now(),
      streaming: true,
      lastModel: "claude-sonnet-4",
      lastThinkingLevel: null,
    };

    const setStreaming = mock(() => Promise.resolve(snapshot));
    const emitWorkspaceActivity = mock(
      (_workspaceId: string, _snapshot: typeof snapshot) => undefined
    );

    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
        emitWorkspaceActivity: typeof emitWorkspaceActivity;
      }
    ).extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;
    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
        emitWorkspaceActivity: typeof emitWorkspaceActivity;
      }
    ).emitWorkspaceActivity = emitWorkspaceActivity;

    const internals = workspaceService as unknown as {
      idleCompactingWorkspaces: Set<string>;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    internals.idleCompactingWorkspaces.add(workspaceId);

    await internals.updateStreamingStatus(workspaceId, true);

    expect(setStreaming).toHaveBeenCalledWith(workspaceId, true, {});
    expect(emitWorkspaceActivity).toHaveBeenCalledTimes(1);
    expect(emitWorkspaceActivity).toHaveBeenCalledWith(workspaceId, snapshot);
    expect(internals.idleCompactingWorkspaces.has(workspaceId)).toBe(true);
  });

  test("passes through stream-start thinkingLevel without re-deriving it from config", async () => {
    const workspaceId = "streaming-thinking-level";
    const snapshot = {
      recency: Date.now(),
      streaming: true,
      lastModel: "claude-sonnet-4",
      lastThinkingLevel: "high" as const,
    };

    const setStreaming = mock(() => Promise.resolve(snapshot));
    const emitWorkspaceActivity = mock(
      (_workspaceId: string, _snapshot: typeof snapshot) => undefined
    );

    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
        emitWorkspaceActivity: typeof emitWorkspaceActivity;
      }
    ).extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;
    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
        emitWorkspaceActivity: typeof emitWorkspaceActivity;
      }
    ).emitWorkspaceActivity = emitWorkspaceActivity;

    const internals = workspaceService as unknown as {
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    await internals.updateStreamingStatus(workspaceId, true, {
      model: "claude-sonnet-4",
      thinkingLevel: "high",
    });

    expect(setStreaming).toHaveBeenCalledWith(workspaceId, true, {
      model: "claude-sonnet-4",
      thinkingLevel: "high",
    });
    expect(emitWorkspaceActivity).toHaveBeenCalledWith(workspaceId, snapshot);
  });

  test("clears idle marker when streaming=false metadata update fails", async () => {
    const workspaceId = "idle-streaming-false-failure";

    const setStreaming = mock(() => Promise.reject(new Error("setStreaming failed")));
    const extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;

    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
      }
    ).extensionMetadata = extensionMetadata;

    const internals = workspaceService as unknown as {
      idleCompactingWorkspaces: Set<string>;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    internals.idleCompactingWorkspaces.add(workspaceId);

    await internals.updateStreamingStatus(workspaceId, false);

    expect(internals.idleCompactingWorkspaces.has(workspaceId)).toBe(false);
    // todoStatus is intentionally NOT passed when there are no todos —
    // passing null would delete an AgentStatusService-written AI summary
    // from the same slot. Explicit clears happen via setTodoStatus.
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, false, {
      hasTodos: false,
    });
  });

  test("stream-stop with no todos does NOT clear todoStatus (preserves AI summary)", async () => {
    // Codex: AgentStatusService writes its AI-generated summary into the
    // same `todoStatus` slot that `setTodoStatus` uses. The stream-stop
    // path used to read an empty todo list and pass `todoStatus: null`,
    // which deleted the slot — wiping a summary that was just generated
    // during the stream. Free-form chats (no todos) hit this every turn.
    const workspaceId = "stream-stop-preserves-ai-status";
    const snapshot = {
      recency: Date.now(),
      streaming: false,
      lastModel: "claude-sonnet-4",
      lastThinkingLevel: null,
    };
    const setStreaming = mock(() => Promise.resolve(snapshot));
    const emitWorkspaceActivity = mock(
      (_workspaceId: string, _snapshot: typeof snapshot) => undefined
    );

    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
        emitWorkspaceActivity: typeof emitWorkspaceActivity;
      }
    ).extensionMetadata = { setStreaming } as unknown as ExtensionMetadataService;
    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
        emitWorkspaceActivity: typeof emitWorkspaceActivity;
      }
    ).emitWorkspaceActivity = emitWorkspaceActivity;

    const internals = workspaceService as unknown as {
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    await internals.updateStreamingStatus(workspaceId, false);

    // The setStreaming call must omit `todoStatus` entirely. If it included
    // `todoStatus: null`, ExtensionMetadataService.setStreaming would delete
    // the slot (see the `update.todoStatus !== undefined` branch there).
    expect(setStreaming).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, false, { hasTodos: false });
    // Defensive double-check that the assertion is strict — toHaveBeenCalledWith
    // with an object literal in some matchers tolerates extra fields. Use
    // `not` against an explicit `todoStatus: null` payload to lock the
    // contract.
    expect(setStreaming).not.toHaveBeenCalledWith(workspaceId, false, {
      hasTodos: false,
      todoStatus: null,
    });
  });
});

describe("WorkspaceService streaming generation guard", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let readTodosSpy:
    | ReturnType<typeof spyOn<typeof todoStorageModule, "readTodosForSessionDir">>
    | undefined;

  beforeEach(async () => {
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock((workspaceId: string) => `/tmp/test/sessions/${workspaceId}`),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    readTodosSpy?.mockRestore();
    await cleanupHistory();
  });

  test("stop-side metadata write is skipped when a newer stream has started", async () => {
    const workspaceId = "ws-generation-guard";
    const todoReadDeferred =
      createDeferred<Awaited<ReturnType<typeof todoStorageModule.readTodosForSessionDir>>>();
    let todoReadCalls = 0;
    const setStreaming = mock(
      (_workspaceId: string, streaming: boolean, update: ExtensionMetadataStreamingUpdate = {}) =>
        Promise.resolve({
          recency: Date.now(),
          streaming,
          lastModel: update.model ?? null,
          lastThinkingLevel: update.thinkingLevel ?? null,
          hasTodos: update.hasTodos,
          agentStatus: null,
        })
    );

    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockImplementation(() => {
      todoReadCalls += 1;
      if (todoReadCalls === 1) {
        return todoReadDeferred.promise;
      }
      return Promise.resolve([]);
    });

    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
      }
    ).extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;

    const internals = workspaceService as unknown as {
      streamingGenerations: Map<string, number>;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    internals.streamingGenerations.set(workspaceId, 1);
    const staleStopPromise = internals.updateStreamingStatus(workspaceId, false, {
      generation: 1,
    });

    internals.streamingGenerations.set(workspaceId, 2);
    await internals.updateStreamingStatus(workspaceId, true, { model: "openai:gpt-4o" });

    todoReadDeferred.resolve([]);
    await staleStopPromise;

    expect(setStreaming).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, true, { model: "openai:gpt-4o" });
  });

  test("todo snapshot refreshes run in call order for consecutive updates", async () => {
    const workspaceId = "ws-todo-refresh-order";
    const firstWriteDeferred = createDeferred<WorkspaceActivitySnapshot>();
    const setTodoStatus = mock(
      (
        _workspaceId: string,
        todoStatus: { emoji: string; message: string } | null,
        hasTodos: boolean
      ) => {
        if (todoStatus?.message === "First task") {
          return firstWriteDeferred.promise;
        }
        return Promise.resolve({
          recency: Date.now(),
          streaming: false,
          lastModel: null,
          lastThinkingLevel: null,
          todoStatus,
          hasTodos,
        });
      }
    );

    let readCount = 0;
    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockImplementation(() => {
      readCount += 1;
      if (readCount === 1) {
        return Promise.resolve([{ content: "First task", status: "in_progress" }]);
      }
      return Promise.resolve([{ content: "Second task", status: "in_progress" }]);
    });

    (
      workspaceService as unknown as {
        extensionMetadata: ExtensionMetadataService;
      }
    ).extensionMetadata = {
      setTodoStatus,
    } as unknown as ExtensionMetadataService;

    const internals = workspaceService as unknown as {
      updateTodoStatusFromStorage: (workspaceId: string) => Promise<void>;
    };

    const firstRefresh = internals.updateTodoStatusFromStorage(workspaceId);
    const secondRefresh = internals.updateTodoStatusFromStorage(workspaceId);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setTodoStatus).toHaveBeenCalledTimes(1);
    expect(readCount).toBe(1);

    firstWriteDeferred.resolve({
      recency: Date.now(),
      streaming: false,
      lastModel: null,
      lastThinkingLevel: null,
      todoStatus: { emoji: "🔄", message: "First task" },
      hasTodos: true,
    });

    await Promise.all([firstRefresh, secondRefresh]);

    expect(setTodoStatus).toHaveBeenCalledTimes(2);
    expect(setTodoStatus.mock.calls[0]).toEqual([
      workspaceId,
      { emoji: "🔄", message: "First task" },
      true,
    ]);
    expect(setTodoStatus.mock.calls[1]).toEqual([
      workspaceId,
      { emoji: "🔄", message: "Second task" },
      true,
    ]);
  });

  test("handleStreamCompletion captures generation before awaiting recency updates", async () => {
    const workspaceId = "ws-stream-completion-generation";
    const recencyDeferred = createDeferred<void>();
    const setStreaming = mock(
      (_workspaceId: string, streaming: boolean, update: ExtensionMetadataStreamingUpdate = {}) =>
        Promise.resolve({
          recency: Date.now(),
          streaming,
          lastModel: update.model ?? null,
          lastThinkingLevel: update.thinkingLevel ?? null,
          hasTodos: update.hasTodos,
          agentStatus: null,
        })
    );

    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockResolvedValue([]);

    const internals = workspaceService as unknown as {
      extensionMetadata: ExtensionMetadataService;
      streamingGenerations: Map<string, number>;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
      updateRecencyTimestamp: (workspaceId: string, timestamp?: number) => Promise<void>;
      handleStreamCompletion: (workspaceId: string) => Promise<void>;
    };

    internals.extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;
    internals.updateRecencyTimestamp = mock(() => recencyDeferred.promise);

    internals.streamingGenerations.set(workspaceId, 1);
    const completionPromise = internals.handleStreamCompletion(workspaceId);

    internals.streamingGenerations.set(workspaceId, 2);
    await internals.updateStreamingStatus(workspaceId, true, { model: "openai:gpt-4o-mini" });

    recencyDeferred.resolve();
    await completionPromise;

    expect(internals.updateRecencyTimestamp).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, true, { model: "openai:gpt-4o-mini" });
  });
  test("tags matching compaction stop snapshots and clears the generation marker", async () => {
    const workspaceId = "ws-compaction-stream-stop";
    const setStreaming = mock(
      (_workspaceId: string, streaming: boolean, update: ExtensionMetadataStreamingUpdate = {}) =>
        Promise.resolve({
          recency: Date.now(),
          streaming,
          lastModel: update.model ?? null,
          lastThinkingLevel: update.thinkingLevel ?? null,
          hasTodos: update.hasTodos,
          agentStatus: null,
        })
    );
    const emitWorkspaceActivity = mock(
      (_workspaceId: string, _snapshot: WorkspaceActivitySnapshot | null) => undefined
    );

    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockResolvedValue([]);

    const internals = workspaceService as unknown as {
      extensionMetadata: ExtensionMetadataService;
      streamingGenerations: Map<string, number>;
      compactionStreamGenerations: Map<string, number>;
      emitWorkspaceActivity: (
        workspaceId: string,
        snapshot: WorkspaceActivitySnapshot | null
      ) => void;
      updateStreamingStatus: (
        workspaceId: string,
        streaming: boolean,
        options?: ExtensionMetadataStreamingUpdate
      ) => Promise<void>;
    };

    internals.extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;
    internals.emitWorkspaceActivity = emitWorkspaceActivity;
    internals.streamingGenerations.set(workspaceId, 3);
    internals.compactionStreamGenerations.set(workspaceId, 3);

    await internals.updateStreamingStatus(workspaceId, false, { generation: 3 });

    expect(emitWorkspaceActivity).toHaveBeenCalledWith(
      workspaceId,
      expect.objectContaining({ streaming: false, isCompaction: true })
    );
    expect(internals.compactionStreamGenerations.has(workspaceId)).toBe(false);
  });

  test("handleStreamCompletion skips recency updates for idle compaction", async () => {
    const workspaceId = "ws-idle-stream-completion";
    const setStreaming = mock(
      (_workspaceId: string, streaming: boolean, update: ExtensionMetadataStreamingUpdate = {}) =>
        Promise.resolve({
          recency: Date.now(),
          streaming,
          lastModel: update.model ?? null,
          lastThinkingLevel: update.thinkingLevel ?? null,
          hasTodos: update.hasTodos,
          agentStatus: null,
        })
    );

    readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockResolvedValue([]);

    const internals = workspaceService as unknown as {
      extensionMetadata: ExtensionMetadataService;
      streamingGenerations: Map<string, number>;
      idleCompactingWorkspaces: Set<string>;
      updateRecencyTimestamp: (workspaceId: string, timestamp?: number) => Promise<void>;
      handleStreamCompletion: (workspaceId: string) => Promise<void>;
    };

    internals.extensionMetadata = {
      setStreaming,
    } as unknown as ExtensionMetadataService;
    internals.updateRecencyTimestamp = mock(() => Promise.resolve());

    internals.streamingGenerations.set(workspaceId, 7);
    internals.idleCompactingWorkspaces.add(workspaceId);

    await internals.handleStreamCompletion(workspaceId);

    expect(internals.updateRecencyTimestamp).not.toHaveBeenCalled();
    expect(setStreaming).toHaveBeenCalledTimes(1);
    expect(setStreaming).toHaveBeenCalledWith(
      workspaceId,
      false,
      expect.objectContaining({ generation: 7, hasTodos: false })
    );
  });
});

describe("WorkspaceService executeBash archive guards", () => {
  let workspaceService: WorkspaceService;
  let waitForInitMock: ReturnType<typeof mock>;
  let getWorkspaceMetadataMock: ReturnType<typeof mock>;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    waitForInitMock = mock(() => Promise.resolve());

    getWorkspaceMetadataMock = mock(() =>
      Promise.resolve({ success: false as const, error: "not found" })
    );

    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: getWorkspaceMetadataMock,
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
      getProjectSecrets: mock(() => []),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
      waitForInit: waitForInitMock,
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("archived workspace => executeBash returns error mentioning archived", async () => {
    const workspaceId = "ws-archived";

    const archivedMetadata: WorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: "/tmp/proj",
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      archivedAt: "2026-01-01T00:00:00.000Z",
    };

    getWorkspaceMetadataMock.mockReturnValue(Promise.resolve(Ok(archivedMetadata)));

    const result = await workspaceService.executeBash(workspaceId, "echo hello");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("archived");
    }

    // This must happen before init/runtime operations.
    expect(waitForInitMock).toHaveBeenCalledTimes(0);
  });

  test("archiving workspace => executeBash returns error mentioning being archived", async () => {
    const workspaceId = "ws-archiving";

    addToArchivingWorkspaces(workspaceService, workspaceId);

    const result = await workspaceService.executeBash(workspaceId, "echo hello");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("being archived");
    }

    expect(waitForInitMock).toHaveBeenCalledTimes(0);
    expect(getWorkspaceMetadataMock).toHaveBeenCalledTimes(0);
  });
});

describe("WorkspaceService executeBash workspace path resolution", () => {
  let workspaceService: WorkspaceService;
  let waitForInitMock: ReturnType<typeof mock>;
  let getWorkspaceMetadataMock: ReturnType<typeof mock>;
  let findWorkspaceMock: ReturnType<typeof mock>;
  let getEffectiveSecretsMock: ReturnType<typeof mock>;
  let createRuntimeSpy: Mock<typeof runtimeFactory.createRuntime>;
  let createBashToolSpy: Mock<typeof bashToolModule.createBashTool>;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    waitForInitMock = mock(() => Promise.resolve());
    findWorkspaceMock = mock(() => ({
      workspacePath: "/persisted/workspace-root",
      projectPath: "/tmp/proj",
      workspaceName: "ws",
    }));
    getEffectiveSecretsMock = mock(() => []);
    getWorkspaceMetadataMock = mock(() =>
      Promise.resolve(
        Ok({
          id: "ws-path",
          name: "ws",
          projectName: "proj",
          projectPath: "/tmp/proj",
          runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/runtime-src" },
        } satisfies WorkspaceMetadata)
      )
    );

    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: getWorkspaceMetadataMock,
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: findWorkspaceMock,
      getEffectiveSecrets: getEffectiveSecretsMock,
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
      waitForInit: waitForInitMock,
    };
    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      ensureReady: mock(() => Promise.resolve({ ready: true })),
      getWorkspacePath: mock(() => "/runtime/workspace-root"),
      normalizePath: mock((targetPath: string, basePath: string) =>
        targetPath ? `${basePath}/${targetPath}` : basePath
      ),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    createBashToolSpy = spyOn(bashToolModule, "createBashTool").mockReturnValue({
      execute: mock(() =>
        Promise.resolve({
          success: true,
          output: "ok",
          exitCode: 0,
          wall_duration_ms: 1,
        } satisfies BashToolResult)
      ),
    } as unknown as ReturnType<typeof bashToolModule.createBashTool>);
  });

  afterEach(async () => {
    createRuntimeSpy.mockRestore();
    createBashToolSpy.mockRestore();
    await cleanupHistory();
  });

  test("uses persisted workspace root for path-addressable runtimes", async () => {
    const result = await workspaceService.executeBash("ws-path", "pwd");

    expect(result.success).toBe(true);
    expect(createRuntimeSpy).toHaveBeenCalled();
    expect(createBashToolSpy).toHaveBeenCalledTimes(1);
    expect(createBashToolSpy.mock.calls[0]?.[0]?.cwd).toBe("/persisted/workspace-root");
    expect(waitForInitMock).toHaveBeenCalledWith("ws-path");
  });

  test("keeps default sub-project execution in the sub-project but runs repo-root mode at checkout root", async () => {
    getWorkspaceMetadataMock.mockReturnValue(
      Promise.resolve(
        Ok({
          id: "ws-path",
          name: "ws",
          projectName: "proj",
          projectPath: "/tmp/proj",
          subProjectPath: "/tmp/proj/packages/api",
          runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/runtime-src" },
        } satisfies WorkspaceMetadata)
      )
    );

    const defaultResult = await workspaceService.executeBash("ws-path", "pwd");
    const repoRootResult = await workspaceService.executeBash("ws-path", "git diff", {
      cwdMode: "repo-root",
    });
    const gitCommandResult = await workspaceService.executeBash("ws-path", "", undefined, "git", [
      "status",
    ]);

    expect(defaultResult.success).toBe(true);
    expect(repoRootResult.success).toBe(true);
    expect(gitCommandResult.success).toBe(true);
    expect(createBashToolSpy).toHaveBeenCalledTimes(3);
    expect(createBashToolSpy.mock.calls[0]?.[0]?.cwd).toBe(
      "/persisted/workspace-root/packages/api"
    );
    expect(createBashToolSpy.mock.calls[1]?.[0]?.cwd).toBe("/persisted/workspace-root");
    expect(createBashToolSpy.mock.calls[2]?.[0]?.cwd).toBe("/persisted/workspace-root");
  });

  test("keeps docker executeBash rooted in the translated runtime path", async () => {
    getWorkspaceMetadataMock.mockReturnValue(
      Promise.resolve(
        Ok({
          id: "ws-path",
          name: "ws",
          projectName: "proj",
          projectPath: "/tmp/proj",
          runtimeConfig: { type: "docker", image: "node:20" },
        } satisfies WorkspaceMetadata)
      )
    );

    const result = await workspaceService.executeBash("ws-path", "pwd");

    expect(result.success).toBe(true);
    expect(createBashToolSpy).toHaveBeenCalledTimes(1);
    expect(createBashToolSpy.mock.calls[0]?.[0]?.cwd).toBe("/runtime/workspace-root");
  });
});

describe("WorkspaceService getFileCompletions", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let createRuntimeSpy: Mock<typeof runtimeFactory.createRuntime>;
  let execBufferedSpy: Mock<typeof runtimeExecHelpers.execBuffered>;

  beforeEach(async () => {
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      ),
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockImplementation(
      (_runtimeConfig, options) => {
        if (!options?.projectPath) {
          throw new Error("Expected createRuntime projectPath in getFileCompletions test");
        }
        const runtimeProjectPath = options.projectPath;

        return {
          getWorkspacePath: (_projectPath: string, workspaceName: string) =>
            `/runtime/${path.basename(runtimeProjectPath)}/${workspaceName}`,
        } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
      }
    );

    execBufferedSpy = spyOn(runtimeExecHelpers, "execBuffered").mockImplementation(
      (_runtime, _command, options) =>
        Promise.reject(new Error(`Unexpected execBuffered call for ${options.cwd}`))
    );
  });

  afterEach(async () => {
    createRuntimeSpy.mockRestore();
    execBufferedSpy.mockRestore();
    await cleanupHistory();
  });

  test("keeps single-project completions unchanged", async () => {
    interface WorkspaceServiceTestAccess {
      getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.getInfo = mock(() =>
      Promise.resolve({
        id: "ws-single",
        name: "ws",
        projectName: "project-a",
        projectPath: "/tmp/project-a",
        namedWorkspacePath: "/persisted/project-a/ws",
        runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
      } satisfies FrontendWorkspaceMetadata)
    );

    execBufferedSpy.mockResolvedValue({
      stdout: "src/single.ts\n",
      stderr: "",
      exitCode: 0,
      duration: 1,
    });

    const result = await workspaceService.getFileCompletions("ws-single", "src/");

    expect(result.paths).toEqual(["src/single.ts"]);
    expect(execBufferedSpy).toHaveBeenCalledTimes(1);
    expect(execBufferedSpy.mock.calls[0]?.[2].cwd).toBe("/persisted/project-a/ws");
  });

  test("preserves the current SSH workspace path and derives sibling legacy paths for multi-project completions when the persisted root matches that layout", async () => {
    interface WorkspaceServiceTestAccess {
      getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.getInfo = mock(() =>
      Promise.resolve({
        id: "ws-multi-ssh",
        name: "ws",
        projectName: "project-a",
        projectPath: "/tmp/project-a",
        namedWorkspacePath: "/tmp/src/project-a/ws",
        runtimeConfig: { type: "ssh", host: "example.com", srcBaseDir: "/tmp/src" },
        projects: [
          { projectPath: "/tmp/project-a", projectName: "project-a" },
          { projectPath: "/tmp/project-b", projectName: "project-b" },
        ],
      } satisfies FrontendWorkspaceMetadata)
    );
    const config = (workspaceService as unknown as { config: Config }).config;
    spyOn(config, "findWorkspace").mockReturnValue({
      projectPath: "/tmp/project-a",
      workspacePath: "/tmp/src/project-a/ws",
    });
    createRuntimeSpy.mockImplementation((_runtimeConfig, options) => {
      const runtimeProjectPath = options?.projectPath;
      if (!runtimeProjectPath) {
        throw new Error("Expected createRuntime projectPath in SSH completion test");
      }
      return {
        getWorkspacePath: () =>
          options.workspacePath ?? `/runtime/${path.basename(runtimeProjectPath)}/ws`,
      } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;
    });

    execBufferedSpy.mockImplementation((_runtime, _command, options) => {
      if (options.cwd === "/tmp/src/project-a/ws") {
        return Promise.resolve({
          stdout: "README.md\n",
          stderr: "",
          exitCode: 0,
          duration: 1,
        });
      }
      if (options.cwd === "/tmp/src/project-b/ws") {
        return Promise.resolve({
          stdout: "src/b.ts\n",
          stderr: "",
          exitCode: 0,
          duration: 1,
        });
      }
      return Promise.reject(new Error(`Unexpected cwd ${options.cwd}`));
    });

    const result = await workspaceService.getFileCompletions("ws-multi-ssh", "", 10);

    expect(result.paths).toContain("project-a/README.md");
    expect(result.paths).toContain("project-b/src/b.ts");
    expect(createRuntimeSpy).toHaveBeenNthCalledWith(1, expect.anything(), {
      projectPath: "/tmp/project-a",
      workspaceName: "ws",
      workspacePath: "/tmp/src/project-a/ws",
    });
    expect(createRuntimeSpy).toHaveBeenNthCalledWith(2, expect.anything(), {
      projectPath: "/tmp/project-b",
      workspaceName: "ws",
      workspacePath: "/tmp/src/project-b/ws",
    });
  });

  test("aggregates multi-project completions using project-prefixed paths", async () => {
    interface WorkspaceServiceTestAccess {
      getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.getInfo = mock(() =>
      Promise.resolve({
        id: "ws-multi",
        name: "ws",
        projectName: "project-a",
        projectPath: "/tmp/project-a",
        namedWorkspacePath: "/persisted/container/ws",
        runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
        projects: [
          { projectPath: "/tmp/project-a", projectName: "project-a" },
          { projectPath: "/tmp/project-b", projectName: "project-b" },
        ],
      } satisfies FrontendWorkspaceMetadata)
    );

    execBufferedSpy.mockImplementation((_runtime, _command, options) => {
      if (options.cwd === "/runtime/project-a/ws") {
        return Promise.resolve({
          stdout: "README.md\nsrc/a.ts\n",
          stderr: "",
          exitCode: 0,
          duration: 1,
        });
      }

      if (options.cwd === "/runtime/project-b/ws") {
        return Promise.resolve({
          stdout: "src/b.ts\nnested/keep.ts\n",
          stderr: "",
          exitCode: 0,
          duration: 1,
        });
      }

      return Promise.reject(new Error(`Unexpected cwd ${options.cwd}`));
    });

    const result = await workspaceService.getFileCompletions("ws-multi", "", 10);

    expect(result.paths).toContain("project-a/README.md");
    expect(result.paths).toContain("project-a/src/a.ts");
    expect(result.paths).toContain("project-b/src/b.ts");
    expect(result.paths).toContain("project-b/nested/keep.ts");
    expect(result.paths).not.toContain("src/a.ts");
    expect(result.paths).toHaveLength(4);

    const completionCwds = execBufferedSpy.mock.calls
      .map((call) => call[2].cwd)
      .sort((left, right) => left.localeCompare(right));
    expect(completionCwds).toEqual(["/runtime/project-a/ws", "/runtime/project-b/ws"]);
  });
});

describe("WorkspaceService getProjectGitStatuses", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  function createGitStatusOutput(params?: {
    headBranch?: string;
    primaryBranch?: string;
    ahead?: number;
    behind?: number;
    dirtyCount?: number;
    outgoingAdditions?: number;
    outgoingDeletions?: number;
    incomingAdditions?: number;
    incomingDeletions?: number;
  }): string {
    return [
      "---HEAD_BRANCH---",
      params?.headBranch ?? "feature/test",
      "---PRIMARY---",
      params?.primaryBranch ?? "main",
      "---AHEAD_BEHIND---",
      `${params?.ahead ?? 1} ${params?.behind ?? 0}`,
      "---DIRTY---",
      String(params?.dirtyCount ?? 0),
      "---LINE_DELTA---",
      `${params?.outgoingAdditions ?? 5} ${params?.outgoingDeletions ?? 2} ${params?.incomingAdditions ?? 3} ${params?.incomingDeletions ?? 1}`,
      "",
    ].join("\n");
  }

  function bashOk(output: string): Result<BashToolResult> {
    return {
      success: true,
      data: {
        success: true,
        output,
        exitCode: 0,
        wall_duration_ms: 0,
      },
    };
  }

  function createServiceHarness(params: {
    metadata: WorkspaceMetadata;
    executeBashImpl: (
      workspaceId: string,
      script: string,
      options?: {
        timeout_secs?: number | null;
        cwdMode?: "default" | "repo-root" | null;
        repoRootProjectPath?: string | null;
      }
    ) => Promise<Result<BashToolResult>>;
  }): {
    workspaceService: WorkspaceService;
    executeBashMock: ReturnType<typeof mock>;
    getWorkspaceMetadataMock: ReturnType<typeof mock>;
  } {
    const getWorkspaceMetadataMock = mock(() => Promise.resolve(Ok(params.metadata)));
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: getWorkspaceMetadataMock,
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    const executeBashMock = mock(params.executeBashImpl);

    interface WorkspaceServiceTestAccess {
      executeBash: typeof executeBashMock;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.executeBash = executeBashMock;

    return { workspaceService, executeBashMock, getWorkspaceMetadataMock };
  }

  test("returns no entries for scratch workspaces without invoking git", async () => {
    const metadata: WorkspaceMetadata = {
      kind: "scratch",
      id: "ws-scratch",
      name: "scratch-ws-scratch",
      projectName: "Scratch",
      projectPath: "/tmp/mux/scratch/ws-scratch",
      runtimeConfig: { type: "local" },
    };
    const { workspaceService, executeBashMock } = createServiceHarness({
      metadata,
      executeBashImpl: () => Promise.reject(new Error("git should not run")),
    });

    expect(await workspaceService.getProjectGitStatuses(metadata.id)).toEqual([]);
    expect(executeBashMock).not.toHaveBeenCalled();
  });

  test("returns a single entry for single-project workspaces", async () => {
    const metadata: WorkspaceMetadata = {
      id: "ws-single",
      name: "ws-single",
      projectName: "project-a",
      projectPath: "/tmp/project-a",
      runtimeConfig: { type: "local" },
    };

    const { workspaceService, executeBashMock, getWorkspaceMetadataMock } = createServiceHarness({
      metadata,
      executeBashImpl: () => Promise.resolve(bashOk(createGitStatusOutput({ dirtyCount: 2 }))),
    });

    const result = await workspaceService.getProjectGitStatuses(metadata.id);

    expect(result).toEqual([
      {
        projectPath: "/tmp/project-a",
        projectName: "project-a",
        gitStatus: {
          branch: "feature/test",
          ahead: 1,
          behind: 0,
          dirty: true,
          outgoingAdditions: 5,
          outgoingDeletions: 2,
          incomingAdditions: 3,
          incomingDeletions: 1,
        },
        error: null,
      },
    ]);
    expect(getWorkspaceMetadataMock).toHaveBeenCalledWith(metadata.id);
    expect(executeBashMock).toHaveBeenCalledTimes(1);
    expect(executeBashMock).toHaveBeenNthCalledWith(
      1,
      metadata.id,
      expect.stringContaining("PREFERRED_BRANCH=''"),
      expect.objectContaining({
        cwdMode: "repo-root",
        repoRootProjectPath: "/tmp/project-a",
        timeout_secs: 5,
      })
    );
    expect(executeBashMock.mock.calls.some(([, script]) => script === "git fetch --quiet")).toBe(
      false
    );
  });

  test("returns one entry per project in stable order for multi-project workspaces", async () => {
    const metadata: WorkspaceMetadata = {
      id: "ws-multi",
      name: "ws-multi",
      projectName: "project-a",
      projectPath: "/tmp/project-a",
      runtimeConfig: { type: "local" },
      projects: [
        { projectPath: "/tmp/project-a", projectName: "project-a" },
        { projectPath: "/tmp/project-b", projectName: "project-b" },
      ],
    };

    const { workspaceService, executeBashMock } = createServiceHarness({
      metadata,
      executeBashImpl: (_workspaceId, _script, options) => {
        const repoRootProjectPath = options?.repoRootProjectPath;
        if (repoRootProjectPath === "/tmp/project-a") {
          return Promise.resolve(
            bashOk(createGitStatusOutput({ headBranch: "feature/a", ahead: 2 }))
          );
        }
        if (repoRootProjectPath === "/tmp/project-b") {
          return Promise.resolve(
            bashOk(createGitStatusOutput({ headBranch: "feature/b", behind: 3 }))
          );
        }
        throw new Error(`Unexpected repoRootProjectPath: ${String(repoRootProjectPath)}`);
      },
    });

    const result = await workspaceService.getProjectGitStatuses(metadata.id, "origin/release");

    expect(result.map((entry) => entry.projectName)).toEqual(["project-a", "project-b"]);
    expect(result[0]?.gitStatus?.branch).toBe("feature/a");
    expect(result[0]?.gitStatus?.ahead).toBe(2);
    expect(result[1]?.gitStatus?.branch).toBe("feature/b");
    expect(result[1]?.gitStatus?.behind).toBe(3);
    expect(executeBashMock).toHaveBeenCalledTimes(2);
    expect(executeBashMock).toHaveBeenNthCalledWith(
      1,
      metadata.id,
      expect.stringContaining("PREFERRED_BRANCH='release'"),
      expect.objectContaining({ repoRootProjectPath: "/tmp/project-a", timeout_secs: 5 })
    );
    expect(executeBashMock).toHaveBeenNthCalledWith(
      2,
      metadata.id,
      expect.stringContaining("PREFERRED_BRANCH='release'"),
      expect.objectContaining({ repoRootProjectPath: "/tmp/project-b", timeout_secs: 5 })
    );
    expect(executeBashMock.mock.calls.some(([, script]) => script === "git fetch --quiet")).toBe(
      false
    );
  });

  test("continues when one project bash execution fails", async () => {
    const metadata: WorkspaceMetadata = {
      id: "ws-multi-failure",
      name: "ws-multi-failure",
      projectName: "project-a",
      projectPath: "/tmp/project-a",
      runtimeConfig: { type: "local" },
      projects: [
        { projectPath: "/tmp/project-a", projectName: "project-a" },
        { projectPath: "/tmp/project-b", projectName: "project-b" },
      ],
    };

    const { workspaceService } = createServiceHarness({
      metadata,
      executeBashImpl: (_workspaceId, _script, options) => {
        if (options?.repoRootProjectPath === "/tmp/project-a") {
          return Promise.resolve(bashOk(createGitStatusOutput()));
        }
        return Promise.resolve(Err("git failed for project-b"));
      },
    });

    const result = await workspaceService.getProjectGitStatuses(metadata.id);

    expect(result).toEqual([
      {
        projectPath: "/tmp/project-a",
        projectName: "project-a",
        gitStatus: {
          branch: "feature/test",
          ahead: 1,
          behind: 0,
          dirty: false,
          outgoingAdditions: 5,
          outgoingDeletions: 2,
          incomingAdditions: 3,
          incomingDeletions: 1,
        },
        error: null,
      },
      {
        projectPath: "/tmp/project-b",
        projectName: "project-b",
        gitStatus: null,
        error: "git failed for project-b",
      },
    ]);
  });

  test("returns gitStatus null with an error when output cannot be parsed", async () => {
    const metadata: WorkspaceMetadata = {
      id: "ws-unparsable",
      name: "ws-unparsable",
      projectName: "project-a",
      projectPath: "/tmp/project-a",
      runtimeConfig: { type: "local" },
    };

    const { workspaceService } = createServiceHarness({
      metadata,
      executeBashImpl: () => Promise.resolve(bashOk("definitely not git status output")),
    });

    const result = await workspaceService.getProjectGitStatuses(metadata.id);

    expect(result).toEqual([
      {
        projectPath: "/tmp/project-a",
        projectName: "project-a",
        gitStatus: null,
        error: "Failed to parse git status script output",
      },
    ]);
  });
});

describe("WorkspaceService post-compaction metadata refresh", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      ),
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("returns expanded plan path for local runtimes", async () => {
    await withTempMuxRoot(async (muxRoot) => {
      const workspaceId = "ws-plan-path";
      const workspaceName = "plan-workspace";
      const projectName = "cmux";
      const planFile = await writePlanFile(muxRoot, projectName, workspaceName);

      interface WorkspaceServiceTestAccess {
        getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
      }

      const fakeMetadata: FrontendWorkspaceMetadata = {
        id: workspaceId,
        name: workspaceName,
        projectName,
        projectPath: "/tmp/proj",
        namedWorkspacePath: "/tmp/proj/plan-workspace",
        runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      };

      const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
      svc.getInfo = mock(() => Promise.resolve(fakeMetadata));

      const result = await workspaceService.getPostCompactionState(workspaceId);

      expect(result.planPath).toBe(planFile);
      expect(result.planPath?.startsWith("~")).toBe(false);
    });
  });

  test("debounces multiple refresh requests into a single metadata emit", async () => {
    const workspaceId = "ws-post-compaction";

    const emitMetadata = mock(() => undefined);

    interface WorkspaceServiceTestAccess {
      sessions: Map<string, { emitMetadata: (metadata: unknown) => void }>;
      getInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
      getPostCompactionState: (workspaceId: string) => Promise<{
        planPath: string | null;
        trackedFilePaths: string[];
        excludedItems: string[];
      }>;
      schedulePostCompactionMetadataRefresh: (workspaceId: string) => void;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.sessions.set(workspaceId, { emitMetadata });

    const fakeMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: "/tmp/proj",
      namedWorkspacePath: "/tmp/proj/ws",
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
    };

    const getInfoMock: WorkspaceServiceTestAccess["getInfo"] = mock(() =>
      Promise.resolve(fakeMetadata)
    );

    const postCompactionState = {
      planPath: "~/.mux/plans/cmux/plan.md",
      trackedFilePaths: ["/tmp/proj/file.ts"],
      excludedItems: [],
    };

    const getPostCompactionStateMock: WorkspaceServiceTestAccess["getPostCompactionState"] = mock(
      () => Promise.resolve(postCompactionState)
    );

    svc.getInfo = getInfoMock;
    svc.getPostCompactionState = getPostCompactionStateMock;

    svc.schedulePostCompactionMetadataRefresh(workspaceId);
    svc.schedulePostCompactionMetadataRefresh(workspaceId);
    svc.schedulePostCompactionMetadataRefresh(workspaceId);

    // Debounce is short, but use a safe buffer.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(getInfoMock).toHaveBeenCalledTimes(1);
    expect(getPostCompactionStateMock).toHaveBeenCalledTimes(1);
    expect(emitMetadata).toHaveBeenCalledTimes(1);

    const enriched = (emitMetadata as ReturnType<typeof mock>).mock.calls[0][0] as {
      postCompaction?: { planPath: string | null };
    };
    expect(enriched.postCompaction?.planPath).toBe(postCompactionState.planPath);
  });
});

describe("WorkspaceService maybePersistAISettingsFromOptions", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve({ success: false as const, error: "nope" })),
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const workspacePath = "/tmp/proj/ws";
    const projectPath = "/tmp/proj";
    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((workspaceId: string) =>
        workspaceId === "ws" ? { projectPath, workspacePath } : null
      ),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [
                {
                  id: "ws",
                  path: workspacePath,
                  name: "ws",
                },
              ],
            },
          ],
        ]),
      })),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };
    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("refuses unpriced model persistence for budgeted active goals", async () => {
    workspaceService.setWorkspaceGoalService({
      getGoal: mock(() => Promise.resolve({ status: "active", budgetCents: 500 })),
    } as unknown as WorkspaceGoalService);

    const result = await workspaceService.updateAgentAISettings("ws", "exec", {
      model: "openai:not-priced-model",
      thinkingLevel: "off",
    });

    expect(result).toEqual({
      success: false,
      error: "Target model has no pricing data. Pick a priced model before switching.",
    });
  });

  test("allows unpriced model persistence when no budgeted goal is active", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));
    workspaceService.setWorkspaceGoalService({
      // No goal record (or one without a budget) — the gate must pass through.
      getGoal: mock(() => Promise.resolve(null)),
    } as unknown as WorkspaceGoalService);
    (
      workspaceService as unknown as {
        persistWorkspaceAISettingsForAgent: (...args: unknown[]) => unknown;
      }
    ).persistWorkspaceAISettingsForAgent = persistSpy;

    const result = await workspaceService.updateAgentAISettings("ws", "exec", {
      model: "openai:not-priced-model",
      thinkingLevel: "off",
    });

    expect(result.success).toBe(true);
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  test("persists agent AI settings for custom agent", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));

    interface WorkspaceServiceTestAccess {
      maybePersistAISettingsFromOptions: (
        workspaceId: string,
        options: unknown,
        context: "send" | "resume"
      ) => Promise<void>;
      persistWorkspaceAISettingsForAgent: (...args: unknown[]) => unknown;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.persistWorkspaceAISettingsForAgent = persistSpy;

    await svc.maybePersistAISettingsFromOptions(
      "ws",
      {
        agentId: "reviewer",
        model: "openai:gpt-4o-mini",
        thinkingLevel: "off",
      },
      "send"
    );

    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  test("persists agent AI settings when agentId matches", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));

    interface WorkspaceServiceTestAccess {
      maybePersistAISettingsFromOptions: (
        workspaceId: string,
        options: unknown,
        context: "send" | "resume"
      ) => Promise<void>;
      persistWorkspaceAISettingsForAgent: (...args: unknown[]) => unknown;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.persistWorkspaceAISettingsForAgent = persistSpy;

    await svc.maybePersistAISettingsFromOptions(
      "ws",
      {
        agentId: "exec",
        model: "openai:gpt-4o-mini",
        thinkingLevel: "off",
      },
      "send"
    );

    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  test("persists AI settings for sub-agent workspaces so auto-resume can use latest model", async () => {
    const persistSpy = mock(() => Promise.resolve({ success: true as const, data: true }));

    interface WorkspaceServiceTestAccess {
      maybePersistAISettingsFromOptions: (
        workspaceId: string,
        options: unknown,
        context: "send" | "resume"
      ) => Promise<void>;
      persistWorkspaceAISettingsForAgent: (...args: unknown[]) => unknown;
      config: {
        findWorkspace: (
          workspaceId: string
        ) => { projectPath: string; workspacePath: string } | null;
        loadConfigOrDefault: () => {
          projects: Map<string, { workspaces: Array<Record<string, unknown>> }>;
        };
      };
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.persistWorkspaceAISettingsForAgent = persistSpy;

    const projectPath = "/tmp/proj";
    const workspacePath = "/tmp/proj/ws";
    svc.config.findWorkspace = mock((workspaceId: string) =>
      workspaceId === "ws" ? { projectPath, workspacePath } : null
    );
    svc.config.loadConfigOrDefault = mock(() => ({
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: "ws",
                path: workspacePath,
                name: "ws",
                parentWorkspaceId: "parent-ws",
              },
            ],
          },
        ],
      ]),
    }));

    await svc.maybePersistAISettingsFromOptions(
      "ws",
      {
        agentId: "exec",
        model: "openai:gpt-4o-mini",
        thinkingLevel: "off",
      },
      "send"
    );

    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledWith(
      "ws",
      "exec",
      { model: "openai:gpt-4o-mini", thinkingLevel: "off" },
      { persistSelectedAgentId: true }
    );
  });
});

// ---------------------------------------------------------------------------
// assertPricedModelForBudgetedGoal — pre-stream gate that rejects unpriced
// models for budgeted resumable goals (active/paused/budget_limited).
//
// Codex P1 (PRRT_kwDOPxxmWM5_sN02) flagged that a persistence-only skip is
// not enough: the request still flows into session.sendMessage and accounting
// records 0 cost on an unpriced model, silently bypassing budget enforcement.
// These tests pin the new pre-dispatch gate so a future regression that puts
// the check back inside maybePersistAISettingsFromOptions is caught.
// ---------------------------------------------------------------------------
describe("WorkspaceService assertPricedModelForBudgetedGoal", () => {
  interface GateOptions {
    model?: string;
    skipAiSettingsPersistence?: boolean;
  }
  interface GateAccess {
    assertPricedModelForBudgetedGoal: (
      workspaceId: string,
      options: GateOptions | undefined
    ) => Promise<Result<void, SendMessageError>>;
  }
  const UNPRICED = "openai:not-priced-model";
  const PRICED = "openai:gpt-4o-mini";
  let workspaceService: WorkspaceService;
  let cleanupHistory: () => Promise<void>;

  async function makeService(): Promise<WorkspaceService> {
    const aiService = {
      isStreaming: mock(() => false),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;
    const { historyService, cleanup } = await createTestHistoryService();
    cleanupHistory = cleanup;
    return new WorkspaceService(
      {
        srcDir: "/tmp/test",
        getSessionDir: mock(() => "/tmp/test/sessions"),
        generateStableId: mock(() => "test-id"),
        findWorkspace: mock(() => null),
      } as unknown as Config,
      historyService,
      aiService,
      {
        on: mock(() => undefined),
        getInitState: mock(() => undefined),
      } as unknown as InitStateManager,
      {} as ExtensionMetadataService,
      { cleanup: mock(() => Promise.resolve()) } as unknown as BackgroundProcessManager
    );
  }

  function setGoal(goal: GoalRecordV1 | null): void {
    // Mock the canonical WorkspaceGoalService.assertPricedModelForBudgetedGoal
    // by composing the same primitives the real implementation uses (model
    // pricing + hasBudgetedResumableGoal). This keeps the gate behaviour in
    // one place — the test still exercises the WS-side delegation contract.
    const fakeGoalService: Pick<
      WorkspaceGoalService,
      "getGoal" | "assertPricedModelForBudgetedGoal"
    > = {
      getGoal: mock(() => Promise.resolve(goal)),
      assertPricedModelForBudgetedGoal: mock((_workspaceId: string, model?: string) => {
        if (!model || modelHasPricingData(model)) {
          return Promise.resolve(Ok(undefined));
        }
        if (!hasBudgetedResumableGoal(goal)) {
          return Promise.resolve(Ok(undefined));
        }
        return Promise.resolve(
          Err({ type: "unknown" as const, raw: UNPRICED_TARGET_MODEL_GOAL_MESSAGE })
        );
      }),
    };
    workspaceService.setWorkspaceGoalService(fakeGoalService as unknown as WorkspaceGoalService);
  }

  function callGate(options: GateOptions | undefined): Promise<Result<void, SendMessageError>> {
    return (workspaceService as unknown as GateAccess).assertPricedModelForBudgetedGoal(
      "ws",
      options
    );
  }

  beforeEach(async () => {
    workspaceService = await makeService();
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test.each([
    ["active", { status: "active" as const, budgetCents: 500 }],
    ["paused", { status: "paused" as const, budgetCents: 500 }],
    ["budget_limited", { status: "budget_limited" as const, budgetCents: 500 }],
  ])("rejects unpriced model on %s budgeted goal", async (_label, partial) => {
    setGoal(partial as unknown as GoalRecordV1);
    const result = await callGate({ model: UNPRICED });
    expect(result.success).toBe(false);
    if (!result.success) {
      const error = result.error;
      expect(typeof error === "object" && error.type === "unknown").toBe(true);
      if (typeof error === "object" && error.type === "unknown") {
        expect(error.raw).toContain("Target model has no pricing data");
      }
    }
  });

  test("allows priced models even on budgeted active goals", async () => {
    setGoal({ status: "active", budgetCents: 500 } as unknown as GoalRecordV1);
    const result = await callGate({ model: PRICED });
    expect(result.success).toBe(true);
  });

  test("allows when no goal exists", async () => {
    setGoal(null);
    const result = await callGate({ model: UNPRICED });
    expect(result.success).toBe(true);
  });

  test("allows when goal has no budget", async () => {
    setGoal({ status: "active", budgetCents: null } as unknown as GoalRecordV1);
    const result = await callGate({ model: UNPRICED });
    expect(result.success).toBe(true);
  });

  test("allows terminal goals (complete) regardless of model", async () => {
    setGoal({ status: "complete", budgetCents: 500 } as unknown as GoalRecordV1);
    const result = await callGate({ model: UNPRICED });
    expect(result.success).toBe(true);
  });

  test("ignores client-controlled skipAiSettingsPersistence flag", async () => {
    // Codex P1 (PRRT_kwDOPxxmWM5_sh1R): `skipAiSettingsPersistence` is part
    // of the public SendMessageOptionsSchema and forwarded verbatim by the
    // router, so a direct API caller could otherwise flip this single bool
    // to disarm the gate while running an unpriced model on a budgeted goal.
    // The gate must reject regardless of the flag.
    setGoal({ status: "active", budgetCents: 500 } as unknown as GoalRecordV1);
    const result = await callGate({ model: UNPRICED, skipAiSettingsPersistence: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      const error = result.error;
      expect(typeof error === "object" && error.type === "unknown").toBe(true);
      if (typeof error === "object" && error.type === "unknown") {
        expect(error.raw).toContain("Target model has no pricing data");
      }
    }
  });

  test("delegates to WorkspaceGoalService.assertPricedModelForBudgetedGoal", async () => {
    // Pin the WS → WorkspaceGoalService delegation contract: WS must not
    // re-implement the gate, otherwise we'd reintroduce the original bug
    // where queued messages bypassed it. See workspaceGoalService.test.ts
    // for the canonical priced-model short-circuit + rejection coverage.
    const assertPricedModelForBudgetedGoal = mock(() =>
      Promise.resolve(Ok(undefined) as Result<void, SendMessageError>)
    );
    workspaceService.setWorkspaceGoalService({
      getGoal: mock(() => Promise.resolve(null)),
      assertPricedModelForBudgetedGoal,
    } as unknown as WorkspaceGoalService);

    const result = await callGate({ model: PRICED });

    expect(result.success).toBe(true);
    expect(assertPricedModelForBudgetedGoal).toHaveBeenCalledTimes(1);
    expect(assertPricedModelForBudgetedGoal).toHaveBeenCalledWith("ws", PRICED);
  });

  test("allows when no model is provided (caller will fall back later)", async () => {
    setGoal({ status: "active", budgetCents: 500 } as unknown as GoalRecordV1);
    const result = await callGate({});
    expect(result.success).toBe(true);
  });
});

describe("WorkspaceService remove lifecycle coordination", () => {
  test("checks descendant tasks while holding the task-tree lifecycle lock", async () => {
    const workspaceId = "parent-remove-lifecycle";
    const workspaceService = createWorkspaceServiceForTest({
      config: {
        findWorkspace: mock(() => null),
      },
    });
    let insideLifecycleLock = false;
    const withTaskTreeLifecycleLock = mock(
      async <T>(_workspaceId: string, operation: () => Promise<T>): Promise<T> => {
        insideLifecycleLock = true;
        try {
          return await operation();
        } finally {
          insideLifecycleLock = false;
        }
      }
    );
    const hasDescendantAgentTasks = mock(() => {
      expect(insideLifecycleLock).toBe(true);
      return true;
    });
    workspaceService.setTaskService({
      withTaskTreeLifecycleLock,
      hasDescendantAgentTasks,
    } as unknown as TaskService);

    expect(await workspaceService.remove(workspaceId, true)).toEqual(
      Err(
        "This workspace has descendant sub-agent workspaces. Remove those descendants deepest-first before removing their parent."
      )
    );
    expect(withTaskTreeLifecycleLock).toHaveBeenCalledWith(workspaceId, expect.any(Function));
    expect(hasDescendantAgentTasks).toHaveBeenCalledWith(workspaceId);
  });
});

describe("WorkspaceService registration-time plugin override sanitization", () => {
  // A LocalRuntime checkout preserves .mux/mcp.local.jsonc across workspace
  // removal, and a removed workspace is invisible to the Agent Plugin
  // uninstaller's pruning/tombstones. Consent dies with the workspace:
  // registering the directory as a NEW workspace sanitizes canonical plugin
  // keys — unless a live sibling still resolves to the same path (its consent
  // context is alive), and a failed sanitize aborts creation instead of
  // silently activating stale enables.
  interface SanitizeAccess {
    sanitizeStalePluginOverridesForNewWorkspace(
      workspaceId: string,
      workspacePath: string,
      persistentSiblingConfig?: Pick<Config, "loadConfigOrDefault">
    ): Promise<string | undefined>;
    pendingPluginSanitizations: Set<string>;
    rollbackUnsanitizedWorkspaceRegistration(workspaceId: string): Promise<boolean>;
  }

  function makeService(
    existingWorkspaces: Array<{ id: string; path: string; runtimeConfig?: unknown }>
  ): WorkspaceService {
    return createWorkspaceServiceForTest({
      config: {
        srcDir: "/tmp/src",
        loadConfigOrDefault: mock(() => ({
          projects: new Map([["/tmp/proj", { workspaces: existingWorkspaces }]]),
        })),
      } as unknown as Config,
    });
  }

  test("sanitizes canonical plugin keys when no sibling shares the path", async () => {
    const service = makeService([{ id: "ws-new", path: "/tmp/proj" }]);
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
    });
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj");
    expect(error).toBeUndefined();
    expect(pruned).toEqual(["ws-new:plugin:"]);
  });

  test("skips sanitization when the live sibling is only visible in the persistent config", async () => {
    // xum run / xum workflow register on an EPHEMERAL temp config whose
    // project entries carry no workspace records; a desktop workspace live on
    // the same checkout exists only in the persistent config. Pruning would
    // strip enables that live consent context still owns from the shared
    // .xum/mcp.local.jsonc — the persistent sibling must force a skip, while
    // a persistent record for a DIFFERENT checkout must not.
    const service = makeService([{ id: "ws-new", path: "/tmp/proj" }]);
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
    });
    const persistentWith = (workspacePath: string): Pick<Config, "loadConfigOrDefault"> =>
      ({
        loadConfigOrDefault: () => ({
          projects: new Map([
            ["/tmp/proj", { workspaces: [{ id: "ws-desktop", path: workspacePath }] }],
          ]),
        }),
      }) as unknown as Pick<Config, "loadConfigOrDefault">;

    const skip = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace(
      "ws-new",
      "/tmp/proj",
      persistentWith("/tmp/proj")
    );
    expect(skip).toBeUndefined();
    expect(pruned).toEqual([]);

    const prune = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace(
      "ws-new",
      "/tmp/proj",
      persistentWith("/tmp/other")
    );
    expect(prune).toBeUndefined();
    expect(pruned).toEqual(["ws-new:plugin:"]);
  });

  test("refuses to prune when the persistent sibling config is unreadable", async () => {
    // The lenient loadConfigOrDefault swallows a malformed ~/.xum/config.json
    // into an EMPTY project map — which reads as "no live sibling" and would
    // prune enables a live desktop workspace still owns. The persistent
    // source must be read in throwing mode and sanitization must fail closed
    // (abort the registration, leave the override file untouched).
    const service = makeService([{ id: "ws-new", path: "/tmp/proj" }]);
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
    });
    const broken = {
      loadConfigOrDefault: (options?: { throwOnError?: boolean }) => {
        if (options?.throwOnError) {
          throw new Error("config.json is malformed");
        }
        // A lenient read would hide the corruption behind an empty map.
        return { projects: new Map() };
      },
    } as unknown as Pick<Config, "loadConfigOrDefault">;
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj", broken);
    expect(error).toContain("unreadable");
    expect(pruned).toEqual([]);
  });

  test("skips sanitization while a live sibling resolves to the same path", async () => {
    // Conversation forks of a local workspace share the checkout: the
    // sibling's consent context is alive, so its enables must survive.
    const service = makeService([
      { id: "ws-sibling", path: "/tmp/proj" },
      { id: "ws-new", path: "/tmp/proj/" },
    ]);
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
    });
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj");
    expect(error).toBeUndefined();
    expect(pruned).toEqual([]);
  });

  test("a failed sanitize surfaces an error so creation aborts", async () => {
    const service = makeService([{ id: "ws-new", path: "/tmp/proj" }]);
    service.setWorkspaceMcpOverridesService({
      prunePluginOverrideKeys: () =>
        Promise.reject(new Error('duplicate "enabledServers" properties')),
    });
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj");
    expect(error).toContain("could not be sanitized");
    expect(error).toContain("mcp.local.jsonc");
  });

  test("an off-host workspace with an equal path string is not a sibling", async () => {
    // SSH/container paths occupy a different filesystem namespace: an equal
    // STRING proves nothing about the local overrides file, and skipping
    // would leave a stale enable to activate on the next local request.
    const service = makeService([
      { id: "ws-ssh", path: "/tmp/proj", runtimeConfig: { type: "ssh", host: "box" } },
      { id: "ws-new", path: "/tmp/proj" },
    ]);
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
    });
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj");
    expect(error).toBeUndefined();
    expect(pruned).toEqual(["ws-new:plugin:"]);
  });

  test("a sibling registered through a symlinked spelling still forces a skip", async () => {
    // Canonical (realpath) identity, not just spelling: pruning here would
    // strip the live symlink-spelled sibling's enables from the shared file.
    const realDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-sanitize-real-"));
    const linkPath = `${realDir}-link`;
    await fsPromises.symlink(realDir, linkPath);
    try {
      const service = makeService([
        { id: "ws-symlink-sibling", path: linkPath },
        { id: "ws-new", path: realDir },
      ]);
      const pruned: string[] = [];
      service.setWorkspaceMcpOverridesService({
        prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
          pruned.push(`${workspaceId}:${keyPrefix}`);
          return Promise.resolve();
        },
      });
      const error = await (
        service as unknown as SanitizeAccess
      ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", realDir);
      expect(error).toBeUndefined();
      expect(pruned).toEqual([]);
    } finally {
      await fsPromises.rm(linkPath, { force: true });
      await fsPromises.rm(realDir, { recursive: true, force: true });
    }
  });

  test("an overlapping registration pending its own sanitization is not a sibling", async () => {
    // Two creations for the same checkout can both persist config entries
    // before either sanitizes; a not-yet-sanitized entry is no proof of live
    // consent, so the scan must ignore it or BOTH creations skip pruning.
    const service = makeService([
      { id: "ws-concurrent", path: "/tmp/proj" },
      { id: "ws-new", path: "/tmp/proj" },
    ]);
    (service as unknown as SanitizeAccess).pendingPluginSanitizations.add("ws-concurrent");
    const pruned: string[] = [];
    service.setWorkspaceMcpOverridesService({
      prunePluginOverrideKeys: (workspaceId, keyPrefix) => {
        pruned.push(`${workspaceId}:${keyPrefix}`);
        return Promise.resolve();
      },
    });
    const error = await (
      service as unknown as SanitizeAccess
    ).sanitizeStalePluginOverridesForNewWorkspace("ws-new", "/tmp/proj");
    expect(error).toBeUndefined();
    expect(pruned).toEqual(["ws-new:plugin:"]);
  });

  test("rollback verification detects a swallowed config write failure", async () => {
    // Config.saveConfig logs and swallows write errors, so removeWorkspace
    // can resolve while the entry survives on disk; the rollback must verify
    // absence rather than trust the resolved promise.
    const stuckWorkspaces = [{ id: "ws-stuck", path: "/tmp/proj" }];
    const service = createWorkspaceServiceForTest({
      config: {
        removeWorkspace: mock(() => Promise.resolve()),
        loadConfigOrDefault: mock(() => ({
          projects: new Map([["/tmp/proj", { workspaces: stuckWorkspaces }]]),
        })),
      } as unknown as Config,
    });
    const access = service as unknown as SanitizeAccess;
    expect(await access.rollbackUnsanitizedWorkspaceRegistration("ws-stuck")).toBe(false);
    // A rollback that actually lands verifies clean.
    expect(await access.rollbackUnsanitizedWorkspaceRegistration("ws-gone")).toBe(true);
  });
});

describe("WorkspaceService remove timing rollup", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("waits for stream-abort before rolling up session timing", async () => {
    const workspaceId = "child-ws";
    const parentWorkspaceId = "parent-ws";

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-remove-"));
    try {
      const sessionRoot = path.join(tempRoot, "sessions");
      await fsPromises.mkdir(path.join(sessionRoot, workspaceId), { recursive: true });

      let abortEmitted = false;
      let rollUpSawAbort = false;

      class FakeAIService extends EventEmitter {
        isStreaming = mock(() => true);

        stopStream = mock(() => {
          setTimeout(() => {
            abortEmitted = true;
            this.emit("stream-abort", {
              type: "stream-abort",
              workspaceId,
              messageId: "msg",
              abortReason: "system",
              metadata: { duration: 123 },
              abandonPartial: true,
            });
          }, 0);

          return Promise.resolve({ success: true as const, data: undefined });
        });

        getWorkspaceMetadata = mock(() =>
          Promise.resolve({
            success: true as const,
            data: {
              id: workspaceId,
              name: "child",
              projectPath: "/tmp/proj",
              runtimeConfig: { type: "local" },
              parentWorkspaceId,
            },
          })
        );
      }

      const aiService = new FakeAIService() as unknown as AIService;
      const mockConfig: Partial<Config> = {
        rootDir: path.join(tempRoot, "root"),
        srcDir: "/tmp/src",
        getSessionDir: mock((id: string) => path.join(sessionRoot, id)),
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => null),
        loadConfigOrDefault: mock(() => ({ projects: new Map() })),
      };

      const timingService: Partial<SessionTimingService> = {
        waitForIdle: mock(() => Promise.resolve()),
        rollUpTimingIntoParent: mock(() => {
          rollUpSawAbort = abortEmitted;
          return Promise.resolve({ didRollUp: true });
        }),
      };

      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        historyService,
        aiService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager,
        undefined, // sessionUsageService
        undefined, // policyService
        undefined, // telemetryService
        undefined, // experimentsService
        timingService as SessionTimingService
      );

      const removeResult = await workspaceService.remove(workspaceId, true);
      expect(removeResult.success).toBe(true);
      expect(mockInitStateManager.clearInMemoryState).toHaveBeenCalledWith(workspaceId);
      expect(rollUpSawAbort).toBe(true);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkspaceService remove shared-workspace guard", () => {
  const projectPath = "/tmp/proj-shared";
  const workspaceId = "child-shared";
  const sharedPath = path.join(projectPath, "parent-ws");
  const runtimeConfig = { type: "worktree" as const, srcBaseDir: "/tmp/src" };

  function buildConfig(taskIsolation?: "none" | "fork"): Partial<Config> {
    return {
      // Unique per-build root: removal publishes durable tombstones under
      // <rootDir>/locks, which must not leak across tests or runs.
      rootDir: path.join(tmpdir(), "mux-shared-guard", `root-${crypto.randomUUID()}`),
      srcDir: "/tmp/src",
      getSessionDir: mock((id: string) => path.join(tmpdir(), "mux-shared-guard", id)),
      removeWorkspace: mock(() => Promise.resolve()),
      findWorkspace: mock(() => ({ workspacePath: sharedPath, projectPath })),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              trusted: true,
              workspaces: [
                {
                  id: workspaceId,
                  name: "agent_explore_child",
                  path: sharedPath,
                  runtimeConfig,
                  taskIsolation,
                },
              ],
            },
          ],
        ]),
      })),
    } as unknown as Partial<Config>;
  }

  function buildAiService(): AIService {
    class FakeAIService extends EventEmitter {
      isStreaming = mock(() => false);
      stopStream = mock(() => Promise.resolve({ success: true as const, data: undefined }));
      getWorkspaceMetadata = mock(() =>
        Promise.resolve({
          success: true as const,
          data: {
            id: workspaceId,
            name: "agent_explore_child",
            projectPath,
            runtimeConfig,
          },
        })
      );
    }
    return new FakeAIService() as unknown as AIService;
  }

  test("does not delete the shared parent checkout for isolation: none tasks", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: sharedPath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildConfig("none"),
        aiService: buildAiService(),
      });

      const result = await workspaceService.remove(workspaceId, true);
      expect(result.success).toBe(true);
      // The parent's checkout must never be physically deleted on behalf of a shared task.
      expect(deleteWorkspace).not.toHaveBeenCalled();
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("deletes the workspace for normal (forked) tasks", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: sharedPath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildConfig(undefined),
        aiService: buildAiService(),
      });

      const result = await workspaceService.remove(workspaceId, true);
      expect(result.success).toBe(true);
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  // Inverse direction: removing the PARENT while a live shared child points at its checkout.
  function buildParentConfig(childTaskStatus: string): Partial<Config> {
    return {
      rootDir: path.join(tmpdir(), "mux-shared-guard", `root-${crypto.randomUUID()}`),
      srcDir: "/tmp/src",
      getSessionDir: mock((id: string) => path.join(tmpdir(), "mux-shared-guard", id)),
      removeWorkspace: mock(() => Promise.resolve()),
      findWorkspace: mock(() => ({ workspacePath: sharedPath, projectPath })),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              trusted: true,
              workspaces: [
                {
                  id: "parent-ws-id",
                  name: "parent-ws",
                  path: sharedPath,
                  runtimeConfig,
                },
                {
                  id: workspaceId,
                  name: "agent_explore_child",
                  path: sharedPath,
                  runtimeConfig,
                  parentWorkspaceId: "parent-ws-id",
                  taskIsolation: "none",
                  taskStatus: childTaskStatus,
                },
              ],
            },
          ],
        ]),
      })),
    } as unknown as Partial<Config>;
  }

  function buildParentAiService(): AIService {
    class FakeAIService extends EventEmitter {
      isStreaming = mock(() => false);
      stopStream = mock(() => Promise.resolve({ success: true as const, data: undefined }));
      getWorkspaceMetadata = mock(() =>
        Promise.resolve({
          success: true as const,
          data: {
            id: "parent-ws-id",
            name: "parent-ws",
            projectPath,
            runtimeConfig,
          },
        })
      );
    }
    return new FakeAIService() as unknown as AIService;
  }

  test("does not delete a parent checkout shared by an active isolation: none child", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: sharedPath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildParentConfig("running"),
        aiService: buildParentAiService(),
      });

      const result = await workspaceService.remove("parent-ws-id", true);
      expect(result.success).toBe(true);
      // The running shared child still uses this checkout as its cwd.
      expect(deleteWorkspace).not.toHaveBeenCalled();
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("deletes a parent checkout when its shared child is only queued (fails fast at dequeue like forked tasks)", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: sharedPath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildParentConfig("queued"),
        aiService: buildParentAiService(),
      });

      const result = await workspaceService.remove("parent-ws-id", true);
      expect(result.success).toBe(true);
      // Queued children require the parent config entry to launch regardless of isolation, so
      // they fail fast at dequeue either way — preserving the checkout would only leak it.
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("deletes a parent checkout when its shared child already reported", async () => {
    const deleteWorkspace = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: sharedPath })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      const workspaceService = createWorkspaceServiceForTest({
        config: buildParentConfig("reported"),
        aiService: buildParentAiService(),
      });

      const result = await workspaceService.remove("parent-ws-id", true);
      expect(result.success).toBe(true);
      expect(deleteWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });
});

describe("WorkspaceService remove desktop session cleanup", () => {
  const workspaceId = "ws-remove-desktop";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let workspaceService: WorkspaceService;
  let removeWorkspaceMock: ReturnType<typeof mock>;
  let tempRoot: string;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
    tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-remove-desktop-"));
    removeWorkspaceMock = mock(() => Promise.resolve());

    const aiService: AIService = {
      isStreaming: mock(() => false),
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock(() => Promise.resolve(Err("not found"))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      // r63: removal serializes session-dir deletion with the memory target
      // locks and removal tombstones under `<rootDir>/locks`.
      rootDir: tempRoot,
      getSessionDir: mock((id: string) => path.join(tempRoot, "sessions", id)),
      removeWorkspace: removeWorkspaceMock,
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
    await cleanupHistory();
  });

  test("remove() closes desktop sessions on success", async () => {
    const close = mock(() => Promise.resolve(undefined));
    const desktopSessionManager = {
      close,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const result = await workspaceService.remove(workspaceId);

    expect(result.success).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(workspaceId);
  });

  test("remove() reopens the timeline when removal aborts with the workspace still configured", async () => {
    await fsPromises.mkdir(path.join(tempRoot, "sessions", workspaceId), { recursive: true });
    const reopened: string[] = [];
    workspaceService.setTimelineRecorder({
      record: () => undefined,
      closeWorkspace: () => Promise.resolve(),
      reopenWorkspace: (id) => reopened.push(id),
    });
    removeWorkspaceMock.mockImplementation(() => {
      throw new Error("config write failed");
    });

    const result = await workspaceService.remove(workspaceId);

    expect(result.success).toBe(false);
    expect(reopened).toEqual([workspaceId]);
  });

  test("remove() flushes the timeline before deleting the session directory", async () => {
    const sessionDir = path.join(tempRoot, "sessions", workspaceId);
    await fsPromises.mkdir(sessionDir, { recursive: true });
    const order: string[] = [];
    workspaceService.setTimelineRecorder({
      record: () => undefined,
      closeWorkspace: () => {
        // A queued append recreates the session directory, so closing is only useful while the
        // directory still exists.
        order.push(existsSync(sessionDir) ? "closed-before-delete" : "closed-after-delete");
        return Promise.resolve();
      },
      reopenWorkspace: () => undefined,
    });

    const result = await workspaceService.remove(workspaceId);

    expect(result.success).toBe(true);
    expect(order).toEqual(["closed-before-delete"]);
    expect(existsSync(sessionDir)).toBe(false);
  });

  test("remove() continues when desktop session cleanup fails", async () => {
    const close = mock(() => Promise.reject(new Error("close failed")));
    const desktopSessionManager = {
      close,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const result = await workspaceService.remove(workspaceId);

    expect(result.success).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(workspaceId);
    expect(removeWorkspaceMock).toHaveBeenCalledWith(workspaceId);
  });
});

describe("WorkspaceService metadata listeners", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("error events clear streaming metadata", async () => {
    const workspaceId = "ws-error";
    const setStreaming = mock(() =>
      Promise.resolve({
        recency: Date.now(),
        streaming: false,
        lastModel: null,
        lastThinkingLevel: null,
        agentStatus: null,
      })
    );

    class FakeAIService extends EventEmitter {
      isStreaming = mock(() => false);
      getWorkspaceMetadata = mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      );
    }

    const aiService = new FakeAIService() as unknown as AIService;
    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };
    const mockExtensionMetadata: Partial<ExtensionMetadataService> = { setStreaming };

    new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadata as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    aiService.emit("error", {
      type: "error",
      workspaceId,
      messageId: "msg-1",
      error: "rate limited",
      errorType: "rate_limit",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setStreaming).toHaveBeenCalledTimes(1);
    // todoStatus is intentionally NOT passed when there are no todos —
    // see updateStreamingStatus comment for rationale.
    expect(setStreaming).toHaveBeenCalledWith(workspaceId, false, {
      hasTodos: false,
      generation: 0,
    });
  });

  test("todo_write events publish todo-derived sidebar status", async () => {
    const workspaceId = "ws-todo-status";
    const setTodoStatus = mock(() =>
      Promise.resolve({
        recency: Date.now(),
        streaming: true,
        lastModel: null,
        lastThinkingLevel: null,
        agentStatus: null,
      })
    );
    const readTodosSpy = spyOn(todoStorageModule, "readTodosForSessionDir").mockResolvedValue([
      { content: "Run typecheck", status: "in_progress" },
      { content: "Add tests", status: "pending" },
    ]);

    class FakeAIService extends EventEmitter {
      isStreaming = mock(() => false);
      getWorkspaceMetadata = mock(() =>
        Promise.resolve({ success: false as const, error: "not found" })
      );
    }

    const aiService = new FakeAIService() as unknown as AIService;
    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };
    const mockExtensionMetadata: Partial<ExtensionMetadataService> = { setTodoStatus };

    new WorkspaceService(
      mockConfig as Config,
      historyService,
      aiService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadata as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    try {
      aiService.emit("tool-call-end", {
        type: "tool-call-end",
        workspaceId,
        messageId: "msg-1",
        toolCallId: "tool-1",
        toolName: "todo_write",
        result: { success: true, count: 2 },
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(readTodosSpy).toHaveBeenCalledWith("/tmp/test/sessions");
      expect(setTodoStatus).toHaveBeenCalledWith(
        workspaceId,
        { emoji: "🔄", message: "Run typecheck" },
        true
      );
    } finally {
      readTodosSpy.mockRestore();
    }
  });
});

describe("WorkspaceService setPinned", () => {
  const projectPath = "/tmp/project";
  const rootId = "ws-root";
  const otherRootId = "ws-other";
  const childId = "ws-child";
  const archivedId = "ws-archived";

  let workspaceService: WorkspaceService;
  let configState: ProjectsConfig;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let emittedMetadata: Array<{ workspaceId: string; metadata: FrontendWorkspaceMetadata | null }>;

  const getEntry = (id: string) =>
    configState.projects.get(projectPath)?.workspaces.find((w) => w.id === id);

  beforeEach(async () => {
    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              { path: `${projectPath}/${rootId}`, id: rootId },
              { path: `${projectPath}/${otherRootId}`, id: otherRootId },
              {
                path: `${projectPath}/${childId}`,
                id: childId,
                parentWorkspaceId: rootId,
              },
              {
                path: `${projectPath}/${archivedId}`,
                id: archivedId,
                archivedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        ],
      ]),
    };

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      findWorkspace: mock((id: string) => {
        const entry = getEntry(id);
        if (!entry) return null;
        return {
          projectPath,
          workspacePath: entry.path,
          parentWorkspaceId: entry.parentWorkspaceId,
        };
      }),
      editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        configState = fn(configState);
        return Promise.resolve();
      }),
      // Project config entries back into metadata so emitted events carry pin state.
      getAllWorkspaceMetadata: mock(() =>
        Promise.resolve(
          (configState.projects.get(projectPath)?.workspaces ?? [])
            .filter((w): w is typeof w & { id: string } => w.id != null)
            .map(
              (w): FrontendWorkspaceMetadata => ({
                id: w.id,
                name: w.id,
                projectName: "proj",
                projectPath,
                namedWorkspacePath: w.path,
                runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
                parentWorkspaceId: w.parentWorkspaceId,
                archivedAt: w.archivedAt,
                unarchivedAt: w.unarchivedAt,
                pinnedAt: w.pinnedAt,
              })
            )
        )
      ),
      loadConfigOrDefault: mock(() => configState),
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
    });

    emittedMetadata = [];
    workspaceService.on("metadata", (payload) => {
      emittedMetadata.push(payload as (typeof emittedMetadata)[number]);
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("pin persists pinnedAt and emits metadata; unpin clears it and emits", async () => {
    const pinResult = await workspaceService.setPinned(rootId, true);
    expect(pinResult.success).toBe(true);

    const pinnedAt = getEntry(rootId)?.pinnedAt;
    expect(pinnedAt).toBeDefined();
    expect(emittedMetadata).toHaveLength(1);
    expect(emittedMetadata[0].workspaceId).toBe(rootId);
    expect(emittedMetadata[0].metadata?.pinnedAt).toBe(pinnedAt);

    const unpinResult = await workspaceService.setPinned(rootId, false);
    expect(unpinResult.success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBeUndefined();
    expect(emittedMetadata).toHaveLength(2);
    expect(emittedMetadata[1].metadata?.pinnedAt).toBeUndefined();
  });

  test("pin-when-pinned and unpin-when-unpinned are no-ops without event churn", async () => {
    const first = await workspaceService.setPinned(rootId, true);
    expect(first.success).toBe(true);
    const firstPinnedAt = getEntry(rootId)?.pinnedAt;
    expect(emittedMetadata).toHaveLength(1);

    // Concurrent double-pin from another client must not move the row.
    const again = await workspaceService.setPinned(rootId, true);
    expect(again.success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBe(firstPinnedAt);
    expect(emittedMetadata).toHaveLength(1);

    // Unpinning a chat that is not pinned is also a quiet no-op.
    const noopUnpin = await workspaceService.setPinned(otherRootId, false);
    expect(noopUnpin.success).toBe(true);
    expect(emittedMetadata).toHaveLength(1);
  });

  test("rejects pinning sub-agent and archived workspaces", async () => {
    const subAgentResult = await workspaceService.setPinned(childId, true);
    expect(subAgentResult.success).toBe(false);
    expect(getEntry(childId)?.pinnedAt).toBeUndefined();

    const archivedResult = await workspaceService.setPinned(archivedId, true);
    expect(archivedResult.success).toBe(false);
    expect(getEntry(archivedId)?.pinnedAt).toBeUndefined();

    expect(emittedMetadata).toHaveLength(0);
  });

  test("pinning after an existing pin yields a strictly greater pinnedAt", async () => {
    expect((await workspaceService.setPinned(otherRootId, true)).success).toBe(true);
    expect((await workspaceService.setPinned(rootId, true)).success).toBe(true);

    const firstMs = Date.parse(getEntry(otherRootId)?.pinnedAt ?? "");
    const secondMs = Date.parse(getEntry(rootId)?.pinnedAt ?? "");
    expect(secondMs).toBeGreaterThan(firstMs);
  });

  test("appends after an existing future pinnedAt (clock skew)", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    getEntry(otherRootId)!.pinnedAt = future;

    expect((await workspaceService.setPinned(rootId, true)).success).toBe(true);
    expect(Date.parse(getEntry(rootId)?.pinnedAt ?? "")).toBeGreaterThan(Date.parse(future));
  });

  test("archive clears pinnedAt and unarchive does not restore it", async () => {
    expect((await workspaceService.setPinned(rootId, true)).success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBeDefined();

    const archiveResult = await workspaceService.archive(rootId);
    expect(archiveResult.success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBeUndefined();

    const unarchiveResult = await workspaceService.unarchive(rootId);
    expect(unarchiveResult.success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBeUndefined();

    // Re-pinning after unarchive works (pin state starts fresh).
    expect((await workspaceService.setPinned(rootId, true)).success).toBe(true);
    expect(getEntry(rootId)?.pinnedAt).toBeDefined();
  });
});

describe("WorkspaceService reorderPinned", () => {
  const projectPath = "/tmp/project";
  const idA = "ws-a";
  const idB = "ws-b";
  const idC = "ws-c";
  const unpinnedId = "ws-unpinned";
  const childId = "ws-child";
  const archivedId = "ws-archived";

  let workspaceService: WorkspaceService;
  let configState: ProjectsConfig;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let emittedMetadata: Array<{ workspaceId: string; metadata: FrontendWorkspaceMetadata | null }>;

  const getEntry = (id: string) =>
    configState.projects.get(projectPath)?.workspaces.find((w) => w.id === id);

  /** Pinned ids in effective order (pinnedAt asc), as the sidebar sorts them. */
  const pinnedOrder = () =>
    (configState.projects.get(projectPath)?.workspaces ?? [])
      .filter((w) => w.id && w.pinnedAt && !w.parentWorkspaceId && !w.archivedAt)
      .sort((a, b) => Date.parse(a.pinnedAt ?? "") - Date.parse(b.pinnedAt ?? ""))
      .map((w) => w.id);

  beforeEach(async () => {
    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              // Pinned block in order A, B, C (pinnedAt ascending).
              {
                path: `${projectPath}/${idA}`,
                id: idA,
                pinnedAt: "2026-01-01T00:00:00.000Z",
              },
              {
                path: `${projectPath}/${idB}`,
                id: idB,
                pinnedAt: "2026-01-01T00:00:10.000Z",
              },
              {
                path: `${projectPath}/${idC}`,
                id: idC,
                pinnedAt: "2026-01-01T00:00:20.000Z",
              },
              { path: `${projectPath}/${unpinnedId}`, id: unpinnedId },
              {
                path: `${projectPath}/${childId}`,
                id: childId,
                parentWorkspaceId: idA,
              },
              {
                path: `${projectPath}/${archivedId}`,
                id: archivedId,
                archivedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        ],
      ]),
    };

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      findWorkspace: mock((id: string) => {
        const entry = getEntry(id);
        if (!entry) return null;
        return {
          projectPath,
          workspacePath: entry.path,
          parentWorkspaceId: entry.parentWorkspaceId,
        };
      }),
      editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        configState = fn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() =>
        Promise.resolve(
          (configState.projects.get(projectPath)?.workspaces ?? [])
            .filter((w): w is typeof w & { id: string } => w.id != null)
            .map(
              (w): FrontendWorkspaceMetadata => ({
                id: w.id,
                name: w.id,
                projectName: "proj",
                projectPath,
                namedWorkspacePath: w.path,
                runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
                parentWorkspaceId: w.parentWorkspaceId,
                archivedAt: w.archivedAt,
                unarchivedAt: w.unarchivedAt,
                pinnedAt: w.pinnedAt,
              })
            )
        )
      ),
      loadConfigOrDefault: mock(() => configState),
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
    });

    emittedMetadata = [];
    workspaceService.on("metadata", (payload) => {
      emittedMetadata.push(payload as (typeof emittedMetadata)[number]);
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("persists the new order and emits metadata only for displaced rows", async () => {
    // Move C to the front: every rank shifts, so all three rows change.
    const result = await workspaceService.reorderPinned([idC, idA, idB]);
    expect(result.success).toBe(true);
    expect(pinnedOrder()).toEqual([idC, idA, idB]);
    expect(emittedMetadata.map((e) => e.workspaceId).sort()).toEqual([idA, idB, idC].sort());
    // Emitted metadata carries the rewritten pinnedAt values.
    for (const event of emittedMetadata) {
      expect(event.metadata?.pinnedAt).toBe(getEntry(event.workspaceId)?.pinnedAt);
    }
  });

  test("swapping only a suffix leaves preceding pins untouched", async () => {
    const pinnedAtA = getEntry(idA)?.pinnedAt;
    const result = await workspaceService.reorderPinned([idA, idC, idB]);
    expect(result.success).toBe(true);
    expect(pinnedOrder()).toEqual([idA, idC, idB]);
    // A kept its rank, so its timestamp is untouched and no event is emitted for it.
    expect(getEntry(idA)?.pinnedAt).toBe(pinnedAtA);
    expect(emittedMetadata.map((e) => e.workspaceId).sort()).toEqual([idB, idC].sort());
  });

  test("no-op order emits nothing and rewrites nothing", async () => {
    const before = [getEntry(idA)?.pinnedAt, getEntry(idB)?.pinnedAt, getEntry(idC)?.pinnedAt];
    const result = await workspaceService.reorderPinned([idA, idB, idC]);
    expect(result.success).toBe(true);
    expect([getEntry(idA)?.pinnedAt, getEntry(idB)?.pinnedAt, getEntry(idC)?.pinnedAt]).toEqual(
      before
    );
    expect(emittedMetadata).toHaveLength(0);
  });

  test("drops stale/unpinned/duplicate ids and appends omitted pins in current order", async () => {
    // Client sends duplicates, an unpinned id, a sub-agent, an archived chat,
    // and a ghost id, and omits B and C entirely.
    const result = await workspaceService.reorderPinned([
      idC,
      idC,
      unpinnedId,
      childId,
      archivedId,
      "ws-ghost",
    ]);
    expect(result.success).toBe(true);
    // C first, then omitted pins A, B keep their relative order.
    expect(pinnedOrder()).toEqual([idC, idA, idB]);
    // Ineligible ids never gain pinnedAt.
    expect(getEntry(unpinnedId)?.pinnedAt).toBeUndefined();
    expect(getEntry(childId)?.pinnedAt).toBeUndefined();
    expect(getEntry(archivedId)?.pinnedAt).toBeUndefined();
  });

  test("reorder preserves the timestamp pool so setPinned still appends at the bottom", async () => {
    const maxBefore = Math.max(
      ...[idA, idB, idC].map((id) => Date.parse(getEntry(id)?.pinnedAt ?? ""))
    );
    expect((await workspaceService.reorderPinned([idC, idB, idA])).success).toBe(true);
    const maxAfter = Math.max(
      ...[idA, idB, idC].map((id) => Date.parse(getEntry(id)?.pinnedAt ?? ""))
    );
    // Re-dealing the pool must not inflate the max timestamp.
    expect(maxAfter).toBe(maxBefore);

    expect((await workspaceService.setPinned(unpinnedId, true)).success).toBe(true);
    expect(pinnedOrder()).toEqual([idC, idB, idA, unpinnedId]);
  });

  test("returns Ok no-op when no id resolves to a workspace", async () => {
    const result = await workspaceService.reorderPinned(["ws-ghost-1", "ws-ghost-2"]);
    expect(result.success).toBe(true);
    expect(pinnedOrder()).toEqual([idA, idB, idC]);
    expect(emittedMetadata).toHaveLength(0);
  });

  test("identical pinnedAt values (client races) still reorder deterministically", async () => {
    const same = "2026-01-01T00:00:00.000Z";
    getEntry(idA)!.pinnedAt = same;
    getEntry(idB)!.pinnedAt = same;
    getEntry(idC)!.pinnedAt = same;

    const result = await workspaceService.reorderPinned([idB, idC, idA]);
    expect(result.success).toBe(true);
    expect(pinnedOrder()).toEqual([idB, idC, idA]);
    // Strictly monotonic after the re-deal.
    const values = [idB, idC, idA].map((id) => Date.parse(getEntry(id)?.pinnedAt ?? ""));
    expect(values[0]).toBeLessThan(values[1]);
    expect(values[1]).toBeLessThan(values[2]);
  });
});

describe("WorkspaceService archive lifecycle hooks", () => {
  const workspaceId = "ws-archive";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-archive";

  let workspaceService: WorkspaceService;
  let mockAIService: AIService;
  let configState: ProjectsConfig;
  let editConfigSpy: ReturnType<typeof mock>;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  const workspaceMetadata: WorkspaceMetadata = {
    id: workspaceId,
    name: "ws-archive",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
  };

  beforeEach(async () => {
    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
              },
            ],
          },
        ],
      ]),
    };

    editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      loadConfigOrDefault: mock(() => configState),
    };
    mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("archive coordinates through the task-tree lifecycle lock", async () => {
    const withTaskTreeLifecycleLock = mock(
      <T>(_: string, operation: () => Promise<T>): Promise<T> => operation()
    );
    workspaceService.setTaskService({
      withTaskTreeLifecycleLock,
      hasActiveDescendantAgentTasksForWorkspace: mock(() => false),
    } as unknown as TaskService);

    expect(await workspaceService.archive(workspaceId)).toEqual(Ok({ kind: "archived" }));
    expect(withTaskTreeLifecycleLock).toHaveBeenCalledWith(workspaceId, expect.any(Function));
  });

  test("archive refuses to hide a parent while descendant sub-agents remain active", async () => {
    const hasActiveDescendantAgentTasksForWorkspace = mock(() => true);
    workspaceService.setTaskService({
      hasActiveDescendantAgentTasksForWorkspace,
    } as unknown as TaskService);

    const preflight = await workspaceService.preflightArchive(workspaceId);
    const archive = await workspaceService.archive(workspaceId);

    const expectedError =
      "This workspace has active descendant sub-agents. Stop them before archiving their parent.";
    expect(preflight).toEqual(Err(expectedError));
    expect(archive).toEqual(Err(expectedError));
    expect(hasActiveDescendantAgentTasksForWorkspace).toHaveBeenCalledWith(workspaceId);
    expect(editConfigSpy).not.toHaveBeenCalled();
  });

  test("returns Err and does not persist archivedAt when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("hook failed");
    }

    expect(editConfigSpy).toHaveBeenCalledTimes(0);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeUndefined();
  });

  test("does not interrupt an active stream when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    (mockAIService.isStreaming as ReturnType<typeof mock>).mockReturnValue(true);

    const interruptStreamSpy = mock(() => Promise.resolve(Ok(undefined)));
    workspaceService.interruptStream =
      interruptStreamSpy as unknown as typeof workspaceService.interruptStream;

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    expect(interruptStreamSpy).toHaveBeenCalledTimes(0);
  });

  test("archive() stays successful when post-persist terminal teardown fails", async () => {
    const closeWorkspaceSessions = mock(() => {
      throw new Error("terminal close failed");
    });
    const terminalService = {
      closeWorkspaceSessions,
    } as unknown as TerminalService;
    workspaceService.setTerminalService(terminalService);

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "archived" }));
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
  });

  test("archive() closes workspace terminal sessions on success", async () => {
    const closeWorkspaceSessions = mock(() => undefined);
    const terminalService = {
      closeWorkspaceSessions,
    } as unknown as TerminalService;
    workspaceService.setTerminalService(terminalService);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(closeWorkspaceSessions).toHaveBeenCalledTimes(1);
    expect(closeWorkspaceSessions).toHaveBeenCalledWith(workspaceId);
  });

  test("archive() does not close terminal sessions when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const closeWorkspaceSessions = mock(() => undefined);
    const terminalService = {
      closeWorkspaceSessions,
    } as unknown as TerminalService;
    workspaceService.setTerminalService(terminalService);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    expect(closeWorkspaceSessions).not.toHaveBeenCalled();
  });

  test("archive() closes desktop sessions on success", async () => {
    const close = mock(() => Promise.resolve(undefined));
    const desktopSessionManager = {
      close,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(workspaceId);
  });

  test("archive() does not close desktop sessions when beforeArchive hook fails", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const close = mock(() => Promise.resolve(undefined));
    const desktopSessionManager = {
      close,
    } as unknown as DesktopSessionManager;
    workspaceService.setDesktopSessionManager(desktopSessionManager);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  test("persists archivedAt when beforeArchive hooks succeed", async () => {
    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Ok(undefined)));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(editConfigSpy).toHaveBeenCalledTimes(1);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
    expect(entry?.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  test("persists archivedAt before afterArchive hooks run and treats hook failures as best-effort", async () => {
    const hooks = new WorkspaceLifecycleHooks();

    const afterHook = mock(() => {
      const entry = configState.projects.get(projectPath)?.workspaces[0];
      expect(entry?.archivedAt).toBeTruthy();
      return Promise.resolve(Err("hook failed"));
    });
    hooks.registerAfterArchive(afterHook);

    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(afterHook).toHaveBeenCalledTimes(1);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
    expect(entry?.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  test("archive() removes DevTools data only after archivedAt is persisted", async () => {
    const removeWorkspaceData = mock((id: string) => {
      // devtools cleanup must run only once the archived state is durable
      expect(id).toBe(workspaceId);
      const entry = configState.projects.get(projectPath)?.workspaces[0];
      expect(entry?.archivedAt).toBeTruthy();
      return Promise.resolve();
    });
    workspaceService.setDevToolsService({ removeWorkspaceData });

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    expect(removeWorkspaceData).toHaveBeenCalledTimes(1);
  });

  test("archive() stays successful when DevTools cleanup fails", async () => {
    workspaceService.setDevToolsService({
      removeWorkspaceData: mock(() => Promise.reject(new Error("disk error"))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(true);
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
  });

  test("archive() does not trigger irreversible descendant cleanup", async () => {
    const cleanupReportedDescendantsAfterArchive = mock(() => Promise.resolve());
    workspaceService.setTaskService({
      cleanupReportedDescendantsAfterArchive,
      hasActiveDescendantAgentTasksForWorkspace: () => false,
    } as unknown as TaskService);

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "archived" }));
    expect(cleanupReportedDescendantsAfterArchive).not.toHaveBeenCalled();
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
  });
});

describe("WorkspaceService archive init cancellation", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("emits metadata when it cancels init but beforeArchive hook fails", async () => {
    const workspaceId = "ws-archive-init-cancel";
    const projectPath = "/tmp/project";
    const workspacePath = "/tmp/project/ws-archive-init-cancel";

    const initStates = new Map<string, InitStatus>([
      [
        workspaceId,
        {
          status: "running",
          hookPath: projectPath,
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        },
      ],
    ]);

    const clearInMemoryStateMock = mock((id: string) => {
      initStates.delete(id);
    });

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock((id: string) => initStates.get(id)),
      clearInMemoryState: clearInMemoryStateMock,
    };

    let configState: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
              },
            ],
          },
        ],
      ]),
    };

    const editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    const frontendMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws-archive-init-cancel",
      projectName: "proj",
      projectPath,
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      namedWorkspacePath: workspacePath,
    };

    const workspaceMetadata: WorkspaceMetadata = {
      id: workspaceId,
      name: "ws-archive-init-cancel",
      projectName: "proj",
      projectPath,
      runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
    };

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([frontendMetadata])),
      loadConfigOrDefault: mock(() => configState),
    };

    const mockAIService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const workspaceService = new WorkspaceService(
      mockConfig as Config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      {} as ExtensionMetadataService,
      { cleanup: mock(() => Promise.resolve()) } as unknown as BackgroundProcessManager
    );

    // Seed abort controller so archive() can cancel init.
    const abortController = new AbortController();
    const initAbortControllers = (
      workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
    ).initAbortControllers;
    initAbortControllers.set(workspaceId, abortController);

    const metadataEvents: Array<FrontendWorkspaceMetadata | null> = [];
    workspaceService.on("metadata", (event: unknown) => {
      if (!event || typeof event !== "object") {
        return;
      }
      const parsed = event as { workspaceId: string; metadata: FrontendWorkspaceMetadata | null };
      if (parsed.workspaceId === workspaceId) {
        metadataEvents.push(parsed.metadata);
      }
    });

    const hooks = new WorkspaceLifecycleHooks();
    hooks.registerBeforeArchive(() => Promise.resolve(Err("hook failed")));
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("hook failed");
    }

    // Ensure we didn't persist archivedAt on hook failure.
    expect(editConfigSpy).toHaveBeenCalledTimes(0);
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeUndefined();

    expect(abortController.signal.aborted).toBe(true);
    expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);

    expect(metadataEvents.length).toBeGreaterThanOrEqual(1);
    expect(metadataEvents.at(-1)?.isInitializing).toBe(undefined);
  });
});

describe("WorkspaceService unarchive lifecycle hooks", () => {
  const workspaceId = "ws-unarchive";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-unarchive";

  let workspaceService: WorkspaceService;
  let configState: ProjectsConfig;
  let editConfigSpy: ReturnType<typeof mock>;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  const workspaceMetadata: FrontendWorkspaceMetadata = {
    id: workspaceId,
    name: "ws-unarchive",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
    archivedAt: "2020-01-01T00:00:00.000Z",
    namedWorkspacePath: workspacePath,
  };

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
                archivedAt: "2020-01-01T00:00:00.000Z",
              },
            ],
          },
        ],
      ]),
    };

    editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([workspaceMetadata])),
    };
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("persists unarchivedAt and runs afterUnarchive hooks (best-effort)", async () => {
    const hooks = new WorkspaceLifecycleHooks();

    const afterHook = mock(() => {
      const entry = configState.projects.get(projectPath)?.workspaces[0];
      expect(entry?.unarchivedAt).toBeTruthy();
      return Promise.resolve(Err("hook failed"));
    });
    hooks.registerAfterUnarchive(afterHook);

    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.unarchive(workspaceId);

    expect(result.success).toBe(true);
    expect(afterHook).toHaveBeenCalledTimes(1);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.unarchivedAt).toBeTruthy();
    expect(entry?.unarchivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("does not run afterUnarchive hooks when workspace is not archived", async () => {
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    if (!entry) {
      throw new Error("Missing workspace entry");
    }
    entry.archivedAt = undefined;

    const hooks = new WorkspaceLifecycleHooks();
    const afterHook = mock(() => Promise.resolve(Ok(undefined)));
    hooks.registerAfterUnarchive(afterHook);
    workspaceService.setWorkspaceLifecycleHooks(hooks);

    const result = await workspaceService.unarchive(workspaceId);

    expect(result.success).toBe(true);
    expect(afterHook).toHaveBeenCalledTimes(0);
  });
  test("unarchiving with missing managed worktree does not recreate the directory", async () => {
    const result = await workspaceService.unarchive(workspaceId);

    expect(result.success).toBe(true);

    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.unarchivedAt).toBeTruthy();
    expect(entry?.unarchivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(
      await fsPromises
        .access(workspacePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
    expect(entry?.path).toBe(workspacePath);
  });
});

describe("WorkspaceService archive snapshots", () => {
  const workspaceId = "ws-archive-snapshot";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-archive-snapshot";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let configState: ProjectsConfig;
  let editConfigSpy: ReturnType<typeof mock>;
  let workspaceService: WorkspaceService;

  const workspaceMetadata: WorkspaceMetadata = {
    id: workspaceId,
    name: "ws-archive-snapshot",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
  };

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    configState = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
                name: "ws-archive-snapshot",
                runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
              },
            ],
          },
        ],
      ]),
      worktreeArchiveBehavior: "snapshot",
    };

    editConfigSpy = mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
      configState = fn(configState);
      return Promise.resolve();
    });

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: editConfigSpy,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      loadConfigOrDefault: mock(() => configState),
    };
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("archive() persists captured snapshot metadata together with archivedAt", async () => {
    const snapshot = {
      version: 1 as const,
      capturedAt: "2026-03-30T00:00:00.000Z",
      stateDirPath: "archive-state",
      projects: [
        {
          projectPath,
          projectName: "proj",
          storageKey: "proj",
          branchName: "ws-archive-snapshot",
          trunkBranch: "main",
          baseSha: "base-sha",
          headSha: "head-sha",
        },
      ],
    };
    const captureSnapshotForArchive = mock(() => Promise.resolve(Ok(snapshot)));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "archived" }));
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeTruthy();
    expect(entry?.worktreeArchiveSnapshot).toEqual(snapshot);
    expect(captureSnapshotForArchive).toHaveBeenCalledWith({
      workspaceId,
      workspaceMetadata,
      acknowledgedUntrackedPaths: undefined,
    });
  });

  test("archive() does not close live sessions when archive readiness checks fail", async () => {
    const closeWorkspaceSessions = mock(() => undefined);
    workspaceService.setTerminalService({
      closeWorkspaceSessions,
    } as unknown as TerminalService);

    const closeDesktopSession = mock(() => Promise.resolve(undefined));
    workspaceService.setDesktopSessionManager({
      close: closeDesktopSession,
    } as unknown as DesktopSessionManager);

    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("should not run")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Err("snapshot failed"))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Err("snapshot failed"));
    expect(captureSnapshotForArchive).not.toHaveBeenCalled();
    expect(closeWorkspaceSessions).not.toHaveBeenCalled();
    expect(closeDesktopSession).not.toHaveBeenCalled();
  });

  test("archive() skips snapshot capture for multi-project workspaces", async () => {
    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("should not run")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const multiProjectMetadata = {
      ...workspaceMetadata,
      projects: [
        { projectPath, projectName: "proj" },
        { projectPath: "/tmp/project-b", projectName: "proj-b" },
      ],
    } satisfies WorkspaceMetadata;
    const aiService = workspaceService as unknown as { aiService: AIService };
    aiService.aiService.getWorkspaceMetadata = mock(() =>
      Promise.resolve(Ok(multiProjectMetadata))
    );

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "archived" }));
    expect(captureSnapshotForArchive).not.toHaveBeenCalled();
  });

  test("archive() aborts when snapshot capture fails", async () => {
    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("snapshot failed")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("snapshot failed");
    }
    const entry = configState.projects.get(projectPath)?.workspaces[0];
    expect(entry?.archivedAt).toBeUndefined();
    expect(entry?.worktreeArchiveSnapshot).toBeUndefined();
    expect(editConfigSpy).toHaveBeenCalledTimes(0);
  });
});

describe("WorkspaceService preflightArchive and acknowledged archive", () => {
  const workspaceId = "ws-preflight-archive";
  const projectPath = "/tmp/project-preflight";
  const workspacePath = "/tmp/project-preflight/ws-preflight-archive";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let workspaceService: WorkspaceService;

  const workspaceMetadata: WorkspaceMetadata = {
    id: workspaceId,
    name: "ws-preflight-archive",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
  };

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const configState: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
                name: "ws-preflight-archive",
                runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
              },
            ],
          },
        ],
      ]),
      worktreeArchiveBehavior: "snapshot",
    };

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) return null;
        return { projectPath, workspacePath };
      }),
      editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        fn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      loadConfigOrDefault: mock(() => configState),
    };
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("preflightArchive returns ready for scratch workspaces under snapshot behavior", async () => {
    // Scratch chats run on the plain local runtime, so the worktree snapshot
    // preflight must short-circuit instead of consulting the snapshot service
    // (whose non-worktree path would reject and block archiving).
    const scratchMetadata: WorkspaceMetadata = {
      kind: "scratch",
      id: workspaceId,
      name: "ws-preflight-archive",
      projectName: "Scratch",
      projectPath: "/tmp/mux/scratch/ws-preflight-archive",
      runtimeConfig: { type: "local" },
    };
    (workspaceService as unknown as { aiService: AIService }).aiService.getWorkspaceMetadata = mock(
      () => Promise.resolve(Ok(scratchMetadata))
    );
    const getUnsupportedUntrackedPaths = mock(() =>
      Promise.resolve(Err("Archive snapshots are only supported for worktree runtimes"))
    );
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths,
    });

    const result = await workspaceService.preflightArchive(workspaceId);

    expect(result).toEqual(Ok({ kind: "ready" }));
    expect(getUnsupportedUntrackedPaths).not.toHaveBeenCalled();
  });

  test("preflightArchive returns ready when no untracked files", async () => {
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.preflightArchive(workspaceId);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ kind: "ready" });
    }
  });

  test("preflightArchive returns confirm-lossy-untracked-files with paths", async () => {
    const untrackedPaths = [".ruff_cache/", "tmp/scratch.txt"];
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok(untrackedPaths))),
    });

    const result = await workspaceService.preflightArchive(workspaceId);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        kind: "confirm-lossy-untracked-files",
        paths: untrackedPaths,
      });
    }
  });

  test("preflightArchive returns error when getUnsupportedUntrackedPaths fails", async () => {
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() =>
        Promise.resolve(Err("Failed to check: dirty submodule"))
      ),
    });

    const result = await workspaceService.preflightArchive(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("dirty submodule");
    }
  });

  test("archive with matching acknowledgedUntrackedPaths succeeds", async () => {
    const untrackedPaths = [".cache/", "temp.txt"];
    const snapshot: WorktreeArchiveSnapshot = {
      version: 1,
      capturedAt: new Date().toISOString(),
      stateDirPath: "archive-state",
      projects: [
        {
          projectPath,
          projectName: "proj",
          storageKey: "proj",
          branchName: "ws-preflight-archive",
          headSha: "abc123",
          baseSha: "def456",
          trunkBranch: "main",
        },
      ],
    };
    const captureSnapshotForArchive = mock(() => Promise.resolve(Ok(snapshot)));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok(untrackedPaths))),
    });

    const result = await workspaceService.archive(workspaceId, untrackedPaths);

    expect(result).toEqual(Ok({ kind: "archived" }));
    // The capture should have been called with acknowledgedUntrackedPaths.
    expect(captureSnapshotForArchive).toHaveBeenCalledWith({
      workspaceId,
      workspaceMetadata,
      acknowledgedUntrackedPaths: untrackedPaths,
    });
  });

  test("archive returns refreshed confirmation when capture detects new untracked files", async () => {
    const captureSnapshotForArchive = mock(() =>
      Promise.resolve(
        Err({
          kind: "confirm-lossy-untracked-files" as const,
          paths: [".cache/", "new-file.txt"],
        })
      )
    );
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([".cache/", "temp.txt"]))),
    });

    const result = await workspaceService.archive(workspaceId, [".cache/", "temp.txt"]);

    expect(result).toEqual(
      Ok({
        kind: "confirm-lossy-untracked-files",
        paths: [".cache/", "new-file.txt"],
      })
    );
    expect(captureSnapshotForArchive).toHaveBeenCalledWith({
      workspaceId,
      workspaceMetadata,
      acknowledgedUntrackedPaths: [".cache/", "temp.txt"],
    });
  });

  test("archive returns refreshed confirmation when acknowledged paths drift before capture", async () => {
    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("should not run")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() =>
        Promise.resolve(Ok([".cache/", "new-file.txt", "temp.txt"]))
      ),
    });

    const result = await workspaceService.archive(workspaceId, [".cache/", "temp.txt"]);

    expect(result).toEqual(
      Ok({
        kind: "confirm-lossy-untracked-files",
        paths: [".cache/", "new-file.txt", "temp.txt"],
      })
    );
    expect(captureSnapshotForArchive).not.toHaveBeenCalled();
  });

  test("archive without acknowledgedUntrackedPaths returns confirmation for untracked files", async () => {
    const captureSnapshotForArchive = mock(() => Promise.resolve(Err("should not run")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive,
      restoreSnapshotAfterUnarchive: mock(() => Promise.resolve(Ok("skipped" as const))),
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([".cache/"]))),
    });

    const result = await workspaceService.archive(workspaceId);

    expect(result).toEqual(Ok({ kind: "confirm-lossy-untracked-files", paths: [".cache/"] }));
    expect(captureSnapshotForArchive).not.toHaveBeenCalled();
  });
});

describe("WorkspaceService unarchive snapshot restore", () => {
  const workspaceId = "ws-unarchive-snapshot";
  const projectPath = "/tmp/project";
  const workspacePath = "/tmp/project/ws-unarchive-snapshot";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let workspaceService: WorkspaceService;

  const workspaceMetadata: FrontendWorkspaceMetadata = {
    id: workspaceId,
    name: "ws-unarchive-snapshot",
    projectName: "proj",
    projectPath,
    runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
    archivedAt: "2020-01-01T00:00:00.000Z",
    namedWorkspacePath: workspacePath,
  };

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    let configState: ProjectsConfig = {
      projects: new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                path: workspacePath,
                id: workspaceId,
                name: "ws-unarchive-snapshot",
                archivedAt: "2020-01-01T00:00:00.000Z",
                runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
                worktreeArchiveSnapshot: {
                  version: 1,
                  capturedAt: "2026-03-30T00:00:00.000Z",
                  stateDirPath: "archive-state",
                  projects: [
                    {
                      projectPath,
                      projectName: "proj",
                      storageKey: "proj",
                      branchName: "ws-unarchive-snapshot",
                      trunkBranch: "main",
                      baseSha: "base-sha",
                      headSha: "head-sha",
                    },
                  ],
                },
              },
            ],
          },
        ],
      ]),
    };

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock((id: string) => {
        if (id !== workspaceId) {
          return null;
        }

        return { projectPath, workspacePath };
      }),
      editConfig: mock((fn: (config: ProjectsConfig) => ProjectsConfig) => {
        configState = fn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([workspaceMetadata])),
      loadConfigOrDefault: mock(() => configState),
    };
    const aiService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(workspaceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("unarchive() returns Err when snapshot restore fails", async () => {
    const restoreSnapshotAfterUnarchive = mock(() => Promise.resolve(Err("restore failed")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive,
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.unarchive(workspaceId);

    expect(result).toEqual(Err("restore failed"));
  });

  test("unarchive() rolls back unarchivedAt when snapshot restore fails", async () => {
    const restoreSnapshotAfterUnarchive = mock(() => Promise.resolve(Err("restore failed")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive,
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.unarchive(workspaceId);

    expect(result).toEqual(Err("restore failed"));
  });

  test("unarchive() rolls back legacy path-only entries when snapshot restore fails", async () => {
    const restoreSnapshotAfterUnarchive = mock(() => Promise.resolve(Err("restore failed")));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive,
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const config = workspaceService as unknown as { config: Config };
    await config.config.editConfig((currentConfig) => {
      const workspaceEntry = currentConfig.projects.get(projectPath)?.workspaces[0];
      if (!workspaceEntry) {
        throw new Error("Missing workspace entry");
      }
      delete workspaceEntry.id;
      return currentConfig;
    });

    const result = await workspaceService.unarchive(workspaceId);

    expect(result).toEqual(Err("restore failed"));
  });

  test("unarchive() invokes snapshot restore when snapshot metadata is present", async () => {
    const restoreSnapshotAfterUnarchive = mock(() => Promise.resolve(Ok("restored" as const)));
    workspaceService.setWorktreeArchiveSnapshotService({
      preflightSnapshotForArchive: mock(() => Promise.resolve(Ok(undefined))),
      captureSnapshotForArchive: mock(() => Promise.resolve(Err("unused"))),
      restoreSnapshotAfterUnarchive,
      getUnsupportedUntrackedPaths: mock(() => Promise.resolve(Ok([]))),
    });

    const result = await workspaceService.unarchive(workspaceId);

    expect(result).toEqual(Ok(undefined));
    expect(restoreSnapshotAfterUnarchive).toHaveBeenCalledWith({
      workspaceId,
      workspaceMetadata,
    });
  });
});

describe("WorkspaceService deleteWorktree", () => {
  const workspaceId = "ws-delete-worktree";
  const projectName = "proj";
  const projectPath = "/tmp/project";
  const workspaceName = "ws-delete-worktree";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;
  let tempSrcBaseDir: string;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
    tempSrcBaseDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-delete-worktree-"));
  });

  afterEach(async () => {
    mock.restore();
    await cleanupHistory();
    await fsPromises.rm(tempSrcBaseDir, { recursive: true, force: true });
  });

  function createHarness(options?: {
    archivedAt?: string;
    runtimeConfig?: FrontendWorkspaceMetadata["runtimeConfig"];
    taskIsolation?: FrontendWorkspaceMetadata["taskIsolation"];
  }): {
    workspaceService: WorkspaceService;
    metadataEvents: Array<FrontendWorkspaceMetadata | null>;
    managedPath: string;
  } {
    const runtimeConfig = options?.runtimeConfig ?? {
      type: "worktree",
      srcBaseDir: tempSrcBaseDir,
    };
    const managedPath = path.join(tempSrcBaseDir, "_workspaces", workspaceName);

    const getCurrentMetadata = async (): Promise<FrontendWorkspaceMetadata> => {
      const transcriptOnly = await fsPromises
        .access(managedPath)
        .then(() => false)
        .catch(() => true);

      return {
        id: workspaceId,
        name: workspaceName,
        projectName,
        projectPath,
        runtimeConfig,
        archivedAt: options?.archivedAt,
        taskIsolation: options?.taskIsolation,
        transcriptOnly,
        namedWorkspacePath: managedPath,
      };
    };

    const mockConfig: Partial<Config> = {
      srcDir: tempSrcBaseDir,
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      getAllWorkspaceMetadata: mock(async () => [await getCurrentMetadata()]),
    };

    const aiService = {
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    const metadataEvents: Array<FrontendWorkspaceMetadata | null> = [];
    workspaceService.on("metadata", (event: unknown) => {
      if (!event || typeof event !== "object") {
        return;
      }
      const parsed = event as { workspaceId: string; metadata: FrontendWorkspaceMetadata | null };
      if (parsed.workspaceId === workspaceId) {
        metadataEvents.push(parsed.metadata);
      }
    });

    return { workspaceService, metadataEvents, managedPath };
  }

  test("deletes an archived managed worktree and emits transcript-only metadata", async () => {
    const { workspaceService, metadataEvents, managedPath } = createHarness({
      archivedAt: "2026-03-01T00:00:00.000Z",
    });
    await fsPromises.mkdir(managedPath, { recursive: true });
    const removeManagedGitWorktreeSpy = spyOn(
      removeManagedGitWorktreeModule,
      "removeManagedGitWorktree"
    ).mockImplementation(async (_projectPath, worktreePath) => {
      await fsPromises.rm(worktreePath, { recursive: true, force: true });
    });

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result).toEqual(Ok(undefined));
    expect(removeManagedGitWorktreeSpy).toHaveBeenCalledWith(projectPath, managedPath);
    expect(
      await fsPromises
        .access(managedPath)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
    expect(metadataEvents.at(-1)?.transcriptOnly).toBe(true);
  });

  test("returns success when the managed worktree is already missing", async () => {
    const { workspaceService, metadataEvents, managedPath } = createHarness({
      archivedAt: "2026-03-01T00:00:00.000Z",
    });
    const removeManagedGitWorktreeSpy = spyOn(
      removeManagedGitWorktreeModule,
      "removeManagedGitWorktree"
    ).mockResolvedValue(undefined);

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result).toEqual(Ok(undefined));
    expect(removeManagedGitWorktreeSpy).toHaveBeenCalledWith(projectPath, managedPath);
    expect(metadataEvents.at(-1)?.transcriptOnly).toBe(true);
  });

  test("rejects deleting a worktree for a non-archived workspace", async () => {
    const { workspaceService, managedPath } = createHarness({
      archivedAt: undefined,
    });
    await fsPromises.mkdir(managedPath, { recursive: true });

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Only archived workspaces can delete their managed worktree");
    }
    expect(
      await fsPromises
        .access(managedPath)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
  });

  test("rejects deleting the shared checkout for an isolation-none sub-agent", async () => {
    const { workspaceService, managedPath } = createHarness({
      archivedAt: "2026-03-01T00:00:00.000Z",
      taskIsolation: "none",
    });
    await fsPromises.mkdir(managedPath, { recursive: true });
    const removeManagedGitWorktreeSpy = spyOn(
      removeManagedGitWorktreeModule,
      "removeManagedGitWorktree"
    );

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result).toEqual(Err("Shared-checkout sub-agents do not own a managed worktree"));
    expect(removeManagedGitWorktreeSpy).not.toHaveBeenCalled();
  });

  test("rejects deleting a worktree for non-worktree runtimes", async () => {
    const { workspaceService } = createHarness({
      archivedAt: "2026-03-01T00:00:00.000Z",
      runtimeConfig: { type: "local" },
    });

    const result = await workspaceService.deleteWorktree(workspaceId);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe(
        "Deleting a managed worktree is only supported for worktree runtimes"
      );
    }
  });
});

describe("WorkspaceService archiveMergedInProject", () => {
  const TARGET_PROJECT_PATH = "/tmp/project";

  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  function createMetadata(
    id: string,
    options?: { projectPath?: string; archivedAt?: string; unarchivedAt?: string }
  ): FrontendWorkspaceMetadata {
    const projectPath = options?.projectPath ?? TARGET_PROJECT_PATH;

    return {
      id,
      name: id,
      projectName: "test-project",
      projectPath,
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(projectPath, id),
      archivedAt: options?.archivedAt,
      unarchivedAt: options?.unarchivedAt,
    };
  }

  function bashOk(output: string): Result<BashToolResult> {
    return {
      success: true,
      data: {
        success: true,
        output,
        exitCode: 0,
        wall_duration_ms: 0,
      },
    };
  }

  function bashToolFailure(error: string): Result<BashToolResult> {
    return {
      success: true,
      data: {
        success: false,
        error,
        exitCode: 1,
        wall_duration_ms: 0,
      },
    };
  }

  function executeBashFailure(error: string): Result<BashToolResult> {
    return { success: false, error };
  }

  type ExecuteBashFn = (
    workspaceId: string,
    script: string,
    options?: {
      timeout_secs?: number;
    }
  ) => Promise<Result<BashToolResult>>;

  type ArchiveFn = (workspaceId: string) => Promise<Result<{ kind: "archived" }>>;

  function archiveSuccess(): Promise<Result<{ kind: "archived" }>> {
    return Promise.resolve(Ok({ kind: "archived" }));
  }

  function createServiceHarness(
    allMetadata: FrontendWorkspaceMetadata[],
    executeBashImpl: ExecuteBashFn,
    archiveImpl: ArchiveFn
  ): {
    workspaceService: WorkspaceService;
    executeBashMock: ReturnType<typeof mock>;
    archiveMock: ReturnType<typeof mock>;
  } {
    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
      getAllWorkspaceMetadata: mock(() => Promise.resolve(allMetadata)),
    };

    const aiService: AIService = {
      on(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
      off(_eventName: string | symbol, _listener: (...args: unknown[]) => void) {
        return this;
      },
    } as unknown as AIService;
    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    const executeBashMock = mock(executeBashImpl);
    const archiveMock = mock(archiveImpl);

    interface WorkspaceServiceTestAccess {
      executeBash: typeof executeBashMock;
      archive: typeof archiveMock;
    }

    const svc = workspaceService as unknown as WorkspaceServiceTestAccess;
    svc.executeBash = executeBashMock;
    svc.archive = archiveMock;

    return { workspaceService, executeBashMock, archiveMock };
  }

  test("treats workspaces with later unarchivedAt as eligible", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-merged-unarchived", {
        archivedAt: "2025-01-01T00:00:00.000Z",
        unarchivedAt: "2025-02-01T00:00:00.000Z",
      }),
      createMetadata("ws-still-archived", {
        archivedAt: "2025-03-01T00:00:00.000Z",
        unarchivedAt: "2025-02-01T00:00:00.000Z",
      }),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-merged-unarchived": bashOk('{"state":"MERGED"}'),
    };

    const { workspaceService, executeBashMock, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId) => {
        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => archiveSuccess()
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual(["ws-merged-unarchived"]);
    expect(result.data.skippedWorkspaceIds).toEqual([]);
    expect(result.data.errors).toEqual([]);

    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect(archiveMock).toHaveBeenCalledWith("ws-merged-unarchived");

    // Should only query GitHub for the workspace that is considered unarchived.
    expect(executeBashMock).toHaveBeenCalledTimes(1);
  });
  test("archives only MERGED workspaces", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-open"),
      createMetadata("ws-merged"),
      createMetadata("ws-no-pr"),
      createMetadata("ws-other-project", { projectPath: "/tmp/other" }),
      createMetadata("ws-already-archived", { archivedAt: "2025-01-01T00:00:00.000Z" }),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-open": bashOk('{"state":"OPEN"}'),
      "ws-merged": bashOk('{"state":"MERGED"}'),
      "ws-no-pr": bashOk('{"no_pr":true}'),
    };

    const { workspaceService, executeBashMock, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId, script, options) => {
        expect(script).toContain("gh pr view --json state");
        expect(options?.timeout_secs).toBe(15);

        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => archiveSuccess()
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual(["ws-merged"]);
    expect(result.data.skippedWorkspaceIds).toEqual(["ws-no-pr", "ws-open"]);
    expect(result.data.errors).toEqual([]);

    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect(archiveMock).toHaveBeenCalledWith("ws-merged");

    expect(executeBashMock).toHaveBeenCalledTimes(3);
  });

  test("skips no_pr and non-merged states", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-open"),
      createMetadata("ws-closed"),
      createMetadata("ws-no-pr"),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-open": bashOk('{"state":"OPEN"}'),
      "ws-closed": bashOk('{"state":"CLOSED"}'),
      "ws-no-pr": bashOk('{"no_pr":true}'),
    };

    const { workspaceService, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId) => {
        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => archiveSuccess()
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual([]);
    expect(result.data.skippedWorkspaceIds).toEqual(["ws-closed", "ws-no-pr", "ws-open"]);
    expect(result.data.errors).toEqual([]);

    expect(archiveMock).toHaveBeenCalledTimes(0);
  });

  test("records errors for malformed JSON and executeBash failures", async () => {
    const allMetadata: FrontendWorkspaceMetadata[] = [
      createMetadata("ws-bad-json"),
      createMetadata("ws-exec-failed"),
      createMetadata("ws-bash-failed"),
    ];

    const ghResultsByWorkspaceId: Record<string, Result<BashToolResult>> = {
      "ws-bad-json": bashOk("not-json"),
      "ws-exec-failed": executeBashFailure("executeBash failed"),
      "ws-bash-failed": bashToolFailure("gh failed"),
    };

    const { workspaceService, archiveMock } = createServiceHarness(
      allMetadata,
      (workspaceId) => {
        const result = ghResultsByWorkspaceId[workspaceId];
        if (!result) {
          throw new Error(`Unexpected executeBash call for workspaceId: ${workspaceId}`);
        }
        return Promise.resolve(result);
      },
      () => archiveSuccess()
    );

    const result = await workspaceService.archiveMergedInProject(TARGET_PROJECT_PATH);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.archivedWorkspaceIds).toEqual([]);
    expect(result.data.skippedWorkspaceIds).toEqual([]);
    expect(result.data.errors).toHaveLength(3);

    const badJsonError = result.data.errors.find((e) => e.workspaceId === "ws-bad-json");
    expect(badJsonError).toBeDefined();
    expect(badJsonError?.error).toContain("Failed to parse gh output");

    const execFailedError = result.data.errors.find((e) => e.workspaceId === "ws-exec-failed");
    expect(execFailedError).toBeDefined();
    expect(execFailedError?.error).toBe("executeBash failed");

    const bashFailedError = result.data.errors.find((e) => e.workspaceId === "ws-bash-failed");
    expect(bashFailedError).toBeDefined();
    expect(bashFailedError?.error).toBe("gh failed");

    expect(archiveMock).toHaveBeenCalledTimes(0);
  });
});

describe("WorkspaceService init cancellation", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("scratch workspace deletion preserves shared workdirs until the last reference", async () => {
    const {
      config,
      historyService: scratchHistoryService,
      cleanup,
    } = await createTestHistoryService();
    const parentId = "1111111111";
    const childId = "2222222222";
    const configWithStableId = config as unknown as { generateStableId: () => string };
    configWithStableId.generateStableId = () => parentId;

    const aiService = {
      isStreaming: mock(() => false),
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock(async (workspaceId: string) => {
        const metadata = (await config.getAllWorkspaceMetadata()).find(
          (workspace) => workspace.id === workspaceId
        );
        return metadata ? Ok(metadata) : Err("not found");
      }),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    try {
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService: scratchHistoryService,
        aiService,
      });
      const created = await workspaceService.createScratch("Scratch test");
      expect(created.success).toBe(true);
      if (!created.success) return;

      const scratchPath = created.data.metadata.namedWorkspacePath;
      await config.editConfig((current) => {
        const scratchProject = current.projects.get(SCRATCH_PROJECT_CONFIG_KEY);
        if (!scratchProject) throw new Error("Scratch project missing");
        scratchProject.workspaces.push({
          kind: "scratch",
          path: scratchPath,
          id: childId,
          name: `agent-explore-${childId}`,
          parentWorkspaceId: parentId,
          taskIsolation: "none",
          taskStatus: "reported",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
        });
        return current;
      });

      expect(await fsPromises.stat(scratchPath).then(() => true)).toBe(true);
      expect(await workspaceService.remove(parentId, true)).toEqual(Ok(undefined));
      expect(await fsPromises.stat(scratchPath).then(() => true)).toBe(true);
      expect(await workspaceService.remove(childId, true)).toEqual(Ok(undefined));
      expect(
        await fsPromises
          .stat(scratchPath)
          .then(() => true)
          .catch(() => false)
      ).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("scratch removal refuses to delete a workdir the workspace does not own", async () => {
    // A stale or hand-edited config entry can point at another chat's dir
    // under the scratch root; removal must not recursively delete it.
    const {
      config,
      historyService: scratchHistoryService,
      cleanup,
    } = await createTestHistoryService();
    const victimId = "3333333333";
    const malformedId = "4444444444";
    const configWithStableId = config as unknown as { generateStableId: () => string };
    configWithStableId.generateStableId = () => victimId;

    const aiService = {
      isStreaming: mock(() => false),
      stopStream: mock(() => Promise.resolve(Ok(undefined))),
      getWorkspaceMetadata: mock(async (workspaceId: string) => {
        const metadata = (await config.getAllWorkspaceMetadata()).find(
          (workspace) => workspace.id === workspaceId
        );
        return metadata ? Ok(metadata) : Err("not found");
      }),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    try {
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService: scratchHistoryService,
        aiService,
      });
      const created = await workspaceService.createScratch("Victim scratch");
      expect(created.success).toBe(true);
      if (!created.success) return;
      const victimPath = created.data.metadata.namedWorkspacePath;

      // Remove the victim's config entry (keep the dir) so the malformed
      // entry is the workdir's only reference; then point the malformed
      // root entry (no task ancestry) at the victim's dir.
      await config.editConfig((current) => {
        const scratchProject = current.projects.get(SCRATCH_PROJECT_CONFIG_KEY);
        if (!scratchProject) throw new Error("Scratch project missing");
        scratchProject.workspaces = scratchProject.workspaces.filter(
          (workspace) => workspace.id !== victimId
        );
        scratchProject.workspaces.push({
          kind: "scratch",
          path: victimPath,
          id: malformedId,
          name: `scratch-${malformedId}`,
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
        });
        return current;
      });

      expect(await workspaceService.remove(malformedId, true)).toEqual(Ok(undefined));
      // Config cleanup proceeded, but the victim's dir must survive.
      expect(await fsPromises.stat(victimPath).then(() => true)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("createScratch rejects when policy disallows the local runtime", async () => {
    const {
      config,
      historyService: scratchHistoryService,
      cleanup,
    } = await createTestHistoryService();
    const policyService = {
      isEnforced: mock(() => true),
      isRuntimeAllowed: mock(() => false),
    } as unknown as WorkspaceServiceArgs[7];

    try {
      const workspaceService = createWorkspaceServiceForTest({
        config,
        historyService: scratchHistoryService,
        policyService,
      });

      const result = await workspaceService.createScratch("Blocked scratch");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not allowed by policy");
      }
      // No config entry or workdir may be left behind by the rejected create.
      expect((await config.getAllWorkspaceMetadata()).length).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("create() rejects untrusted projects", async () => {
    const projectPath = "/tmp/proj";
    const generateStableIdMock = mock(() => "ws-untrusted");

    const mockAIService = {
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: Partial<Config> = {
      rootDir: "/tmp/mux-root",
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: generateStableIdMock,
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [],
              trusted: false,
            },
          ],
        ]),
      })),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };

    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    const result = await workspaceService.create(projectPath, "ws-branch", undefined, "title", {
      type: "local",
    });

    expect(result).toEqual(
      Err(
        "This project must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page."
      )
    );
    expect(generateStableIdMock).not.toHaveBeenCalled();
  });

  test("create() rejects slash branches whose sanitized workspace name already exists", async () => {
    const projectPath = "/tmp/proj";
    const generateStableIdMock = mock(() => "ws-conflict");
    const mockConfig: Partial<Config> = {
      rootDir: "/tmp/mux-root",
      srcDir: "/tmp/src",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: generateStableIdMock,
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [{ id: "existing", name: "feature-foo", path: "/tmp/proj/feature-foo" }],
              trusted: true,
            },
          ],
        ]),
      })),
    };
    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
    });

    const result = await workspaceService.create(projectPath, "feature/foo", undefined, "title", {
      type: "local",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Branch "feature/foo"');
      expect(result.error).toContain('workspace name "feature-foo"');
    }
    expect(generateStableIdMock).not.toHaveBeenCalled();
  });

  test("archive() aborts init and still archives when init is running", async () => {
    const workspaceId = "ws-init-running";

    const removeMock = mock(() => Promise.resolve({ success: true as const, data: undefined }));
    const editConfigMock = mock(() => Promise.resolve());
    const clearInMemoryStateMock = mock((_workspaceId: string) => undefined);

    const mockAIService = {
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      findWorkspace: mock(() => ({ projectPath: "/tmp/proj", workspacePath: "/tmp/proj/ws" })),
      editConfig: editConfigMock,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      // WorkspaceService subscribes to init-end events on construction.
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(
        (): InitStatus => ({
          status: "running",
          hookPath: "/tmp/proj",
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        })
      ),
      clearInMemoryState: clearInMemoryStateMock,
    };
    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    // Make it obvious if archive() incorrectly chooses deletion.
    workspaceService.remove = removeMock as unknown as typeof workspaceService.remove;

    const result = await workspaceService.archive(workspaceId);
    expect(result.success).toBe(true);
    expect(editConfigMock).toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);
  });

  test("archive() uses normal archive flow when init is complete", async () => {
    const workspaceId = "ws-init-complete";

    const removeMock = mock(() => Promise.resolve({ success: true as const, data: undefined }));
    const editConfigMock = mock(() => Promise.resolve());

    const mockAIService = {
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      findWorkspace: mock(() => ({ projectPath: "/tmp/proj", workspacePath: "/tmp/proj/ws" })),
      editConfig: editConfigMock,
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      // WorkspaceService subscribes to init-end events on construction.
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(
        (): InitStatus => ({
          status: "success",
          hookPath: "/tmp/proj",
          startTime: 0,
          lines: [],
          exitCode: 0,
          endTime: 1,
        })
      ),
      clearInMemoryState: mock((_workspaceId: string) => undefined),
    };
    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    // Make it obvious if archive() incorrectly chooses deletion.
    workspaceService.remove = removeMock as unknown as typeof workspaceService.remove;

    const result = await workspaceService.archive(workspaceId);
    expect(result.success).toBe(true);
    expect(editConfigMock).toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  test("list() includes isInitializing when init state is running", async () => {
    const workspaceId = "ws-list-initializing";

    const mockAIService = {
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: "/tmp/proj",
      createdAt: "2026-01-01T00:00:00.000Z",
      namedWorkspacePath: "/tmp/proj/ws",
      runtimeConfig: { type: "local" },
    };

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getAllWorkspaceMetadata: mock(() => Promise.resolve([mockMetadata])),
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };

    const mockInitStateManager: Partial<InitStateManager> = {
      // WorkspaceService subscribes to init-end events on construction.
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock((id: string): InitStatus | undefined =>
        id === workspaceId
          ? {
              status: "running",
              hookPath: "/tmp/proj",
              startTime: 0,
              lines: [],
              exitCode: null,
              endTime: null,
            }
          : undefined
      ),
    };
    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    const list = await workspaceService.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.isInitializing).toBe(true);
  });

  test("create() clears init state + emits updated metadata when skipping background init", async () => {
    const workspaceId = "ws-skip-init";
    const projectPath = "/tmp/proj";
    const branchName = "ws_branch";
    const workspacePath = "/tmp/proj/ws_branch";

    const initStates = new Map<string, InitStatus>();
    const clearInMemoryStateMock = mock((id: string) => {
      initStates.delete(id);
    });

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      startInit: mock((id: string) => {
        initStates.set(id, {
          status: "running",
          hookPath: projectPath,
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        });
      }),
      getInitState: mock((id: string) => initStates.get(id)),
      clearInMemoryState: clearInMemoryStateMock,
    };

    const configState: ProjectsConfig = { projects: new Map() };

    const mockMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: branchName,
      title: "title",
      projectName: "proj",
      projectPath,
      createdAt: "2026-01-01T00:00:00.000Z",
      namedWorkspacePath: workspacePath,
      runtimeConfig: { type: "local" },
    };

    const mockConfig: Partial<Config> = {
      rootDir: "/tmp/mux-root",
      srcDir: "/tmp/src",
      generateStableId: mock(() => workspaceId),
      editConfig: mock((editFn: (config: ProjectsConfig) => ProjectsConfig) => {
        editFn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([mockMetadata])),
      getEffectiveSecrets: mock(() => [{ key: "GH_TOKEN", value: "token" }]),
      getSessionDir: mock(() => "/tmp/test/sessions"),
      findWorkspace: mock(() => null),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [],
              trusted: true,
            },
          ],
        ]),
      })),
    };

    const mockAIService = {
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;
    const createWorkspaceMock = mock(() =>
      Promise.resolve({ success: true as const, workspacePath })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      createWorkspace: createWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    const sessionEmitter = new EventEmitter();
    const fakeSession = {
      onChatEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("chat-event", listener);
        return () => sessionEmitter.off("chat-event", listener);
      },
      onMetadataEvent: (listener: (event: unknown) => void) => {
        sessionEmitter.on("metadata-event", listener);
        return () => sessionEmitter.off("metadata-event", listener);
      },
      emitMetadata: (metadata: FrontendWorkspaceMetadata | null) => {
        sessionEmitter.emit("metadata-event", { workspaceId, metadata });
      },
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      dispose: () => {},
    } as unknown as AgentSession;

    try {
      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        historyService,
        mockAIService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      const metadataEvents: Array<FrontendWorkspaceMetadata | null> = [];
      workspaceService.on("metadata", (event: unknown) => {
        if (!event || typeof event !== "object") {
          return;
        }
        const parsed = event as { workspaceId: string; metadata: FrontendWorkspaceMetadata | null };
        if (parsed.workspaceId === workspaceId) {
          metadataEvents.push(parsed.metadata);
        }
      });

      workspaceService.registerSession(workspaceId, fakeSession);

      const removingWorkspaces = (
        workspaceService as unknown as { removingWorkspaces: Set<string> }
      ).removingWorkspaces;
      removingWorkspaces.add(workspaceId);

      const result = await workspaceService.create(projectPath, branchName, undefined, "title", {
        type: "local",
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      expect(createWorkspaceMock).toHaveBeenCalledWith(
        expect.objectContaining({ env: { GH_TOKEN: "token" } })
      );
      expect(result.data.metadata.isInitializing).toBe(undefined);
      expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);

      expect(metadataEvents).toHaveLength(2);
      expect(metadataEvents[0]?.isInitializing).toBe(true);
      expect(metadataEvents[1]?.isInitializing).toBe(undefined);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("create() auto-generates a workspace branch name when none is provided", async () => {
    // /new mirrors /fork's seamless flow: callers no longer have to invent a
    // workspace name. The backend should derive the next "workspace-N" slot
    // and persist `pendingAutoTitle` so the first message can title the workspace.
    const workspaceId = "ws-auto-named";
    const projectPath = "/tmp/proj-auto";
    const workspacePath = "/tmp/proj-auto/workspace-3";

    const initStates = new Map<string, InitStatus>();
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      startInit: mock((id: string) => {
        initStates.set(id, {
          status: "running",
          hookPath: projectPath,
          startTime: 0,
          lines: [],
          exitCode: null,
          endTime: null,
        });
      }),
      getInitState: mock((id: string) => initStates.get(id)),
      clearInMemoryState: mock((id: string) => {
        initStates.delete(id);
      }),
    };

    const configState: ProjectsConfig = { projects: new Map() };

    const mockMetadata: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "workspace-3",
      projectName: "proj-auto",
      projectPath,
      createdAt: "2026-01-01T00:00:00.000Z",
      namedWorkspacePath: workspacePath,
      runtimeConfig: { type: "local" },
      pendingAutoTitle: true,
    };

    const mockConfig: Partial<Config> = {
      rootDir: "/tmp/mux-root",
      srcDir: "/tmp/src",
      generateStableId: mock(() => workspaceId),
      editConfig: mock((editFn: (config: ProjectsConfig) => ProjectsConfig) => {
        editFn(configState);
        return Promise.resolve();
      }),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([mockMetadata])),
      getEffectiveSecrets: mock(() => []),
      getSessionDir: mock(() => "/tmp/test/sessions"),
      findWorkspace: mock(() => null),
      // Two pre-existing workspaces — auto-naming should skip past them.
      loadConfigOrDefault: mock(() => ({
        projects: new Map([
          [
            projectPath,
            {
              workspaces: [
                { id: "x", name: "workspace-1", path: "/tmp/proj-auto/workspace-1" },
                { id: "y", name: "workspace-2", path: "/tmp/proj-auto/workspace-2" },
              ],
              trusted: true,
            },
          ],
        ]),
      })),
    };

    const mockAIService = {
      isStreaming: mock(() => false),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;
    const createWorkspaceMock = mock(() =>
      Promise.resolve({ success: true as const, workspacePath })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      createWorkspace: createWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    try {
      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        historyService,
        mockAIService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      const removingWorkspaces = (
        workspaceService as unknown as { removingWorkspaces: Set<string> }
      ).removingWorkspaces;
      // Skip the background init path so the test stays focused on auto-naming/persistence.
      removingWorkspaces.add(workspaceId);

      const result = await workspaceService.create(
        projectPath,
        // No branchName — backend should auto-generate workspace-3.
        undefined,
        undefined,
        undefined,
        { type: "local" },
        undefined,
        // pendingAutoTitle: true mirrors the /fork-with-message flow.
        true
      );

      expect(result.success).toBe(true);
      if (!result.success) {
        return;
      }

      // Backend picked the next "workspace-N" slot and threaded it through to
      // both the runtime call and the persisted config entry.
      expect(createWorkspaceMock).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: "workspace-3",
          directoryName: "workspace-3",
        })
      );

      const persisted = configState.projects.get(projectPath)?.workspaces ?? [];
      const newEntry = persisted.find((entry) => entry.id === workspaceId);
      expect(newEntry?.name).toBe("workspace-3");
      expect(newEntry?.pendingAutoTitle).toBe(true);
    } finally {
      createRuntimeSpy.mockRestore();
    }
  });

  test("remove() aborts init and clears state before teardown", async () => {
    const workspaceId = "ws-remove-aborts";

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-ws-remove-"));
    try {
      const abortController = new AbortController();
      const clearInMemoryStateMock = mock((_workspaceId: string) => undefined);
      const mockInitStateManager = {
        on: mock(() => undefined as unknown as InitStateManager),
        getInitState: mock(() => undefined),
        clearInMemoryState: clearInMemoryStateMock,
      } as unknown as InitStateManager;

      const mockAIService = {
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
        getWorkspaceMetadata: mock(() => Promise.resolve({ success: false as const, error: "na" })),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        on: mock(() => {}),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        off: mock(() => {}),
      } as unknown as AIService;

      const mockConfig: Partial<Config> = {
        rootDir: path.join(tempRoot, "root"),
        srcDir: "/tmp/src",
        getSessionDir: mock((id: string) => path.join(tempRoot, id)),
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => null),
      };
      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        historyService,
        mockAIService,
        mockInitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      // Inject an in-progress init AbortController.
      const initAbortControllers = (
        workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
      ).initAbortControllers;
      initAbortControllers.set(workspaceId, abortController);

      const result = await workspaceService.remove(workspaceId, true);
      expect(result.success).toBe(true);
      expect(abortController.signal.aborted).toBe(true);
      expect(clearInMemoryStateMock).toHaveBeenCalledWith(workspaceId);

      expect(initAbortControllers.has(workspaceId)).toBe(false);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("remove() does not clear init state when runtime deletion fails with force=false", async () => {
    const workspaceId = "ws-remove-runtime-delete-fails";
    const projectPath = "/tmp/proj";

    const abortController = new AbortController();
    const clearInMemoryStateMock = mock((_workspaceId: string) => undefined);
    const mockInitStateManager = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
      clearInMemoryState: clearInMemoryStateMock,
    } as unknown as InitStateManager;
    const removeWorkspaceMock = mock(() => Promise.resolve());

    const deleteWorkspaceMock = mock(() =>
      Promise.resolve({ success: false as const, error: "dirty" })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace: deleteWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-ws-remove-fail-"));
    try {
      const mockAIService = {
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: "ws",
              projectPath,
              projectName: "proj",
              runtimeConfig: { type: "local" },
            })
          )
        ),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        on: mock(() => {}),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        off: mock(() => {}),
      } as unknown as AIService;

      const mockConfig: Partial<Config> = {
        srcDir: "/tmp/src",
        getSessionDir: mock((id: string) => path.join(tempRoot, id)),
        removeWorkspace: removeWorkspaceMock,
        findWorkspace: mock(() => null),
      };
      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        historyService,
        mockAIService,
        mockInitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      // Inject an in-progress init AbortController.
      const initAbortControllers = (
        workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
      ).initAbortControllers;
      initAbortControllers.set(workspaceId, abortController);

      const result = await workspaceService.remove(workspaceId, false);
      expect(result.success).toBe(false);
      expect(abortController.signal.aborted).toBe(true);

      // If runtime deletion fails with force=false, removal returns early and the workspace remains.
      // Keep init state intact so init-end can refresh metadata and clear isInitializing.
      expect(clearInMemoryStateMock).not.toHaveBeenCalled();
      expect(removeWorkspaceMock).not.toHaveBeenCalled();
    } finally {
      createRuntimeSpy.mockRestore();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
  test("remove() calls runtime.deleteWorkspace when force=true", async () => {
    const workspaceId = "ws-remove-runtime-delete";
    const projectPath = "/tmp/proj";

    const deleteWorkspaceMock = mock(() =>
      Promise.resolve({ success: true as const, deletedPath: "/tmp/deleted" })
    );

    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace: deleteWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);

    const tempRoot = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-ws-remove-runtime-"));
    try {
      const mockAIService = {
        isStreaming: mock(() => false),
        stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
        getWorkspaceMetadata: mock(() =>
          Promise.resolve(
            Ok({
              id: workspaceId,
              name: "ws",
              projectPath,
              projectName: "proj",
              runtimeConfig: { type: "local" },
            })
          )
        ),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        on: mock(() => {}),
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        off: mock(() => {}),
      } as unknown as AIService;

      const mockConfig: Partial<Config> = {
        rootDir: path.join(tempRoot, "root"),
        srcDir: "/tmp/src",
        getSessionDir: mock((id: string) => path.join(tempRoot, id)),
        removeWorkspace: mock(() => Promise.resolve()),
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({ projects: new Map() })),
      };
      const workspaceService = new WorkspaceService(
        mockConfig as Config,
        historyService,
        mockAIService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );

      const result = await workspaceService.remove(workspaceId, true);
      expect(result.success).toBe(true);
      // trusted defaults to false (no project config), so deleteWorkspace gets (path, name, force, undefined, false)
      expect(deleteWorkspaceMock).toHaveBeenCalledWith(projectPath, "ws", true, undefined, false);
    } finally {
      createRuntimeSpy.mockRestore();
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkspaceService regenerateTitle", () => {
  let workspaceService: WorkspaceService;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    const mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve({ success: false as const, error: "workspace metadata unavailable" })
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => ({ projectPath: "/tmp/proj", workspacePath: "/tmp/proj/ws" })),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => undefined),
    };

    workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("returns updateTitle error when persisting generated title fails", async () => {
    const workspaceId = "ws-regenerate-title";

    await historyService.appendToHistory(workspaceId, createMuxMessage("user-1", "user", "Fix CI"));

    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockResolvedValue(
      Ok({
        name: "ci-fix-a1b2",
        title: "Fix CI",
        modelUsed: "anthropic:claude-3-5-haiku-latest",
      })
    );
    const updateTitleSpy = spyOn(workspaceService, "updateTitle").mockResolvedValueOnce(
      Err("Failed to update workspace title: disk full")
    );

    try {
      const result = await workspaceService.regenerateTitle(workspaceId);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Failed to update workspace title: disk full");
      }
      expect(generateIdentitySpy).toHaveBeenCalledTimes(1);
      const call = generateIdentitySpy.mock.calls[0];
      expect(call?.[3]).toBeUndefined();
      expect(call?.[4]).toBe("Fix CI");
      expect(updateTitleSpy).toHaveBeenCalledWith(workspaceId, "Fix CI");
    } finally {
      updateTitleSpy.mockRestore();
      generateIdentitySpy.mockRestore();
    }
  });
  test("falls back to full history when latest compaction epoch has no user message", async () => {
    const workspaceId = "ws-regenerate-title-compacted";

    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("user-before-boundary", "user", "Refactor sidebar loading")
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("summary-boundary", "assistant", "Compacted summary", {
        compacted: true,
        compactionBoundary: true,
        compactionEpoch: 1,
      })
    );
    await historyService.appendToHistory(
      workspaceId,
      createMuxMessage("assistant-after-boundary", "assistant", "No new user messages yet")
    );

    const iterateSpy = spyOn(historyService, "iterateFullHistory");
    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockResolvedValue(
      Ok({
        name: "sidebar-refactor-a1b2",
        title: "Refactor sidebar loading",
        modelUsed: "anthropic:claude-3-5-haiku-latest",
      })
    );
    const updateTitleSpy = spyOn(workspaceService, "updateTitle").mockResolvedValueOnce(
      Ok(undefined)
    );

    try {
      const result = await workspaceService.regenerateTitle(workspaceId);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe("Refactor sidebar loading");
      }
      expect(iterateSpy).toHaveBeenCalledTimes(1);
      expect(generateIdentitySpy).toHaveBeenCalledTimes(1);
      const call = generateIdentitySpy.mock.calls[0];
      expect(call?.[0]).toBe("Refactor sidebar loading");
      const context = call?.[3];
      expect(typeof context).toBe("string");
      if (typeof context === "string") {
        expect(context).toContain("Refactor sidebar loading");
        expect(context).toContain("Compacted summary");
        expect(context).toContain("No new user messages yet");
        expect(context).not.toContain("omitted for brevity");
      }
      expect(call?.[4]).toBe("Refactor sidebar loading");
      expect(updateTitleSpy).toHaveBeenCalledWith(workspaceId, "Refactor sidebar loading");
    } finally {
      updateTitleSpy.mockRestore();
      generateIdentitySpy.mockRestore();
      iterateSpy.mockRestore();
    }
  });
  test("uses first user turn + latest 3 turns and flags omitted context", async () => {
    const workspaceId = "ws-regenerate-title-first-plus-last-three";

    for (let turn = 1; turn <= 12; turn++) {
      const role: "user" | "assistant" = turn % 2 === 1 ? "user" : "assistant";
      const text = `${role === "user" ? "User" : "Assistant"} turn ${turn}`;
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage(`${role}-${turn}`, role, text)
      );
    }

    const generateIdentitySpy = spyOn(
      workspaceTitleGenerator,
      "generateWorkspaceIdentity"
    ).mockResolvedValue(
      Ok({
        name: "title-refresh-a1b2",
        title: "User turn 1",
        modelUsed: "anthropic:claude-3-5-haiku-latest",
      })
    );
    const updateTitleSpy = spyOn(workspaceService, "updateTitle").mockResolvedValueOnce(
      Ok(undefined)
    );

    try {
      const result = await workspaceService.regenerateTitle(workspaceId);

      expect(result.success).toBe(true);
      expect(generateIdentitySpy).toHaveBeenCalledTimes(1);
      const call = generateIdentitySpy.mock.calls[0];
      expect(call?.[0]).toBe("User turn 1");
      const context = call?.[3];
      expect(typeof context).toBe("string");
      expect(call?.[4]).toBe("User turn 11");
      expect(updateTitleSpy).toHaveBeenCalledWith(workspaceId, "User turn 1");
    } finally {
      updateTitleSpy.mockRestore();
      generateIdentitySpy.mockRestore();
    }
  });
});

describe("WorkspaceService fork", () => {
  let config: Config;
  let tempDir: string;
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({
      config,
      tempDir,
      historyService,
      cleanup: cleanupHistory,
    } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("cleans up init state when orchestrateFork rejects", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = "/tmp/project";

    const mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() =>
        Promise.resolve(
          Ok({
            id: sourceWorkspaceId,
            name: "source-branch",
            projectPath: sourceProjectPath,
            projectName: "project",
            runtimeConfig: { type: "local" },
          })
        )
      ),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const startInitMock = mock(() => undefined);
    const endInitMock = mock(() => Promise.resolve());
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: startInitMock,
      endInit: endInitMock,
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/src",
      generateStableId: mock(() => newWorkspaceId),
      findWorkspace: mock(() => null),
      getSessionDir: mock(() => "/tmp/test/sessions"),
      getEffectiveSecrets: mock(() => []),
      loadConfigOrDefault: mock(() => ({
        projects: new Map([[sourceProjectPath, { workspaces: [], trusted: true }]]),
      })),
    };

    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockImplementation(
      () => Promise.reject(new Error("runtime explosion"))
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, "fork-child");

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Failed to fork workspace: runtime explosion");
      }

      expect(startInitMock).toHaveBeenCalledWith(newWorkspaceId, sourceProjectPath);
      expect(endInitMock).toHaveBeenCalledWith(newWorkspaceId, -1);

      const initAbortControllers = (
        workspaceService as unknown as { initAbortControllers: Map<string, AbortController> }
      ).initAbortControllers;
      expect(initAbortControllers.has(newWorkspaceId)).toBe(false);
    } finally {
      orchestrateForkSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
    }
  });
  test("fork inherits a paused goal snapshot with fresh accounting", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const forkedWorkspacePath = path.join(sourceProjectPath, "fork-child");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch"),
    };

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    const goalService = new WorkspaceGoalService(config, historyService, extensionMetadata);
    const parentGoal = await setWorkspaceGoalOk(goalService, {
      workspaceId: sourceWorkspaceId,
      objective: "Keep fork goal",
      budgetCents: 500,
      turnCap: 8,
    });
    await goalService.recordStreamAccounting({
      workspaceId: sourceWorkspaceId,
      costUsd: 1,
      streamOriginKind: "goal_continuation",
    });

    const mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      extensionMetadata,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
    workspaceService.setWorkspaceGoalService(goalService);

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, "fork-child");

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }

      const forkGoal = await goalService.getGoal(newWorkspaceId);
      expect(forkGoal).toMatchObject({
        objective: "Keep fork goal",
        budgetCents: 500,
        turnCap: 8,
        status: "paused",
        costCents: 0,
        turnsUsed: 0,
        attributedChildren: [],
      });
      expect(forkGoal?.goalId).not.toBe(parentGoal.goalId);
      expect(await goalService.getGoal(sourceWorkspaceId)).toMatchObject({
        goalId: parentGoal.goalId,
        status: "active",
        costCents: 100,
        turnsUsed: 1,
      });
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });

  test("resets forked session usage while preserving copied history", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch"),
    };

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    // Seed source history with assistant usage so the source cost ledger is non-empty
    // before we fork. The fork should keep this history but not inherit its costs.
    await historyService.appendToHistory(
      sourceWorkspaceId,
      createMuxMessage("assistant-1", "assistant", "Hello", {
        model: "claude-sonnet-4-20250514",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      })
    );

    const sessionUsageService = new SessionUsageService(config, historyService);
    const sourceUsage = await sessionUsageService.getSessionUsage(sourceWorkspaceId);
    expect(sourceUsage?.byModel["claude-sonnet-4-20250514"]?.input.tokens).toBe(100);

    const mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager,
      sessionUsageService
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => path.join(sourceProjectPath, "fork-child")),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: path.join(sourceProjectPath, "fork-child"),
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, "fork-child");
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }
      expect(result.data.metadata.forkFamilyBaseName).toBeUndefined();

      const forkedUsage = await sessionUsageService.getSessionUsage(newWorkspaceId);
      expect(forkedUsage).toEqual({ byModel: {}, version: 1 });

      const forkedMessages: string[] = [];
      const historyResult = await historyService.iterateFullHistory(
        newWorkspaceId,
        "forward",
        (chunk) => {
          forkedMessages.push(...chunk.map((message) => message.id));
        }
      );
      expect(historyResult.success).toBe(true);
      expect(forkedMessages).toContain("assistant-1");
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });
  test("fork snapshots persisted partials without mutating the source workspace", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const forkedWorkspacePath = path.join(sourceProjectPath, "fork-child");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch"),
    };

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const sourcePartial = createMuxMessage(
      "assistant-partial",
      "assistant",
      "Waiting on task_await",
      { historySequence: 1 }
    );
    const writePartialResult = await historyService.writePartial(sourceWorkspaceId, sourcePartial);
    expect(writePartialResult.success).toBe(true);

    const mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, "fork-child");
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }

      const sourcePartialAfterFork = await historyService.readPartial(sourceWorkspaceId);
      expect(sourcePartialAfterFork?.id).toBe(sourcePartial.id);
      expect(await historyService.readPartial(newWorkspaceId)).toBeNull();

      const forkedMessageIds: string[] = [];
      const historyResult = await historyService.iterateFullHistory(
        newWorkspaceId,
        "forward",
        (chunk) => {
          forkedMessageIds.push(...chunk.map((message) => message.id));
        }
      );
      expect(historyResult.success).toBe(true);
      expect(forkedMessageIds).toContain(sourcePartial.id);
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });

  test("auto-generated fork names normalize legacy fork families before the validation fallback", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "Feature-fork-2",
      title: "Feature branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "Feature-fork-2"),
    };
    const forkedWorkspacePath = path.join(sourceProjectPath, "feature-1");

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId);

      expect(orchestrateForkSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceWorkspaceName: sourceMetadata.name,
          newWorkspaceName: "feature-1",
        })
      );

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }

      expect(result.data.metadata.name).toBe("feature-1");
      expect(result.data.metadata.forkFamilyBaseName).toBe("Feature");
      expect(result.data.metadata.namedWorkspacePath).toBe(forkedWorkspacePath);
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });

  test("auto-generated fork names increment existing fork suffixes instead of nesting them", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch-2",
      title: "Source branch (2)",
      forkFamilyBaseName: "source-branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch-2"),
    };
    const forkedWorkspacePath = path.join(sourceProjectPath, "source-branch-3");

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId);

      expect(orchestrateForkSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceWorkspaceName: sourceMetadata.name,
          newWorkspaceName: "source-branch-3",
        })
      );

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }

      expect(result.data.metadata.name).toBe("source-branch-3");
      expect(result.data.metadata.title).toBe("Source branch (3)");
      expect(result.data.metadata.forkFamilyBaseName).toBe("source-branch");
      expect(result.data.metadata.namedWorkspacePath).toBe(forkedWorkspacePath);
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });
  test("fork marks the new workspace as pending auto-title when a continue message is queued", async () => {
    const sourceWorkspaceId = "source-workspace";
    const newWorkspaceId = "forked-workspace";
    const sourceProjectPath = path.join(tempDir, "project");
    const sourceMetadata: FrontendWorkspaceMetadata = {
      id: sourceWorkspaceId,
      name: "source-branch",
      title: "Source branch",
      projectPath: sourceProjectPath,
      projectName: "project",
      runtimeConfig: { type: "local" },
      namedWorkspacePath: path.join(sourceProjectPath, "source-branch"),
    };
    const forkedWorkspacePath = path.join(sourceProjectPath, "source-branch-1");

    await fsPromises.mkdir(sourceProjectPath, { recursive: true });
    await config.addWorkspace(sourceProjectPath, sourceMetadata);
    await config.editConfig((current) => {
      const project = current.projects.get(sourceProjectPath);
      if (!project) {
        throw new Error("Expected test project config to exist");
      }
      project.trusted = true;
      return current;
    });

    const mockAIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve(Ok(sourceMetadata))),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => ({ status: "running" }) as unknown as InitStatus),
      startInit: mock(() => undefined),
      endInit: mock(() => Promise.resolve()),
      appendOutput: mock(() => undefined),
      enterHookPhase: mock(() => undefined),
    };

    const workspaceService = new WorkspaceService(
      config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );

    const targetRuntime = {
      getWorkspacePath: mock(() => forkedWorkspacePath),
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>;

    const generateStableIdSpy = spyOn(config, "generateStableId").mockReturnValue(newWorkspaceId);
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue({
      emitMetadata: mock(() => undefined),
    } as unknown as AgentSession);
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue(
      {} as ReturnType<typeof runtimeFactory.createRuntime>
    );
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const copyPlanSpy = spyOn(runtimeExecHelpers, "copyPlanFileAcrossRuntimes").mockResolvedValue(
      undefined
    );
    const orchestrateForkSpy = spyOn(forkOrchestratorModule, "orchestrateFork").mockResolvedValue(
      Ok({
        workspacePath: forkedWorkspacePath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      })
    );

    try {
      const result = await workspaceService.fork(sourceWorkspaceId, undefined, undefined, true);

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Expected success result, got error: ${result.error}`);
      }

      expect(result.data.metadata.pendingAutoTitle).toBe(true);
      const persistedMetadata = (await config.getAllWorkspaceMetadata()).find(
        (metadata) => metadata.id === newWorkspaceId
      );
      expect(persistedMetadata?.pendingAutoTitle).toBe(true);
    } finally {
      orchestrateForkSpy.mockRestore();
      copyPlanSpy.mockRestore();
      runBackgroundInitSpy.mockRestore();
      createRuntimeSpy.mockRestore();
      getOrCreateSessionSpy.mockRestore();
      generateStableIdSpy.mockRestore();
    }
  });
});

describe("WorkspaceService interruptStream", () => {
  let historyService: HistoryService;
  let cleanupHistory: () => Promise<void>;

  beforeEach(async () => {
    ({ historyService, cleanup: cleanupHistory } = await createTestHistoryService());
  });

  afterEach(async () => {
    await cleanupHistory();
  });

  test("sendQueuedImmediately clears hard-interrupt suppression before queued resend", async () => {
    const workspaceId = "ws-interrupt-queue-111";

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      findWorkspace: mock(() => null),
    };

    const mockAIService: AIService = {
      isStreaming: mock(() => false),
      getWorkspaceMetadata: mock(() => Promise.resolve({ success: false, error: "not found" })),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      on: mock(() => {}),
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      off: mock(() => {}),
    } as unknown as AIService;

    const workspaceService = createWorkspaceServiceForTest({
      config: mockConfig,
      historyService,
      aiService: mockAIService,
      initStateManager: mockInitStateManager as InitStateManager,
    });

    const resetAutoResumeCount = mock(() => undefined);
    const markParentWorkspaceInterrupted = mock(() => undefined);
    const terminateAllDescendantAgentTasks = mock(() => Promise.resolve([] as string[]));
    workspaceService.setTaskService({
      resetAutoResumeCount,
      markParentWorkspaceInterrupted,
      terminateAllDescendantAgentTasks,
    } as unknown as TaskService);

    const sendNextUserQueuedMessage = mock(() => true);
    const restoreQueueToInput = mock(() => undefined);
    const interruptStream = mock(() => Promise.resolve(Ok(undefined)));
    const fakeSession = {
      interruptStream,
      sendNextUserQueuedMessage,
      restoreQueueToInput,
    };
    const getOrCreateSessionSpy = spyOn(workspaceService, "getOrCreateSession").mockReturnValue(
      fakeSession as unknown as AgentSession
    );

    try {
      const result = await workspaceService.interruptStream(workspaceId, {
        sendQueuedImmediately: true,
      });

      expect(result.success).toBe(true);
      expect(markParentWorkspaceInterrupted).toHaveBeenCalledWith(workspaceId);
      expect(terminateAllDescendantAgentTasks).toHaveBeenCalledWith(workspaceId);
      expect(resetAutoResumeCount).toHaveBeenCalledTimes(2);
      expect(sendNextUserQueuedMessage).toHaveBeenCalledTimes(1);
      expect(restoreQueueToInput).not.toHaveBeenCalled();
    } finally {
      getOrCreateSessionSpy.mockRestore();
    }
  });
});

// --- Pure helper tests (no mocks needed) ---

describe("generateForkBranchName", () => {
  test("returns -1 when no existing forks", () => {
    expect(generateForkBranchName("sidebar-a1b2", [])).toBe("sidebar-a1b2-1");
  });

  test("increments past the highest existing fork number", () => {
    expect(
      generateForkBranchName("sidebar-a1b2", [
        "sidebar-a1b2-1",
        "sidebar-a1b2-3",
        "other-workspace",
      ])
    ).toBe("sidebar-a1b2-4");
  });

  test("continues numbering for generated forks when given the stable family base name", () => {
    expect(generateForkBranchName("ws", ["ws-1", "ws-2"])).toBe("ws-3");
  });

  test("preserves numeric suffixes for non-fork names", () => {
    expect(generateForkBranchName("release-2024", ["release-1"])).toBe("release-2024-1");
  });

  test("continues numbering across legacy and new fork name patterns", () => {
    expect(generateForkBranchName("ws", ["ws-fork-1", "ws-2", "ws-fork-3"])).toBe("ws-4");
  });

  test("ignores non-matching workspace names", () => {
    expect(generateForkBranchName("feature", ["feature-branch", "feature-impl", "other-1"])).toBe(
      "feature-1"
    );
  });

  test("handles gaps in numbering", () => {
    expect(generateForkBranchName("ws", ["ws-1", "ws-5"])).toBe("ws-6");
  });

  test("ignores non-numeric suffixes", () => {
    expect(generateForkBranchName("ws", ["ws-abc", "ws-fork-"])).toBe("ws-1");
  });

  test("ignores partially numeric suffixes", () => {
    expect(generateForkBranchName("ws", ["ws-1abc", "ws-fork-02x", "ws-3"])).toBe("ws-4");
  });
});

describe("generateForkTitle", () => {
  test("returns (1) when no existing forks", () => {
    expect(generateForkTitle("Fix sidebar layout", [])).toBe("Fix sidebar layout (1)");
  });

  test("increments past the highest existing suffix", () => {
    expect(
      generateForkTitle("Fix sidebar layout", [
        "Fix sidebar layout",
        "Fix sidebar layout (1)",
        "Fix sidebar layout (3)",
      ])
    ).toBe("Fix sidebar layout (4)");
  });

  test("strips existing suffix from parent before computing base", () => {
    // Forking "Fix sidebar (2)" should produce "Fix sidebar (3)", not "Fix sidebar (2) (1)"
    expect(generateForkTitle("Fix sidebar (2)", ["Fix sidebar (1)", "Fix sidebar (2)"])).toBe(
      "Fix sidebar (3)"
    );
  });

  test("ignores non-matching titles", () => {
    expect(generateForkTitle("Refactor auth", ["Fix sidebar layout (1)", "Other task (2)"])).toBe(
      "Refactor auth (1)"
    );
  });

  test("handles gaps in numbering", () => {
    expect(generateForkTitle("Task", ["Task (1)", "Task (5)"])).toBe("Task (6)");
  });

  test("ignores non-numeric suffixes when selecting the next title number", () => {
    expect(generateForkTitle("Task", ["Task (2025 roadmap)", "Task (12abc)", "Task (2)"])).toBe(
      "Task (3)"
    );
  });
});

// Regression: persisted completed init state must not defer goal continuations as initializing.
describe("WorkspaceService.getGoalContinuationRuntimeState", () => {
  async function makeService(initState: InitStatus | undefined): Promise<WorkspaceService> {
    const mockAIService = {
      isStreaming: mock(() => false),
      on: mock(() => undefined),
      off: mock(() => undefined),
    } as unknown as AIService;

    const mockConfig: Partial<Config> = {
      srcDir: "/tmp/test",
      findWorkspace: mock(() => ({ projectPath: "/tmp/proj", workspacePath: "/tmp/proj/ws" })),
      getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
      getSessionDir: mock(() => "/tmp/test/sessions"),
      generateStableId: mock(() => "test-id"),
      loadConfigOrDefault: mock(() => ({ projects: new Map() })),
    };
    const mockInitStateManager: Partial<InitStateManager> = {
      on: mock(() => undefined as unknown as InitStateManager),
      getInitState: mock(() => initState),
    };
    const mockExtensionMetadataService = {};
    const mockBackgroundProcessManager = {};
    const { historyService } = await createTestHistoryService();
    return new WorkspaceService(
      mockConfig as Config,
      historyService,
      mockAIService,
      mockInitStateManager as InitStateManager,
      mockExtensionMetadataService as ExtensionMetadataService,
      mockBackgroundProcessManager as BackgroundProcessManager
    );
  }

  test("isInitializing is false when init has finished successfully", async () => {
    const service = await makeService({
      status: "success",
      hookPath: "/tmp/proj",
      startTime: 0,
      lines: [],
      exitCode: 0,
      endTime: 1,
    });
    expect(service.getGoalContinuationRuntimeState("ws-1").isInitializing).toBe(false);
  });

  test("isInitializing is false when no init state has ever existed", async () => {
    const service = await makeService(undefined);
    expect(service.getGoalContinuationRuntimeState("ws-1").isInitializing).toBe(false);
  });

  test("isInitializing is true only while init is actively running", async () => {
    const service = await makeService({
      status: "running",
      hookPath: "/tmp/proj",
      startTime: 0,
      lines: [],
      exitCode: null,
      endTime: null,
    });
    expect(service.getGoalContinuationRuntimeState("ws-1").isInitializing).toBe(true);
  });

  test("kickoff continuation fires on a freshly-init'd workspace", async () => {
    const workspaceId = "kickoff-after-init";
    const service = await makeService({
      status: "success",
      hookPath: "/tmp/proj",
      startTime: 0,
      lines: [],
      exitCode: 0,
      endTime: 1,
    });

    const { historyService, config, cleanup } = await createTestHistoryService();
    try {
      await config.addWorkspace("/tmp/kickoff-proj", {
        id: workspaceId,
        name: workspaceId,
        projectName: "kickoff-proj",
        projectPath: "/tmp/kickoff-proj",
        runtimeConfig: { type: "local" },
      });
      const extensionMetadata = new ExtensionMetadataService(
        `${config.rootDir}/kickoff-extension-metadata.json`
      );
      const goalService = new WorkspaceGoalService(config, historyService, extensionMetadata);

      const dispatcher = new IdleDispatcher();
      const execute = mock(() => Promise.resolve(true));
      goalService.registerGoalContinuationConsumer(dispatcher, {
        hasActiveDescendantTasks: () => false,
        getRuntimeState: (id) => service.getGoalContinuationRuntimeState(id),
        executeGoalContinuation: execute,
        getKickoffSendOptions: () => Promise.resolve({ model: "openai:gpt-4o", agentId: "exec" }),
      });

      const result = await goalService.setGoal({ workspaceId, objective: "Ship the kickoff fix" });
      expect(result.success).toBe(true);

      // Wait for the kickoff continuation dispatch via the shared
      // `waitForCondition` helper instead of an inline `Date.now()` loop —
      // the dispatcher worker is microtask + setTimeout-driven so we poll
      // until it lands (Coder-agents-review nit DEREM-50).
      await waitForCondition(() => execute.mock.calls.length > 0, { timeoutMs: 1_000 });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }));
    } finally {
      await cleanup();
    }
  });

  // --------------------------------------------------------------------------
  // getGoalContinuationKickoffSendOptions — model-resolution cascade
  // --------------------------------------------------------------------------

  describe("model-resolution cascade", () => {
    async function makeServiceWithConfig(
      configOverrides: Partial<Config>
    ): Promise<WorkspaceService> {
      const mockAIService = {
        isStreaming: mock(() => false),
        on: mock(() => undefined),
        off: mock(() => undefined),
      } as unknown as AIService;
      const mockInitStateManager: Partial<InitStateManager> = {
        on: mock(() => undefined as unknown as InitStateManager),
        getInitState: mock(() => undefined),
      };
      const mockConfig: Partial<Config> = {
        srcDir: "/tmp/test",
        getAllWorkspaceMetadata: mock(() => Promise.resolve([])),
        getSessionDir: mock(() => "/tmp/test/sessions"),
        generateStableId: mock(() => "test-id"),
        ...configOverrides,
      };
      const { historyService } = await createTestHistoryService();
      const mockExtensionMetadataService = {};
      const mockBackgroundProcessManager = {};
      return new WorkspaceService(
        mockConfig as Config,
        historyService,
        mockAIService,
        mockInitStateManager as InitStateManager,
        mockExtensionMetadataService as ExtensionMetadataService,
        mockBackgroundProcessManager as BackgroundProcessManager
      );
    }

    test("returns null when the workspace is not found in config", async () => {
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => null),
        loadConfigOrDefault: mock(() => ({ projects: new Map() })),
      });
      expect(await service.getGoalContinuationKickoffSendOptions("ws-unknown")).toBeNull();
    });

    test("prefers per-workspace agent model over workspace default and globals", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                aiSettingsByAgent: {
                  exec: { model: "anthropic:claude-haiku-4-5", thinkingLevel: "off" as const },
                },
                aiSettings: { model: "openai:gpt-4o", thinkingLevel: "off" as const },
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({
          projects,
          agentAiDefaults: { exec: { modelString: "google:gemini-2.5-pro" } },
        })),
      });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toContain("haiku");
      expect(result?.agentId).toBe("exec");
    });

    test("uses the persisted selected agent for initial goal kickoff options", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-selected-agent";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                agentId: "review",
                aiSettingsByAgent: {
                  review: { model: "anthropic:claude-sonnet-4-6", thinkingLevel: "off" as const },
                  exec: { model: "openai:gpt-4o", thinkingLevel: "off" as const },
                },
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({ projects })),
      });

      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);

      expect(result).toEqual({
        model: "anthropic:claude-sonnet-4-6",
        agentId: "review",
        thinkingLevel: "off",
        // The bucket owns the reasoning choice; absent resolves to explicit standard.
        reasoningMode: "standard",
      });
    });

    test("carries the persisted thinking level with the winning model candidate", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-thinking";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                aiSettingsByAgent: {
                  exec: { model: "anthropic:claude-fable-5", thinkingLevel: "medium" as const },
                },
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({ projects })),
      });

      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);

      // Regression: continuations previously dropped the persisted thinking
      // level, streaming with an implicit "off" that Fable/Mythos-class
      // Anthropic models reject ("thinking.type.disabled" unsupported).
      expect(result).toEqual({
        model: "anthropic:claude-fable-5",
        agentId: "exec",
        thinkingLevel: "medium",
        reasoningMode: "standard",
      });
    });

    test("falls back to exec when the selected agent cannot run goal continuations", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-plan-agent";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                agentId: "plan",
                aiSettingsByAgent: {
                  plan: { model: "anthropic:claude-sonnet-4-6", thinkingLevel: "off" as const },
                  exec: { model: "openai:gpt-4o", thinkingLevel: "off" as const },
                },
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({ projects })),
      });

      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);

      expect(result).toEqual({
        model: "openai:gpt-4o",
        agentId: "exec",
        thinkingLevel: "off",
        reasoningMode: "standard",
      });
    });

    test("falls through to workspace default model when per-agent is missing", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                aiSettings: { model: "openai:gpt-4o", thinkingLevel: "off" as const },
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({ projects })),
      });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toBe("openai:gpt-4o");
    });

    test("falls through to global agent default when workspace has no model", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [projectPath, { workspaces: [{ id: workspaceId, path: "/tmp/proj/ws" }] }],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({
          projects,
          agentAiDefaults: { exec: { modelString: "anthropic:claude-sonnet-4-6" } },
        })),
      });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toContain("sonnet");
    });

    test("model-less reasoning-only agent default still contributes its fields", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [projectPath, { workspaces: [{ id: workspaceId, path: "/tmp/proj/ws" }] }],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({
          projects,
          // "Inherit" model in settings persists entries with only thinking
          // fields; the model must fall through while these fields apply.
          agentAiDefaults: {
            exec: { thinkingLevel: "high" as const, reasoningMode: "pro" as const },
          },
        })),
      });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toBeTruthy();
      expect(result?.thinkingLevel).toBe("high");
      expect(result?.reasoningMode).toBe("pro");
    });

    test("resolves defaults through the selected agent's declared base chain", async () => {
      // A custom agent declaring base: plan must inherit Plan's configured
      // defaults, not fall through to the Exec approximation (mirrors
      // Settings/ACP/task-spawn resolution).
      const projectPath = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-goal-chain-"));
      try {
        const agentsDir = path.join(projectPath, ".mux", "agents");
        await fsPromises.mkdir(agentsDir, { recursive: true });
        await fsPromises.writeFile(
          path.join(agentsDir, "researcher.md"),
          `---\nname: Researcher\ndescription: Plan-derived custom agent for tests\nbase: plan\nsubagent:\n  runnable: true\n---\n\nTest agent body.\n`,
          "utf-8"
        );

        const workspaceId = "ws-1";
        const projects = new Map([
          [
            projectPath,
            { workspaces: [{ id: workspaceId, path: projectPath, agentId: "researcher" }] },
          ],
        ]);
        const service = await makeServiceWithConfig({
          findWorkspace: mock(() => ({ projectPath, workspacePath: projectPath })),
          loadConfigOrDefault: mock(() => ({
            projects,
            agentAiDefaults: {
              plan: { thinkingLevel: "high" as const, reasoningMode: "pro" as const },
              exec: { thinkingLevel: "low" as const, reasoningMode: "standard" as const },
            },
          })),
        });
        // In-place metadata (projectPath === name) resolves the checkout root
        // to the fixture directory holding .mux/agents/researcher.md.
        spyOn(service, "getInfo").mockResolvedValue({
          id: workspaceId,
          name: projectPath,
          projectPath,
          projectName: "goal-chain",
          runtimeConfig: { type: "local" },
        } as FrontendWorkspaceMetadata);

        const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
        expect(result?.thinkingLevel).toBe("high");
        expect(result?.reasoningMode).toBe("pro");
      } finally {
        await fsPromises.rm(projectPath, { recursive: true, force: true });
      }
    });

    test("a project-scoped exec override with base: plan inherits Plan's defaults", async () => {
      // Every agent's declaration must be inspected, including one named
      // "exec": a project exec.md with base: plan must resolve Plan's pro
      // default, matching ACP/task/desktop resolution.
      const projectPath = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-exec-chain-"));
      try {
        const agentsDir = path.join(projectPath, ".mux", "agents");
        await fsPromises.mkdir(agentsDir, { recursive: true });
        await fsPromises.writeFile(
          path.join(agentsDir, "exec.md"),
          `---\nname: Exec\ndescription: Project exec override for tests\nbase: plan\n---\n\nTest agent body.\n`,
          "utf-8"
        );

        const workspaceId = "ws-1";
        const projects = new Map([
          [projectPath, { workspaces: [{ id: workspaceId, path: projectPath, agentId: "exec" }] }],
        ]);
        const service = await makeServiceWithConfig({
          findWorkspace: mock(() => ({ projectPath, workspacePath: projectPath })),
          loadConfigOrDefault: mock(() => ({
            projects,
            agentAiDefaults: {
              plan: { reasoningMode: "pro" as const },
            },
          })),
        });
        spyOn(service, "getInfo").mockResolvedValue({
          id: workspaceId,
          name: projectPath,
          projectPath,
          projectName: "exec-chain",
          runtimeConfig: { type: "local" },
        } as FrontendWorkspaceMetadata);

        const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
        expect(result?.reasoningMode).toBe("pro");
      } finally {
        await fsPromises.rm(projectPath, { recursive: true, force: true });
      }
    });

    test("idle compaction inherits reasoning through compact's configured base chain", async () => {
      // Same class as the /compact frontend fix: exec's configured pro must
      // reach backend compaction even with no workspace-level overrides.
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [projectPath, { workspaces: [{ id: workspaceId, path: "/tmp/proj/ws" }] }],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({
          projects,
          agentAiDefaults: {
            exec: { reasoningMode: "pro" as const },
          },
        })),
      });
      (
        service as unknown as {
          extensionMetadata: { getSnapshot: (id: string) => Promise<undefined> };
        }
      ).extensionMetadata = { getSnapshot: () => Promise.resolve(undefined) };

      const result = await (
        service as unknown as {
          buildIdleCompactionSendOptions(id: string): Promise<{ reasoningMode?: string }>;
        }
      ).buildIdleCompactionSendOptions(workspaceId);
      expect(result.reasoningMode).toBe("pro");
    });

    test("heartbeat reasoning resolves through the selected agent's declared base chain", async () => {
      // Same parity requirement as goal kickoffs: a base: plan custom agent
      // must inherit Plan's configured Pro default, not the Exec fallback.
      const projectPath = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-hb-chain-"));
      try {
        const agentsDir = path.join(projectPath, ".mux", "agents");
        await fsPromises.mkdir(agentsDir, { recursive: true });
        await fsPromises.writeFile(
          path.join(agentsDir, "researcher.md"),
          `---\nname: Researcher\ndescription: Plan-derived custom agent for tests\nbase: plan\nsubagent:\n  runnable: true\n---\n\nTest agent body.\n`,
          "utf-8"
        );

        const workspaceId = "ws-1";
        const projects = new Map([
          [
            projectPath,
            { workspaces: [{ id: workspaceId, path: projectPath, agentId: "researcher" }] },
          ],
        ]);
        const service = await makeServiceWithConfig({
          findWorkspace: mock(() => ({ projectPath, workspacePath: projectPath })),
          loadConfigOrDefault: mock(() => ({
            projects,
            agentAiDefaults: {
              plan: {
                modelString: "openai:gpt-5.6-sol",
                thinkingLevel: "high" as const,
                reasoningMode: "pro" as const,
              },
              exec: {
                modelString: "anthropic:claude-sonnet-4-6",
                thinkingLevel: "low" as const,
                reasoningMode: "standard" as const,
              },
            },
          })),
        });
        (
          service as unknown as {
            extensionMetadata: { getSnapshot: (id: string) => Promise<undefined> };
          }
        ).extensionMetadata = { getSnapshot: () => Promise.resolve(undefined) };
        spyOn(service, "getInfo").mockResolvedValue({
          id: workspaceId,
          name: projectPath,
          projectPath,
          projectName: "hb-chain",
          runtimeConfig: { type: "local" },
        } as FrontendWorkspaceMetadata);

        // Model, thinking, and reasoning must ALL resolve through the chain:
        // inheriting pro beside exec's Anthropic model would gate pro out.
        const result = await (
          service as unknown as {
            buildHeartbeatSendOptions(id: string): Promise<{
              sendOptions: { model: string; thinkingLevel?: string; reasoningMode?: string };
            }>;
          }
        ).buildHeartbeatSendOptions(workspaceId);
        expect(result.sendOptions.model).toBe("openai:gpt-5.6-sol");
        expect(result.sendOptions.thinkingLevel).toBe("high");
        expect(result.sendOptions.reasoningMode).toBe("pro");
      } finally {
        await fsPromises.rm(projectPath, { recursive: true, force: true });
      }
    });

    test("falls through to DEFAULT_MODEL as the final fallback", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [projectPath, { workspaces: [{ id: workspaceId, path: "/tmp/proj/ws" }] }],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({ projects })),
      });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toBeTruthy();
      expect(result?.agentId).toBe("exec");
    });

    test("skips invalid candidate strings and tries the next fallback", async () => {
      const projectPath = "/tmp/proj";
      const workspaceId = "ws-1";
      const projects = new Map([
        [
          projectPath,
          {
            workspaces: [
              {
                id: workspaceId,
                path: "/tmp/proj/ws",
                aiSettings: { model: "   ", thinkingLevel: "off" as const }, // whitespace-only -> skipped
              },
            ],
          },
        ],
      ]);
      const service = await makeServiceWithConfig({
        findWorkspace: mock(() => ({ projectPath, workspacePath: "/tmp/proj/ws" })),
        loadConfigOrDefault: mock(() => ({
          projects,
          agentAiDefaults: { exec: { modelString: "openai:gpt-4o" } },
        })),
      });
      const result = await service.getGoalContinuationKickoffSendOptions(workspaceId);
      expect(result?.model).toBe("openai:gpt-4o");
    });
  });
});

describe("WorkspaceService.getLastUserPrompt", () => {
  async function withService(
    seed: (historyService: HistoryService, workspaceId: string) => Promise<void>
  ): Promise<string | null> {
    const { config, historyService, cleanup } = await createTestHistoryService();
    const workspaceId = "last-user-prompt";
    try {
      await seed(historyService, workspaceId);
      const workspaceService = createWorkspaceServiceForTest({ config, historyService });
      const result = await workspaceService.getLastUserPrompt(workspaceId);
      return result?.text ?? null;
    } finally {
      await cleanup();
    }
  }

  test("returns a typed prompt that predates the latest compaction boundary", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "the prompt before compaction", { historySequence: 1 })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("summary", "assistant", "Compacted summary", {
          historySequence: 2,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 1,
        })
      );
    });

    expect(prompt).toBe("the prompt before compaction");
  });

  test("skips synthetic and empty user turns", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "typed by the user", { historySequence: 1 })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u2", "user", "   ", { historySequence: 2 })
      );
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u3", "user", "injected turn", { historySequence: 3, synthetic: true })
      );
    });

    expect(prompt).toBe("typed by the user");
  });

  test("returns null when the workspace has no typed prompt", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("a1", "assistant", "hello", { historySequence: 1 })
      );
    });

    expect(prompt).toBeNull();
  });

  test("prefers the raw slash command over its expanded provider text", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      const message = createMuxMessage("u1", "user", "Expanded skill body sent to the model", {
        historySequence: 1,
      });
      await historyService.appendToHistory(workspaceId, {
        ...message,
        metadata: { ...message.metadata, muxMetadata: { rawCommand: "/compact" } },
      } as typeof message);
    });

    expect(prompt).toBe("/compact");
  });

  test("reconstructs a compaction command's follow-up text", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      const message = createMuxMessage("u1", "user", "Expanded compaction instructions", {
        historySequence: 1,
      });
      await historyService.appendToHistory(workspaceId, {
        ...message,
        metadata: {
          ...message.metadata,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: { followUpContent: { text: "then rerun the failing test" } },
          },
        },
      } as typeof message);
    });

    expect(prompt).toBe("/compact\nthen rerun the failing test");
  });

  test("keeps the bare compaction command when the follow-up is the resume sentinel", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      const message = createMuxMessage("u1", "user", "Expanded compaction instructions", {
        historySequence: 1,
      });
      await historyService.appendToHistory(workspaceId, {
        ...message,
        metadata: {
          ...message.metadata,
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: { followUpContent: { text: "Continue" } },
          },
        },
      } as typeof message);
    });

    expect(prompt).toBe("/compact");
  });

  test("keeps scanning past a staged-attachment notice", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "summarize the attached data", { historySequence: 1 })
      );
      const notice = buildStagedAttachmentNotice([
        {
          kind: "staged",
          id: "csv-1",
          filename: "data.csv",
          mediaType: "text/csv",
          sizeBytes: 34,
          stagedPath: ".mux/user-attachments/id/data.csv",
        },
      ]);
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u2", "user", notice.trimStart(), { historySequence: 2 })
      );
    });

    expect(prompt).toBe("summarize the attached data");
  });

  test("survives a compaction row whose parsed metadata is missing", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      const message = createMuxMessage("u1", "user", "Expanded compaction instructions", {
        historySequence: 1,
      });
      await historyService.appendToHistory(workspaceId, {
        ...message,
        metadata: {
          ...message.metadata,
          muxMetadata: { type: "compaction-request", rawCommand: "/compact" },
        },
      } as unknown as typeof message);
    });

    expect(prompt).toBe("/compact");
  });

  test("keeps scanning past a user row with primitive muxMetadata", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "the older valid prompt", { historySequence: 1 })
      );
      const broken = createMuxMessage("u2", "user", "   ", { historySequence: 2 });
      await historyService.appendToHistory(workspaceId, {
        ...broken,
        metadata: { ...broken.metadata, muxMetadata: "corrupted" },
      } as unknown as typeof broken);
    });

    expect(prompt).toBe("the older valid prompt");
  });

  test("keeps scanning past a user row with malformed parts", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      await historyService.appendToHistory(
        workspaceId,
        createMuxMessage("u1", "user", "the older valid prompt", { historySequence: 1 })
      );
      const broken = createMuxMessage("u2", "user", "ignored", { historySequence: 2 });
      await historyService.appendToHistory(workspaceId, {
        ...broken,
        parts: undefined,
      } as unknown as typeof broken);
    });

    expect(prompt).toBe("the older valid prompt");
  });

  test("returns the newest prompt when several share one reverse-read chunk", async () => {
    const prompt = await withService(async (historyService, workspaceId) => {
      for (const [index, text] of ["oldest prompt", "middle prompt", "newest prompt"].entries()) {
        await historyService.appendToHistory(
          workspaceId,
          createMuxMessage(`u${index}`, "user", text, { historySequence: index + 1 })
        );
      }
    });

    expect(prompt).toBe("newest prompt");
  });
});

describe("WorkspaceService.remove usage-rollup ordering", () => {
  test("usage recorded while draining background producers reaches the parent rollup", async () => {
    // Codex round 13: the child's usage snapshot was read BEFORE the
    // cancel-and-drain calls for the pending branch summary and in-flight
    // /refine pass. A draining producer records headless usage as it
    // settles, so that spend landed after the snapshot and was permanently
    // lost from parent accounting (the child is deleted with no second
    // rollup). Drains must complete before the snapshot is read.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const projectDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-rollup-"));
    const parentId = "rollup-parent-ws";
    const childId = "rollup-child-ws";
    try {
      await config.editConfig((cfg) => {
        cfg.projects.set(projectDir, {
          trusted: true,
          workspaces: [
            { path: projectDir, id: parentId, name: parentId },
            { path: projectDir, id: childId, name: childId, parentWorkspaceId: parentId },
          ],
        });
        return cfg;
      });

      // Fake usage ledger: the draining refine pass records the child's
      // spend only when cancelInFlightRefinePass runs (modelling a settle-
      // time recordHeadlessUsage write).
      const usageByWorkspace = new Map<string, Record<string, unknown>>();
      const rollupCalls: Array<{ parent: string; child: string; byModel: object }> = [];
      const sessionUsageService = {
        getSessionUsage: (workspaceId: string) =>
          Promise.resolve({ byModel: usageByWorkspace.get(workspaceId) ?? {} }),
        rollUpUsageIntoParent: (parent: string, child: string, byModel: object) => {
          rollupCalls.push({ parent, child, byModel });
          return Promise.resolve({ didRollUp: true });
        },
      } as unknown as SessionUsageService;
      const cancelInFlightRefinePass = mock((workspaceId: string) => {
        // The drained pass settles and records its spend against the child.
        usageByWorkspace.set(workspaceId, {
          "anthropic:claude-sonnet-4-5": { input: { tokens: 42, cost_usd: 0.01 } },
        });
        return Promise.resolve();
      });

      const service = createWorkspaceServiceForTest({
        config,
        historyService,
        sessionUsageService,
        aiService: createMockAIService({
          getWorkspaceMetadata: (async (workspaceId: string) => {
            const metadata = (await config.getAllWorkspaceMetadata()).find(
              (m) => m.id === workspaceId
            );
            return metadata ? Ok(metadata) : Err("workspace not found");
          }) as AIService["getWorkspaceMetadata"],
        }),
      });
      service.setRefinePassCanceller({ cancelInFlightRefinePass });

      const result = await service.remove(childId);
      expect(result.success).toBe(true);
      expect(cancelInFlightRefinePass).toHaveBeenCalled();

      // The drain-recorded spend made it into the parent rollup snapshot.
      expect(rollupCalls).toHaveLength(1);
      expect(rollupCalls[0].parent).toBe(parentId);
      expect(rollupCalls[0].child).toBe(childId);
      expect(Object.keys(rollupCalls[0].byModel)).toContain("anthropic:claude-sonnet-4-5");
    } finally {
      await fsPromises.rm(projectDir, { recursive: true, force: true });
      await cleanup();
    }
  });

  test("a failed non-forced deletion defers the one-shot rollups until removal commits", async () => {
    // rollUpUsageIntoParent / rollUpTimingIntoParent record the child in the
    // one-shot rolledUpFrom guard. Rolling up BEFORE runtime deletion meant a
    // force=false deletion failure left the child usable, and the eventual
    // successful removal skipped the rollup — permanently losing the child's
    // post-failure spend from parent accounting. Rollups must run only after
    // deletion can no longer fail, so a failed attempt rolls up nothing and
    // the retry captures the child's full (including post-failure) usage.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const projectDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-rollup-retry-"));
    const parentId = "rollup-retry-parent-ws";
    const childId = "rollup-retry-child-ws";
    let deletionFails = true;
    const deleteWorkspaceMock = mock(() =>
      deletionFails
        ? Promise.resolve({ success: false as const, error: "worktree has uncommitted changes" })
        : Promise.resolve({ success: true as const, deletedPath: projectDir })
    );
    const createRuntimeSpy = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
      deleteWorkspace: deleteWorkspaceMock,
    } as unknown as ReturnType<typeof runtimeFactory.createRuntime>);
    try {
      await config.editConfig((cfg) => {
        cfg.projects.set(projectDir, {
          trusted: true,
          workspaces: [
            { path: projectDir, id: parentId, name: parentId },
            { path: projectDir, id: childId, name: childId, parentWorkspaceId: parentId },
          ],
        });
        return cfg;
      });

      const childUsage: Record<string, unknown> = {
        "anthropic:claude-sonnet-4-5": { input: { tokens: 42, cost_usd: 0.01 } },
      };
      const usageRollups: Array<{ parent: string; child: string; byModel: object }> = [];
      const sessionUsageService = {
        getSessionUsage: () => Promise.resolve({ byModel: { ...childUsage } }),
        rollUpUsageIntoParent: (parent: string, child: string, byModel: object) => {
          usageRollups.push({ parent, child, byModel });
          return Promise.resolve({ didRollUp: true });
        },
      } as unknown as SessionUsageService;
      const timingRollups: string[] = [];
      const sessionTimingService = {
        waitForIdle: () => Promise.resolve(),
        rollUpTimingIntoParent: (_parent: string, child: string) => {
          timingRollups.push(child);
          return Promise.resolve();
        },
      } as unknown as SessionTimingService;

      const service = createWorkspaceServiceForTest({
        config,
        historyService,
        sessionUsageService,
        sessionTimingService,
        aiService: createMockAIService({
          getWorkspaceMetadata: (async (workspaceId: string) => {
            const metadata = (await config.getAllWorkspaceMetadata()).find(
              (m) => m.id === workspaceId
            );
            return metadata ? Ok(metadata) : Err("workspace not found");
          }) as AIService["getWorkspaceMetadata"],
        }),
      });

      // Non-forced removal fails at runtime deletion: the child stays usable,
      // so neither one-shot rollup may have been consumed.
      const failedAttempt = await service.remove(childId);
      expect(failedAttempt.success).toBe(false);
      expect(deleteWorkspaceMock).toHaveBeenCalledTimes(1);
      expect(usageRollups).toHaveLength(0);
      expect(timingRollups).toHaveLength(0);

      // The still-usable child accrues more spend before the retry.
      childUsage["openai:gpt-5.2"] = { input: { tokens: 7, cost_usd: 0.002 } };

      deletionFails = false;
      const retry = await service.remove(childId);
      expect(retry.success).toBe(true);

      // The retry rolls up exactly once, with the full post-failure snapshot.
      expect(timingRollups).toEqual([childId]);
      expect(usageRollups).toHaveLength(1);
      expect(usageRollups[0].parent).toBe(parentId);
      expect(usageRollups[0].child).toBe(childId);
      expect(Object.keys(usageRollups[0].byModel)).toEqual([
        "anthropic:claude-sonnet-4-5",
        "openai:gpt-5.2",
      ]);
    } finally {
      createRuntimeSpy.mockRestore();
      await fsPromises.rm(projectDir, { recursive: true, force: true });
      await cleanup();
    }
  });
});

describe("WorkspaceService.remove checkout-deletion ordering", () => {
  test("an admitted apply's checkout write completes before removal deletes the workdir", async () => {
    // Codex round 15: the refine drain ran AFTER runtime/workdir deletion, so
    // an admitted /refine apply's agent_skill_write could race checkout
    // deletion — recreating .mux/skills inside the deleted tree (orphaned
    // state) or failing midway with the failure swallowed. The drain must
    // complete before any disk mutation.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const scratchId = "scratch-apply-race";
    const scratchDir = path.join(config.rootDir, "scratch", scratchId);
    try {
      await fsPromises.mkdir(scratchDir, { recursive: true });
      await config.editConfig((cfg) => {
        cfg.projects.set(SCRATCH_PROJECT_CONFIG_KEY, {
          workspaces: [{ path: scratchDir, id: scratchId, name: scratchId, kind: "scratch" }],
        });
        return cfg;
      });
      const scratchMetadata: WorkspaceMetadata = {
        id: scratchId,
        name: scratchId,
        projectName: "scratch",
        projectPath: scratchDir,
        runtimeConfig: { type: "local" },
        kind: "scratch",
      };
      // Models the admitted apply completing during the drain: it writes a
      // project skill into the CHECKOUT as it settles. Only the FIRST drain
      // has an in-flight pass (matching the real idempotent canceller — later
      // calls find nothing to drain and no-op).
      let drained = false;
      const cancelInFlightRefinePass = mock(async () => {
        if (drained) return;
        drained = true;
        await fsPromises.mkdir(path.join(scratchDir, ".mux", "skills", "lesson"), {
          recursive: true,
        });
        await fsPromises.writeFile(
          path.join(scratchDir, ".mux", "skills", "lesson", "SKILL.md"),
          "distilled\n"
        );
      });
      const service = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService: createMockAIService({
          getWorkspaceMetadata: (() =>
            Promise.resolve(Ok(scratchMetadata))) as AIService["getWorkspaceMetadata"],
        }),
      });
      service.setRefinePassCanceller({ cancelInFlightRefinePass });

      const result = await service.remove(scratchId);
      expect(result.success).toBe(true);
      expect(cancelInFlightRefinePass).toHaveBeenCalled();

      // The drain's checkout write happened BEFORE workdir deletion, so the
      // removal deleted everything — no recreated .mux/skills orphan.
      const workdirExists = await fsPromises.access(scratchDir).then(
        () => true,
        () => false
      );
      expect(workdirExists).toBe(false);
    } finally {
      await fsPromises.rm(scratchDir, { recursive: true, force: true });
      await cleanup();
    }
  });
});

describe("WorkspaceService.fork branch-summary rollback ordering", () => {
  test("a fork whose setup fails never leaves a summary writer or registration behind", async () => {
    // Codex round-11: the background summary writer used to start BEFORE
    // staged-attachment copying and usage reset. Their failure handler
    // deletes newSessionDir without cancelling the registration, so a racing
    // guarded append (tail verified pre-rollback, append landing after)
    // recreated the failed fork's session dir, and the settled entry leaked
    // forever because the fork never returned. The writer now starts only
    // after all failure-prone setup completed.
    const { config, historyService, cleanup } = await createTestHistoryService();
    const projectDir = await fsPromises.mkdtemp(path.join(tmpdir(), "mux-fork-src-"));
    const sourceId = "fork-src-ws";
    // Gate the guarded append so the writer (old ordering) is mid-append when
    // the rollback deletes the session dir — Codex's exact race window.
    let releaseAppend: () => void = () => undefined;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const realGuardedAppend = historyService.appendToHistoryIfTailMatches.bind(historyService);
    const guardedAppendSpy = spyOn(
      historyService,
      "appendToHistoryIfTailMatches"
    ).mockImplementation(async (workspaceId, message, tailMessageId) => {
      await appendGate;
      // Model the lost race deterministically: the tail was verified before
      // the rollback, so the append itself lands unconditionally.
      void tailMessageId;
      const result = await historyService.appendToHistory(workspaceId, message);
      return result.success ? Ok("appended" as const) : result;
    });
    try {
      await config.editConfig((cfg) => {
        cfg.projects.set(projectDir, {
          trusted: true,
          workspaces: [{ path: projectDir, id: sourceId, name: sourceId }],
        });
        return cfg;
      });
      // Meaty abandoned tail (clears BRANCH_SUMMARY_MIN_SEGMENT_TOKENS).
      const filler = "explored the fork rollback race and traced the write path ".repeat(200);
      const branchPoint = createMuxMessage("fork-bp", "assistant", "branch point", {
        timestamp: 1,
      });
      for (const message of [
        createMuxMessage("fork-m1", "user", "original question", { timestamp: 0 }),
        branchPoint,
        createMuxMessage("fork-tail-u", "user", filler, { timestamp: 2 }),
        createMuxMessage("fork-tail-a", "assistant", filler, { timestamp: 3 }),
      ]) {
        expect((await historyService.appendToHistory(sourceId, message)).success).toBe(true);
      }

      const sourceMetadata: WorkspaceMetadata = {
        id: sourceId,
        name: sourceId,
        projectName: "fork-src",
        projectPath: projectDir,
        runtimeConfig: { type: "local" },
      };
      const summaryChunks: LanguageModelV3StreamPart[] = [
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "The abandoned branch explored a race." },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ];
      const aiService = {
        on: mock(() => undefined),
        off: mock(() => undefined),
        isStreaming: mock(() => false),
        getWorkspaceMetadata: mock((workspaceId: string) =>
          Promise.resolve(
            workspaceId === sourceId ? Ok(sourceMetadata) : Err("workspace not found")
          )
        ),
        createModelWithPinnedMetadata: mock((modelString: string) =>
          Promise.resolve(
            Ok({
              model: new MockLanguageModelV3({
                doStream: () =>
                  Promise.resolve({ stream: simulateReadableStream({ chunks: summaryChunks }) }),
              }),
              metadataModel: modelString,
            })
          )
        ),
      } as unknown as AIService;
      const initStateManager = {
        on: mock(() => undefined),
        off: mock(() => undefined),
        getInitState: mock(() => undefined),
        startInit: mock(() => undefined),
        appendOutput: mock(() => undefined),
        endInit: mock(() => Promise.resolve()),
        enterHookPhase: mock(() => undefined),
        clearInMemoryState: mock(() => undefined),
      } as unknown as InitStateManager;
      // Failure injection: the usage reset (the LAST failure-prone setup
      // step) rejects, driving the fork into its rollback path.
      const sessionUsageService = {
        resetSessionUsage: mock(() => Promise.reject(new Error("usage reset failed"))),
        recordHeadlessUsage: mock(() => Promise.resolve(undefined)),
      } as unknown as SessionUsageService;
      const experimentsService = {
        isExperimentEnabled: (id: string) =>
          id === EXPERIMENT_IDS.RLM || id === EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING,
      } as unknown as ExperimentsService;

      const service = createWorkspaceServiceForTest({
        config,
        historyService,
        aiService,
        initStateManager,
        sessionUsageService,
        experimentsService,
      });
      let newWorkspaceId = "";
      const realGenerateId = config.generateStableId.bind(config);
      const idSpy = spyOn(config, "generateStableId").mockImplementation(() => {
        newWorkspaceId = realGenerateId();
        return newWorkspaceId;
      });
      try {
        const forkResult = await service.fork(sourceId, "fork-rollback-target", "fork-bp");
        expect(forkResult.success).toBe(false);
        if (forkResult.success) return;
        expect(forkResult.error).toContain("Failed to copy fork state");
        expect(newWorkspaceId.length).toBeGreaterThan(0);

        // Unblock any (old-ordering) writer mid-append and let it settle.
        releaseAppend();
        await new Promise((resolve) => setTimeout(resolve, 50));

        // No writer ran, so no registration leaked and the rolled-back
        // session's chat.jsonl was not recreated by a late guarded append.
        expect(await awaitPendingBranchSummary(newWorkspaceId)).toBeNull();
        expect(guardedAppendSpy).not.toHaveBeenCalled();
        const chatFile = path.join(config.getSessionDir(newWorkspaceId), "chat.jsonl");
        const chatExists = await fsPromises.access(chatFile).then(
          () => true,
          () => false
        );
        expect(chatExists).toBe(false);
      } finally {
        idSpy.mockRestore();
      }
    } finally {
      guardedAppendSpy.mockRestore();
      void realGuardedAppend;
      await fsPromises.rm(projectDir, { recursive: true, force: true });
      await cleanup();
    }
  });
});
