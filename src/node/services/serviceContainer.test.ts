import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Context, Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import { createConfigStores, type Config, type ConfigStores } from "@/node/config";
import { AppFiberScopeTag } from "@/node/services/di/appFiberScope";
import { EffectRunnerTag } from "@/node/services/di/effectRunner";
import * as appLayers from "@/node/services/di/layers/app";
import { CoreOptionsTag } from "@/node/services/di/layers/core";
import {
  AI,
  Analytics,
  DevTools,
  Experiments,
  IdleDispatcherTag,
  InitStateManagerTag,
  MCPConfig,
  MCPServerManagerTag,
  Memory,
  MemoryConsolidation,
  MemoryMeta,
  Policy,
  Provider,
  SessionTiming,
  SessionUsage,
  StreamManagerTag,
  Task,
  Telemetry,
  Workspace,
  WorkspaceGoal,
  WorkspaceMcpOverrides,
  WorkspaceTurnManagerTag,
  type AppTags,
} from "@/node/services/di/tags";
import { ServiceContainer } from "./serviceContainer";

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

  it("serves the layer-built core and cross-cutting services through the fields and the Effect context", () => {
    services = new ServiceContainer(stores);
    const effectContext = services.toORPCContext()["effect/context"];

    const fieldTags: Array<[keyof ServiceContainer, Context.Key<AppTags, unknown>]> = [
      ["aiService", AI],
      ["streamManager", StreamManagerTag],
      ["initStateManager", InitStateManagerTag],
      ["workspaceService", Workspace],
      ["taskService", Task],
      ["workspaceTurnManager", WorkspaceTurnManagerTag],
      ["providerService", Provider],
      ["mcpConfigService", MCPConfig],
      ["mcpServerManager", MCPServerManagerTag],
      ["sessionUsageService", SessionUsage],
      ["workspaceGoalService", WorkspaceGoal],
      ["memoryService", Memory],
      ["memoryMetaService", MemoryMeta],
      ["memoryConsolidationService", MemoryConsolidation],
      ["idleDispatcher", IdleDispatcherTag],
      ["policyService", Policy],
      ["telemetryService", Telemetry],
      ["experimentsService", Experiments],
      ["sessionTimingService", SessionTiming],
      ["analyticsService", Analytics],
      ["devToolsService", DevTools],
      ["workspaceMcpOverridesService", WorkspaceMcpOverrides],
    ];
    for (const [field, tag] of fieldTags) {
      expect(Context.get(effectContext, tag)).toBe(services[field]);
    }
    // The core graph's options are derived from the layer-built cross-cutting
    // instances, so core constructors received the same objects the fields expose.
    const coreOptions = services.runtime.get(CoreOptionsTag);
    expect(coreOptions.policyService).toBe(services.policyService);
    expect(coreOptions.experimentsService).toBe(services.experimentsService);
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
