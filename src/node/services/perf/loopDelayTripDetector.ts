import assert from "@/common/utils/assert";

/**
 * Reports one trip when the loop-delay p99 exceeds the threshold for
 * `consecutiveWindows` windows in a row. It stays quiet while the streak
 * continues and re-arms after a window at or below the threshold.
 */
export class LoopDelayTripDetector {
  private streak = 0;
  private previousP99Ms = 0;

  constructor(
    private readonly thresholdMs: number,
    private readonly consecutiveWindows: number
  ) {
    assert(consecutiveWindows >= 2, "consecutiveWindows must be >= 2");
  }

  /** Returns `[previous, current]` p99 when this window trips, otherwise null. */
  observe(p99Ms: number): [number, number] | null {
    const previous = this.previousP99Ms;
    this.previousP99Ms = p99Ms;
    if (p99Ms <= this.thresholdMs) {
      this.streak = 0;
      return null;
    }
    // Saturate so a very long streak never counts up again to the trip value.
    this.streak = Math.min(this.streak + 1, this.consecutiveWindows + 1);
    return this.streak === this.consecutiveWindows ? [previous, p99Ms] : null;
  }

  reset(): void {
    this.streak = 0;
    this.previousP99Ms = 0;
  }
}
