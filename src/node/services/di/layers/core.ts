import { Effect, Layer } from "effect";
import { ConfigTag, MemoryMeta } from "@/node/services/di/tags";
import { MemoryMetaService } from "@/node/services/memoryMeta";

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
