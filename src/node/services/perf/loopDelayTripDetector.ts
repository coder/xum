import type { LoopDelayWindow } from "@/common/orpc/schemas/perfFlightRecorder";
import assert from "@/common/utils/assert";

/**
 * Reports one trip when the loop delay exceeds the threshold for
 * `consecutiveWindows` windows in a row. A window is high when its histogram p99
 * or its sampler lag exceeds the threshold: a block spanning the whole window can
 * leave the histogram empty, and only the late sampling tick shows it. It stays
 * quiet while the streak continues and re-arms after a window at or below the
 * threshold.
 */
export class LoopDelayTripDetector {
  private streak = 0;
  private previous: LoopDelayWindow = { p99Ms: null, samplerLagMs: 0 };

  constructor(
    private readonly thresholdMs: number,
    private readonly consecutiveWindows: number
  ) {
    assert(consecutiveWindows >= 2, "consecutiveWindows must be >= 2");
  }

  /** Returns the `[previous, current]` windows when this window trips, otherwise null. */
  observe(window: LoopDelayWindow): [LoopDelayWindow, LoopDelayWindow] | null {
    const previous = this.previous;
    this.previous = window;
    if (Math.max(window.p99Ms ?? 0, window.samplerLagMs) <= this.thresholdMs) {
      this.streak = 0;
      return null;
    }
    // Saturate so a very long streak never counts up again to the trip value.
    this.streak = Math.min(this.streak + 1, this.consecutiveWindows + 1);
    return this.streak === this.consecutiveWindows ? [previous, window] : null;
  }

  reset(): void {
    this.streak = 0;
    this.previous = { p99Ms: null, samplerLagMs: 0 };
  }
}
