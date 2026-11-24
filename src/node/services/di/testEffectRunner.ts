/**
 * Test helper: an `EffectRunner` and a `HostClock` bound to ONE `TestClock`,
 * so a worker constructed with them sleeps, stamps and arms timers on virtual
 * time that the test advances with `adjust`/`setTime` (no real timers, no
 * polling).
 *
 * Built exactly like production (`EffectRunnerLive` with `HostClockLive` above
 * it at the base of a `makeAppRuntime` graph) with a TestClock as the provider,
 * so the worker under test and the test's `adjust` share one clock. `adjust`
 * resolves after every due sleep has been resumed and its synchronous
 * continuation has run (pinned in `testEffectRunner.test.ts`).
 */
import { Clock, Effect, Layer } from "effect";
import type { Duration } from "effect";
import { TestClock } from "effect/testing";
import type { HostClock } from "@/node/utils/hostClock";
import { disposeAppRuntime, makeAppRuntime } from "./appRuntime";
import { EffectRunnerLive, EffectRunnerTag, type EffectRunner } from "./effectRunner";
import { HostClockLive, HostClockTag } from "./hostClockLive";

/**
 * Where the test clock starts. Epoch 0 breaks production sentinels such as
 * `lastPartialWriteTime: 0` ("never written"), which assume a real wall time.
 */
export const TEST_CLOCK_START_MS = Date.UTC(2026, 0, 1);

export interface TestEffectRunner {
  readonly runner: EffectRunner;
  /** The HostClock over the same TestClock as `runner`. */
  readonly hostClock: HostClock;
  /** Advance the test clock, running every sleep due on or before the new time. */
  adjust(duration: Duration.Input): Promise<void>;
  /** Set the test clock to an absolute time (ms since epoch); same firing rule. */
  setTime(timestampMs: number): Promise<void>;
  dispose(): Promise<void>;
}

// TestClock.setTime is async and makeAppRuntime builds with runSync, so the
// start cannot be set after the build. The layer shifts the wrapped TestClock's
// wall time instead; sleeps are relative and stay unshifted.
const startedTestClock = (options?: TestClock.TestClock.Options) =>
  Layer.effect(Clock.Clock)(
    Effect.map(TestClock.make(options), (testClock): TestClock.TestClock => {
      const nowMs = () => TEST_CLOCK_START_MS + testClock.currentTimeMillisUnsafe();
      const nowNanos = () =>
        BigInt(TEST_CLOCK_START_MS) * BigInt(1_000_000) + testClock.currentTimeNanosUnsafe();
      return {
        ...testClock,
        currentTimeMillisUnsafe: nowMs,
        currentTimeMillis: Effect.sync(nowMs),
        currentTimeNanosUnsafe: nowNanos,
        currentTimeNanos: Effect.sync(nowNanos),
        setTime: (timestampMs: number) => testClock.setTime(timestampMs - TEST_CLOCK_START_MS),
      };
    })
  );

export function makeTestEffectRunner(options?: TestClock.TestClock.Options): TestEffectRunner {
  const runnerLayer = EffectRunnerLive.pipe(Layer.provideMerge(startedTestClock(options)));
  const app = makeAppRuntime(HostClockLive.pipe(Layer.provideMerge(runnerLayer)));
  const runner = app.get(EffectRunnerTag);
  return {
    runner,
    hostClock: app.get(HostClockTag),
    // Run through the runner so `TestClock.adjust` reads the captured clock.
    adjust: (duration) => runner.runPromise(TestClock.adjust(duration)),
    setTime: (timestampMs) => runner.runPromise(TestClock.setTime(timestampMs)),
    dispose: () => disposeAppRuntime(app.managed),
  };
}
