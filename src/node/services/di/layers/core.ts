import * as os from "os";
import * as path from "path";
import { Context, Effect, Layer } from "effect";
import { AIService } from "@/node/services/aiService";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import {
  buildCoreTail,
  type CoreOptions,
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
  TerminalAttentionStoreTag,
  TurnRequestBuilderBindingsTag,
  Workspace,
  WorkspaceGoal,
  WorkspaceMcpOverrides,
  WorkspaceTurnManagerTag,
  type CoreRootTags,
  type CoreTags,
  type StoreTags,
} from "@/node/services/di/tags";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { HistoryService } from "@/node/services/historyService";
import { IdleDispatcher } from "@/node/services/idleDispatcher";
import { InitStateManager } from "@/node/services/initStateManager";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import { MemoryService } from "@/node/services/memoryService";
import { ProviderService } from "@/node/services/providerService";
import { SessionUsageService } from "@/node/services/sessionUsageService";
import { StreamManager } from "@/node/services/streamManager";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import type { TurnRequestBuilderBindings } from "@/node/services/turnRequestBuilder";
import { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import { StoresFromCoreOptionsLive } from "./stores";

/**
 * Layers for the core service graph shared by the desktop/server app and the
 * headless CLI roots (Effect migration Phase 11).
 *
 * Every `*Live` below is a thin adapter around an existing constructor with
 * its existing argument list; the bodies stay synchronous (DI contract in
 * `../appRuntime.ts`) and register no finalizers. Dependencies are expressed
 * only through what a body yields, and build order only through the explicit
 * stages at the bottom of this file (`Layer.provideMerge` between stages;
 * `Layer.mergeAll` for true siblings within a stage — siblings may build in
 * any order, so nothing may rely on sibling order). The head of the graph
 * (S1–S3, through `AIService`) is staged here; the remainder and the
 * setter/listener wiring still run imperatively (`buildCoreTail`) behind a
 * projection layer until the next PR peels them too.
 */

/** The core graph's inputs other than the stores (`CoreOptions` in coreServices.ts). */
export class CoreOptionsTag extends Context.Service<CoreOptionsTag, CoreOptions>()(
  "xum/CoreOptions"
) {}

/**
 * What the roots must provide beneath `CoreLive`: the stores, the options,
 * and the two always-present collaborators the desktop builds elsewhere
 * (`MemoryMetaLive`; `WorkspaceMcpOverrides` from `CrossCuttingLive`). CLI
 * roots supply the defaults (`MemoryMetaLive`, `WorkspaceMcpOverridesDefaultLive`).
 */
export type CoreInputTags = StoreTags | CoreOptionsTag | MemoryMeta | WorkspaceMcpOverrides;

/** Memory metadata sidecar; scope root derives from the xum home (`config.rootDir`). */
export const MemoryMetaLive: Layer.Layer<MemoryMeta, never, ConfigTag> = Layer.effect(
  MemoryMeta,
  Effect.map(ConfigTag, (config) => new MemoryMetaService(config.rootDir))
);

/**
 * Default for roots without a desktop `CrossCuttingLive`: workspace MCP
 * override reads AND registration-time plugin-override sanitization must work
 * in every process that can register workspaces, not just desktop.
 */
export const WorkspaceMcpOverridesDefaultLive: Layer.Layer<
  WorkspaceMcpOverrides,
  never,
  ConfigTag
> = Layer.effect(
  WorkspaceMcpOverrides,
  Effect.map(ConfigTag, (config) => new WorkspaceMcpOverridesService(config))
);

// ---------------------------------------------------------------------------
// S1 — leaves: depend only on the graph inputs.
// ---------------------------------------------------------------------------

export const HistoryLive = Layer.effect(
  History,
  Effect.map(SessionLocatorTag, (sessionLocator) => new HistoryService(sessionLocator))
);

export const InitStateManagerLive = Layer.effect(
  InitStateManagerTag,
  Effect.map(ConfigTag, (config) => new InitStateManager(config))
);

export const ProviderLive = Layer.effect(
  Provider,
  Effect.gen(function* () {
    const opts = yield* CoreOptionsTag;
    return new ProviderService(
      yield* ConfigTag,
      opts.policyService,
      yield* ProvidersConfigStoreTag,
      yield* FileLeaseManagerTag
    );
  })
);

export const BackgroundProcessManagerLive = Layer.sync(
  BackgroundProcessManagerTag,
  () => new BackgroundProcessManager(path.join(os.tmpdir(), "mux-bashes"))
);

export const ExtensionMetadataLive = Layer.effect(
  ExtensionMetadata,
  Effect.map(CoreOptionsTag, (opts) => new ExtensionMetadataService(opts.extensionMetadataPath))
);

// Agent memory (memory experiment): scope roots derive from Config (xum home
// + session dirs); experiment gating happens per stream in AIService.
export const MemoryLive = Layer.effect(
  Memory,
  Effect.gen(function* () {
    return new MemoryService(yield* ConfigTag, yield* MemoryMeta);
  })
);

export const TerminalAttentionStoreLive = Layer.effect(
  TerminalAttentionStoreTag,
  Effect.map(ConfigTag, (config) => new TerminalAttentionStore(config))
);

// Goal continuation bridge lives at the core scope so every codepath that
// uses the core graph (xum run, xum server via ServiceContainer, tests)
// gets a working dispatcher. Without this, requestContinuationAfterStreamEnd
// is a no-op and the auto-continuation loop never fires. The dispatcher is
// also exposed so ServiceContainer can share it with HeartbeatService. Its
// consumer is registered by the graph's wiring once Task/Workspace exist.
export const IdleDispatcherLive = Layer.sync(IdleDispatcherTag, () => new IdleDispatcher());

/** One mutable record per graph build (`sync`, not `succeed`); filled by the graph's wiring. */
export const TurnRequestBuilderBindingsLive = Layer.sync(
  TurnRequestBuilderBindingsTag,
  (): TurnRequestBuilderBindings => ({})
);

// ---------------------------------------------------------------------------
// S2a — need S1 leaves.
// ---------------------------------------------------------------------------

// Providers config accessor enables mappedToModel alias resolution for
// headless usage pricing (status generation and memory sweeps).
export const SessionUsageLive = Layer.effect(
  SessionUsage,
  Effect.gen(function* () {
    const providerService = yield* Provider;
    return new SessionUsageService(yield* ConfigTag, yield* History, () =>
      providerService.getConfig()
    );
  })
);

export const WorkspaceGoalLive = Layer.effect(
  WorkspaceGoal,
  Effect.gen(function* () {
    const opts = yield* CoreOptionsTag;
    return new WorkspaceGoalService(
      yield* ConfigTag,
      yield* History,
      yield* ExtensionMetadata,
      opts.analyticsService,
      opts.goalServiceOptions,
      yield* ProvidersConfigStoreTag
    );
  })
);

// ---------------------------------------------------------------------------
// S2b — StreamManager needs SessionUsage (S2a).
// ---------------------------------------------------------------------------

export const StreamManagerLive = Layer.effect(
  StreamManagerTag,
  Effect.gen(function* () {
    const providerService = yield* Provider;
    return new StreamManager(yield* History, yield* SessionUsage, () =>
      providerService.getConfig()
    );
  })
);

// ---------------------------------------------------------------------------
// S3 — AIService needs StreamManager (S2b). Its constructor installs itself as
// the stream manager's event sink and subscribes to provider config changes —
// both on declared constructor dependencies (I6).
// ---------------------------------------------------------------------------

export const AILive = Layer.effect(
  AI,
  Effect.gen(function* () {
    const opts = yield* CoreOptionsTag;
    return new AIService(
      yield* ConfigTag,
      yield* History,
      yield* InitStateManagerTag,
      yield* Provider,
      yield* BackgroundProcessManagerTag,
      yield* SessionUsage,
      yield* WorkspaceMcpOverrides,
      opts.policyService,
      opts.telemetryService,
      opts.devToolsService,
      opts.experimentsService,
      yield* StreamManagerTag,
      yield* TurnRequestBuilderBindingsTag,
      yield* ProvidersConfigStoreTag,
      yield* SecretsStoreTag
    );
  })
);

// ---------------------------------------------------------------------------
// Remainder projection (transitional): today's imperative construction of the
// services after AIService plus all of the graph's wiring (`buildCoreTail`,
// order unchanged) over the layer-built head, exposed under their tags. The
// next PR peels it into stages S4–S8 and a `CoreWiringLive`.
// ---------------------------------------------------------------------------

/** What `buildCoreTail` produces. */
export type CoreTailTags =
  | MemoryConsolidation
  | MCPConfig
  | MCPServerManagerTag
  | Workspace
  | Task
  | WorkspaceTurnManagerTag;

const CoreTailProjectionLive: Layer.Layer<
  CoreTailTags,
  never,
  Exclude<CoreTags, CoreTailTags> | CoreInputTags
> = Layer.effectContext(
  Effect.gen(function* () {
    const tail = buildCoreTail({
      config: yield* ConfigTag,
      secretsStore: yield* SecretsStoreTag,
      providersConfigStore: yield* ProvidersConfigStoreTag,
      options: yield* CoreOptionsTag,
      historyService: yield* History,
      initStateManager: yield* InitStateManagerTag,
      backgroundProcessManager: yield* BackgroundProcessManagerTag,
      sessionUsageService: yield* SessionUsage,
      extensionMetadata: yield* ExtensionMetadata,
      workspaceGoalService: yield* WorkspaceGoal,
      idleDispatcher: yield* IdleDispatcherTag,
      streamManager: yield* StreamManagerTag,
      aiService: yield* AI,
      memoryService: yield* Memory,
      memoryMetaService: yield* MemoryMeta,
      turnRequestBuilderBindings: yield* TurnRequestBuilderBindingsTag,
      workspaceMcpOverridesService: yield* WorkspaceMcpOverrides,
      terminalAttentionStore: yield* TerminalAttentionStoreTag,
    });
    return Context.empty().pipe(
      Context.add(MemoryConsolidation, tail.memoryConsolidationService),
      Context.add(MCPConfig, tail.mcpConfigService),
      Context.add(MCPServerManagerTag, tail.mcpServerManager),
      Context.add(Workspace, tail.workspaceService),
      Context.add(Task, tail.taskService),
      Context.add(WorkspaceTurnManagerTag, tail.workspaceTurnManager)
    );
  })
);

// ---------------------------------------------------------------------------
// Staged composition. Each stage depends only on stages above it; `provideMerge`
// keeps both sides exposed, so the final context carries every core tag.
// ---------------------------------------------------------------------------

const S1 = Layer.mergeAll(
  HistoryLive,
  InitStateManagerLive,
  ProviderLive,
  BackgroundProcessManagerLive,
  ExtensionMetadataLive,
  MemoryLive,
  TerminalAttentionStoreLive,
  IdleDispatcherLive,
  TurnRequestBuilderBindingsLive
);
const S2a = Layer.mergeAll(SessionUsageLive, WorkspaceGoalLive).pipe(Layer.provideMerge(S1));
const S2b = StreamManagerLive.pipe(Layer.provideMerge(S2a));
const S3 = AILive.pipe(Layer.provideMerge(S2b));

/**
 * The whole core graph, wired. The roots provide `CoreInputTags` beneath it
 * (`MemoryMeta` is one of them, hence excluded from the outputs here; the
 * root's merged context still carries every `CoreTags` entry).
 */
export const CoreLive: Layer.Layer<
  Exclude<CoreTags, MemoryMeta>,
  never,
  CoreInputTags
> = CoreTailProjectionLive.pipe(Layer.provideMerge(S3));

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
 * core graph over the caller's options with the CLI defaults for the two
 * desktop-built inputs, and the runtime seams at the base exactly as in
 * `AppLive` (`./app.ts`). Composition direction is
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
  return CoreLive.pipe(
    // True siblings: both derive from the config alone.
    Layer.provideMerge(Layer.mergeAll(MemoryMetaLive, WorkspaceMcpOverridesDefaultLive)),
    Layer.provideMerge(Layer.succeed(CoreOptionsTag)(coreOptions)),
    Layer.provideMerge(runtimeSeams)
  );
}
