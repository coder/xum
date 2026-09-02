/**
 * Core service graph shared by `xum run`/`xum workflow` (CLI) and
 * `ServiceContainer` (desktop).
 *
 * The graph is built by the Effect Layer graph in `di/layers/core.ts`
 * (`CoreLive`, Effect migration Phase 11): the head — every service up to and
 * including `AIService` — as staged per-service layers, and the remainder
 * through `buildCoreTail` below, today's imperative construction of the
 * remaining services plus all setter/listener wiring, unchanged in order. The
 * roots are `createCoreServices` (`./coreServicesRoot.ts`, CLI) and `AppLive`
 * (`di/layers/app.ts`, desktop). The tail's construction order and wiring are
 * the behavioral contract the next PR's stages and wiring layer must replay.
 */

import * as path from "path";
import type {
  Config,
  ConfigStores,
  FileLeaseManager,
  ProvidersConfigStore,
  SecretsStore,
  WorkspaceSessionLocator,
} from "@/node/config";
import type { HistoryService } from "@/node/services/historyService";
import type { IdleDispatcher } from "@/node/services/idleDispatcher";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { ProviderService } from "@/node/services/providerService";
import type { AIService } from "@/node/services/aiService";
import type { TurnRequestBuilderBindings } from "@/node/services/turnRequestBuilder";
import type { StreamManager } from "@/node/services/streamManager";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import { log } from "@/node/services/log";
import type {
  WorkspaceGoalService,
  GoalLifecycleAnalyticsSink,
  WorkspaceGoalServiceOptions,
} from "@/node/services/workspaceGoalService";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { STAGING_DIR_NAME, readMutationEpochToken } from "@/node/services/agentPlugins/journals";
import {
  PLUGIN_SERVER_KEY_PREFIX,
  createAgentPluginsMcpProvider,
} from "@/node/services/agentPlugins/mcpConfig";
import { MCPConfigService } from "@/node/services/mcpConfigService";
import { MCPServerManager, type MCPServerManagerOptions } from "@/node/services/mcpServerManager";
import { mergeMultiProjectSecrets } from "@/node/services/utils/multiProjectSecrets";
import { isMultiProject } from "@/common/utils/multiProject";
import { secretsToRecord } from "@/common/types/secrets";
import type { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { WorkspaceService } from "@/node/services/workspaceService";
import { TaskService } from "@/node/services/taskService";
import { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import type { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import type { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import type { PolicyService } from "@/node/services/policyService";
import type { TelemetryService } from "@/node/services/telemetryService";
import type { ExperimentsService } from "@/node/services/experimentsService";
import type { MemoryService } from "@/node/services/memoryService";
import { MemoryConsolidationService } from "@/node/services/memoryConsolidationService";
import type { MemoryMetaService } from "@/node/services/memoryMeta";
import type { SessionTimingService } from "@/node/services/sessionTimingService";
import type { DevToolsService } from "@/node/services/devToolsService";

export interface CoreServicesOptions {
  config: Config;
  sessionLocator?: WorkspaceSessionLocator;
  providersConfigStore?: ProvidersConfigStore;
  secretsStore?: SecretsStore;
  fileLeaseManager?: FileLeaseManager;
  extensionMetadataPath: string;
  /** Overrides config for MCPConfigService; CLI passes its persistent realConfig. */
  mcpConfig?: Config;
  mcpServerManagerOptions?: MCPServerManagerOptions;
  /** Optional cross-cutting services (desktop creates before core services). */
  policyService?: PolicyService;
  telemetryService?: TelemetryService;
  analyticsService?: GoalLifecycleAnalyticsSink;
  goalServiceOptions?: WorkspaceGoalServiceOptions;
  experimentsService?: ExperimentsService;
  sessionTimingService?: SessionTimingService;
  devToolsService?: DevToolsService;
}

/**
 * The graph's inputs other than the stores (`CoreOptionsTag` in
 * `di/layers/core.ts`). The optional cross-cutting services stay optional here
 * (present in the desktop graph, absent in CLI roots), so core constructors
 * see exactly the arguments they saw before.
 */
export type CoreOptions = Omit<CoreServicesOptions, keyof ConfigStores>;

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
  streamManager: StreamManager;
  mcpConfigService: MCPConfigService;
  mcpServerManager: MCPServerManager;
  extensionMetadata: ExtensionMetadataService;
  workspaceService: WorkspaceService;
  taskService: TaskService;
  workspaceTurnManager: WorkspaceTurnManager;
  memoryService: MemoryService;
  memoryMetaService: MemoryMetaService;
  memoryConsolidationService: MemoryConsolidationService;
  turnRequestBuilderBindings: TurnRequestBuilderBindings;
}

/** The layer-built head of the graph (stages S1–S3 in `di/layers/core.ts`) plus what the tail reads. */
export interface CoreGraphHead extends Pick<
  CoreServices,
  | "historyService"
  | "initStateManager"
  | "backgroundProcessManager"
  | "sessionUsageService"
  | "extensionMetadata"
  | "workspaceGoalService"
  | "idleDispatcher"
  | "streamManager"
  | "aiService"
  | "memoryService"
  | "memoryMetaService"
  | "turnRequestBuilderBindings"
> {
  config: Config;
  secretsStore: SecretsStore;
  providersConfigStore: ProvidersConfigStore;
  options: CoreOptions;
  workspaceMcpOverridesService: WorkspaceMcpOverridesService;
  terminalAttentionStore: TerminalAttentionStore;
}

/** The services the tail constructs (the rest of `CoreServices` comes from the head). */
export type CoreGraphTail = Pick<
  CoreServices,
  | "memoryConsolidationService"
  | "mcpConfigService"
  | "mcpServerManager"
  | "workspaceService"
  | "taskService"
  | "workspaceTurnManager"
>;

/**
 * Today's imperative construction of the services after `AIService`, and all
 * of the graph's setter/listener wiring, in the original order. Transitional:
 * the next PR replays this as staged layers + a wiring layer; until then the
 * wiring lines that only need head services (the registration probe, the
 * memory binding) simply run first here — nothing constructed in between
 * observes them (verified per constructor, see the PR's I6 audit).
 */
export function buildCoreTail(head: CoreGraphHead): CoreGraphTail {
  const {
    config,
    secretsStore,
    providersConfigStore,
    options: opts,
    historyService,
    initStateManager,
    backgroundProcessManager,
    sessionUsageService,
    extensionMetadata,
    workspaceGoalService,
    idleDispatcher,
    streamManager,
    aiService,
    memoryService,
    memoryMetaService,
    turnRequestBuilderBindings,
    workspaceMcpOverridesService,
    terminalAttentionStore,
  } = head;

  // Write tombstones are process-local removal knowledge; the shared config
  // is the authority (with XUM_ALLOW_MULTIPLE_INSTANCES a downgraded backend
  // can legitimately re-register a deterministic legacy id this process
  // pruned). Without this probe, a tombstoned id that becomes active again
  // would have every metadata write and broadcast suppressed until an
  // activity bootstrap happens to run. Raw view first (cheap; complete when
  // every persisted entry carries an inline id); only id-less legacy entries
  // require the authoritative enumeration. Throws propagate: unknowable
  // registration keeps the tombstone.
  extensionMetadata.setRegistrationProbe(async (workspaceId) => {
    const evidence = config.readPersistedWorkspaceIdEvidence();
    if (evidence.ids.has(workspaceId)) {
      return true;
    }
    if (!evidence.hasWorkspaceEntriesWithoutIds) {
      return false;
    }
    // Targeted lenient positive first: a POSITIVE identity match needs no
    // completeness, so a re-registered workspace whose own compatibility
    // metadata is healthy must not stay write-suppressed because an
    // UNRELATED legacy entry's metadata is malformed (the strict
    // enumeration below throws on the first such entry, and the tombstone
    // would then pin every one of the target's writes as transient
    // indefinitely). A lenient scan only skips unreadable entries — it
    // never fabricates a match.
    if (config.findWorkspace(workspaceId) != null) {
      return true;
    }
    // Negatives keep requiring the complete strict view: a lenient miss is
    // indistinguishable from an identity hidden by a read failure. Alias
    // ids: a second resolvable compatibility file's identity stays
    // registered for findWorkspace even though it is not any entry's
    // primary id — refusing its writes/deletions requires knowing it here.
    const legacyAliasIds = new Set<string>();
    const registered = (
      await config.getAllWorkspaceMetadata({ throwOnError: true, legacyAliasIds })
    ).some((metadata) => metadata.id === workspaceId);
    return registered || legacyAliasIds.has(workspaceId);
  });
  turnRequestBuilderBindings.memoryService = memoryService;

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
  const mcpConfig = opts.mcpConfig ?? config;
  // Agent Plugins (agent-plugins experiment): read-only plugin MCP servers are
  // merged into listings; without an ExperimentsService the provider is inert.
  const mcpConfigService = new MCPConfigService(mcpConfig, {
    agentPluginsMcpProvider: createAgentPluginsMcpProvider({
      xumHome: mcpConfig.rootDir,
      isEnabled: () =>
        opts.experimentsService?.isExperimentEnabled(EXPERIMENT_IDS.AGENT_PLUGINS) === true,
    }),
    policyService: opts.policyService,
    telemetryService: opts.telemetryService,
    workspaceMetadataProvider: aiService,
  });
  const mcpServerManager = new MCPServerManager(
    mcpConfigService,
    {
      // A plugin update/uninstall in a sibling process (desktop app alongside
      // `xum server`) bumps the installer's mutation epoch; managers retire
      // cached plugin instances before serving them again. The sibling's
      // uninstall also pruned plugin keys from workspace override files, so
      // the sweep refreshes cached override snapshots from disk.
      config,
      telemetryService: opts.telemetryService,
      pluginInvalidation: {
        keyPrefix: PLUGIN_SERVER_KEY_PREFIX,
        readToken: () => readMutationEpochToken(path.join(mcpConfig.rootDir, STAGING_DIR_NAME)),
        readWorkspaceOverrides: async (workspaceId: string) =>
          (await workspaceMcpOverridesService.getOverridesForWorkspace(workspaceId)).overrides,
      },
      ...opts.mcpServerManagerOptions,
    },
    opts.policyService
  );
  turnRequestBuilderBindings.mcpServerManager = mcpServerManager;
  streamManager.setMCPServerManager(mcpServerManager);
  // Recorded prompt options can hold stale secret snapshots, so prompt refreshes
  // resolve credentials from current configuration.
  mcpServerManager.setSecretsResolver(async (workspaceId, projectPath) => {
    const metadataResult = await aiService.getWorkspaceMetadata(workspaceId);
    const metadata = metadataResult.success ? metadataResult.data : null;
    const secrets =
      metadata && isMultiProject(metadata)
        ? mergeMultiProjectSecrets(metadata, secretsStore)
        : secretsStore.getEffectiveSecrets(projectPath);
    return secretsToRecord(secrets);
  });

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
    streamManager,
    secretsStore,
    providersConfigStore
  );
  turnRequestBuilderBindings.workspaceHeartbeatService = workspaceService;
  // Tool-started workflows share the same sidebar activity cache as ORPC-started workflows,
  // so terminal updates must prune active run counts regardless of launch path.
  turnRequestBuilderBindings.onWorkflowRunStatusChanged = (event) =>
    workspaceService.emitWorkflowRunActivity(event);
  turnRequestBuilderBindings.workflowResultContinuationSender = workspaceService;
  workspaceService.setMemoryConsolidationService(memoryConsolidationService);
  if (opts.devToolsService) {
    // DevTools debug-log cleanup when workspaces are archived/removed.
    workspaceService.setDevToolsService(opts.devToolsService);
  }
  workspaceService.setMCPServerManager(mcpServerManager);
  // Plugin override keys must be pruned from a workspace's override files when
  // registering a preserved checkout (desktop create/fork, task
  // materialization, and headless `xum run`/`xum workflow` registration) and
  // during removal: a stale enable in a kept .xum/mcp.local.jsonc could
  // otherwise re-activate a same-name reinstall's server.
  workspaceService.setWorkspaceMcpOverridesService(workspaceMcpOverridesService);
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
    sessionUsageService,
    workspaceGoalService,
    secretsStore,
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
    streamManager
  );
  taskService.setWorkspaceTurnManager(workspaceTurnManager);
  turnRequestBuilderBindings.taskService = taskService;
  turnRequestBuilderBindings.workspaceTurnManager = workspaceTurnManager;
  workspaceService.setAgentTaskIntegration(taskService);

  // Goal continuation bridge lives at the core scope so every codepath that
  // uses the core graph (xum run, xum server via ServiceContainer, tests)
  // gets a working dispatcher. Without this, requestContinuationAfterStreamEnd
  // is a no-op and the auto-continuation loop never fires.
  workspaceGoalService.registerGoalContinuationConsumer(idleDispatcher, {
    hasActiveDescendantTasks: (workspaceId) =>
      taskService.hasActiveDescendantAgentTasksForWorkspace(workspaceId),
    getRuntimeState: (workspaceId) => workspaceService.getGoalContinuationRuntimeState(workspaceId),
    executeGoalContinuation: (input) => workspaceService.executeGoalContinuation(input),
    getKickoffSendOptions: (workspaceId) =>
      workspaceService.getGoalContinuationKickoffSendOptions(workspaceId),
  });

  return {
    memoryConsolidationService,
    mcpConfigService,
    mcpServerManager,
    workspaceService,
    taskService,
    workspaceTurnManager,
  };
}
