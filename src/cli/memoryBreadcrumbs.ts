import { PerformanceObserver, constants as perfConstants } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

export interface MajorGcHeapWindow {
  /** Heap in use right after the most recent major GC, ever. */
  lastAfterMajorGc: number | null;
  /** Lowest post-major-GC heap since the previous takeWindow(); null when no major GC ran. */
  minAfterMajorGc: number | null;
}

/**
 * The `[memory]` line's heapUsed is sampled at an arbitrary point of the GC sawtooth: on a busy
 * server it swung 300-1000 MB while the heap after a full GC stayed near 350 MB (F12 sandbox,
 * 2026-10-15), so readers mistook garbage for growth. The heap measured right after each major
 * GC is the retained size; the lowest one per window is the floor a leak would raise.
 */
export function createMajorGcHeapTracker(readHeapUsed: () => number) {
  let last: number | null = null;
  let windowMin: number | null = null;
  return {
    onMajorGc(): void {
      const used = readHeapUsed();
      last = used;
      windowMin = windowMin === null ? used : Math.min(windowMin, used);
    },
    takeWindow(): MajorGcHeapWindow {
      const window = { lastAfterMajorGc: last, minAfterMajorGc: windowMin };
      windowMin = null;
      return window;
    },
  };
}

/**
 * Feeds a tracker from Node's `gc` performance entries. The observer callback runs shortly after
 * the GC (entries are delivered asynchronously), so the reading includes whatever was allocated in
 * between: close to, and never below, the true post-GC size. Returns null when the runtime has no
 * gc entries; the breadcrumb then omits the values instead of failing startup.
 */
export function observeMajorGcHeap(): ReturnType<typeof createMajorGcHeapTracker> | null {
  const tracker = createMajorGcHeapTracker(() => getHeapStatistics().used_heap_size);
  try {
    const observer = new PerformanceObserver((list) => {
      const sawMajor = list
        .getEntries()
        // gc entries carry `detail.kind`; the installed Node typings omit `detail`.
        .some(
          (entry) =>
            (entry as { detail?: { kind?: number } }).detail?.kind ===
            perfConstants.NODE_PERFORMANCE_GC_MAJOR
        );
      if (sawMajor) tracker.onMajorGc();
    });
    observer.observe({ entryTypes: ["gc"] });
    return tracker;
  } catch {
    return null;
  }
}

const toMb = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** The `[memory]` line suffix for one window; "none" marks a window without a major GC. */
export function formatMajorGcHeapFields(window: MajorGcHeapWindow): string {
  const mbOrNone = (bytes: number | null) => (bytes === null ? "none" : `${toMb(bytes)}MB`);
  return ` heapAfterMajorGc=${mbOrNone(window.lastAfterMajorGc)} minHeapAfterMajorGc=${mbOrNone(window.minAfterMajorGc)}`;
}

/**
 * Starts the observer and returns the per-line suffix reader. Without gc entries it returns ""
 * so the line keeps its older fields only.
 */
export function startMajorGcHeapFields(): () => string {
  const tracker = observeMajorGcHeap();
  if (tracker === null) return () => "";
  return () => formatMajorGcHeapFields(tracker.takeWindow());
}
