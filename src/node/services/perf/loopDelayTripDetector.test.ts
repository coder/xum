import { describe, expect, test } from "bun:test";
import type { LoopDelayWindow } from "@/common/orpc/schemas/perfFlightRecorder";
import { LoopDelayTripDetector } from "./loopDelayTripDetector";

const p99 = (p99Ms: number | null, samplerLagMs = 0): LoopDelayWindow => ({ p99Ms, samplerLagMs });

describe("LoopDelayTripDetector", () => {
  test("trips once at the second consecutive high window and re-arms after recovery", () => {
    const detector = new LoopDelayTripDetector(100, 2);
    const results = [150, 100, 120, 130, 140, 500, 90, 101, 102].map((ms) =>
      detector.observe(p99(ms))
    );
    expect(results).toEqual([
      null, // a single high window
      null, // at the threshold is not high
      null,
      [p99(120), p99(130)], // second consecutive high window
      null, // the streak continues without a second trip
      null,
      null, // recovered
      null,
      [p99(101), p99(102)], // re-armed
    ]);
  });

  test("a late sampling tick counts as high even when the histogram recorded nothing", () => {
    const detector = new LoopDelayTripDetector(100, 2);
    const results = [p99(null, 1500), p99(30, 400), p99(null, 0), p99(null, 100)].map((w) =>
      detector.observe(w)
    );
    // Lag-only and p99 windows chain into one streak; an empty on-time window is not high.
    expect(results).toEqual([null, [p99(null, 1500), p99(30, 400)], null, null]);
  });
});
