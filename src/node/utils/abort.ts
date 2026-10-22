/**
 * AbortSignal helpers.
 *
 * We frequently need to “bridge” an external AbortSignal into an internal AbortController
 * (e.g. per-stream cancellation, startup cancellation).
 *
 * The two common footguns this helper avoids:
 * - Missing an abort that happened before listener attachment.
 * - Leaving long-lived listeners around when the bridged operation completes.
 */

/**
 * Link an external AbortSignal into an AbortController.
 *
 * Returns a cleanup function that removes the event listener (no-op if none was added).
 */
export function linkAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController
): () => void {
  const noop = () => undefined;

  if (!source) {
    return noop;
  }

  if (source.aborted) {
    target.abort();
    return noop;
  }

  const onAbort = () => target.abort();
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

/**
 * Sleep for `ms` milliseconds, rejecting early if `abortSignal` fires.
 *
 * Extracted from four identical copies across SSHRuntime, sshConnectionPool,
 * SSH2ConnectionPool, and codexOauthService.
 */
export async function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (abortSignal?.aborted) {
    throw new Error("Operation aborted");
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error("Operation aborted"));
    };

    const cleanup = () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
    };

    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
