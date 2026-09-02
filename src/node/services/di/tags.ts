/**
 * Effect service tags for the app dependency graph (Effect migration Phase 11).
 *
 * One tag per service class provided by the Layer graph in `./layers/*`. The
 * service classes are imported as types only, so this module has no runtime
 * dependency on them and can be imported from anywhere (layers, oRPC handlers,
 * tests) without creating import cycles.
 *
 * Naming: the class name minus a trailing `Service` (`MemoryMeta` for
 * `MemoryMetaService`); classes without that suffix, or whose bare name would
 * collide with the exported class, take a `Tag` suffix (`ConfigTag`). Ids are
 * `"xum/<Name>"`.
 */
import { Context } from "effect";
import type {
  Config,
  FileLeaseManager,
  ProvidersConfigStore,
  SecretsStore,
  WorkspaceSessionLocator,
} from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { AnalyticsService } from "@/node/services/analytics/analyticsService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { DevToolsService } from "@/node/services/devToolsService";
import type { ExperimentsService } from "@/node/services/experimentsService";
import type { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import type { HistoryService } from "@/node/services/historyService";
import type { IdleDispatcher } from "@/node/services/idleDispatcher";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { MCPConfigService } from "@/node/services/mcpConfigService";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import type { MemoryConsolidationService } from "@/node/services/memoryConsolidationService";
import type { MemoryMetaService } from "@/node/services/memoryMeta";
import type { MemoryService } from "@/node/services/memoryService";
import type { PolicyService } from "@/node/services/policyService";
import type { ProviderService } from "@/node/services/providerService";
import type { SessionTimingService } from "@/node/services/sessionTimingService";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type { StreamManager } from "@/node/services/streamManager";
import type { TaskService } from "@/node/services/taskService";
import type { TelemetryService } from "@/node/services/telemetryService";
import type { TurnRequestBuilderBindings } from "@/node/services/turnRequestBuilder";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import type { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import type { AppFiberScopeTag } from "./appFiberScope";
import type { EffectRunnerTag } from "./effectRunner";
import type { CoreOptionsTag } from "./layers/core";

export class ConfigTag extends Context.Service<ConfigTag, Config>()("xum/Config") {}
export class SessionLocatorTag extends Context.Service<
  SessionLocatorTag,
  WorkspaceSessionLocator
>()("xum/SessionLocator") {}
export class ProvidersConfigStoreTag extends Context.Service<
  ProvidersConfigStoreTag,
  ProvidersConfigStore
>()("xum/ProvidersConfigStore") {}
export class SecretsStoreTag extends Context.Service<SecretsStoreTag, SecretsStore>()(
  "xum/SecretsStore"
) {}
export class FileLeaseManagerTag extends Context.Service<FileLeaseManagerTag, FileLeaseManager>()(
  "xum/FileLeaseManager"
) {}

/** Host-local sidecar for user-owned memory metadata (pins + usage stats). */
export class MemoryMeta extends Context.Service<MemoryMeta, MemoryMetaService>()(
  "xum/MemoryMeta"
) {}

// Core service graph (`CoreServices` in coreServices.ts), shared by the desktop
// app and the headless CLI roots. One tag per `CoreServices` field.
export class History extends Context.Service<History, HistoryService>()("xum/History") {}
export class InitStateManagerTag extends Context.Service<InitStateManagerTag, InitStateManager>()(
  "xum/InitStateManager"
) {}
export class Provider extends Context.Service<Provider, ProviderService>()("xum/Provider") {}
export class BackgroundProcessManagerTag extends Context.Service<
  BackgroundProcessManagerTag,
  BackgroundProcessManager
>()("xum/BackgroundProcessManager") {}
export class SessionUsage extends Context.Service<SessionUsage, SessionUsageService>()(
  "xum/SessionUsage"
) {}
export class WorkspaceGoal extends Context.Service<WorkspaceGoal, WorkspaceGoalService>()(
  "xum/WorkspaceGoal"
) {}
export class IdleDispatcherTag extends Context.Service<IdleDispatcherTag, IdleDispatcher>()(
  "xum/IdleDispatcher"
) {}
export class AI extends Context.Service<AI, AIService>()("xum/AI") {}
export class StreamManagerTag extends Context.Service<StreamManagerTag, StreamManager>()(
  "xum/StreamManager"
) {}
export class MCPConfig extends Context.Service<MCPConfig, MCPConfigService>()("xum/MCPConfig") {}
export class MCPServerManagerTag extends Context.Service<MCPServerManagerTag, MCPServerManager>()(
  "xum/MCPServerManager"
) {}
export class ExtensionMetadata extends Context.Service<
  ExtensionMetadata,
  ExtensionMetadataService
>()("xum/ExtensionMetadata") {}
export class Workspace extends Context.Service<Workspace, WorkspaceService>()("xum/Workspace") {}
export class Task extends Context.Service<Task, TaskService>()("xum/Task") {}
export class WorkspaceTurnManagerTag extends Context.Service<
  WorkspaceTurnManagerTag,
  WorkspaceTurnManager
>()("xum/WorkspaceTurnManager") {}
export class Memory extends Context.Service<Memory, MemoryService>()("xum/Memory") {}
export class MemoryConsolidation extends Context.Service<
  MemoryConsolidation,
  MemoryConsolidationService
>()("xum/MemoryConsolidation") {}
/** Late-bound collaborators of the turn request builder (a mutable record, filled by wiring). */
export class TurnRequestBuilderBindingsTag extends Context.Service<
  TurnRequestBuilderBindingsTag,
  TurnRequestBuilderBindings
>()("xum/TurnRequestBuilderBindings") {}

// Desktop cross-cutting services that the core graph's options derive from
// (`CrossCuttingLive` in ./layers/desktop.ts).
export class Policy extends Context.Service<Policy, PolicyService>()("xum/Policy") {}
export class Telemetry extends Context.Service<Telemetry, TelemetryService>()("xum/Telemetry") {}
export class Experiments extends Context.Service<Experiments, ExperimentsService>()(
  "xum/Experiments"
) {}
export class SessionTiming extends Context.Service<SessionTiming, SessionTimingService>()(
  "xum/SessionTiming"
) {}
export class Analytics extends Context.Service<Analytics, AnalyticsService>()("xum/Analytics") {}
export class DevTools extends Context.Service<DevTools, DevToolsService>()("xum/DevTools") {}
export class WorkspaceMcpOverrides extends Context.Service<
  WorkspaceMcpOverrides,
  WorkspaceMcpOverridesService
>()("xum/WorkspaceMcpOverrides") {}

/** The process's config stores (`ConfigStores`), one tag per store. */
export type StoreTags =
  | ConfigTag
  | SessionLocatorTag
  | ProvidersConfigStoreTag
  | SecretsStoreTag
  | FileLeaseManagerTag;

/**
 * The runtime seams provided at the base of every graph (`./effectRunner.ts`,
 * `./appFiberScope.ts`); their tags live next to their layers.
 */
export type RuntimeSeamTags = EffectRunnerTag | AppFiberScopeTag;

/** Every `CoreServices` field, as provided by `CoreProjectionLive` (./layers/core.ts). */
export type CoreTags =
  | History
  | InitStateManagerTag
  | Provider
  | BackgroundProcessManagerTag
  | SessionUsage
  | WorkspaceGoal
  | IdleDispatcherTag
  | AI
  | StreamManagerTag
  | MCPConfig
  | MCPServerManagerTag
  | ExtensionMetadata
  | Workspace
  | Task
  | WorkspaceTurnManagerTag
  | Memory
  | MemoryMeta
  | MemoryConsolidation
  | TurnRequestBuilderBindingsTag;

/** Everything a headless CLI root (`createCoreServices`) provides. */
export type CoreRootTags = StoreTags | RuntimeSeamTags | CoreOptionsTag | CoreTags;

/** The desktop cross-cutting services provided by `CrossCuttingLive`. */
export type CrossCuttingTags =
  | Policy
  | Telemetry
  | Experiments
  | SessionTiming
  | Analytics
  | DevTools
  | WorkspaceMcpOverrides;

/** Every service the desktop/server app graph (`AppLive`) provides. */
export type AppTags = CoreRootTags | CrossCuttingTags;
