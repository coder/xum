/**
 * MutexMap - Generic mutex utility for serializing operations per key
 *
 * Prevents race conditions when multiple concurrent operations need to
 * modify the same resource (file, data structure, etc.) identified by a key.
 *
 * Example usage:
 * ```typescript
 * const fileLocks = new MutexMap<string>();
 *
 * // Serialize writes to the same file
 * await fileLocks.withLock("file.txt", async () => {
 *   await fs.writeFile("file.txt", data);
 * });
 * ```
 */
export class MutexMap<K> {
  private locks = new Map<K, Promise<void>>();

  /**
   * Execute an operation with exclusive access per key
   * Operations for the same key are serialized (run one at a time)
   * Operations for different keys can run concurrently
   */
  async withLock<T>(key: K, operation: () => Promise<T>): Promise<T> {
    // Chain onto existing lock (or resolved promise if none)
    const previousLock = this.locks.get(key) ?? Promise.resolve();

    let releaseLock: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    // ATOMIC: set our lock BEFORE awaiting previous
    // This prevents the TOCTOU race where multiple callers see the same
    // existing lock, all await it, then all proceed concurrently
    this.locks.set(key, lockPromise);

    try {
      await previousLock; // Wait for previous operation
      return await operation();
    } finally {
      releaseLock!();
      if (this.locks.get(key) === lockPromise) {
        this.locks.delete(key);
      }
    }
  }

  /**
   * Like withLock, but stops waiting at `deadline` (epoch ms) and returns `{ kind: "timeout" }`.
   * Giving up only leaves the queue: the current holder keeps the key, and the abandoned place,
   * once reached, releases at once without running `operation`. Once entered, `operation` runs to
   * completion; the deadline never detaches it.
   */
  async withLockBounded<T>(
    key: K,
    operation: () => Promise<T>,
    deadline: number
  ): Promise<{ kind: "ok"; value: T } | { kind: "timeout" }> {
    let entered = false;
    let abandoned = false;
    const run = this.withLock(key, async (): Promise<T | undefined> => {
      if (abandoned) return undefined;
      entered = true;
      return await operation();
    });
    return await new Promise((resolve, reject) => {
      // A timer (never a synchronous check) even for a past deadline: an uncontended key is
      // entered in a microtask, before any timer can fire, so it is never refused.
      const timer = setTimeout(
        () => {
          if (entered || abandoned) return;
          abandoned = true;
          resolve({ kind: "timeout" });
        },
        Math.max(0, deadline - Date.now())
      );
      timer.unref?.();
      run.then(
        (value) => {
          clearTimeout(timer);
          if (!abandoned) resolve({ kind: "ok", value: value as T });
        },
        (error: unknown) => {
          clearTimeout(timer);
          if (!abandoned) reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
  }

  /**
   * Like withLock, but never queues: when any operation holds or awaits `key` right now, returns
   * `{ acquired: false }` without running `operation`. The check and withLock's synchronous
   * `locks.set` run in the same tick, so no other caller can slip in between.
   */
  async tryWithLock<T>(
    key: K,
    operation: () => Promise<T>
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    if (this.locks.has(key)) {
      return { acquired: false };
    }
    return { acquired: true, value: await this.withLock(key, operation) };
  }
}
