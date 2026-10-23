import { nodeClock, type HostClock } from "@/node/utils/hostClock";

export type AbortAndTimeoutResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "timeout" }
  | { kind: "aborted" };

export async function raceWithAbortAndTimeout<T>(
  promise: Promise<T>,
  // clock: agent-loop callers pass their HostClock so tests can drive the
  // timeout on a TestClock; every other caller keeps nodeClock (setTimeout).
  options: { signal?: AbortSignal; timeoutMs?: number; clock?: HostClock }
): Promise<AbortAndTimeoutResult<T>> {
  return await new Promise<AbortAndTimeoutResult<T>>((resolve, reject) => {
    let settled = false;
    let cancelTimer: (() => void) | undefined;

    const cleanup = () => {
      cancelTimer?.();
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (result: AbortAndTimeoutResult<T>) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = () => settle({ kind: "aborted" });

    // The caller has already started this work. Observe its rejection even when
    // cancellation won before we were called, so late failures cannot go unhandled.
    promise.then(
      (value) => settle({ kind: "ok", value }),
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
    if (options.signal?.aborted) {
      settle({ kind: "aborted" });
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Register settlement before arming the timer so an already-settled
    // promise wins over a simultaneous timeout.
    if (options.timeoutMs != null) {
      cancelTimer = (options.clock ?? nodeClock).setTimer(
        () => settle({ kind: "timeout" }),
        options.timeoutMs,
        { unref: true }
      );
    }
  });
}
