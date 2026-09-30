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
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {
    assert(Number.isInteger(limit) && limit > 0, "AsyncSemaphore limit must be a positive integer");
  }

  /** Acquire a slot, waiting until one is free. Release the slot exactly once. */
  async acquire(): Promise<AsyncSemaphoreSlot> {
    while (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    return new AsyncSemaphoreSlot(this);
  }

  /**
   * Free a slot and wake the next waiter in queue
   * @internal - Should only be called by AsyncSemaphoreSlot
   */
  releaseSlot(): void {
    assert(this.active > 0, "AsyncSemaphore.releaseSlot called with no active holders");
    this.active -= 1;
    this.queue.shift()?.();
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

  constructor(private readonly semaphore: AsyncSemaphore) {}

  release(): void {
    assert(!this.released, "AsyncSemaphoreSlot.release called twice");
    this.released = true;
    this.semaphore.releaseSlot();
  }
}
