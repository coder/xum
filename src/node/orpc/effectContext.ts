/**
 * Effect-migration spike: bridges xum services into the Effect runtime for
 * oRPC handlers written with `@orpc/experimental-effect`.
 *
 * `ORPCContext` carries a pre-built `Context.Context` under the well-known
 * `"effect/context"` key (see `WithEffectContext`). `handlerGen` provides it to
 * every effect a handler yields, so Effect-native handlers resolve services by
 * yielding tags instead of reaching through the oRPC context object. During
 * the incremental migration both styles coexist:
 *
 * - Effect-native handlers: `const meta = yield* MemoryMeta;`
 * - Transitional handlers: `context.memoryMetaService.effects.…` (same
 *   instances, no Effect context required).
 *
 * Grow `OrpcEffectServices` as more services gain Effect surfaces.
 */
import { Context } from "effect";
import type { MemoryMetaService } from "@/node/services/memoryMeta";

/** Effect service tag for the memory metadata sidecar service. */
export class MemoryMeta extends Context.Service<MemoryMeta, MemoryMetaService>()(
  "xum/MemoryMeta"
) {}

/** Union of all services available to Effect-native oRPC handlers. */
export type OrpcEffectServices = MemoryMeta;

export function buildOrpcEffectContext(services: {
  memoryMetaService: MemoryMetaService;
}): Context.Context<OrpcEffectServices> {
  return Context.make(MemoryMeta, services.memoryMetaService);
}
