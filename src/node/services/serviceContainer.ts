import * as path from "path";
import { DEFAULT_CODER_ARCHIVE_BEHAVIOR } from "@/common/config/coderArchiveBehavior";
import { DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR } from "@/common/config/worktreeArchiveBehavior";
import { log } from "@/node/services/log";
import type { Config } from "@/node/config";
import { createCoreServices, type CoreServices } from "@/node/services/coreServices";
import { PTYService } from "@/node/services/ptyService";
import type { TerminalWindowManager } from "@/desktop/terminalWindowManager";
import { ProjectService } from "@/node/services/projectService";
import { MuxGatewayOauthService } from "@/node/services/muxGatewayOauthService";
import { MuxGovernorOauthService } from "@/node/services/muxGovernorOauthService";
import { CodexOauthService } from "@/node/services/codexOauthService";
import { CoderOauthService } from "@/node/services/coderOauthService";
import { CopilotOauthService } from "@/node/services/copilotOauthService";
import { TerminalService } from "@/node/services/terminalService";
import { BackupService } from "@/node/services/backup/backupService";
import { createBackupGitRepo, createBackupPayloadStore } from "@/node/services/backup/adapters";
import { EditorService } from "@/node/services/editorService";
import { WindowService } from "@/node/services/windowService";
import { UpdateService } from "@/node/services/updateService";
import { TokenizerService } from "@/node/services/tokenizerService";
import { InstructionsService } from "@/node/services/instructionsService";
import { ServerService } from "@/node/services/serverService";
import { MenuEventService } from "@/node/services/menuEventService";
import { VoiceService } from "@/node/services/voiceService";
import { TelemetryService } from "@/node/services/telemetryService";
import type {
  ErrorEvent,
  ReasoningDeltaEvent,
  StreamAbortEvent,
  StreamDeltaEvent,
  StreamEndEvent,
  StreamStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
} from "@/common/types/stream";
import { BrowserBridgeServer } from "@/node/services/browser/BrowserBridgeServer";
import { AgentBrowserSessionDiscoveryService } from "@/node/services/browser/AgentBrowserSessionDiscoveryService";
import { BrowserBridgeTokenManager } from "@/node/services/browser/BrowserBridgeTokenManager";
import { BrowserControlService } from "@/node/services/browser/BrowserControlService";
import { BrowserSessionStateHub } from "@/node/services/browser/BrowserSessionStateHub";
import { DevToolsService } from "@/node/services/devToolsService";
import { SessionTimingService } from "@/node/services/sessionTimingService";
import { TimelineService } from "@/node/services/timelineService";
import {
  AnalyticsService,
  type IngestWorkspaceMeta,
} from "@/node/services/analytics/analyticsService";
import { ExperimentsService } from "@/node/services/experimentsService";
import { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import { AgentPluginInstallService } from "@/node/services/agentPlugins/installService";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { McpOauthService } from "@/node/services/mcpOauthService";
import { HeartbeatService } from "@/node/services/heartbeatService";
import { AgentStatusService } from "@/node/services/agentStatusService";
import { IdleCompactionService } from "@/node/services/idleCompactionService";
import type { IdleDispatcher } from "@/node/services/idleDispatcher";
import { coderService, type CoderService } from "@/node/services/coderService";
import { SshPromptService } from "@/node/services/sshPromptService";
import { WorkspaceLifecycleHooks } from "@/node/services/workspaceLifecycleHooks";
import { WorktreeArchiveSnapshotService } from "@/node/services/worktreeArchiveSnapshotService";
import {
  createCoderArchiveHook,
  createCoderUnarchiveHook,
} from "@/node/runtime/coderLifecycleHooks";
import { createWorktreeArchiveHook } from "@/node/runtime/worktreeLifecycleHooks";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { RefineService } from "@/node/services/refinement/refineService";
import { setGlobalCoderService } from "@/node/runtime/runtimeFactory";
import { setSshPromptService } from "@/node/runtime/sshConnectionPool";
import { setSshPromptService as setSSH2SshPromptService } from "@/node/runtime/SSH2ConnectionPool";
import {
  createRuntimeForWorkspace,
  resolveWorkspaceExecutionPath,
} from "@/node/runtime/runtimeHelpers";
import { PolicyService } from "@/node/services/policyService";
import { ServerAuthService } from "@/node/services/serverAuthService";
import { DesktopBridgeServer } from "@/node/services/desktop/DesktopBridgeServer";
import { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import { DesktopTokenManager } from "@/node/services/desktop/DesktopTokenManager";
import type { ORPCContext } from "@/node/orpc/context";
/**
 * ServiceContainer - Central dependency container for all backend services.
 *
 * This class instantiates and wires together all services needed by the ORPC router.
 * Services are accessed via the ORPC context object.
 */
export class ServiceContainer {
  public readonly workflowRuntimeFactory = new QuickJSRuntimeFactory();
  public readonly config: Config;
  // Core services — instantiated by createCoreServices (shared with `xum run` CLI)
  private readonly historyService: CoreServices["historyService"];
  public readonly aiService: CoreServices["aiService"];
  public readonly workspaceService: CoreServices["workspaceService"];
  public readonly taskService: CoreServices["taskService"];
  public readonly providerService: CoreServices["providerService"];
  public readonly mcpConfigService: CoreServices["mcpConfigService"];
  public readonly mcpServerManager: CoreServices["mcpServerManager"];
  public readonly sessionUsageService: CoreServices["sessionUsageService"];
  public readonly workspaceGoalService: CoreServices["workspaceGoalService"];
  public readonly memoryService: CoreServices["memoryService"];
  public readonly memoryMetaService: CoreServices["memoryMetaService"];
  public readonly memoryConsolidationService: CoreServices["memoryConsolidationService"];
  public readonly refineService: RefineService;
  private readonly extensionMetadata: CoreServices["extensionMetadata"];
  private readonly backgroundProcessManager: CoreServices["backgroundProcessManager"];
  // Desktop-only services
  public readonly projectService: ProjectService;
  public readonly muxGatewayOauthService: MuxGatewayOauthService;
  public readonly muxGovernorOauthService: MuxGovernorOauthService;
  public readonly codexOauthService: CodexOauthService;
  public readonly coderOauthService: CoderOauthService;
  public readonly copilotOauthService: CopilotOauthService;
  public readonly backupService: BackupService;
  public readonly terminalService: TerminalService;
  public readonly editorService: EditorService;
  public readonly windowService: WindowService;
  public readonly updateService: UpdateService;
  public readonly tokenizerService: TokenizerService;
  public readonly instructionsService: InstructionsService;
  public readonly serverService: ServerService;
  public readonly menuEventService: MenuEventService;
  public readonly voiceService: VoiceService;
  public readonly mcpOauthService: McpOauthService;
  public readonly workspaceMcpOverridesService: WorkspaceMcpOverridesService;
  public readonly agentPluginInstallService: AgentPluginInstallService;
  public readonly telemetryService: TelemetryService;
  public readonly sessionTimingService: SessionTimingService;
  public readonly timelineService: TimelineService;
  public readonly devToolsService: DevToolsService;
  public readonly browserSessionDiscoveryService: AgentBrowserSessionDiscoveryService;
  public readonly browserBridgeTokenManager: BrowserBridgeTokenManager;
  public readonly browserBridgeServer: BrowserBridgeServer;
  public readonly browserControlService: BrowserControlService;
  public readonly browserSessionStateHub: BrowserSessionStateHub;
  public readonly analyticsService: AnalyticsService;
  public readonly experimentsService: ExperimentsService;
  public readonly policyService: PolicyService;
  public readonly coderService: CoderService;
  public readonly serverAuthService: ServerAuthService;
  public readonly desktopSessionManager: DesktopSessionManager;
  public readonly desktopTokenManager: DesktopTokenManager;
  public readonly desktopBridgeServer: DesktopBridgeServer;
  public readonly sshPromptService = new SshPromptService();
  private readonly ptyService: PTYService;
  public readonly idleCompactionService: IdleCompactionService;
  public readonly idleDispatcher: IdleDispatcher;
  public readonly heartbeatService: HeartbeatService;
  public readonly agentStatusService: AgentStatusService;

  constructor(config: Config) {
    this.config = config;

    // Cross-cutting services: created first so they can be passed to core
    // services via constructor params (no setter injection needed).
    this.policyService = new PolicyService(config);
    this.telemetryService = new TelemetryService(config.rootDir);
    this.experimentsService = new ExperimentsService({
      telemetryService: this.telemetryService,
      xumHome: config.rootDir,
    });
    this.backupService = new BackupService(config, {
      gitRepo: createBackupGitRepo({
        cacheRoot: path.join(config.rootDir, "backup-cache"),
      }),
      payload: createBackupPayloadStore({ config }),
    });
    this.sessionTimingService = new SessionTimingService(config, this.telemetryService);
    this.analyticsService = new AnalyticsService(config);
    this.devToolsService = new DevToolsService(config);
    this.browserBridgeTokenManager = new BrowserBridgeTokenManager();

    // Desktop passes WorkspaceMcpOverridesService explicitly so AIService uses
    // the persistent config rather than creating a default with an ephemeral one.
    this.workspaceMcpOverridesService = new WorkspaceMcpOverridesService(config);

    const core = createCoreServices({
      config,
      extensionMetadataPath: path.join(config.rootDir, "extensionMetadata.json"),
      workspaceMcpOverridesService: this.workspaceMcpOverridesService,
      policyService: this.policyService,
      telemetryService: this.telemetryService,
      analyticsService: this.analyticsService,
      experimentsService: this.experimentsService,
      sessionTimingService: this.sessionTimingService,
      devToolsService: this.devToolsService,
    });

    // Spread core services into class fields
    this.historyService = core.historyService;
    this.aiService = core.aiService;
    this.aiService.setAnalyticsService(this.analyticsService);
    this.browserSessionDiscoveryService = new AgentBrowserSessionDiscoveryService({
      resolveWorkspaceCandidatePathsFn: async (workspaceId: string) => {
        const allWorkspaceMetadata = await config.getAllWorkspaceMetadata();
        const workspaceMetadata =
          allWorkspaceMetadata.find((candidate) => candidate.id === workspaceId) ?? null;
        if (workspaceMetadata == null) {
          return [];
        }

        const runtime = createRuntimeForWorkspace(workspaceMetadata);
        const workspacePath = resolveWorkspaceExecutionPath(workspaceMetadata, runtime);
        return [workspaceMetadata.projectPath, workspacePath].filter(
          (candidatePath): candidatePath is string => candidatePath.trim().length > 0
        );
      },
    });
    this.browserControlService = new BrowserControlService({
      browserSessionDiscoveryService: this.browserSessionDiscoveryService,
      resolveSessionEnvFn: () => Promise.resolve(process.env),
    });
    this.browserSessionStateHub = new BrowserSessionStateHub({
      browserControlService: this.browserControlService,
    });
    this.browserBridgeServer = new BrowserBridgeServer({
      browserSessionDiscoveryService: this.browserSessionDiscoveryService,
      browserBridgeTokenManager: this.browserBridgeTokenManager,
      browserSessionStateHub: this.browserSessionStateHub,
    });
    this.workspaceService = core.workspaceService;
    this.taskService = core.taskService;
    this.providerService = core.providerService;
    this.mcpConfigService = core.mcpConfigService;
    this.mcpServerManager = core.mcpServerManager;
    this.sessionUsageService = core.sessionUsageService;
    this.workspaceGoalService = core.workspaceGoalService;
    this.memoryService = core.memoryService;
    this.memoryMetaService = core.memoryMetaService;
    this.memoryConsolidationService = core.memoryConsolidationService;
    this.extensionMetadata = core.extensionMetadata;
    this.backgroundProcessManager = core.backgroundProcessManager;

    // Managed Agent Plugin installer (agent-plugins experiment). Gated on the
    // backend ExperimentsService exactly like the plugin MCP provider; the
    // MCP manager dependency lets update/uninstall recycle running plugin
    // servers whose content changed behind an unchanged command line.
    this.agentPluginInstallService = new AgentPluginInstallService(config, {
      isEnabled: () => this.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.AGENT_PLUGINS),
      mcpServerManager: this.mcpServerManager,
      workspaceMcpOverridesService: this.workspaceMcpOverridesService,
    });

    this.projectService = new ProjectService(config, this.sshPromptService);
    this.projectService.setWorkspaceService(this.workspaceService);
    this.projectService.setWorkspaceMetadataRefresher(this.workspaceService);
    this.projectService.setMcpServerManager(this.mcpServerManager);
    this.desktopSessionManager = new DesktopSessionManager({
      config,
      experimentsService: this.experimentsService,
      workspaceService: this.workspaceService,
    });
    this.aiService.setDesktopSessionManager(this.desktopSessionManager);
    this.desktopTokenManager = new DesktopTokenManager();
    this.desktopBridgeServer = new DesktopBridgeServer({
      desktopSessionManager: this.desktopSessionManager,
      desktopTokenManager: this.desktopTokenManager,
    });

    // Idle compaction service - auto-compacts workspaces after configured idle period
    this.idleCompactionService = new IdleCompactionService(
      config,
      this.historyService,
      this.extensionMetadata,
      (workspaceId) => this.workspaceService.executeIdleCompaction(workspaceId)
    );
    // Forward terminal idle-compaction outcomes so the loop stops re-attempting a
    // persistently failing workspace (immediately on model_not_found, otherwise after
    // two consecutive failures).
    this.workspaceService.setIdleCompactionOutcomeListener((workspaceId, outcome) =>
      this.idleCompactionService.recordOutcome(workspaceId, outcome)
    );
    // IdleDispatcher + goal continuation bridge are owned by createCoreServices
    // so the wiring works for `xum run` too. Share the same dispatcher with
    // HeartbeatService — its priority ordering ensures an active goal
    // suppresses background heartbeats.
    this.idleDispatcher = core.idleDispatcher;
    this.heartbeatService = new HeartbeatService(
      config,
      this.extensionMetadata,
      this.workspaceService,
      this.taskService,
      this.idleDispatcher
    );
    this.timelineService = new TimelineService(
      config,
      this.historyService,
      this.experimentsService
    );
    // /refine trajectory distillation (RLM r11). Chat emission routes through
    // WorkspaceService so a live session renders the appended summary row
    // immediately (the row itself is already durable in chat.jsonl).
    this.refineService = new RefineService(
      config,
      this.memoryService,
      this.memoryMetaService,
      this.historyService,
      this.aiService,
      this.experimentsService,
      {
        timelineService: this.timelineService,
        sessionUsageService: this.sessionUsageService,
        emitChatMessage: (workspaceId, message) =>
          this.workspaceService.emitChatEvent(workspaceId, { ...message, type: "message" }),
        // r40: refine row publication and apply mutations must not interleave
        // with a concurrent turn's PREPARING snapshot or split its
        // user/assistant pair — hold the session's turn-admission block while
        // they land, failing closed when a turn is active.
        acquireTurnExclusion: (workspaceId) =>
          this.workspaceService.acquireIdleTurnExclusion(workspaceId),
      }
    );
    // Removal must be able to abort + drain a running /refine pass before it
    // deletes the session directory (post-construction wiring: RefineService
    // is built after WorkspaceService).
    this.workspaceService.setRefinePassCanceller(this.refineService);
    this.workspaceService.setTimelineRecorder(this.timelineService);
    this.taskService.setTimelineRecorder(this.timelineService);
    this.heartbeatService.setTimelineRecorder(this.timelineService);
    this.workspaceGoalService.setTimelineRecorder(this.timelineService);
    this.aiService.setTimelineService(this.timelineService);
    this.timelineService.subscribeToWorkspace(this.workspaceService);
    this.windowService = new WindowService();
    this.mcpOauthService = new McpOauthService(
      config,
      this.mcpConfigService,
      this.windowService,
      this.telemetryService
    );
    this.mcpServerManager.setMcpOauthService(this.mcpOauthService);

    this.muxGatewayOauthService = new MuxGatewayOauthService(
      config,
      this.providerService,
      this.windowService
    );
    this.muxGovernorOauthService = new MuxGovernorOauthService(
      config,
      this.windowService,
      this.policyService
    );
    this.codexOauthService = new CodexOauthService(
      config,
      this.providerService,
      this.windowService
    );
    this.aiService.setCodexOauthService(this.codexOauthService);
    this.coderOauthService = new CoderOauthService(
      config,
      this.providerService,
      this.windowService,
      // Policy-aware: an enforced forcedBaseUrl overrides the deployment URL
      // for logins, refreshes, and issuer checks.
      this.policyService
    );
    this.aiService.setCoderOauthService(this.coderOauthService);
    this.copilotOauthService = new CopilotOauthService(this.providerService, this.windowService);
    // Terminal services - PTYService is cross-platform
    this.ptyService = new PTYService();
    this.terminalService = new TerminalService(config, this.ptyService);
    // Wire terminal service to workspace service for cleanup on removal
    this.workspaceService.setTerminalService(this.terminalService);
    this.workspaceService.setDesktopSessionManager(this.desktopSessionManager);
    // Plugin-override pruning is wired inside createCoreServices (shared with
    // headless CLI registration), using this.workspaceMcpOverridesService.
    // Editor service for opening workspaces in code editors
    this.editorService = new EditorService(config, this.workspaceService);
    this.updateService = new UpdateService(this.config);
    this.tokenizerService = new TokenizerService(
      this.sessionUsageService,
      this.aiService,
      this.providerService
    );
    this.instructionsService = new InstructionsService(
      config,
      this.aiService,
      this.tokenizerService
    );
    // AgentStatusService depends on tokenizer + window focus state; instantiate
    // after both are constructed so the small-model status loop can run with
    // accurate token budgeting and focus-aware cadence.
    this.agentStatusService = new AgentStatusService(
      config,
      this.historyService,
      this.tokenizerService,
      this.extensionMetadata,
      this.workspaceService,
      this.windowService,
      this.aiService,
      // Status generation spends tokens outside StreamManager; give it a cost
      // telemetry sink so that spend shows up in per-workspace usage, and an
      // ingest trigger so the headless-usage sidecar reaches dashboard totals
      // even when the workspace has no further stream activity.
      {
        sessionUsageService: this.sessionUsageService,
        requestAnalyticsIngest: (workspaceId) => {
          this.workspaceService.emit("analyticsIngest", { workspaceId });
        },
      }
    );
    this.serverService = new ServerService();
    this.menuEventService = new MenuEventService();
    this.voiceService = new VoiceService(config, this.providerService, this.policyService);
    this.coderService = coderService;

    this.serverAuthService = new ServerAuthService(config);

    const workspaceLifecycleHooks = new WorkspaceLifecycleHooks();
    const worktreeArchiveSnapshotService = new WorktreeArchiveSnapshotService(this.config);
    this.workspaceService.setWorktreeArchiveSnapshotService(worktreeArchiveSnapshotService);
    const getArchiveBehavior = () =>
      this.config.loadConfigOrDefault().coderWorkspaceArchiveBehavior ??
      DEFAULT_CODER_ARCHIVE_BEHAVIOR;
    workspaceLifecycleHooks.registerBeforeArchive(
      createCoderArchiveHook({
        coderService: this.coderService,
        getArchiveBehavior,
        // Model-driven archives probe the remote spawn-record layout before stopping a
        // running Coder workspace: detached jobs surviving an unclean Xum exit live only in
        // those records, which the host-local crash-orphan scans cannot see.
        hasUnsettledRemoteBackgroundJobs: async (workspaceMetadata) => {
          const runtime = createRuntimeForWorkspace(workspaceMetadata);
          return await this.backgroundProcessManager.hasUnsettledRemoteSpawnRecords(
            runtime,
            workspaceMetadata.id
          );
        },
      })
    );
    workspaceLifecycleHooks.registerAfterUnarchive(
      createCoderUnarchiveHook({
        coderService: this.coderService,
        getArchiveBehavior,
      })
    );
    const getWorktreeArchiveBehavior = () =>
      this.config.loadConfigOrDefault().worktreeArchiveBehavior ??
      DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR;
    workspaceLifecycleHooks.registerAfterArchive(
      createWorktreeArchiveHook({ getWorktreeArchiveBehavior })
    );
    this.workspaceService.setWorkspaceLifecycleHooks(workspaceLifecycleHooks);

    // Register globally so all createRuntime calls can create CoderSSHRuntime
    setGlobalCoderService(this.coderService);
    setSshPromptService(this.sshPromptService);
    setSSH2SshPromptService(this.sshPromptService);

    // Backend timing stats.
    this.aiService.on("stream-start", (data: StreamStartEvent) =>
      this.sessionTimingService.handleStreamStart(data)
    );
    this.aiService.on("stream-delta", (data: StreamDeltaEvent) =>
      this.sessionTimingService.handleStreamDelta(data)
    );
    this.aiService.on("reasoning-delta", (data: ReasoningDeltaEvent) =>
      this.sessionTimingService.handleReasoningDelta(data)
    );
    this.aiService.on("tool-call-start", (data: ToolCallStartEvent) =>
      this.sessionTimingService.handleToolCallStart(data)
    );
    this.aiService.on("tool-call-delta", (data: ToolCallDeltaEvent) =>
      this.sessionTimingService.handleToolCallDelta(data)
    );
    this.aiService.on("tool-call-end", (data: ToolCallEndEvent) =>
      this.sessionTimingService.handleToolCallEnd(data)
    );
    // Newly created sub-agent workspaces are ingested here before a full rebuild,
    // so keep workspaceName + parentWorkspaceId to avoid NULL analytics attribution.
    // Multi-project workspaces stay stored under _multi in config, but analytics should
    // still attribute spend to the workspace's first real project path.
    const ingestWorkspaceAnalytics = (workspaceId: string) => {
      const workspaceLookup = this.config.findWorkspace(workspaceId);
      const sessionDir = this.config.getSessionDir(workspaceId);
      const analyticsProjectPath =
        workspaceLookup?.attributionProjectPath ?? workspaceLookup?.projectPath;
      this.analyticsService.ingestWorkspace(workspaceId, sessionDir, {
        projectPath: analyticsProjectPath,
        projectName: analyticsProjectPath ? path.basename(analyticsProjectPath) : undefined,
        workspaceName: workspaceLookup?.workspaceName,
        parentWorkspaceId: workspaceLookup?.parentWorkspaceId,
      });
    };
    this.aiService.on("stream-end", (data: StreamEndEvent) => {
      this.sessionTimingService.handleStreamEnd(data);
      ingestWorkspaceAnalytics(data.workspaceId);
    });
    // Billable usage persisted outside StreamManager stream-end requests its
    // own incremental ingest pass.
    this.workspaceService.on("analyticsIngest", (event) => {
      ingestWorkspaceAnalytics(event.workspaceId);
    });
    // Memory consolidation/harvest spend rides the headless-usage sidecar
    // without any chat activity; ingest promptly so background sweeps reach
    // dashboard totals instead of stranding until an unrelated stream-end
    // or app restart.
    this.memoryConsolidationService.on("analyticsIngest", (event: { workspaceId: string }) => {
      ingestWorkspaceAnalytics(event.workspaceId);
    });
    // WorkspaceService emits metadata:null after successful remove().
    // Clear analytics rows immediately so deleted workspaces disappear from stats
    // without waiting for a future ingest pass.
    this.workspaceService.on("metadata", (event) => {
      if (event.metadata !== null) {
        return;
      }

      // Removed sub-agent children archive their transcript into the parent's
      // session dir before this event fires. Re-ingest the parent (chained after
      // the clear) so the child's spend is restored from the archive instead of
      // vanishing from analytics until the parent's next stream-end.
      let reingestAfterClear:
        | { workspaceId: string; sessionDir: string; meta: IngestWorkspaceMeta }
        | undefined;
      const parentWorkspaceId = event.removedParentWorkspaceId;
      if (parentWorkspaceId) {
        const parentLookup = this.config.findWorkspace(parentWorkspaceId);
        const parentProjectPath = parentLookup?.attributionProjectPath ?? parentLookup?.projectPath;
        reingestAfterClear = {
          workspaceId: parentWorkspaceId,
          sessionDir: this.config.getSessionDir(parentWorkspaceId),
          meta: {
            projectPath: parentProjectPath,
            projectName: parentProjectPath ? path.basename(parentProjectPath) : undefined,
            workspaceName: parentLookup?.workspaceName,
            parentWorkspaceId: parentLookup?.parentWorkspaceId,
          },
        };
      }

      this.analyticsService.clearWorkspace(event.workspaceId, { reingestAfterClear });
    });

    this.aiService.on("stream-abort", (data: StreamAbortEvent) => {
      this.sessionTimingService.handleStreamAbort(data);
      // Aborted turns persist their spend before this event fires (same async
      // chain): normal aborts commit the usage-stamped partial to chat.jsonl
      // (or the headless sidecar for non-commit-worthy partials); abandoned
      // aborts (edit/discard) write only the sidecar. Ingest both, or the
      // interrupted turn's spend stays out of dashboards until the next
      // stream-end.
      ingestWorkspaceAnalytics(data.workspaceId);
    });
    // Errored turns whose partial would be dropped at commit time route their
    // usage to the headless sidecar (persistStreamError). The sidecar write
    // precedes this event in the same async chain, so ingest here keeps the
    // dashboard current instead of waiting for the next stream or restart.
    this.aiService.on("error", (data: ErrorEvent) => {
      ingestWorkspaceAnalytics(data.workspaceId);
    });
  }

  async initialize(): Promise<void> {
    const startupStartedAt = Date.now();
    const stepDurationsMs: Record<string, number> = {};
    const recordStep = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const stepStartedAt = Date.now();
      try {
        return await fn();
      } finally {
        stepDurationsMs[name] = Date.now() - stepStartedAt;
      }
    };

    log.info("[startup] ServiceContainer.initialize starting");

    await recordStep("extensionMetadata.initialize", () => this.extensionMetadata.initialize());
    // Initialize telemetry service
    await recordStep("telemetryService.initialize", () => this.telemetryService.initialize());

    // Initialize policy service (startup gating)
    await recordStep("policyService.initialize", () => this.policyService.initialize());

    await recordStep("experimentsService.initialize", () => this.experimentsService.initialize());
    // Kick off non-task chat restart recovery eagerly; task workspaces recover in TaskService.initialize().
    await recordStep("workspaceService.initialize", () => this.workspaceService.initialize());
    await recordStep("taskService.initialize", () => this.taskService.initialize());

    const idleCompactionStartedAt = Date.now();
    // Start idle compaction checker
    this.idleCompactionService.start();
    stepDurationsMs["idleCompactionService.start"] = Date.now() - idleCompactionStartedAt;

    const heartbeatStartedAt = Date.now();
    this.heartbeatService.start();
    stepDurationsMs["heartbeatService.start"] = Date.now() - heartbeatStartedAt;

    const agentStatusStartedAt = Date.now();
    this.agentStatusService.start();
    stepDurationsMs["agentStatusService.start"] = Date.now() - agentStatusStartedAt;

    // Dream launch sweep (PRD #3534): consolidate memory for workspaces idle
    // ≥24h with writes since their last run. Fire-and-forget after the await
    // chain — startup must never block or crash on background housekeeping.
    void this.extensionMetadata
      .getAllSnapshots()
      .then((snapshots) => {
        const recencyByWorkspace = new Map<string, number>();
        for (const [workspaceId, snapshot] of snapshots) {
          recencyByWorkspace.set(workspaceId, snapshot.recency);
        }
        return this.memoryConsolidationService.runLaunchSweep(recencyByWorkspace);
      })
      .catch((error: unknown) => {
        log.warn("[MemoryConsolidation] launch sweep failed", { error });
      });

    // Refresh xum-owned Coder SSH config in background (handles binary path changes on restart)
    // Skip getCoderInfo() to avoid caching "unavailable" if coder isn't installed yet
    void this.coderService.ensureMuxCoderSSHConfig().catch((error: unknown) => {
      log.warn("Background xum SSH config setup failed", { error });
    });

    log.info("[startup] ServiceContainer.initialize completed", {
      totalMs: Date.now() - startupStartedAt,
      stepDurationsMs,
    });
  }

  /**
   * Build the ORPCContext from this container's services.
   * Centralizes the ServiceContainer → ORPCContext mapping so callers
   * (desktop/main.ts, cli/server.ts) don't duplicate a 30-field spread.
   */
  toORPCContext(): Omit<ORPCContext, "headers"> {
    return {
      workflowRuntimeFactory: this.workflowRuntimeFactory,
      config: this.config,
      aiService: this.aiService,
      historyService: this.historyService,
      projectService: this.projectService,
      workspaceService: this.workspaceService,
      taskService: this.taskService,
      providerService: this.providerService,
      muxGatewayOauthService: this.muxGatewayOauthService,
      muxGovernorOauthService: this.muxGovernorOauthService,
      codexOauthService: this.codexOauthService,
      coderOauthService: this.coderOauthService,
      copilotOauthService: this.copilotOauthService,
      backupService: this.backupService,
      terminalService: this.terminalService,
      editorService: this.editorService,
      windowService: this.windowService,
      updateService: this.updateService,
      tokenizerService: this.tokenizerService,
      instructionsService: this.instructionsService,
      serverService: this.serverService,
      menuEventService: this.menuEventService,
      voiceService: this.voiceService,
      mcpConfigService: this.mcpConfigService,
      mcpOauthService: this.mcpOauthService,
      workspaceMcpOverridesService: this.workspaceMcpOverridesService,
      mcpServerManager: this.mcpServerManager,
      agentPluginInstallService: this.agentPluginInstallService,
      sessionTimingService: this.sessionTimingService,
      timelineService: this.timelineService,
      telemetryService: this.telemetryService,
      analyticsService: this.analyticsService,
      experimentsService: this.experimentsService,
      sessionUsageService: this.sessionUsageService,
      workspaceGoalService: this.workspaceGoalService,
      memoryService: this.memoryService,
      memoryMetaService: this.memoryMetaService,
      memoryConsolidationService: this.memoryConsolidationService,
      refineService: this.refineService,
      devToolsService: this.devToolsService,
      browserSessionDiscoveryService: this.browserSessionDiscoveryService,
      browserBridgeTokenManager: this.browserBridgeTokenManager,
      browserBridgeServer: this.browserBridgeServer,
      browserControlService: this.browserControlService,
      browserSessionStateHub: this.browserSessionStateHub,
      policyService: this.policyService,
      coderService: this.coderService,
      serverAuthService: this.serverAuthService,
      sshPromptService: this.sshPromptService,
      desktopSessionManager: this.desktopSessionManager,
      desktopTokenManager: this.desktopTokenManager,
      desktopBridgeServer: this.desktopBridgeServer,
    };
  }

  /**
   * Shutdown services that need cleanup
   */
  async shutdown(): Promise<void> {
    // Stop the bridge before closing sessions so desktop clients get a clean disconnect.
    await this.desktopBridgeServer.stop();
    this.desktopTokenManager.dispose();
    await this.desktopSessionManager.closeAll();
    this.heartbeatService.stop();
    this.agentStatusService.stop();
    this.idleCompactionService.stop();
    await this.browserBridgeServer.stop();
    this.browserSessionStateHub.dispose();
    this.browserBridgeTokenManager.dispose();
    await this.timelineService.flush();
    await this.analyticsService.dispose();
    await this.telemetryService.shutdown();
  }

  setProjectDirectoryPicker(picker: (initialPath?: string | null) => Promise<string | null>): void {
    this.projectService.setDirectoryPicker(picker);
  }

  setTerminalWindowManager(manager: TerminalWindowManager): void {
    this.terminalService.setTerminalWindowManager(manager);
  }

  /**
   * Dispose all services. Called on app quit to clean up resources.
   * Terminates all background processes to prevent orphans.
   */
  async dispose(): Promise<void> {
    // Must run before any session teardown: AgentSession.dispose() triggers
    // backgroundProcessManager.cleanup(), which would otherwise erase the persisted
    // armed-monitor registry records that drive post-restart "monitor lost" wakes.
    this.backgroundProcessManager.beginShutdown();
    // Stop the bridge before closing sessions so desktop clients get a clean disconnect.
    await this.desktopBridgeServer.stop();
    this.desktopTokenManager.dispose();
    await this.desktopSessionManager.closeAll();
    // Stop the periodic AgentStatusService loop here too (not just in
    // shutdown()): dispose() is the path used by the desktop before-quit
    // and ACP in-process close handlers, and the ref'd setInterval would
    // otherwise keep the process alive and continue calling
    // generateWorkspaceStatus against services that are about to be torn
    // down below.
    this.agentStatusService.stop();
    await this.browserBridgeServer.stop();
    this.browserSessionStateHub.dispose();
    this.browserBridgeTokenManager.dispose();
    await this.analyticsService.dispose();
    this.policyService.dispose();
    this.mcpServerManager.dispose();
    await this.mcpOauthService.dispose();
    await this.muxGatewayOauthService.dispose();
    await this.muxGovernorOauthService.dispose();
    await this.codexOauthService.dispose();
    await this.coderOauthService.dispose();

    this.copilotOauthService.dispose();
    this.serverAuthService.dispose();
    this.providerService.dispose();
    await this.backgroundProcessManager.terminateAll();
    await this.timelineService.flush();
  }
}
