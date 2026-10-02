import { describe, expect, test } from "bun:test";
import { LoopDelayTripDetector } from "./loopDelayTripDetector";

describe("LoopDelayTripDetector", () => {
  test("trips once at the second consecutive high window and re-arms after recovery", () => {
    const detector = new LoopDelayTripDetector(100, 2);
    const results = [150, 100, 120, 130, 140, 500, 90, 101, 102].map((p99) =>
      detector.observe(p99)
    );
    expect(results).toEqual([
      null, // a single high window
      null, // at the threshold is not high
      null,
      [120, 130], // second consecutive high window
      null, // the streak continues without a second trip
      null,
      null, // recovered
      null,
      [101, 102], // re-armed
    ]);
  });
});
