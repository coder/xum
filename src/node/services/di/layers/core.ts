import { Context, Effect, Layer } from "effect";
import type { ConfigStores } from "@/node/config";
import {
  buildCoreGraph,
  type CoreServices,
  type CoreServicesOptions,
} from "@/node/services/coreServices";
import { AppFiberScopeLive } from "@/node/services/di/appFiberScope";
import { EffectRunnerLive } from "@/node/services/di/effectRunner";
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
  type StoreTags,
} from "@/node/services/di/tags";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import { StoresFromCoreOptionsLive } from "./stores";

/**
 * Layers for the core service graph shared by the desktop/server app and the
 * headless CLI roots. Bodies are thin adapters around the existing constructors
 * and must stay synchronous (see the DI contract in `../appRuntime.ts`).
 */

/** Memory metadata sidecar; scope root derives from the xum home (`config.rootDir`). */
export const MemoryMetaLive: Layer.Layer<MemoryMeta, never, ConfigTag> = Layer.effect(
  MemoryMeta,
  Effect.map(ConfigTag, (config) => new MemoryMetaService(config.rootDir))
);

/**
 * The core graph's inputs other than the stores: today's `CoreServicesOptions`
 * minus `ConfigStores`. The optional cross-cutting services stay optional here
 * (present in the desktop graph, absent in CLI roots), so core constructors
 * see exactly the arguments they saw before.
 */
export type CoreOptions = Omit<CoreServicesOptions, keyof ConfigStores>;

export class CoreOptionsTag extends Context.Service<CoreOptionsTag, CoreOptions>()(
  "xum/CoreOptions"
) {}

/**
 * Coarse projection of the whole core graph: runs today's imperative
 * construction body (`buildCoreGraph`, unchanged) once and exposes every
 * `CoreServices` field under its tag. Zero behavior change by construction —
 * the peel into staged per-service layers is the next phase's work, gated on
 * this layer's typecheck/startup budgets.
 */
export const CoreProjectionLive: Layer.Layer<CoreTags, never, CoreOptionsTag | StoreTags> =
  Layer.effectContext(
    Effect.gen(function* () {
      const opts = yield* CoreOptionsTag;
      const core = buildCoreGraph({
        ...opts,
        config: yield* ConfigTag,
        sessionLocator: yield* SessionLocatorTag,
        providersConfigStore: yield* ProvidersConfigStoreTag,
        secretsStore: yield* SecretsStoreTag,
        fileLeaseManager: yield* FileLeaseManagerTag,
      });
      return coreContextFromServices(core);
    })
  );

/** `CoreServices` → tagged context; inverse of `coreServicesFromContext`. */
export function coreContextFromServices(core: CoreServices): Context.Context<CoreTags> {
  return Context.empty().pipe(
    Context.add(History, core.historyService),
    Context.add(InitStateManagerTag, core.initStateManager),
    Context.add(Provider, core.providerService),
    Context.add(BackgroundProcessManagerTag, core.backgroundProcessManager),
    Context.add(SessionUsage, core.sessionUsageService),
    Context.add(WorkspaceGoal, core.workspaceGoalService),
    Context.add(IdleDispatcherTag, core.idleDispatcher),
    Context.add(AI, core.aiService),
    Context.add(StreamManagerTag, core.streamManager),
    Context.add(MCPConfig, core.mcpConfigService),
    Context.add(MCPServerManagerTag, core.mcpServerManager),
    Context.add(ExtensionMetadata, core.extensionMetadata),
    Context.add(Workspace, core.workspaceService),
    Context.add(Task, core.taskService),
    Context.add(WorkspaceTurnManagerTag, core.workspaceTurnManager),
    Context.add(Memory, core.memoryService),
    Context.add(MemoryMeta, core.memoryMetaService),
    Context.add(MemoryConsolidation, core.memoryConsolidationService),
    Context.add(TurnRequestBuilderBindingsTag, core.turnRequestBuilderBindings)
  );
}

/** Tagged context → the plain `CoreServices` object the roots hand out. */
export function coreServicesFromContext(context: Context.Context<CoreTags>): CoreServices {
  return {
    historyService: Context.get(context, History),
    initStateManager: Context.get(context, InitStateManagerTag),
    providerService: Context.get(context, Provider),
    backgroundProcessManager: Context.get(context, BackgroundProcessManagerTag),
    sessionUsageService: Context.get(context, SessionUsage),
    workspaceGoalService: Context.get(context, WorkspaceGoal),
    idleDispatcher: Context.get(context, IdleDispatcherTag),
    aiService: Context.get(context, AI),
    streamManager: Context.get(context, StreamManagerTag),
    mcpConfigService: Context.get(context, MCPConfig),
    mcpServerManager: Context.get(context, MCPServerManagerTag),
    extensionMetadata: Context.get(context, ExtensionMetadata),
    workspaceService: Context.get(context, Workspace),
    taskService: Context.get(context, Task),
    workspaceTurnManager: Context.get(context, WorkspaceTurnManagerTag),
    memoryService: Context.get(context, Memory),
    memoryMetaService: Context.get(context, MemoryMeta),
    memoryConsolidationService: Context.get(context, MemoryConsolidation),
    turnRequestBuilderBindings: Context.get(context, TurnRequestBuilderBindingsTag),
  };
}

/**
 * Full Layer graph for a headless CLI root (`xum run`, `xum workflow`): the
 * core projection over the caller's options, with the runtime seams at the
 * base exactly as in `AppLive` (`./app.ts`). Composition direction is
 * `consumer.pipe(Layer.provideMerge(provider))`; every tag stays exposed.
 */
export function CoreRootLive(opts: CoreServicesOptions): Layer.Layer<CoreRootTags> {
  // The stores travel under their own tags (StoresFromCoreOptionsLive).
  const {
    config,
    sessionLocator,
    providersConfigStore,
    secretsStore,
    fileLeaseManager,
    ...coreOptions
  } = opts;
  const runtimeSeams = AppFiberScopeLive.pipe(
    Layer.provideMerge(EffectRunnerLive.pipe(Layer.provideMerge(StoresFromCoreOptionsLive(opts))))
  );
  return CoreProjectionLive.pipe(
    Layer.provideMerge(Layer.succeed(CoreOptionsTag)(coreOptions)),
    Layer.provideMerge(runtimeSeams)
  );
}
