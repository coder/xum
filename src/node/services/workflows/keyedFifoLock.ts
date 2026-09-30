import assert from "@/common/utils/assert";

/**
 * In-process FIFO lock per key (a lock path). A key is present in `queues` exactly while it is
 * held; its array lists the waiters in arrival order, and release hands the key straight to the
 * first one. A waiter that gives up at its deadline is spliced out, so a hung holder retains
 * nothing for it (a promise chain would keep every abandoned place, and its closure, alive until
 * the holder released).
 */
export class KeyedFifoLock {
  private readonly queues = new Map<string, Array<() => void>>();

  /** Takes `key` only if nobody holds it (and so nobody waits); otherwise null. */
  tryAcquire(key: string): (() => void) | null {
    if (this.queues.has(key)) {
      return null;
    }
    this.queues.set(key, []);
    return this.releaser(key);
  }

  /**
   * Waits in FIFO order for `key` until `deadline` (epoch ms). Returns the release, or null when
   * the deadline passed first; giving up only leaves the queue, the holder keeps the key.
   */
  async acquire(key: string, deadline: number): Promise<(() => void) | null> {
    const immediate = this.tryAcquire(key);
    if (immediate != null) {
      return immediate;
    }
    const waiters = this.queues.get(key);
    assert(waiters != null, "KeyedFifoLock: a held key has a waiter list");
    return await new Promise((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(this.releaser(key));
      };
      const timer = setTimeout(
        () => {
          const index = waiters.indexOf(grant);
          if (index !== -1) {
            waiters.splice(index, 1);
            resolve(null);
          }
        },
        Math.max(0, deadline - Date.now())
      );
      timer.unref?.();
      waiters.push(grant);
    });
  }

  /** No production caller: kept as the only observable that an abandoned waiter retains nothing. */
  waiterCount(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }

  private releaser(key: string): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const waiters = this.queues.get(key);
      assert(waiters != null, "KeyedFifoLock: released a key that is not held");
      const next = waiters.shift();
      if (next != null) {
        next();
      } else {
        this.queues.delete(key);
      }
    };
  }
}
