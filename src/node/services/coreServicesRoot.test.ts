import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Context } from "effect";
import { createConfigStores, type ConfigStores } from "@/node/config";
import * as coreServices from "@/node/services/coreServices";
import type { CoreServices } from "@/node/services/coreServices";
import { AppFiberScopeTag } from "@/node/services/di/appFiberScope";
import { closeScopeBounded, disposeAppRuntime } from "@/node/services/di/appRuntime";
import { EffectRunnerTag } from "@/node/services/di/effectRunner";
import { CoreOptionsTag } from "@/node/services/di/layers/core";
import {
  AI,
  BackgroundProcessManagerTag,
  ConfigTag,
  ExtensionMetadata,
  FileLeaseManagerTag,
  History,
  IdleDispatcherTag,
  InitStateManagerTag,
  MCPConfig,
  MCPServerManagerTag,
  Memory,
  MemoryConsolidation,
  MemoryMeta,
  Provider,
  ProvidersConfigStoreTag,
  SecretsStoreTag,
  SessionLocatorTag,
  SessionUsage,
  StreamManagerTag,
  Task,
  TurnRequestBuilderBindingsTag,
  Workspace,
  WorkspaceGoal,
  WorkspaceTurnManagerTag,
  type CoreRootTags,
  type CoreTags,
} from "@/node/services/di/tags";
import { createCoreServices, type CoreServicesRoot } from "./coreServicesRoot";

/**
 * Independent field → tag listing (the production mapping lives in
 * di/layers/core.ts); `Record<keyof CoreServices, …>` keeps it exhaustive.
 */
const CORE_FIELD_TAGS: Record<keyof CoreServices, Context.Key<CoreTags, unknown>> = {
  historyService: History,
  initStateManager: InitStateManagerTag,
  providerService: Provider,
  backgroundProcessManager: BackgroundProcessManagerTag,
  sessionUsageService: SessionUsage,
  workspaceGoalService: WorkspaceGoal,
  idleDispatcher: IdleDispatcherTag,
  aiService: AI,
  streamManager: StreamManagerTag,
  mcpConfigService: MCPConfig,
  mcpServerManager: MCPServerManagerTag,
  extensionMetadata: ExtensionMetadata,
  workspaceService: Workspace,
  taskService: Task,
  workspaceTurnManager: WorkspaceTurnManagerTag,
  memoryService: Memory,
  memoryMetaService: MemoryMeta,
  memoryConsolidationService: MemoryConsolidation,
  turnRequestBuilderBindings: TurnRequestBuilderBindingsTag,
};

describe("createCoreServices", () => {
  let tempDir: string;
  let stores: ConfigStores;
  let root: CoreServicesRoot | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-core-root-test-"));
    stores = createConfigStores(tempDir);
  });

  afterEach(async () => {
    if (root) {
      // The CLI cleanup order: supervised scope first, runtime last.
      await closeScopeBounded(root.appFiberScope);
      await disposeAppRuntime(root.runtime.managed);
      root = undefined;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("serves every CoreServices field through its tag (one instance each)", () => {
    root = createCoreServices({
      ...stores,
      extensionMetadataPath: path.join(tempDir, "extensionMetadata.json"),
    });

    for (const [field, tag] of Object.entries(CORE_FIELD_TAGS) as Array<
      [keyof CoreServices, Context.Key<CoreRootTags, unknown>]
    >) {
      expect(root.runtime.get(tag)).toBe(root[field]);
    }
    expect(root.appFiberScope).toBe(root.runtime.get(AppFiberScopeTag));
    expect(root.appFiberScope.state._tag).not.toBe("Closed");
    expect(root.runtime.get(EffectRunnerTag)).toBeDefined();
  });

  it("uses the caller's stores and carries the remaining options under CoreOptionsTag", () => {
    const extensionMetadataPath = path.join(tempDir, "extensionMetadata.json");
    root = createCoreServices({ ...stores, extensionMetadataPath, mcpConfig: stores.config });

    expect(root.runtime.get(ConfigTag)).toBe(stores.config);
    expect(root.runtime.get(SessionLocatorTag)).toBe(stores.sessionLocator);
    expect(root.runtime.get(ProvidersConfigStoreTag)).toBe(stores.providersConfigStore);
    expect(root.runtime.get(SecretsStoreTag)).toBe(stores.secretsStore);
    expect(root.runtime.get(FileLeaseManagerTag)).toBe(stores.fileLeaseManager);
    // Options minus stores, exactly as passed (no cross-cutting services in a CLI root).
    expect(root.runtime.get(CoreOptionsTag)).toEqual({
      extensionMetadataPath,
      mcpConfig: stores.config,
    });
  });

  it("defaults omitted stores to the config root, like the graph body did", () => {
    root = createCoreServices({
      config: stores.config,
      extensionMetadataPath: path.join(tempDir, "extensionMetadata.json"),
    });

    expect(root.runtime.get(ConfigTag)).toBe(stores.config);
    expect(root.runtime.get(SessionLocatorTag).rootDir).toBe(stores.config.rootDir);
    expect(root.runtime.get(ProvidersConfigStoreTag).rootDir).toBe(stores.config.rootDir);
    expect(root.runtime.get(SecretsStoreTag).rootDir).toBe(stores.config.rootDir);
    expect(root.runtime.get(FileLeaseManagerTag).rootDir).toBe(stores.config.rootDir);
    expect(root.runtime.get(SessionLocatorTag)).not.toBe(stores.sessionLocator);
  });

  it("releases the runtime through the CLI cleanup steps, idempotently", async () => {
    root = createCoreServices({
      ...stores,
      extensionMetadataPath: path.join(tempDir, "extensionMetadata.json"),
    });
    const { appFiberScope, runtime } = root;

    await closeScopeBounded(appFiberScope);
    expect(appFiberScope.state._tag).toBe("Closed");
    // Dependencies are still alive between the two steps (the explicit CLI
    // disposers run here).
    expect(runtime.managed.cachedContext).toBeDefined();

    await disposeAppRuntime(runtime.managed);
    expect(runtime.managed.cachedContext).toBeUndefined();
    // The afterEach pair then exercises the idempotent second close/dispose.
  });

  it("surfaces a throwing graph body as a synchronous throw", () => {
    const buildSpy = spyOn(coreServices, "buildCoreGraph").mockImplementation(() => {
      throw new Error("core boom");
    });
    try {
      // Same shape as a throwing service constructor, so the CLI roots' existing
      // startup error paths apply unchanged.
      expect(() =>
        createCoreServices({
          ...stores,
          extensionMetadataPath: path.join(tempDir, "extensionMetadata.json"),
        })
      ).toThrow("core boom");
    } finally {
      buildSpy.mockRestore();
    }
  });
});
