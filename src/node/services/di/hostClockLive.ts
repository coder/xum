/**
 * The `HostClock` Effect service (phase 3 of the agent-loop host refactor).
 *
 * The swap point is Effect's own `Clock`: `HostClockLive` derives the service
 * from the `Clock` that the graph's `EffectRunner` captured. With the default
 * Clock (production) that is `nodeClock`, i.e. today's `Date.now()` and
 * `setTimeout()`; under a `TestClock` it is a clock over that TestClock, so
 * timestamps, timers and the runner's `Effect.sleep`s all move with one
 * `adjust`. Hand-built services that take a runner derive their default the
 * same way (`hostClockFor`), so a test that injects a TestClock runner cannot
 * end up with a second, real clock for its timestamps.
 */
import { Clock, Context, Duration, Effect, Fiber, Layer } from "effect";
import { nodeClock, type HostClock } from "@/node/utils/hostClock";
import { EffectRunnerTag, type EffectRunner } from "./effectRunner";

export class HostClockTag extends Context.Service<HostClockTag, HostClock>()("xum/HostClock") {}

// The default Clock reference is one cached object (effect Context.ts
// getDefaultValue), so identity tells "no Clock layer was provided".
const LIVE_EFFECT_CLOCK = Context.get(Context.empty(), Clock.Clock);

/**
 * A HostClock over a non-default Effect `Clock` (a TestClock in tests). Timers
 * are runner fibers sleeping on that clock; cancel interrupts the fiber.
 */
function clockOnEffect(runner: EffectRunner, clock: Clock.Clock): HostClock {
  return {
    nowMs: () => clock.currentTimeMillisUnsafe(),
    setTimer: (fn, ms) => {
      let returned = false;
      let cancelled = false;
      let dueBeforeReturn = false;
      const fire = () => {
        if (!cancelled) {
          fn();
        }
      };
      const fiber = runner.runFork(
        Effect.sleep(Duration.millis(Math.max(0, ms))).pipe(
          Effect.andThen(
            Effect.sync(() => {
              // A sleep that is already due (0 ms on a TestClock) completes
              // inside runFork. Keep the setTimeout contract: fn never runs
              // before setTimer returns.
              if (returned) fire();
              else dueBeforeReturn = true;
            })
          )
        )
      );
      returned = true;
      if (dueBeforeReturn) {
        queueMicrotask(fire);
      }
      return () => {
        cancelled = true;
        runner.runFork(Fiber.interrupt(fiber));
      };
    },
  };
}

/** The HostClock that matches the Clock this runner runs on. */
export function hostClockFor(runner: EffectRunner): HostClock {
  const clock = runner.runSync(Clock.clockWith(Effect.succeed));
  return clock === LIVE_EFFECT_CLOCK ? nodeClock : clockOnEffect(runner, clock);
}

/** Place it directly above `EffectRunnerLive`, so both share one Clock. */
export const HostClockLive: Layer.Layer<HostClockTag, never, EffectRunnerTag> = Layer.effect(
  HostClockTag,
  Effect.gen(function* () {
    return hostClockFor(yield* EffectRunnerTag);
  })
);
