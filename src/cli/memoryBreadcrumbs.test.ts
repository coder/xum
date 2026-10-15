import { describe, expect, test } from "bun:test";
import { createMajorGcHeapTracker, formatMajorGcHeapFields } from "./memoryBreadcrumbs";

describe("createMajorGcHeapTracker", () => {
  test("reports the heap after the last major GC and the lowest one since the last window", () => {
    const readings = [900, 400, 650];
    const tracker = createMajorGcHeapTracker(() => {
      const next = readings.shift();
      if (next === undefined) throw new Error("unexpected heap read");
      return next;
    });

    for (let i = 0; i < 3; i++) tracker.onMajorGc();

    expect(tracker.takeWindow()).toEqual({ lastAfterMajorGc: 650, minAfterMajorGc: 400 });
  });

  test("a window without a major GC keeps the last value and has no minimum", () => {
    let used = 500;
    const tracker = createMajorGcHeapTracker(() => used);
    tracker.onMajorGc();
    tracker.takeWindow();

    // The minimum is per window, so the next window does not repeat the old low.
    expect(tracker.takeWindow()).toEqual({ lastAfterMajorGc: 500, minAfterMajorGc: null });

    used = 700;
    tracker.onMajorGc();
    expect(tracker.takeWindow()).toEqual({ lastAfterMajorGc: 700, minAfterMajorGc: 700 });
  });

  test("before any major GC both values are missing", () => {
    const tracker = createMajorGcHeapTracker(() => {
      throw new Error("heap must not be read without a GC");
    });
    expect(tracker.takeWindow()).toEqual({ lastAfterMajorGc: null, minAfterMajorGc: null });
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
