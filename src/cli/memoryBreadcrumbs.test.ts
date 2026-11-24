import { describe, expect, test } from "bun:test";
import {
  createMajorGcHeapTracker,
  formatMajorGcHeapFields,
  type GcStatistic,
} from "./memoryBreadcrumbs";

const gc = (gcType: string, usedHeapSize: number): GcStatistic => ({
  gcType,
  afterGC: { heapStatistics: { usedHeapSize } },
});

describe("createMajorGcHeapTracker", () => {
  test("keeps every major GC of a batch: the last value and the window minimum", () => {
    const tracker = createMajorGcHeapTracker();

    tracker.record([gc("MarkSweepCompact", 900), gc("MarkSweepCompact", 400)]);
    tracker.record([gc("Scavenge", 50), gc("MarkSweepCompact", 650), gc("Scavenge", 80)]);

    expect(tracker.takeWindow()).toEqual({ lastAfterMajorGc: 650, minAfterMajorGc: 400 });
  });

  test("a window without a major GC keeps the last value and has no minimum", () => {
    const tracker = createMajorGcHeapTracker();
    tracker.record([gc("MarkSweepCompact", 500)]);
    tracker.takeWindow();

    // Minor GCs alone do not count, and the old low does not carry into the new window.
    tracker.record([gc("Scavenge", 20)]);
    expect(tracker.takeWindow()).toEqual({ lastAfterMajorGc: 500, minAfterMajorGc: null });
  });

  test("before any major GC both values are missing", () => {
    expect(createMajorGcHeapTracker().takeWindow()).toEqual({
      lastAfterMajorGc: null,
      minAfterMajorGc: null,
    });
  });
});

describe("formatMajorGcHeapFields", () => {
  test("a window without a major GC reads none, not 0MB", () => {
    const MB = 1024 * 1024;
    expect(formatMajorGcHeapFields({ lastAfterMajorGc: 365 * MB, minAfterMajorGc: null })).toBe(
      " heapAfterMajorGc=365MB minHeapAfterMajorGc=none"
    );
  });
});
