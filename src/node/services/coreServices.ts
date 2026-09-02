/**
 * Core service graph shared by `xum run`/`xum workflow` (CLI) and
 * `ServiceContainer` (desktop).
 *
 * `buildCoreGraph` is the imperative construction body. Both roots reach it
 * through the Effect Layer graph — `CoreProjectionLive` in `di/layers/core.ts`
 * wraps it as a single coarse layer (Effect migration Phase 11) — so the roots
 * are `createCoreServices` (`./coreServicesRoot.ts`, CLI) and `AppLive`
 * (`di/layers/app.ts`, desktop). Construction order and wiring here are the
 * behavioral contract the per-service layers of the next phase must replay.
 */

import * as os from "os";
import * as path from "path";
import type { Config } from "@/node/config";
import {
  FileLeaseManager,
  ProvidersConfigStore,
  SecretsStore,
  WorkspaceSessionLocator,
} from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import { IdleDispatcher } from "@/node/services/idleDispatcher";
import { InitStateManager } from "@/node/services/initStateManager";
import { ProviderService } from "@/node/services/providerService";
import { AIService } from "@/node/services/aiService";
import type { TurnRequestBuilderBindings } from "@/node/services/turnRequestBuilder";
import { StreamManager } from "@/node/services/streamManager";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { SessionUsageService } from "@/node/services/sessionUsageService";
import { log } from "@/node/services/log";
import {
  WorkspaceGoalService,
  type GoalLifecycleAnalyticsSink,
  type WorkspaceGoalServiceOptions,
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
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { WorkspaceService } from "@/node/services/workspaceService";
import { TaskService } from "@/node/services/taskService";
import { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import type { PolicyService } from "@/node/services/policyService";
import type { TelemetryService } from "@/node/services/telemetryService";
import type { ExperimentsService } from "@/node/services/experimentsService";
import { MemoryService } from "@/node/services/memoryService";
import { MemoryConsolidationService } from "@/node/services/memoryConsolidationService";
import { MemoryMetaService } from "@/node/services/memoryMeta";
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
  workspaceMcpOverridesService?: WorkspaceMcpOverridesService;
  /**
   * Layer-provided instance (desktop `ServiceContainer` builds it from its
   * Effect graph, see `di/layers/core.ts`); default-constructed when absent.
   */
  memoryMetaService?: MemoryMetaService;
  /** Optional cross-cutting services (desktop creates before core services). */
  policyService?: PolicyService;
  telemetryService?: TelemetryService;
  analyticsService?: GoalLifecycleAnalyticsSink;
  goalServiceOptions?: WorkspaceGoalServiceOptions;
  experimentsService?: ExperimentsService;
  sessionTimingService?: SessionTimingService;
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

export function buildCoreGraph(opts: CoreServicesOptions): CoreServices {
  const { config, extensionMetadataPath } = opts;

  const sessionLocator = opts.sessionLocator ?? new WorkspaceSessionLocator(config.rootDir);
  const historyService = new HistoryService(sessionLocator);
  const initStateManager = new InitStateManager(config);
  const providersConfigStore =
    opts.providersConfigStore ?? new ProvidersConfigStore(config.rootDir);
  const secretsStore = opts.secretsStore ?? new SecretsStore(config.rootDir);
  const fileLeaseManager = opts.fileLeaseManager ?? new FileLeaseManager(config.rootDir);
  const providerService = new ProviderService(
    config,
    opts.policyService,
    providersConfigStore,
    fileLeaseManager
  );
  const backgroundProcessManager = new BackgroundProcessManager(
    path.join(os.tmpdir(), "mux-bashes")
  );
  // Providers config accessor enables mappedToModel alias resolution for
  // headless usage pricing (status generation and memory sweeps).
  const sessionUsageService = new SessionUsageService(config, historyService, () =>
    providerService.getConfig()
  );
  const extensionMetadata = new ExtensionMetadataService(extensionMetadataPath);
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
  const workspaceGoalService = new WorkspaceGoalService(
    config,
    historyService,
    extensionMetadata,
    opts.analyticsService,
    opts.goalServiceOptions,
    providersConfigStore
  );

  // Default-construct when the caller (CLI) does not pass one: workspace MCP
  // override reads AND registration-time plugin-override sanitization must
  // work in every process that can register workspaces, not just desktop.
  const workspaceMcpOverridesService =
    opts.workspaceMcpOverridesService ?? new WorkspaceMcpOverridesService(config);

  const turnRequestBuilderBindings: TurnRequestBuilderBindings = {};
  const streamManager = new StreamManager(historyService, sessionUsageService, () =>
    providerService.getConfig()
  );

  const aiService = new AIService(
    config,
    historyService,
    initStateManager,
    providerService,
    backgroundProcessManager,
    sessionUsageService,
    workspaceMcpOverridesService,
    opts.policyService,
    opts.telemetryService,
    opts.devToolsService,
    opts.experimentsService,
    streamManager,
    turnRequestBuilderBindings,
    providersConfigStore,
    secretsStore
  );

  // Agent memory (memory experiment): scope roots derive from Config (xum home
  // + session dirs); experiment gating happens per stream in AIService.
  // Host-local sidecar for user-owned memory metadata (pins + usage stats).
  const memoryMetaService = opts.memoryMetaService ?? new MemoryMetaService(config.rootDir);
  const memoryService = new MemoryService(config, memoryMetaService);
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

  const terminalAttentionStore = new TerminalAttentionStore(config);
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
    streamManager,
    mcpConfigService,
    mcpServerManager,
    extensionMetadata,
    workspaceService,
    taskService,
    workspaceTurnManager,
    memoryService,
    memoryMetaService,
    memoryConsolidationService,
    turnRequestBuilderBindings,
  };
}
