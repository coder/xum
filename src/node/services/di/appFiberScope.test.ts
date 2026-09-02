import { describe, expect, it, spyOn } from "bun:test";
import { Effect, Exit, Fiber, Layer, Scope } from "effect";
import { log } from "@/node/services/log";
import { AppFiberScopeLive, AppFiberScopeTag } from "./appFiberScope";
import { closeScopeBounded, disposeAppRuntime, makeAppRuntime } from "./appRuntime";
import { EffectRunnerLive, EffectRunnerTag } from "./effectRunner";

/** An interruptible I/O-style suspension that never resolves; records interruption. */
function hungIo(onInterrupt: () => void): Effect.Effect<void> {
  return Effect.callback<void>(() =>
    Effect.sync(() => {
      onInterrupt();
    })
  );
}

function buildSeams() {
  const app = makeAppRuntime(AppFiberScopeLive.pipe(Layer.provideMerge(EffectRunnerLive)));
  return {
    app,
    appFiberScope: app.get(AppFiberScopeTag),
    runner: app.get(EffectRunnerTag),
  };
}

describe("AppFiberScope", () => {
  it("closeScopeBounded interrupts and awaits an I/O-suspended fiber forked into it", async () => {
    const { app, appFiberScope } = buildSeams();
    const steps: string[] = [];
    const fiber = app.managed.runSync(
      Effect.forkIn(
        hungIo(() => steps.push("cancelled")).pipe(
          Effect.ensuring(Effect.sync(() => steps.push("finalized")))
        ),
        appFiberScope
      )
    );

    await closeScopeBounded(appFiberScope);

    // Interrupted (the cancel path ran) and awaited (its finalizer ran before
    // the close resolved), so shutdown can rely on the fiber being gone.
    expect(steps).toEqual(["cancelled", "finalized"]);
    expect(fiber.pollUnsafe()).toBeDefined();
    expect(Exit.isFailure(fiber.pollUnsafe()!)).toBe(true);
    await disposeAppRuntime(app.managed);
  });

  it("fibers forked through the EffectRunner are interrupted by neither close (unsupervised)", async () => {
    const { app, appFiberScope, runner } = buildSeams();
    let interrupted = false;
    const fiber = runner.runFork(
      hungIo(() => {
        interrupted = true;
      })
    );

    await closeScopeBounded(appFiberScope);
    await disposeAppRuntime(app.managed);

    // The runner is not a supervisor: its fibers belong to whoever forked them
    // (a worker's own scope with an explicit stop()), so dispose leaves them be.
    expect(interrupted).toBe(false);
    expect(fiber.pollUnsafe()).toBeUndefined();
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(interrupted).toBe(true);
  });

  it("disposeAppRuntime re-closes an already-closed AppFiberScope idempotently", async () => {
    const { app, appFiberScope } = buildSeams();
    let finalized = 0;
    app.managed.runSync(
      Scope.addFinalizer(
        appFiberScope,
        Effect.sync(() => {
          finalized += 1;
        })
      )
    );

    await closeScopeBounded(appFiberScope);
    expect(finalized).toBe(1);

    // The runtime's layer scope owns the child; closing the runtime afterwards
    // must neither throw nor run the child's finalizers a second time.
    await disposeAppRuntime(app.managed);
    expect(finalized).toBe(1);
    expect(app.managed.cachedContext).toBeUndefined();
  });

  it("runtime dispose alone closes the AppFiberScope (backstop for a missed explicit close)", async () => {
    const { app, appFiberScope } = buildSeams();
    let interrupted = false;
    app.managed.runSync(
      Effect.forkIn(
        hungIo(() => {
          interrupted = true;
        }),
        appFiberScope
      )
    );

    await disposeAppRuntime(app.managed);

    expect(interrupted).toBe(true);
    expect(appFiberScope.state._tag).toBe("Closed");
  });

  it("closeScopeBounded returns at the timeout when a fiber cannot be interrupted, warning instead of rejecting", async () => {
    const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const { app, appFiberScope } = buildSeams();
      // Uninterruptible and never-resolving: the scope close can never finish.
      app.managed.runSync(Effect.forkIn(Effect.uninterruptible(Effect.never), appFiberScope));

      const startedAt = Date.now();
      await closeScopeBounded(appFiberScope, 50);

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("timed out");
      // The runtime dispose then hits the same hung finalizer; keep it bounded too.
      await disposeAppRuntime(app.managed, 50);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
