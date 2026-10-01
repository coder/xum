import assert from "@/common/utils/assert";

/**
 * AsyncSemaphore - a counting semaphore for async operations.
 *
 * At most `limit` holders run at once; further acquirers wait FIFO until a
 * slot is released. Useful for sliding-window concurrency: the next queued
 * operation starts as soon as any running one finishes, instead of waiting
 * for an entire fixed-size batch to drain.
 */
export class AsyncSemaphore {
  private active = 0;
  // `active` stays at `limit` while a queued waiter is handed a slot, so a free slot
  // implies an empty queue: nobody can barge past a waiter.
  private readonly queue: Array<(slot: AsyncSemaphoreSlot) => void> = [];

  constructor(private readonly limit: number) {
    assert(Number.isInteger(limit) && limit > 0, "AsyncSemaphore limit must be a positive integer");
  }

  /** Acquire a slot, waiting until one is free. Release the slot exactly once. */
  async acquire(): Promise<AsyncSemaphoreSlot> {
    if (this.active < this.limit) {
      this.active += 1;
      return this.newSlot();
    }
    // releaseSlot() hands its slot straight to the first waiter
    // (formal/primitives/AsyncSemaphore.tla): a woken waiter that re-checked in a later
    // microtask could lose the slot to a caller in between and re-queue at the tail.
    return await new Promise<AsyncSemaphoreSlot>((resolve) => this.queue.push(resolve));
  }

  /**
   * Releases go only through the slot handle (#5332): a public releaseSlot() let a caller free a
   * slot it never acquired, which hands that slot to a waiter while the real holder still runs.
   */
  private newSlot(): AsyncSemaphoreSlot {
    return new AsyncSemaphoreSlot(() => this.releaseSlot());
  }

  /** Hand the slot to the next waiter in queue, or free it when nobody waits. */
  private releaseSlot(): void {
    assert(this.active > 0, "AsyncSemaphore.releaseSlot called with no active holders");
    const next = this.queue.shift();
    if (next) {
      next(this.newSlot()); // the slot moves over; `active` is unchanged
    } else {
      this.active -= 1;
    }
  }
}

/**
 * AsyncSemaphoreSlot - a held semaphore slot.
 *
 * Released explicitly (typically in a `finally` block) so callers can order
 * side effects before the next waiter is admitted; double release asserts.
 */
class AsyncSemaphoreSlot {
  private released = false;

  constructor(private readonly releaseToSemaphore: () => void) {}

  release(): void {
    assert(!this.released, "AsyncSemaphoreSlot.release called twice");
    this.released = true;
    this.releaseToSemaphore();
  }
}
