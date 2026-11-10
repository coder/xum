/**
 * Builds one SessionFiles from a layer. Every test builds its layer here.
 *
 * Kept apart from the contract harness, which imports bun:test: testHistoryService.ts calls this,
 * and the Jest integration tests (tests/ipc) load testHistoryService.ts, where bun:test does not
 * resolve.
 */
import { Effect, type Layer } from "effect";
import { SessionFilesTag } from "@/node/services/di/tags";
import type { SessionFiles } from "./sessionFiles";

export function buildSessionFiles(layer: Layer.Layer<SessionFilesTag>): SessionFiles {
  return Effect.runSync(
    Effect.gen(function* () {
      return yield* SessionFilesTag;
    }).pipe(Effect.provide(layer))
  );
}
