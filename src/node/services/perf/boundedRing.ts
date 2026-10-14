import assert from "@/common/utils/assert";

/**
 * Fixed-capacity FIFO that also forgets entries older than `maxAgeMs`.
 * Each entry is stamped with the time it was recorded (the caller's clock, so
 * a renderer's skewed clock cannot keep entries alive or evict them early).
 */
export class BoundedRing<T> {
  private readonly entries: Array<{ atMs: number; value: T }> = [];

  constructor(
    private readonly capacity: number,
    private readonly maxAgeMs: number
  ) {
    assert(Number.isInteger(capacity) && capacity > 0, "BoundedRing capacity must be > 0");
    assert(maxAgeMs > 0, "BoundedRing maxAgeMs must be > 0");
  }

  push(value: T, atMs: number): void {
    this.entries.push({ atMs, value });
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    this.evictOlderThan(atMs);
  }

  /** Values recorded within `maxAgeMs` of `nowMs`, oldest first. */
  values(nowMs: number): T[] {
    this.evictOlderThan(nowMs);
    return this.entries.map((entry) => entry.value);
  }

  private evictOlderThan(nowMs: number): void {
    const cutoff = nowMs - this.maxAgeMs;
    let drop = 0;
    while (drop < this.entries.length && this.entries[drop].atMs < cutoff) drop++;
    if (drop > 0) this.entries.splice(0, drop);
  }
}
