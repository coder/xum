/**
 * `AppFiberScope` — the runtime-owned, *supervised* fiber scope (Effect
 * migration Phase 11, PR 2).
 *
 * A child of the app runtime's layer scope. Fibers forked into it with
 * `Effect.forkIn(effect, appFiberScope)` are interrupted **and awaited** when
 * it closes, which `ServiceContainer.dispose()` does explicitly and early
 * (right after `backgroundProcessManager.beginShutdown()`, before the
 * hand-ordered teardown steps) via `closeScopeBounded`, so interrupted fibers
 * can still use their dependencies while they finalize. `runtime.dispose()`
 * later re-closes it idempotently as a backstop.
 *
 * This is the seam for I/O-suspended, long-lived work that shutdown must wait
 * for (the streamManager engine core, in a later phase). It is the counterpart
 * of `EffectRunner` (`./effectRunner.ts`), which is unsupervised: a fiber forked
 * through the runner is interrupted by neither close. Anything forked here must
 * tolerate interruption at any suspension point and must not depend on
 * resources torn down before the close (see the dispose order in
 * `ServiceContainer`). No production occupant yet; the contract is pinned by
 * tests.
 */
import { Context, Effect, Layer, Scope } from "effect";

export class AppFiberScopeTag extends Context.Service<AppFiberScopeTag, Scope.Closeable>()(
  "xum/AppFiberScope"
) {}

/**
 * Synchronous body (DI contract: layers build without suspending). Parallel
 * finalizer strategy: forked fibers are independent, so they are interrupted
 * concurrently rather than one after another.
 */
export const AppFiberScopeLive: Layer.Layer<AppFiberScopeTag> = Layer.effect(
  AppFiberScopeTag,
  Effect.flatMap(Effect.scope, (parent) => Scope.fork(parent, "parallel"))
);
