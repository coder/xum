import { Layer } from "effect";
import type { ConfigStores } from "@/node/config";
import type { AppTags } from "@/node/services/di/tags";
import { MemoryMetaLive } from "./core";
import { StoresLive } from "./stores";

/**
 * Full Layer graph for a `ServiceContainer` process (desktop, `xum server`,
 * ACP, tests/ipc, headless bench).
 *
 * Composition direction: `consumer.pipe(Layer.provideMerge(provider))` — the
 * right-hand operand satisfies the left-hand operand's requirements and both
 * stay exposed in the final context. `Layer.mergeAll` is only for true
 * siblings; it does not satisfy one sibling's requirements from another.
 */
export function AppLive(stores: ConfigStores): Layer.Layer<AppTags> {
  return MemoryMetaLive.pipe(Layer.provideMerge(StoresLive(stores)));
}
