import * as path from "path";
import type { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import { HistoryService } from "@/node/services/historyService";
import {
  buildAgentTaskIndex,
  countActiveAgentTasks,
  hasActiveDescendantAgentTasksUsingIndex,
  isDescendantAgentTaskUsingParentById,
  listAgentTaskWorkspaces,
  resolveWorkspaceAISettings,
} from "@/node/services/agentTaskIndex";
import { buildParentAiSettingsFallbacks } from "@/node/services/agentTaskReawakenAi";
import type { InitStateManager } from "@/node/services/initStateManager";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import type {
  BackgroundableForegroundWaiter,
  WorkspaceHost,
  WorkspaceTurnManagerHost,
} from "@/node/services/taskWorkspaceSeam";
import {
  createAIServiceMocks,
  createMockInitStateManager,
  createWorkspaceServiceMocks,
  runWithTaskTreeHold,
} from "@/node/services/taskService.testHarness";

type WorkspaceTurnManagerHostFake = WorkspaceTurnManagerHost & {
  backgroundForegroundWaitsForWorkspace(workspaceId: string): number;
};

function createWorkspaceTurnManagerHost(
  config: Config,
  workspaceService: WorkspaceHost,
  aiService: AIService,
  terminalAttentionStore: TerminalAttentionStore
): WorkspaceTurnManagerHostFake {
  const lifecycleLocks = new MutexMap<string>();
  const foregroundWaiters = new Map<string, Set<BackgroundableForegroundWaiter>>();
  const foregroundAwaitCounts = new Map<string, number>();
  // Tree and activity rules come from the production predicates so this host cannot drift from
  // TaskService (queued tasks, archived streams, the streaming fallback, agent-ID normalization).
  const isStreaming = (workspaceId: string) => aiService.isStreaming(workspaceId);
  const isDescendant = (
    cfg: ReturnType<Config["loadConfigOrDefault"]>,
    ancestorWorkspaceId: string,
    taskId: string
  ) =>
    isDescendantAgentTaskUsingParentById(
      buildAgentTaskIndex(cfg).parentById,
      ancestorWorkspaceId,
      taskId
    );
  const backgroundForegroundWaitsForWorkspace = (workspaceId: string) => {
    let signaled = 0;
    for (const waiter of foregroundWaiters.get(workspaceId) ?? []) {
      waiter.cleanup();
      waiter.reject(new ForegroundWaitBackgroundedError());
      signaled += 1;
    }
    return signaled;
  };
  return {
    acquireTaskCreationLock: () =>
      Promise.resolve({
        [Symbol.asyncDispose]: () => Promise.resolve(),
      }),
    backgroundForegroundWaitIfQueued: (enabled, workspaceId) => {
      if (
        !enabled ||
        workspaceId == null ||
        !workspaceService.hasQueuedMessages(workspaceId, "tool-end")
      )
        return;
      backgroundForegroundWaitsForWorkspace(workspaceId);
    },
    backgroundForegroundWaitsForWorkspace,
    buildParentAiSettingsFallbacks,
    bumpWorkspaceStopEpoch: () => undefined,
    countActiveAgentTasks: (cfg) =>
      countActiveAgentTasks(listAgentTaskWorkspaces(cfg), {
        isStreaming,
        isForegroundAwaiting: (workspaceId) => foregroundAwaitCounts.has(workspaceId),
      }),
    editWorkspaceEntry: async (workspaceId, updater, options) => {
      let found = false;
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const workspace = project.workspaces.find((candidate) => candidate.id === workspaceId);
          if (workspace != null) {
            updater(workspace, cfg);
            found = true;
            break;
          }
        }
        return cfg;
      });
      if (!found && options?.allowMissing !== true)
        throw new Error("Workspace not found: " + workspaceId);
      return found;
    },
    emitWorkspaceMetadata: () => Promise.resolve(),
    enqueueTerminalAttention: async (params) => {
      await terminalAttentionStore.enqueueIfAbsent(params);
    },
    hasActiveDescendantAgentTasks: (cfg, workspaceId) =>
      hasActiveDescendantAgentTasksUsingIndex(buildAgentTaskIndex(cfg), workspaceId, isStreaming),
    isDescendantAgentTaskInConfig: isDescendant,
    isForegroundAwaiting: (workspaceId) => foregroundAwaitCounts.has(workspaceId),
    latchWorkspaceStopsInProgress: () => () => undefined,
    listActiveBackgroundWorkflowRunIds: async (workspaceId, referencedRunIds) => {
      if (referencedRunIds.length === 0) return [];
      const runs = await new WorkflowRunStore({
        sessionDir: path.join(config.sessionsDir, workspaceId),
      }).listRuns();
      return runs
        .filter(
          (run) =>
            referencedRunIds.includes(run.id) &&
            run.workspaceId === workspaceId &&
            ["pending", "running", "backgrounded"].includes(run.status)
        )
        .map((run) => run.id);
    },
    listActiveWorkflowRunIdsForWorkspaceStrict: async (workspaceId) => {
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(config.sessionsDir, workspaceId),
      });
      const runs = await runStore.listRunsForActivityScan();
      return runs
        .filter(
          (run) =>
            run.workspaceId === workspaceId &&
            run.parentWorkflow == null &&
            ["pending", "running", "backgrounded"].includes(run.status)
        )
        .map((run) => run.id);
    },
    listAgentReferencedWorkflowRunIds: () => Promise.resolve([]),
    listAgentTaskExecutionEntries: listAgentTaskWorkspaces,
    markTaskForegroundRelevant: () => undefined,
    maybeStartPatchGenerationForReportedTask: () => Promise.resolve(),
    registerBackgroundableForegroundWaiter: (workspaceId, waiter) => {
      const waiters = foregroundWaiters.get(workspaceId) ?? new Set();
      waiters.add(waiter);
      foregroundWaiters.set(workspaceId, waiters);
    },
    releaseRetainedStopLatches: () => undefined,
    resolveWorkspaceAISettings,
    scheduleMaybeStartQueuedTasks: () => undefined,
    scheduleTerminalAttentionDrain: () => undefined,
    startForegroundAwait: (workspaceId) => {
      foregroundAwaitCounts.set(workspaceId, (foregroundAwaitCounts.get(workspaceId) ?? 0) + 1);
      return () => {
        const count = foregroundAwaitCounts.get(workspaceId) ?? 0;
        if (count <= 1) foregroundAwaitCounts.delete(workspaceId);
        else foregroundAwaitCounts.set(workspaceId, count - 1);
      };
    },
    unregisterBackgroundableForegroundWaiter: (workspaceId, waiter) => {
      const waiters = foregroundWaiters.get(workspaceId);
      waiters?.delete(waiter);
      if (waiters?.size === 0) foregroundWaiters.delete(workspaceId);
    },
    withTaskTreeLifecycleLock: (workspaceId, operation) =>
      lifecycleLocks.withLock(workspaceId, () => runWithTaskTreeHold(operation)),
  };
}

export function createWorkspaceTurnManagerHarness(
  config: Config,
  overrides?: {
    historyService?: HistoryService;
    aiService?: AIService;
    workspaceService?: WorkspaceHost;
    initStateManager?: InitStateManager;
  }
): {
  historyService: HistoryService;
  taskService: WorkspaceTurnManager;
  taskHost: WorkspaceTurnManagerHostFake;
  aiService: AIService;
  workspaceService: WorkspaceHost;
  initStateManager: InitStateManager;
} {
  const historyService = overrides?.historyService ?? new HistoryService(config);
  const aiService = overrides?.aiService ?? createAIServiceMocks(config).aiService;
  const workspaceService =
    overrides?.workspaceService ?? createWorkspaceServiceMocks().workspaceService;
  const initStateManager = overrides?.initStateManager ?? createMockInitStateManager();
  const terminalAttentionStore = new TerminalAttentionStore(config);
  const taskHost = createWorkspaceTurnManagerHost(
    config,
    workspaceService,
    aiService,
    terminalAttentionStore
  );
  const taskService = new WorkspaceTurnManager(
    config,
    historyService,
    aiService,
    workspaceService,
    initStateManager,
    taskHost,
    terminalAttentionStore
  );

  return {
    historyService,
    taskService,
    taskHost,
    aiService,
    workspaceService,
    initStateManager,
  };
}
