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

  /**
   * Skips a window the process blocked on purpose (see FlightRecorder.noteSelfInducedBlock).
   * A streak that has not tripped yet restarts, so real high windows on either side of
   * the skipped one never count as consecutive. A streak that already tripped stays
   * quiet: only a real window at or below the threshold re-arms it, so the skipped
   * window cannot cause a second trip for the same stall.
   */
  ignoreWindow(): void {
    if (this.streak < this.consecutiveWindows) this.reset();
  }

  reset(): void {
    this.streak = 0;
    this.previous = { p99Ms: null, samplerLagMs: 0 };
  }
}
