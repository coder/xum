/**
 * Bridges xum services into the Effect runtime for oRPC handlers written
 * with `@orpc/experimental-effect`.
 *
 * `ORPCContext` carries a pre-built `Context.Context` under the well-known
 * `"effect/context"` key (see `WithEffectContext`). In production that context
 * is the app runtime's built service context (`ServiceContainer.runtime`, see
 * `di/appRuntime.ts`), so every service the Layer graph provides is yieldable
 * by tag. `handlerGen` provides it to every effect a handler yields, so
 * Effect-native handlers resolve services by yielding tags instead of reaching
 * through the oRPC context object. During the incremental migration both
 * styles coexist:
 *
 * - Effect-native handlers: `const meta = yield* MemoryMeta;`
 * - Transitional handlers: `context.memoryMetaService.effects.…` (same
 *   instances, no Effect context required).
 *
 * Tags live in `src/node/services/di/tags.ts`; handlers import them from there.
 */
import type { AppTags } from "@/node/services/di/tags";

/** Union of all services available to Effect-native oRPC handlers. */
export type OrpcEffectServices = AppTags;
