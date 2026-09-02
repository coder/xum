import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Context, Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import { createConfigStores, type Config, type ConfigStores } from "@/node/config";
import type { ORPCContext } from "@/node/orpc/context";
import { isInteractiveHostKeyApprovalAvailable } from "@/node/runtime/sshConnectionPool";
import { AppFiberScopeTag } from "@/node/services/di/appFiberScope";
import { EffectRunnerTag } from "@/node/services/di/effectRunner";
import * as appLayers from "@/node/services/di/layers/app";
import { CoreOptionsTag } from "@/node/services/di/layers/core";
import {
  AgentBrowserSessionDiscovery,
  AgentPluginInstall,
  AI,
  Analytics,
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
  FileLeaseManagerTag,
  History,
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
  TurnRequestBuilderBindingsTag,
  Update,
  Voice,
  WindowTag,
  Workspace,
  WorkspaceGoal,
  WorkspaceLifecycleHooksTag,
  WorkspaceMcpOverrides,
  WorktreeArchiveSnapshot,
  type AppTags,
} from "@/node/services/di/tags";
import { ServiceContainer } from "./serviceContainer";

/**
 * Independent field → tag listing for every ORPC context field (the production
 * mapping lives in the Layer files); `Record<keyof …>` keeps it exhaustive, so
 * a field added to `ORPCContext` without a tag fails to compile here.
 */
const ORPC_FIELD_TAGS: Record<
  keyof Omit<ORPCContext, "headers" | "effect/context" | "effect/wrap">,
  Context.Key<AppTags, unknown>
> = {
  config: ConfigTag,
  sessionLocator: SessionLocatorTag,
  providersConfigStore: ProvidersConfigStoreTag,
  secretsStore: SecretsStoreTag,
  fileLeaseManager: FileLeaseManagerTag,
  aiService: AI,
  historyService: History,
  streamManager: StreamManagerTag,
  initStateManager: InitStateManagerTag,
  projectService: Project,
  workspaceService: Workspace,
  taskService: Task,
  providerService: Provider,
  muxGatewayOauthService: MuxGatewayOauth,
  muxGovernorOauthService: MuxGovernorOauth,
  codexOauthService: CodexOauth,
  coderOauthService: CoderOauth,
  copilotOauthService: CopilotOauth,
  backupService: Backup,
  terminalService: Terminal,
  editorService: Editor,
  windowService: WindowTag,
  updateService: Update,
  tokenizerService: Tokenizer,
  serverService: Server,
  menuEventService: MenuEvent,
  voiceService: Voice,
  mcpConfigService: MCPConfig,
  mcpOauthService: McpOauth,
  workspaceMcpOverridesService: WorkspaceMcpOverrides,
  mcpServerManager: MCPServerManagerTag,
  agentPluginInstallService: AgentPluginInstall,
  sessionTimingService: SessionTiming,
  timelineService: Timeline,
  telemetryService: Telemetry,
  experimentsService: Experiments,
  memoryService: Memory,
  memoryMetaService: MemoryMeta,
  memoryConsolidationService: MemoryConsolidation,
  refineService: Refine,
  sessionUsageService: SessionUsage,
  instructionsService: Instructions,
  workspaceGoalService: WorkspaceGoal,
  devToolsService: DevTools,
  browserSessionDiscoveryService: AgentBrowserSessionDiscovery,
  browserBridgeTokenManager: BrowserBridgeTokenManagerTag,
  browserBridgeServer: BrowserBridgeServerTag,
  browserControlService: BrowserControl,
  browserSessionStateHub: BrowserSessionStateHubTag,
  policyService: Policy,
  coderService: Coder,
  serverAuthService: ServerAuth,
  sshPromptService: SshPrompt,
  analyticsService: Analytics,
  desktopSessionManager: DesktopSessionManagerTag,
  desktopTokenManager: DesktopTokenManagerTag,
  desktopBridgeServer: DesktopBridgeServerTag,
  workflowRuntimeFactory: QuickJSRuntimeFactoryTag,
};

describe("ServiceContainer", () => {
  let tempDir: string;
  let config: Config;
  let stores: ConfigStores;
  let services: ServiceContainer | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-service-container-test-"));
    stores = createConfigStores(tempDir);
    config = stores.config;
  });

  afterEach(async () => {
    if (services) {
      await services.dispose();
      await services.shutdown();
      services = undefined;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("attributes multi-project stream-end analytics to the primary project path", async () => {
    const primaryProjectPath = "/fake/project-a";
    const secondaryProjectPath = "/fake/project-b";
    const workspaceId = "workspace-1";
    const workspaceName = "feature-branch";
    const workspacePath = path.join(config.srcDir, "project-a+project-b", workspaceName);

    await config.editConfig((cfg) => {
      cfg.projects.set(MULTI_PROJECT_CONFIG_KEY, {
        workspaces: [
          {
            path: workspacePath,
            id: workspaceId,
            name: workspaceName,
            parentWorkspaceId: "parent-workspace",
            projects: [
              { projectName: "project-a", projectPath: primaryProjectPath },
              { projectName: "project-b", projectPath: secondaryProjectPath },
            ],
            runtimeConfig: { type: "local" },
          },
        ],
      });
      return cfg;
    });

    services = new ServiceContainer(stores);
    const ingestWorkspaceSpy = spyOn(
      services.analyticsService,
      "ingestWorkspace"
    ).mockImplementation(() => undefined);

    services.aiService.emit("stream-end", {
      type: "stream-end",
      workspaceId,
      messageId: "message-1",
      metadata: { model: "openai:gpt-4o" },
      parts: [],
    });

    expect(ingestWorkspaceSpy).toHaveBeenCalledWith(
      workspaceId,
      path.join(config.sessionsDir, workspaceId),
      {
        projectPath: primaryProjectPath,
        projectName: path.basename(primaryProjectPath),
        workspaceName,
        parentWorkspaceId: "parent-workspace",
      }
    );
  });

  it("exposes desktopSessionManager in the ORPC context", () => {
    services = new ServiceContainer(stores);

    const context = services.toORPCContext();

    expect(context.desktopSessionManager).toBe(services.desktopSessionManager);
  });

  it("closes desktop sessions during shutdown", async () => {
    services = new ServiceContainer(stores);
    const closeAllSpy = spyOn(services.desktopSessionManager, "closeAll").mockImplementation(() =>
      Promise.resolve(undefined)
    );

    await services.shutdown();

    expect(closeAllSpy).toHaveBeenCalledTimes(1);
  });

  it("closes desktop sessions during dispose", async () => {
    services = new ServiceContainer(stores);
    const closeAllSpy = spyOn(services.desktopSessionManager, "closeAll").mockImplementation(() =>
      Promise.resolve(undefined)
    );

    await services.dispose();

    expect(closeAllSpy).toHaveBeenCalledTimes(1);
  });

  it("serves the layer-built MemoryMetaService through both the field and the Effect context", () => {
    services = new ServiceContainer(stores);

    const effectContext = services.toORPCContext()["effect/context"];

    // One instance: constructor-wired consumers (memoryService, refineService)
    // and Effect-native oRPC handlers (`yield* MemoryMeta`) must share state.
    expect(Context.get(effectContext, MemoryMeta)).toBe(services.memoryMetaService);
    expect(services.runtime.get(MemoryMeta)).toBe(services.memoryMetaService);
  });

  it("closes the Effect runtime as the last dispose step", async () => {
    services = new ServiceContainer(stores);
    const container = services;
    let runtimeAliveAtLastExplicitStep: boolean | undefined;
    // timelineService.flush() is the final explicit teardown step; the runtime
    // must still be alive when it runs and gone once dispose() resolves.
    const flushSpy = spyOn(services.timelineService, "flush").mockImplementation(() => {
      runtimeAliveAtLastExplicitStep = container.runtime.managed.cachedContext !== undefined;
      return Promise.resolve(undefined);
    });

    await services.dispose();

    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(runtimeAliveAtLastExplicitStep).toBe(true);
    // ManagedRuntime clears its cached context when its scope closes.
    expect(services.runtime.managed.cachedContext).toBeUndefined();
    // The afterEach dispose()+shutdown() pair then exercises the latched path.
  });

  it("exposes the runtime seams through the field and the Effect context", () => {
    services = new ServiceContainer(stores);

    const effectContext = services.toORPCContext()["effect/context"];

    expect(Context.get(effectContext, AppFiberScopeTag)).toBe(services.appFiberScope);
    expect(services.appFiberScope.state._tag).not.toBe("Closed");
    expect(Context.get(effectContext, EffectRunnerTag)).toBe(services.runtime.get(EffectRunnerTag));
  });

  it("closes the AppFiberScope (interrupt + await) before the explicit teardown steps", async () => {
    services = new ServiceContainer(stores);
    const steps: string[] = [];
    // An I/O-suspended occupant: never resolves on its own, records its cancel
    // path and finalizer. Supervised fibers must be gone before any explicit
    // teardown step so they can still use their dependencies while finalizing.
    services.runtime.managed.runSync(
      Effect.forkIn(
        Effect.callback<void>(() =>
          Effect.sync(() => {
            steps.push("occupant-cancelled");
          })
        ).pipe(Effect.ensuring(Effect.sync(() => steps.push("occupant-finalized")))),
        services.appFiberScope
      )
    );
    // desktopBridgeServer.stop() is the first explicit teardown step after the
    // shutdown latch.
    const bridgeStopSpy = spyOn(services.desktopBridgeServer, "stop").mockImplementation(() => {
      steps.push("bridge-stop");
      return Promise.resolve(undefined);
    });

    await services.dispose();

    expect(bridgeStopSpy).toHaveBeenCalledTimes(1);
    expect(steps).toEqual(["occupant-cancelled", "occupant-finalized", "bridge-stop"]);
    expect(services.appFiberScope.state._tag).toBe("Closed");
  });

  it("shares one teardown across concurrent dispose() calls", async () => {
    services = new ServiceContainer(stores);
    const steps: string[] = [];
    // An occupant whose finalization is asynchronous: the first dispose() is
    // still awaiting it when the second dispose() arrives. Without a shared
    // teardown the second call would find the scope already marked closed and
    // proceed to the explicit steps while this finalizer is still running.
    services.runtime.managed.runSync(
      Effect.forkIn(
        Effect.callback<void>(() => Effect.void).pipe(
          Effect.ensuring(
            Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 30))).pipe(
              Effect.andThen(Effect.sync(() => steps.push("occupant-finalized")))
            )
          )
        ),
        services.appFiberScope
      )
    );
    const bridgeStopSpy = spyOn(services.desktopBridgeServer, "stop").mockImplementation(() => {
      steps.push("bridge-stop");
      return Promise.resolve(undefined);
    });

    await Promise.all([services.dispose(), services.dispose()]);

    expect(bridgeStopSpy).toHaveBeenCalledTimes(1);
    expect(steps).toEqual(["occupant-finalized", "bridge-stop"]);
  });

  it("runs the clock-driven workers on the runtime's clock", async () => {
    // Inject a TestClock beneath the real graph: EffectRunnerLive captures it,
    // so the workers' lifecycle fibers sleep on virtual time if (and only if)
    // the container hands them the runtime's runner.
    const realAppLive = appLayers.AppLive;
    const appLiveSpy = spyOn(appLayers, "AppLive").mockImplementation((appStores) =>
      realAppLive(appStores).pipe(Layer.provideMerge(TestClock.layer()))
    );
    try {
      services = new ServiceContainer(stores);
    } finally {
      appLiveSpy.mockRestore();
    }
    const runtime = services.runtime.managed;
    // IdleCompactionService.checkAllWorkspaces reads the config synchronously
    // at the start of every check.
    const loadConfigSpy = spyOn(services.config, "loadConfigOrDefault");
    // HeartbeatService's observable lifecycle contract: the scheduler fiber is
    // held in `startupTimeout` during the startup delay and moves to
    // `checkInterval` once ticking (same shape heartbeatService.test.ts pins).
    const heartbeatInternals = services.heartbeatService as unknown as {
      startupTimeout: unknown;
      checkInterval: unknown;
    };

    services.idleCompactionService.start();
    services.heartbeatService.start();
    expect(loadConfigSpy).not.toHaveBeenCalled();
    expect(heartbeatInternals.startupTimeout).not.toBeNull();
    expect(heartbeatInternals.checkInterval).toBeNull();

    // Both workers wait one minute before their first tick.
    await runtime.runPromise(TestClock.adjust(Duration.minutes(1)));

    expect(loadConfigSpy).toHaveBeenCalledTimes(1);
    expect(heartbeatInternals.startupTimeout).toBeNull();
    expect(heartbeatInternals.checkInterval).not.toBeNull();

    services.heartbeatService.stop();
    services.idleCompactionService.stop();
  });

  it("serves every ORPC context field through its tag (one instance each)", () => {
    services = new ServiceContainer(stores);
    const orpcContext = services.toORPCContext();
    const effectContext = orpcContext["effect/context"];

    for (const [field, tag] of Object.entries(ORPC_FIELD_TAGS) as Array<
      [keyof typeof ORPC_FIELD_TAGS, Context.Key<AppTags, unknown>]
    >) {
      expect(Context.get(effectContext, tag)).toBe(orpcContext[field]);
    }
    expect(services.runtime.get(IdleDispatcherTag)).toBe(services.idleDispatcher);
    expect(services.runtime.get(StreamManagerTag).effectRunner).toBe(
      services.runtime.get(EffectRunnerTag)
    );
    // The core graph's options are derived from the layer-built cross-cutting
    // instances, so core constructors received the same objects the fields expose.
    const coreOptions = services.runtime.get(CoreOptionsTag);
    expect(coreOptions.policyService).toBe(services.policyService);
    expect(coreOptions.experimentsService).toBe(services.experimentsService);
  });

  it("wires the desktop services like the constructor did (each line has an observable effect)", () => {
    services = new ServiceContainer(stores);

    // turnRequestBuilderBindings: the desktop-only collaborators.
    const bindings = services.runtime.get(TurnRequestBuilderBindingsTag);
    expect(bindings.analyticsService).toBe(services.analyticsService);
    expect(bindings.desktopSessionManager).toBe(services.desktopSessionManager);
    expect(bindings.timelineService).toBe(services.timelineService);
    expect(bindings.codexOauthService).toBe(services.codexOauthService);
    expect(bindings.coderOauthService).toBe(services.coderOauthService);

    // Setter-provided collaborators (the former `set*` lines).
    const workspaceInternals = services.workspaceService as unknown as {
      terminalService?: unknown;
      desktopSessionManager?: unknown;
      refinePassCanceller?: unknown;
      timelineRecorder?: unknown;
      worktreeArchiveSnapshotService?: unknown;
      workspaceLifecycleHooks?: unknown;
    };
    expect(workspaceInternals.terminalService).toBe(services.terminalService);
    expect(workspaceInternals.desktopSessionManager).toBe(services.desktopSessionManager);
    expect(workspaceInternals.refinePassCanceller).toBe(services.refineService);
    expect(workspaceInternals.timelineRecorder).toBe(services.timelineService);
    expect(workspaceInternals.worktreeArchiveSnapshotService).toBe(
      services.runtime.get(WorktreeArchiveSnapshot)
    );
    expect(workspaceInternals.workspaceLifecycleHooks).toBe(
      services.runtime.get(WorkspaceLifecycleHooksTag)
    );
    for (const recorderOwner of [
      services.taskService,
      services.heartbeatService,
      services.workspaceGoalService,
    ]) {
      expect((recorderOwner as unknown as { timelineRecorder?: unknown }).timelineRecorder).toBe(
        services.timelineService
      );
    }
    const projectInternals = services.projectService as unknown as {
      workspaceService?: unknown;
      workspaceMetadataRefresher?: unknown;
      mcpServerManager?: unknown;
    };
    expect(projectInternals.workspaceService).toBe(services.workspaceService);
    expect(projectInternals.workspaceMetadataRefresher).toBe(services.workspaceService);
    expect(projectInternals.mcpServerManager).toBe(services.mcpServerManager);
    expect(
      (services.mcpServerManager as unknown as { mcpOauthService?: unknown }).mcpOauthService
    ).toBe(services.mcpOauthService);
    const backupInternals = services.backupService as unknown as {
      projectRegistrar?: unknown;
      memoryNotifier?: unknown;
    };
    expect(backupInternals.projectRegistrar).toBe(services.projectService);
    expect(backupInternals.memoryNotifier).toBe(services.memoryService);

    // Idle-compaction outcomes reach the idle compaction service.
    const recordOutcomeSpy = spyOn(services.idleCompactionService, "recordOutcome");
    const outcomeListener = (
      services.workspaceService as unknown as {
        idleCompactionOutcomeListener?: (workspaceId: string, outcome: unknown) => void;
      }
    ).idleCompactionOutcomeListener;
    outcomeListener?.("ws-1", { success: true });
    expect(recordOutcomeSpy).toHaveBeenCalledWith("ws-1", { success: true });

    // Global registrations: the SSH connection pools consult this container's
    // prompt service for interactive host-key approval.
    const responderSpy = spyOn(services.sshPromptService, "hasInteractiveResponder");
    responderSpy.mockReturnValue(true);
    expect(isInteractiveHostKeyApprovalAvailable()).toBe(true);
    responderSpy.mockReturnValue(false);
    expect(isInteractiveHostKeyApprovalAvailable()).toBe(false);

    // Timeline subscribed to the workspace service, and the workers' timing
    // listeners registered: a stream-start reaches the session timing service.
    const timingSpy = spyOn(services.sessionTimingService, "handleStreamStart").mockImplementation(
      () => undefined
    );
    services.aiService.emit("stream-start", {
      type: "stream-start",
      workspaceId: "ws-1",
      messageId: "m-1",
      model: "openai:gpt-4o",
      historySequence: 1,
      startTime: Date.now(),
      mode: "exec",
    });
    expect(timingSpy).toHaveBeenCalledTimes(1);
  });

  it("tears down in the fixed dispose() and shutdown() order", async () => {
    const order: string[] = [];
    const record = (step: string) => () => {
      order.push(step);
      return Promise.resolve(undefined);
    };
    services = new ServiceContainer(stores);
    spyOn(services.desktopBridgeServer, "stop").mockImplementation(record("bridge.stop"));
    spyOn(services.desktopSessionManager, "closeAll").mockImplementation(
      record("sessions.closeAll")
    );
    spyOn(services.browserBridgeServer, "stop").mockImplementation(record("browserBridge.stop"));
    spyOn(services.analyticsService, "dispose").mockImplementation(record("analytics.dispose"));
    spyOn(services.timelineService, "flush").mockImplementation(record("timeline.flush"));
    spyOn(services.telemetryService, "shutdown").mockImplementation(record("telemetry.shutdown"));

    await services.dispose();
    // §5: bridge before sessions; browser bridge before analytics; timeline flush last.
    expect(order).toEqual([
      "bridge.stop",
      "sessions.closeAll",
      "browserBridge.stop",
      "analytics.dispose",
      "timeline.flush",
    ]);

    order.length = 0;
    await services.shutdown();
    expect(order).toEqual([
      "bridge.stop",
      "sessions.closeAll",
      "browserBridge.stop",
      "timeline.flush",
      "analytics.dispose",
      "telemetry.shutdown",
    ]);
  });

  it("surfaces a throwing layer as a synchronous constructor throw", () => {
    const realAppLive = appLayers.AppLive;
    const appLiveSpy = spyOn(appLayers, "AppLive").mockImplementation((appStores) =>
      Layer.sync(MemoryMeta, () => {
        throw new Error("layer boom");
      }).pipe(Layer.provideMerge(realAppLive(appStores)))
    );
    try {
      // Same shape as a throwing service constructor, so the entry points'
      // existing startup catch paths (dialog / log-and-exit) apply unchanged.
      expect(() => new ServiceContainer(stores)).toThrow("layer boom");
    } finally {
      appLiveSpy.mockRestore();
    }
  });
});
