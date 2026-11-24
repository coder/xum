/**
 * Core service graph shared by `mux run` (CLI) and `ServiceContainer` (desktop).
 */

import * as os from "os";
import * as path from "path";
import type { Config } from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import { IdleDispatcher } from "@/node/services/idleDispatcher";
import { InitStateManager } from "@/node/services/initStateManager";
import { ProviderService } from "@/node/services/providerService";
import { AIService } from "@/node/services/aiService";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { SessionUsageService } from "@/node/services/sessionUsageService";
import { log } from "@/node/services/log";
import {
  WorkspaceGoalService,
  type GoalLifecycleAnalyticsSink,
  type WorkspaceGoalServiceOptions,
} from "@/node/services/workspaceGoalService";
import { MCPConfigService } from "@/node/services/mcpConfigService";
import { MCPServerManager, type MCPServerManagerOptions } from "@/node/services/mcpServerManager";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { WorkspaceService } from "@/node/services/workspaceService";
import { TaskService } from "@/node/services/taskService";
import type { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import type { PolicyService } from "@/node/services/policyService";
import type { TelemetryService } from "@/node/services/telemetryService";
import type { ExperimentsService } from "@/node/services/experimentsService";
import { MemoryService } from "@/node/services/memoryService";
import { MemoryConsolidationService } from "@/node/services/memoryConsolidationService";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import type { SessionTimingService } from "@/node/services/sessionTimingService";
import type { ExternalSecretResolver } from "@/common/types/secrets";
import type { DevToolsService } from "@/node/services/devToolsService";

export interface CoreServicesOptions {
  config: Config;
  extensionMetadataPath: string;
  /** Overrides config for MCPConfigService; CLI passes its persistent realConfig. */
  mcpConfig?: Config;
  mcpServerManagerOptions?: MCPServerManagerOptions;
  workspaceMcpOverridesService?: WorkspaceMcpOverridesService;
  /** Optional cross-cutting services (desktop creates before core services). */
  policyService?: PolicyService;
  telemetryService?: TelemetryService;
  analyticsService?: GoalLifecycleAnalyticsSink;
  goalServiceOptions?: WorkspaceGoalServiceOptions;
  experimentsService?: ExperimentsService;
  sessionTimingService?: SessionTimingService;
  opResolver?: ExternalSecretResolver;
  devToolsService?: DevToolsService;
}

export interface CoreServices {
  historyService: HistoryService;
  initStateManager: InitStateManager;
  providerService: ProviderService;
  backgroundProcessManager: BackgroundProcessManager;
  sessionUsageService: SessionUsageService;
  workspaceGoalService: WorkspaceGoalService;
  /**
   * Shared with HeartbeatService (when the desktop ServiceContainer wires it
   * up) so an active goal naturally suppresses background heartbeats via
   * priority dispatch ordering.
   */
  idleDispatcher: IdleDispatcher;
  aiService: AIService;
  mcpConfigService: MCPConfigService;
  mcpServerManager: MCPServerManager;
  extensionMetadata: ExtensionMetadataService;
  workspaceService: WorkspaceService;
  taskService: TaskService;
  memoryService: MemoryService;
  memoryMetaService: MemoryMetaService;
  memoryConsolidationService: MemoryConsolidationService;
}

export function createCoreServices(opts: CoreServicesOptions): CoreServices {
  const { config, extensionMetadataPath } = opts;

  const historyService = new HistoryService(config);
  const initStateManager = new InitStateManager(config);
  const providerService = new ProviderService(config, opts.policyService);
  const backgroundProcessManager = new BackgroundProcessManager(
    path.join(os.tmpdir(), "mux-bashes")
  );
  // Providers config accessor enables mappedToModel alias resolution for
  // headless usage pricing (status generation, memory sweeps, /btw).
  const sessionUsageService = new SessionUsageService(config, historyService, () =>
    providerService.getConfig()
  );
  const extensionMetadata = new ExtensionMetadataService(extensionMetadataPath);
  const workspaceGoalService = new WorkspaceGoalService(
    config,
    historyService,
    extensionMetadata,
    opts.analyticsService,
    opts.goalServiceOptions
  );

  const aiService = new AIService(
    config,
    historyService,
    initStateManager,
    providerService,
    backgroundProcessManager,
    sessionUsageService,
    opts.workspaceMcpOverridesService,
    opts.policyService,
    opts.telemetryService,
    opts.devToolsService,
    opts.opResolver,
    opts.experimentsService
  );

  // Agent memory (memory experiment): scope roots derive from Config (mux home
  // + session dirs); experiment gating happens per stream in AIService.
  // Host-local sidecar for user-owned memory metadata (pins + usage stats).
  const memoryMetaService = new MemoryMetaService(config.rootDir);
  const memoryService = new MemoryService(config, memoryMetaService);
  aiService.setMemoryService(memoryService);

  // Background dream consolidation (memory-consolidation experiment). Without
  // an ExperimentsService (CLI/test contexts) the service stays inert.
  const memoryConsolidationService = new MemoryConsolidationService(
    config,
    memoryService,
    memoryMetaService,
    historyService,
    aiService,
    opts.experimentsService ?? { isExperimentEnabled: () => false },
    sessionUsageService
  );

  // MCP: allow callers to override which Config provides server definitions
  const mcpConfigService = new MCPConfigService(opts.mcpConfig ?? config);
  const mcpServerManager = new MCPServerManager(
    mcpConfigService,
    opts.mcpServerManagerOptions,
    opts.policyService
  );
  aiService.setMCPServerManager(mcpServerManager);

  const workspaceService = new WorkspaceService(
    config,
    historyService,
    aiService,
    initStateManager,
    extensionMetadata,
    backgroundProcessManager,
    sessionUsageService,
    opts.policyService,
    opts.telemetryService,
    opts.experimentsService,
    opts.sessionTimingService,
    opts.opResolver
  );
  aiService.setWorkspaceHeartbeatService(workspaceService);
  // Tool-started workflows share the same sidebar activity cache as ORPC-started workflows,
  // so terminal updates must prune active run counts regardless of launch path.
  aiService.setWorkflowRunStatusChangedHandler((event) =>
    workspaceService.emitWorkflowRunActivity(event)
  );
  aiService.setWorkflowResultContinuationSender(workspaceService);
  workspaceService.setMemoryConsolidationService(memoryConsolidationService);
  if (opts.devToolsService) {
    // DevTools debug-log cleanup when workspaces are archived/removed.
    workspaceService.setDevToolsService(opts.devToolsService);
  }
  workspaceService.setMCPServerManager(mcpServerManager);
  workspaceService.setWorkspaceGoalService(workspaceGoalService);
  workspaceGoalService.setOnActivityChange((workspaceId, snapshot) => {
    workspaceService.emitWorkspaceActivity(workspaceId, snapshot);
  });
  // Wire user-initiated `promoteUpcomingGoal` through `interruptStream`
  // so promoting mid-stream cleanly aborts the in-flight turn before
  // the new active goal lands. Without this, the goal service would
  // proceed without aborting and the tail of the current stream could
  // leak token usage into the newly-promoted goal's accounting (the
  // earlier Codex P1 concern). Soft hand-off here means a queued
  // message stays in the user's input box; the next `sendMessage`
  // will start fresh against the promoted goal.
  workspaceGoalService.setStreamInterrupter(async (workspaceId) => {
    const result = await workspaceService.interruptStream(workspaceId);
    if (!result.success) {
      // The goal service logs + falls back; we just surface a warning
      // here so production paths flag the rare error.
      log.warn("coreServices: promote interrupt failed", { workspaceId, error: result.error });
    }
  });

  const taskService = new TaskService(
    config,
    historyService,
    aiService,
    workspaceService,
    initStateManager,
    opts.opResolver,
    sessionUsageService,
    workspaceGoalService
  );
  aiService.setTaskService(taskService);
  workspaceService.setTaskService(taskService);

  // Goal continuation bridge lives at the core scope so every codepath that
  // uses createCoreServices (mux run, mux server via ServiceContainer, tests)
  // gets a working dispatcher. Without this, requestContinuationAfterStreamEnd
  // is a no-op and the auto-continuation loop never fires. The dispatcher is
  // also exposed so ServiceContainer can share it with HeartbeatService.
  const idleDispatcher = new IdleDispatcher();
  workspaceGoalService.registerGoalContinuationConsumer(idleDispatcher, {
    hasActiveDescendantTasks: (workspaceId) =>
      taskService.hasActiveDescendantAgentTasksForWorkspace(workspaceId),
    getRuntimeState: (workspaceId) => workspaceService.getGoalContinuationRuntimeState(workspaceId),
    executeGoalContinuation: (input) => workspaceService.executeGoalContinuation(input),
    getKickoffSendOptions: (workspaceId) =>
      workspaceService.getGoalContinuationKickoffSendOptions(workspaceId),
  });

  return {
    historyService,
    initStateManager,
    providerService,
    backgroundProcessManager,
    sessionUsageService,
    workspaceGoalService,
    idleDispatcher,
    aiService,
    mcpConfigService,
    mcpServerManager,
    extensionMetadata,
    workspaceService,
    taskService,
    memoryService,
    memoryMetaService,
    memoryConsolidationService,
  };
}
