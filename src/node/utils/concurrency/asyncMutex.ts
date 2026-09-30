import assert from "@/common/utils/assert";

/**
 * AsyncMutex - A mutual exclusion lock for async operations
 *
 * Ensures only one async operation can hold the lock at a time; waiters get
 * the lock in arrival order. Uses `using` declarations for guaranteed lock
 * release.
 *
 * Example:
 * ```typescript
 * const mutex = new AsyncMutex();
 * await using lock = await mutex.acquire();
 * // Critical section - only one execution at a time
 * // Lock automatically released when scope exits
 * ```
 */
export class AsyncMutex {
  // Stays true while a queued waiter is being handed the lock, so `locked` is
  // false only when the queue is empty: nobody can barge past a waiter.
  private locked = false;
  private readonly queue: Array<(lock: AsyncMutexLock) => void> = [];

  /**
   * Acquire the lock. Blocks until lock is available.
   * Returns an AsyncDisposable lock that auto-releases on scope exit.
   */
  async acquire(): Promise<AsyncMutexLock> {
    const lock = this.tryAcquire();
    if (lock !== null) {
      return lock;
    }
    // release() hands the lock straight to the first waiter (formal/primitives/AsyncMutex.tla):
    // a woken waiter that re-checked `locked` in a later microtask could lose the lock to a
    // caller in between and re-queue at the tail, breaking FIFO order.
    return await new Promise<AsyncMutexLock>((resolve) => this.queue.push(resolve));
  }

  /** True while some caller holds the lock (for defensive assertions only —
   * it cannot tell WHO holds it, so never use it as a locking substitute). */
  get isLocked(): boolean {
    return this.locked;
  }

  /**
   * Take the lock only if it is free RIGHT NOW; returns null when another
   * holder has it. Synchronous check-and-take — atomic in single-threaded
   * JS (no await between check and set). For callers whose work is optional
   * under contention and must never queue behind a long-lived lease (r70:
   * task-terminal delivery must not wait behind a running guest eval).
   */
  tryAcquire(): AsyncMutexLock | null {
    if (this.locked) {
      return null;
    }
    this.locked = true;
    return new AsyncMutexLock(() => this.release());
  }

  /**
   * Hand the lock to the next waiter, or free it when nobody waits. Private and
   * reached only through a handle's one-shot release, so a stale handle cannot
   * free a lock that someone else holds.
   */
  private release(): void {
    assert(this.locked, "AsyncMutex released while not locked");
    const next = this.queue.shift();
    if (next) {
      next(new AsyncMutexLock(() => this.release()));
    } else {
      this.locked = false;
    }
  }
}

/**
 * AsyncMutexLock - Auto-releasing lock handle
 *
 * Implements AsyncDisposable to ensure lock is released when scope exits.
 * This provides static compile-time guarantees against lock leaks.
 */
export class AsyncMutexLock implements AsyncDisposable {
  private released = false;

  constructor(private readonly releaseLock: () => void) {}

  /**
   * Release the lock when the `using` block exits. Disposing again is a no-op
   * (like KeyedFifoLock): an early explicit dispose followed by `await using`
   * scope exit is legitimate, and throwing from a dispose would mask the
   * error that unwound the scope.
   */
  [Symbol.asyncDispose](): Promise<void> {
    if (!this.released) {
      this.released = true;
      this.releaseLock();
    }
    return Promise.resolve();
  }
}
