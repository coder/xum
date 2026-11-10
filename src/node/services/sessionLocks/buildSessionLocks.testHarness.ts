/**
 * Builds one SessionLocks from a layer. Every test builds its layer here.
 *
 * Kept apart from the contract harness, which imports bun:test: testHistoryService.ts calls this,
 * and the Jest integration tests (tests/ipc) load testHistoryService.ts, where bun:test does not
 * resolve.
 */
import { Effect, type Layer } from "effect";
import { SessionLocksTag } from "@/node/services/di/tags";
import type { SessionLocks } from "./sessionLocks";

/** The layers keep no scope, so a synchronous build is enough. */
export function buildSessionLocks(layer: Layer.Layer<SessionLocksTag>): SessionLocks {
  return Effect.runSync(
    Effect.gen(function* () {
      return yield* SessionLocksTag;
    }).pipe(Effect.provide(layer))
  );
}
