import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Context, Layer } from "effect";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import { createConfigStores, type Config, type ConfigStores } from "@/node/config";
import * as appLayers from "@/node/services/di/layers/app";
import { MemoryMeta } from "@/node/services/di/tags";
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
