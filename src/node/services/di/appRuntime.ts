/**
 * App-lifetime Effect runtime (Effect migration Phase 11).
 *
 * A `ManagedRuntime` built from the process's Layer graph (`./layers/app.ts`
 * for `ServiceContainer` roots). It owns the app-lifetime `Scope`, and its
 * built `Context` is what oRPC Effect-native handlers receive as
 * `"effect/context"`.
 *
 * DI contract (Phase 11 compatibility rules, not permanent architecture law):
 *
 * - **Synchronous layer bodies.** Every Layer in the graph must build without
 *   suspending (`Layer.succeed`/`Layer.sync`/`Layer.effect` over sync effects;
 *   `acquireRelease` with a sync acquire is fine). `makeAppRuntime` builds the
 *   graph eagerly with `runSync` and asserts that it completed, so a layer that
 *   suspends fails right here — at construction, exactly where a throwing
 *   service constructor fails today, and therefore inside every entry point's
 *   existing startup catch path (`desktop/main.ts` dialog, `cli/server.ts`/ACP
 *   log-and-exit). Asynchronous acquisition belongs in `initialize()` or a
 *   later explicit async factory root, never silently inside a layer. Eager
 *   building also keeps fibers started through the runtime synchronous up to
 *   their first async boundary (`cachedContext` is set, so `runX` is
 *   `Effect.run…With(context)`), which the deterministic-winner funnels in the
 *   codebase rely on.
 * - **Only the composition root holds the runtime.** Services must not be
 *   handed the `ManagedRuntime`: after `dispose()` every `runX` on it dies with
 *   "ManagedRuntime disposed", and a late worker callback would defect.
 * - **No layer finalizers yet.** Teardown order stays explicit in
 *   `ServiceContainer.dispose()`; layer bodies register no finalizers, so
 *   `disposeAppRuntime` (the last dispose step) reorders nothing. It is wired
 *   now so that later phases (the streamManager engine core) have a fixed,
 *   bounded slot for scope-owned resources.
 */
import assert from "@/common/utils/assert";
import { Context, Duration, Effect, Fiber, ManagedRuntime } from "effect";
import type { Layer } from "effect";
import { APP_RUNTIME_DISPOSE_TIMEOUT_MS } from "@/constants/terminationTimeouts";
import { log } from "@/node/services/log";

export interface AppRuntime<R> {
  /** The runtime that owns the layer scope. Composition roots only (see contract). */
  readonly managed: ManagedRuntime.ManagedRuntime<R, never>;
  /** The built service context; also the oRPC `"effect/context"`. */
  readonly context: Context.Context<R>;
  /** Resolve a service instance from the built context. */
  readonly get: <I extends R, S>(tag: Context.Key<I, S>) => S;
}

/**
 * Build the runtime for `layer` eagerly and synchronously. Throws (constructor
 * semantics) if the graph cannot be built without suspending or a layer body
 * throws.
 */
export function makeAppRuntime<R>(layer: Layer.Layer<R, never, never>): AppRuntime<R> {
  const startedAt = performance.now();
  const managed = ManagedRuntime.make(layer);
  const context = managed.runSync(Effect.context<R>());
  assert(
    managed.cachedContext !== undefined,
    "AppRuntime layer graph must build synchronously (see DI contract in di/appRuntime.ts)"
  );
  log.debug("[startup] AppRuntime built", { ms: Math.round(performance.now() - startedAt) });
  return {
    managed,
    context,
    get: (tag) => Context.get(context, tag),
  };
}

/**
 * Close the runtime's scope (interrupting fibers started through it and running
 * layer finalizers in reverse order), bounded by `timeoutMs`. Never rejects and
 * is idempotent: a second call finds the scope already closed and returns.
 *
 * The close runs in a detached fiber and the caller waits on its join, so a
 * hung finalizer cannot pin shutdown past the bound — the wait is interrupted,
 * the finalizer keeps running best-effort, and a warning is logged.
 */
export function disposeAppRuntime(
  runtime: ManagedRuntime.ManagedRuntime<never, never>,
  timeoutMs: number = APP_RUNTIME_DISPOSE_TIMEOUT_MS
): Promise<void> {
  return Effect.runPromise(disposeAppRuntimeEffect(runtime, timeoutMs));
}

function disposeAppRuntimeEffect(
  runtime: ManagedRuntime.ManagedRuntime<never, never>,
  timeoutMs: number
): Effect.Effect<void> {
  const startedAt = performance.now();
  // Uninterruptible teardown shell; only the bounded wait inside is interruptible
  // so the timeout can win the race (house shape from #4038).
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const closing = yield* Effect.forkDetach(runtime.disposeEffect);
      yield* Effect.interruptible(
        Fiber.join(closing).pipe(Effect.timeout(Duration.millis(timeoutMs)))
      ).pipe(
        Effect.catchTag("TimeoutError", () =>
          Effect.sync(() => {
            log.warn("[shutdown] AppRuntime dispose timed out; finalizers continue best-effort", {
              timeoutMs,
            });
          })
        )
      );
      log.debug("[shutdown] AppRuntime disposed", {
        ms: Math.round(performance.now() - startedAt),
      });
    }).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          log.warn("[shutdown] AppRuntime dispose failed", { error: defect });
        })
      )
    )
  );
}
