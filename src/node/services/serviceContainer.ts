import { log } from "@/node/services/log";
import type { Config, ConfigStores, WorkspaceSessionLocator } from "@/node/config";
import type { FileLeaseManager, ProvidersConfigStore, SecretsStore } from "@/node/config";
import type { CoreServices } from "@/node/services/coreServices";
import type { TerminalWindowManager } from "@/desktop/terminalWindowManager";
import type { ProjectService } from "@/node/services/projectService";
import type { MuxGatewayOauthService } from "@/node/services/muxGatewayOauthService";
import type { MuxGovernorOauthService } from "@/node/services/muxGovernorOauthService";
import type { CodexOauthService } from "@/node/services/codexOauthService";
import type { CoderOauthService } from "@/node/services/coderOauthService";
import type { CopilotOauthService } from "@/node/services/copilotOauthService";
import type { TerminalService } from "@/node/services/terminalService";
import type { BackupService } from "@/node/services/backup/backupService";
import type { EditorService } from "@/node/services/editorService";
import type { WindowService } from "@/node/services/windowService";
import type { UpdateService } from "@/node/services/updateService";
import type { TokenizerService } from "@/node/services/tokenizerService";
import type { InstructionsService } from "@/node/services/instructionsService";
import type { ServerService } from "@/node/services/serverService";
import type { MenuEventService } from "@/node/services/menuEventService";
import type { VoiceService } from "@/node/services/voiceService";
import type { TelemetryService } from "@/node/services/telemetryService";
import type { BrowserBridgeServer } from "@/node/services/browser/BrowserBridgeServer";
import type { AgentBrowserSessionDiscoveryService } from "@/node/services/browser/AgentBrowserSessionDiscoveryService";
import type { BrowserBridgeTokenManager } from "@/node/services/browser/BrowserBridgeTokenManager";
import type { BrowserControlService } from "@/node/services/browser/BrowserControlService";
import type { BrowserSessionStateHub } from "@/node/services/browser/BrowserSessionStateHub";
import type { DevToolsService } from "@/node/services/devToolsService";
import type { SessionTimingService } from "@/node/services/sessionTimingService";
import type { TimelineService } from "@/node/services/timelineService";
import type { AnalyticsService } from "@/node/services/analytics/analyticsService";
import type { ExperimentsService } from "@/node/services/experimentsService";
import type { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import type { AgentPluginInstallService } from "@/node/services/agentPlugins/installService";
import type { McpOauthService } from "@/node/services/mcpOauthService";
import type { HeartbeatService } from "@/node/services/heartbeatService";
import type { AgentStatusService } from "@/node/services/agentStatusService";
import type { IdleCompactionService } from "@/node/services/idleCompactionService";
import type { IdleDispatcher } from "@/node/services/idleDispatcher";
import type { CoderService } from "@/node/services/coderService";
import type { SshPromptService } from "@/node/services/sshPromptService";
import type { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import type { RefineService } from "@/node/services/refinement/refineService";
import type { PolicyService } from "@/node/services/policyService";
import type { ServerAuthService } from "@/node/services/serverAuthService";
import type { DesktopBridgeServer } from "@/node/services/desktop/DesktopBridgeServer";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import type { DesktopTokenManager } from "@/node/services/desktop/DesktopTokenManager";
import type { ORPCContext } from "@/node/orpc/context";
import type { Scope } from "effect";
import { AppFiberScopeTag } from "@/node/services/di/appFiberScope";
import {
  closeScopeBounded,
  disposeAppRuntime,
  makeAppRuntime,
  type AppRuntime,
} from "@/node/services/di/appRuntime";
import { AppLive } from "@/node/services/di/layers/app";
import { shutdownStep } from "@/node/services/shutdownStep";
import {
  AgentBrowserSessionDiscovery,
  AgentPluginInstall,
  AgentStatus,
  AI,
  Analytics,
  BackgroundProcessManagerTag,
  Backup,
  BrowserBridgeServerTag,
  BrowserBridgeTokenManagerTag,
  BrowserControl,
  BrowserSessionStateHubTag,
  Coder,
  CoderOauth,
  CodexOauth,
  ConfigTag,
  CopilotOauth,
  DesktopBridgeServerTag,
  DesktopSessionManagerTag,
  DesktopTokenManagerTag,
  DevTools,
  Editor,
  Experiments,
  ExtensionMetadata,
  FileLeaseManagerTag,
  Heartbeat,
  History,
  IdleCompaction,
  IdleDispatcherTag,
  InitStateManagerTag,
  Instructions,
  MCPConfig,
  McpOauth,
  MCPServerManagerTag,
  Memory,
  MemoryConsolidation,
  MemoryMeta,
  MenuEvent,
  MuxGatewayOauth,
  MuxGovernorOauth,
  Policy,
  Project,
  Provider,
  ProvidersConfigStoreTag,
  QuickJSRuntimeFactoryTag,
  Refine,
  SecretsStoreTag,
  Server,
  ServerAuth,
  SessionLocatorTag,
  SessionTiming,
  SessionUsage,
  SshPrompt,
  StreamManagerTag,
  Task,
  Telemetry,
  Terminal,
  Timeline,
  Tokenizer,
  Update,
  Voice,
  WindowTag,
  Workspace,
  WorkspaceGoal,
  WorkspaceMcpOverrides,
  WorkspaceTurnManagerTag,
  type AppTags,
} from "@/node/services/di/tags";
/**
 * ServiceContainer - Central dependency container for all backend services.
 *
 * Every service is built by the Effect Layer graph (`di/layers/app.ts`: the
 * stores, the runtime seams, the cross-cutting services, the core graph shared
 * with the CLI roots, and the desktop group layers with their wiring). The
 * constructor builds that graph once, eagerly and synchronously, and exposes
 * the services as plain fields for the ORPC context; startup (`initialize()`)
 * and the hand-ordered teardown (`dispose()`/`shutdown()`) stay here (DI
 * contract in `di/appRuntime.ts`).
 */
export class ServiceContainer {
  public readonly runtime: AppRuntime<AppTags>;
  /**
   * Supervised fiber scope owned by the runtime (`di/appFiberScope.ts`).
   * Closed early in `dispose()`; no production occupant yet.
   */
  public readonly appFiberScope: Scope.Closeable;
  public readonly workflowRuntimeFactory: QuickJSRuntimeFactory;
  public readonly config: Config;
  public readonly sessionLocator: WorkspaceSessionLocator;
  public readonly providersConfigStore: ProvidersConfigStore;
  public readonly secretsStore: SecretsStore;
  public readonly fileLeaseManager: FileLeaseManager;
  // Core services — built by the shared core graph layer (`di/layers/core.ts`;
  // the same definitions back the `xum run`/`xum workflow` roots)
  private readonly historyService: CoreServices["historyService"];
  public readonly aiService: CoreServices["aiService"];
  public readonly streamManager: CoreServices["streamManager"];
  public readonly initStateManager: CoreServices["initStateManager"];
  public readonly workspaceService: CoreServices["workspaceService"];
  public readonly taskService: CoreServices["taskService"];
  public readonly workspaceTurnManager: CoreServices["workspaceTurnManager"];
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
  // Desktop-only services (`di/layers/desktop.ts`)
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
  public readonly sshPromptService: SshPromptService;
  public readonly idleCompactionService: IdleCompactionService;
  public readonly idleDispatcher: IdleDispatcher;
  public readonly heartbeatService: HeartbeatService;
  public readonly agentStatusService: AgentStatusService;
  /**
   * The in-flight (or completed) `dispose()` teardown. Every caller shares it,
   * so a concurrent or repeated dispose() (the desktop's two before-quit
   * paths, tests' dispose-then-shutdown) awaits the one sequence instead of
   * re-running steps — in particular it cannot observe the AppFiberScope as
   * already closed and start tearing down dependencies while the first call
   * is still awaiting the scope's fibers.
   */
  private disposePromise: Promise<void> | null = null;

  constructor(stores: ConfigStores) {
    // Built eagerly and synchronously: a layer body that throws fails the
    // constructor, like any service constructor did before the graph existed.
    this.runtime = makeAppRuntime(AppLive(stores));
    const get = this.runtime.get;
    this.appFiberScope = get(AppFiberScopeTag);
    this.workflowRuntimeFactory = get(QuickJSRuntimeFactoryTag);
    this.config = get(ConfigTag);
    this.sessionLocator = get(SessionLocatorTag);
    this.providersConfigStore = get(ProvidersConfigStoreTag);
    this.secretsStore = get(SecretsStoreTag);
    this.fileLeaseManager = get(FileLeaseManagerTag);
    this.historyService = get(History);
    this.aiService = get(AI);
    this.streamManager = get(StreamManagerTag);
    this.initStateManager = get(InitStateManagerTag);
    this.workspaceService = get(Workspace);
    this.taskService = get(Task);
    this.workspaceTurnManager = get(WorkspaceTurnManagerTag);
    this.providerService = get(Provider);
    this.mcpConfigService = get(MCPConfig);
    this.mcpServerManager = get(MCPServerManagerTag);
    this.sessionUsageService = get(SessionUsage);
    this.workspaceGoalService = get(WorkspaceGoal);
    this.memoryService = get(Memory);
    this.memoryMetaService = get(MemoryMeta);
    this.memoryConsolidationService = get(MemoryConsolidation);
    this.refineService = get(Refine);
    this.extensionMetadata = get(ExtensionMetadata);
    this.backgroundProcessManager = get(BackgroundProcessManagerTag);
    this.projectService = get(Project);
    this.muxGatewayOauthService = get(MuxGatewayOauth);
    this.muxGovernorOauthService = get(MuxGovernorOauth);
    this.codexOauthService = get(CodexOauth);
    this.coderOauthService = get(CoderOauth);
    this.copilotOauthService = get(CopilotOauth);
    this.backupService = get(Backup);
    this.terminalService = get(Terminal);
    this.editorService = get(Editor);
    this.windowService = get(WindowTag);
    this.updateService = get(Update);
    this.tokenizerService = get(Tokenizer);
    this.instructionsService = get(Instructions);
    this.serverService = get(Server);
    this.menuEventService = get(MenuEvent);
    this.voiceService = get(Voice);
    this.mcpOauthService = get(McpOauth);
    this.workspaceMcpOverridesService = get(WorkspaceMcpOverrides);
    this.agentPluginInstallService = get(AgentPluginInstall);
    this.telemetryService = get(Telemetry);
    this.sessionTimingService = get(SessionTiming);
    this.timelineService = get(Timeline);
    this.devToolsService = get(DevTools);
    this.browserSessionDiscoveryService = get(AgentBrowserSessionDiscovery);
    this.browserBridgeTokenManager = get(BrowserBridgeTokenManagerTag);
    this.browserBridgeServer = get(BrowserBridgeServerTag);
    this.browserControlService = get(BrowserControl);
    this.browserSessionStateHub = get(BrowserSessionStateHubTag);
    this.analyticsService = get(Analytics);
    this.experimentsService = get(Experiments);
    this.policyService = get(Policy);
    this.coderService = get(Coder);
    this.serverAuthService = get(ServerAuth);
    this.desktopSessionManager = get(DesktopSessionManagerTag);
    this.desktopTokenManager = get(DesktopTokenManagerTag);
    this.desktopBridgeServer = get(DesktopBridgeServerTag);
    this.sshPromptService = get(SshPrompt);
    this.idleCompactionService = get(IdleCompaction);
    this.idleDispatcher = get(IdleDispatcherTag);
    this.heartbeatService = get(Heartbeat);
    this.agentStatusService = get(AgentStatus);
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
      // The runtime's built service context, consumed by Effect-native oRPC
      // handlers (`yield* MemoryMeta`; see src/node/orpc/effectContext.ts).
      "effect/context": this.runtime.context,
      workflowRuntimeFactory: this.workflowRuntimeFactory,
      config: this.config,
      sessionLocator: this.sessionLocator,
      providersConfigStore: this.providersConfigStore,
      secretsStore: this.secretsStore,
      fileLeaseManager: this.fileLeaseManager,
      aiService: this.aiService,
      historyService: this.historyService,
      streamManager: this.streamManager,
      initStateManager: this.initStateManager,
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
   * Terminates all background processes to prevent orphans. Idempotent:
   * concurrent and repeated calls share one teardown (see `disposePromise`).
   */
  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce();
    return this.disposePromise;
  }

  /**
   * The §5 teardown order (di/appRuntime.ts). Every step reports its duration
   * as a `[shutdown]` debug line via `shutdownStep` (synchronous steps without
   * a suspension point), so a quit transcript localizes a slow or hung step;
   * `closeScopeBounded`/`disposeAppRuntime` write their own lines.
   */
  private async disposeOnce(): Promise<void> {
    const disposeStartedAt = performance.now();
    log.debug("[shutdown] ServiceContainer.dispose starting");
    // Must run before any session teardown: AgentSession.dispose() triggers
    // backgroundProcessManager.cleanup(), which would otherwise erase the persisted
    // armed-monitor registry records that drive post-restart "monitor lost" wakes.
    shutdownStep("backgroundProcessManager.beginShutdown", () =>
      this.backgroundProcessManager.beginShutdown()
    );
    // Interrupt and await the runtime's supervised fibers while every dependency
    // they might touch during finalization is still alive. Fixed here (before
    // the explicit teardown) so later occupants do not re-derive the position;
    // bounded and idempotent, and never rejects (di/appRuntime.ts).
    await closeScopeBounded(this.appFiberScope);
    // Stop the bridge before closing sessions so desktop clients get a clean disconnect.
    await shutdownStep("desktopBridgeServer.stop", () => this.desktopBridgeServer.stop());
    shutdownStep("desktopTokenManager.dispose", () => this.desktopTokenManager.dispose());
    await shutdownStep("desktopSessionManager.closeAll", () =>
      this.desktopSessionManager.closeAll()
    );
    // Stop the periodic AgentStatusService loop here too (not just in
    // shutdown()): dispose() is the path used by the desktop before-quit
    // and ACP in-process close handlers, and the ref'd setInterval would
    // otherwise keep the process alive and continue calling
    // generateWorkspaceStatus against services that are about to be torn
    // down below.
    shutdownStep("agentStatusService.stop", () => this.agentStatusService.stop());
    await shutdownStep("browserBridgeServer.stop", () => this.browserBridgeServer.stop());
    shutdownStep("browserSessionStateHub.dispose", () => this.browserSessionStateHub.dispose());
    shutdownStep("browserBridgeTokenManager.dispose", () =>
      this.browserBridgeTokenManager.dispose()
    );
    await shutdownStep("analyticsService.dispose", () => this.analyticsService.dispose());
    shutdownStep("policyService.dispose", () => this.policyService.dispose());
    shutdownStep("mcpServerManager.dispose", () => this.mcpServerManager.dispose());
    await shutdownStep("mcpOauthService.dispose", () => this.mcpOauthService.dispose());
    await shutdownStep("muxGatewayOauthService.dispose", () =>
      this.muxGatewayOauthService.dispose()
    );
    await shutdownStep("muxGovernorOauthService.dispose", () =>
      this.muxGovernorOauthService.dispose()
    );
    await shutdownStep("codexOauthService.dispose", () => this.codexOauthService.dispose());
    await shutdownStep("coderOauthService.dispose", () => this.coderOauthService.dispose());

    shutdownStep("copilotOauthService.dispose", () => this.copilotOauthService.dispose());
    shutdownStep("serverAuthService.dispose", () => this.serverAuthService.dispose());
    shutdownStep("providerService.dispose", () => this.providerService.dispose());
    await shutdownStep("backgroundProcessManager.terminateAll", () =>
      this.backgroundProcessManager.terminateAll()
    );
    await shutdownStep("timelineService.flush", () => this.timelineService.flush());
    // Last: close the Effect runtime's scope. No layer owns finalizers yet, so
    // this only releases the runtime; the position (after every explicit
    // teardown step) is fixed now for later scope-owned occupants.
    await disposeAppRuntime(this.runtime.managed);
    log.debug("[shutdown] ServiceContainer.dispose completed", {
      totalMs: Math.round(performance.now() - disposeStartedAt),
    });
  }
}
