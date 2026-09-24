export type AbortAndTimeoutResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "timeout" }
  | { kind: "aborted" };

export async function raceWithAbortAndTimeout<T>(
  promise: Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number }
): Promise<AbortAndTimeoutResult<T>> {
  return await new Promise<AbortAndTimeoutResult<T>>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer != null) {
        clearTimeout(timer);
      }
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
      timer = setTimeout(() => settle({ kind: "timeout" }), options.timeoutMs);
      timer.unref?.();
    }
  });
}
