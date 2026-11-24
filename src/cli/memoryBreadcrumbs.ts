import { GCProfiler } from "node:v8";

export interface MajorGcHeapWindow {
  /** Heap in use right after the most recent major GC, ever. */
  lastAfterMajorGc: number | null;
  /** Lowest post-major-GC heap since the previous takeWindow(); null when no major GC ran. */
  minAfterMajorGc: number | null;
}

/** The part of a `v8.GCProfiler` statistics entry this module reads. */
export interface GcStatistic {
  gcType: string;
  afterGC: { heapStatistics: { usedHeapSize: number } };
}

/**
 * The `[memory]` line's heapUsed is sampled at an arbitrary point of the GC sawtooth: on a busy
 * server it swung 300-1000 MB while the heap after a full GC stayed near 350 MB (F12 sandbox,
 * 2026-10-15), so readers mistook garbage for growth. The heap measured right after each major
 * GC is the retained size; the lowest one per window is the floor a leak would raise.
 */
export function createMajorGcHeapTracker() {
  let last: number | null = null;
  let windowMin: number | null = null;
  return {
    /** Records every major GC in `statistics`, in order; other GC types are ignored. */
    record(statistics: readonly GcStatistic[]): void {
      for (const entry of statistics) {
        if (entry.gcType !== "MarkSweepCompact") continue;
        const used = entry.afterGC.heapStatistics.usedHeapSize;
        last = used;
        windowMin = windowMin === null ? used : Math.min(windowMin, used);
      }
    },
    takeWindow(): MajorGcHeapWindow {
      const window = { lastAfterMajorGc: last, minAfterMajorGc: windowMin };
      windowMin = null;
      return window;
    },
  };
}

const toMb = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** The `[memory]` line suffix for one window; "none" marks a window without a major GC. */
export function formatMajorGcHeapFields(window: MajorGcHeapWindow): string {
  const mbOrNone = (bytes: number | null) => (bytes === null ? "none" : `${toMb(bytes)}MB`);
  return ` heapAfterMajorGc=${mbOrNone(window.lastAfterMajorGc)} minHeapAfterMajorGc=${mbOrNone(window.minAfterMajorGc)}`;
}

/**
 * The profiler keeps one ~3 KB entry per GC (scavenges included) until stop(), so it is drained
 * this often to keep that buffer small on a busy server.
 */
const GC_PROFILE_DRAIN_MS = 60_000;

/**
 * Starts recording GCs and returns the per-line suffix reader. `v8.GCProfiler` captures each
 * GC's heap statistics at GC time; a PerformanceObserver callback runs only after JavaScript
 * yields, so it measured later allocations instead of the post-GC heap. Call this before
 * startup work so a major GC during startup counts. Without the profiler the reader returns ""
 * and the line keeps its older fields only.
 */
export function startMajorGcHeapFields(): () => string {
  const tracker = createMajorGcHeapTracker();
  let profiler: GCProfiler;
  try {
    profiler = new GCProfiler();
    profiler.start();
  } catch {
    return () => "";
  }
  const drain = () => {
    tracker.record(
      (profiler.stop() as { statistics?: GcStatistic[] } | undefined)?.statistics ?? []
    );
    profiler.start();
  };
  // unref: diagnostics must never keep the process alive.
  setInterval(drain, GC_PROFILE_DRAIN_MS).unref();
  return () => {
    drain();
    return formatMajorGcHeapFields(tracker.takeWindow());
  };
}
