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
import type { MemoryMetaService } from "@/node/services/memoryMeta";
import type { AppFiberScopeTag } from "./appFiberScope";
import type { EffectRunnerTag } from "./effectRunner";

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

/** Every service the desktop/server app graph (`AppLive`) provides. */
export type AppTags = StoreTags | RuntimeSeamTags | MemoryMeta;
