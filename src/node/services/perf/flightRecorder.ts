import {
  constants as perfHooksConstants,
  monitorEventLoopDelay,
  performance as nodePerformance,
  PerformanceObserver,
} from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import type {
  BackendHealthSample,
  FlightRecorderSnapshot,
  FlightRecorderState,
  FlightRecorderStatus,
  FlightRecorderTrip,
  GcKind,
  HeapSample,
  RendererBatch,
  RendererEventEntry,
  RendererLoafEntry,
} from "@/common/orpc/schemas/perfFlightRecorder";
import { perfEpochNowMs } from "@/common/utils/perf/clock";
import {
  FLIGHT_RECORDER_BACKEND_SAMPLE_CAPACITY,
  FLIGHT_RECORDER_HEAP_EVERY_N_SAMPLES,
  FLIGHT_RECORDER_HEAP_SAMPLE_CAPACITY,
  FLIGHT_RECORDER_LOAF_TRIP_MS,
  FLIGHT_RECORDER_LOOP_DELAY_P99_TRIP_MS,
  FLIGHT_RECORDER_LOOP_DELAY_RESOLUTION_MS,
  FLIGHT_RECORDER_LOOP_DELAY_TRIP_CONSECUTIVE_WINDOWS,
  FLIGHT_RECORDER_MAX_FAILURE_CHARS,
  FLIGHT_RECORDER_RENDERER_EVENT_CAPACITY,
  FLIGHT_RECORDER_RENDERER_LOAF_CAPACITY,
  FLIGHT_RECORDER_RETENTION_MS,
  FLIGHT_RECORDER_SAMPLE_INTERVAL_MS,
  FLIGHT_RECORDER_TRIP_CAPACITY,
} from "@/constants/perfFlightRecorder";
import { log } from "@/node/services/log";
import { BoundedRing } from "./boundedRing";
import { LoopDelayTripDetector } from "./loopDelayTripDetector";

/** Event-loop delay histogram; values are nanoseconds (node:perf_hooks IntervalHistogram). */
export interface LoopDelayHistogram {
  enable(): unknown;
  disable(): unknown;
  reset(): void;
  percentile(percentile: number): number;
  readonly min: number;
  readonly max: number;
  readonly count: number;
}

/**
 * Runtime probes the recorder samples. Production uses node:perf_hooks and
 * node:v8; Bun lacks `monitorEventLoopDelay` and the `gc` entry type, so the
 * bun test lane passes fakes.
 */
export interface FlightRecorderProbes {
  createLoopDelayHistogram(resolutionMs: number): LoopDelayHistogram;
  /** Cumulative event-loop idle and active milliseconds since process start. */
  readEventLoopUtilization(): { idleMs: number; activeMs: number };
  observeGc(onGc: (kind: GcKind, durationMs: number) => void): { disconnect(): void };
  readHeap(): { usedBytes: number; totalBytes: number; limitBytes: number };
}

export interface FlightRecorderScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface FlightRecorderOptions {
  probes?: FlightRecorderProbes;
  scheduler?: FlightRecorderScheduler;
  now?: () => number;
}

export type FlightRecorderTripListener = (trip: FlightRecorderTrip) => void;
export type FlightRecorderStatusListener = (status: FlightRecorderStatus) => void;

function gcKindFromNodeKind(kind: unknown): GcKind {
  switch (kind) {
    case perfHooksConstants.NODE_PERFORMANCE_GC_MINOR:
      return "minor";
    case perfHooksConstants.NODE_PERFORMANCE_GC_MAJOR:
      return "major";
    case perfHooksConstants.NODE_PERFORMANCE_GC_INCREMENTAL:
      return "incremental";
    case perfHooksConstants.NODE_PERFORMANCE_GC_WEAKCB:
      return "weakcb";
    default:
      return "unknown";
  }
}

function readGcDetailKind(detail: unknown): unknown {
  return typeof detail === "object" && detail !== null && "kind" in detail
    ? detail.kind
    : undefined;
}

const nodeProbes: FlightRecorderProbes = {
  createLoopDelayHistogram: (resolutionMs) => monitorEventLoopDelay({ resolution: resolutionMs }),
  readEventLoopUtilization: () => {
    const elu = nodePerformance.eventLoopUtilization();
    return { idleMs: elu.idle, activeMs: elu.active };
  },
  observeGc: (onGc) => {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // `detail` is a runtime field of gc entries that @types/node's PerformanceEntry omits.
        onGc(gcKindFromNodeKind(readGcDetailKind(Reflect.get(entry, "detail"))), entry.duration);
      }
    });
    observer.observe({ entryTypes: ["gc"] });
    return observer;
  },
  readHeap: () => {
    const stats = getHeapStatistics();
    return {
      usedBytes: stats.used_heap_size,
      totalBytes: stats.total_heap_size,
      limitBytes: stats.heap_size_limit,
    };
  },
};

const nodeScheduler: FlightRecorderScheduler = {
  setInterval: (callback, intervalMs) => {
    const handle = setInterval(callback, intervalMs);
    // Sampling must never keep the process alive.
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

type GcStats = BackendHealthSample["gc"];

function emptyGcStats(): GcStats {
  const zero = () => ({ count: 0, totalMs: 0, maxMs: 0 });
  return {
    ...zero(),
    byKind: { minor: zero(), major: zero(), incremental: zero(), weakcb: zero(), unknown: zero() },
  };
}

const NS_PER_MS = 1e6;

/** Everything one enabled period created; torn down as a unit. */
interface Collection {
  histogram: LoopDelayHistogram | null;
  gcObserver: { disconnect(): void } | null;
  interval: { handle: unknown } | null;
  gc: GcStats;
  lastTickAtMs: number;
  lastElu: { idleMs: number; activeMs: number };
  ticks: number;
}

/**
 * Opt-in, local-only backend health recorder (experiment `perfFlightRecorder`).
 *
 * Off (the default) creates no observers, histograms or timers. On, it samples
 * event-loop delay, event-loop utilization and GC at 1 Hz (heap every 10th
 * sample) into rings bounded by capacity and age, accepts renderer batches, and
 * emits typed threshold trips for later flight-recorder steps. Any probe failure
 * logs once, tears down what was started and latches "failed" until restart.
 */
export class FlightRecorder {
  private readonly probes: FlightRecorderProbes;
  private readonly scheduler: FlightRecorderScheduler;
  private readonly now: () => number;

  private state: FlightRecorderState = "off";
  /** The experiment value last adopted via setEnabled; differs from state when failed. */
  private enabled = false;
  private failure: string | undefined;
  private collection: Collection | null = null;

  private readonly samples = new BoundedRing<BackendHealthSample>(
    FLIGHT_RECORDER_BACKEND_SAMPLE_CAPACITY,
    FLIGHT_RECORDER_RETENTION_MS
  );
  private readonly heap = new BoundedRing<HeapSample>(
    FLIGHT_RECORDER_HEAP_SAMPLE_CAPACITY,
    FLIGHT_RECORDER_RETENTION_MS
  );
  private readonly rendererLoaf = new BoundedRing<RendererLoafEntry>(
    FLIGHT_RECORDER_RENDERER_LOAF_CAPACITY,
    FLIGHT_RECORDER_RETENTION_MS
  );
  private readonly rendererEvents = new BoundedRing<RendererEventEntry>(
    FLIGHT_RECORDER_RENDERER_EVENT_CAPACITY,
    FLIGHT_RECORDER_RETENTION_MS
  );
  private readonly trips = new BoundedRing<FlightRecorderTrip>(
    FLIGHT_RECORDER_TRIP_CAPACITY,
    FLIGHT_RECORDER_RETENTION_MS
  );
  private droppedLoaf = 0;
  private droppedEvents = 0;

  private readonly loopDelayTrips = new LoopDelayTripDetector(
    FLIGHT_RECORDER_LOOP_DELAY_P99_TRIP_MS,
    FLIGHT_RECORDER_LOOP_DELAY_TRIP_CONSECUTIVE_WINDOWS
  );
  private readonly tripListeners = new Set<FlightRecorderTripListener>();
  private loggedListenerError = false;
  private readonly statusListeners = new Set<FlightRecorderStatusListener>();
  private publishedStatus: FlightRecorderStatus = { enabled: false, state: "off" };

  constructor(options: FlightRecorderOptions = {}) {
    this.probes = options.probes ?? nodeProbes;
    this.scheduler = options.scheduler ?? nodeScheduler;
    this.now = options.now ?? perfEpochNowMs;
  }

  /** Idempotent. A failed recorder stays failed: broken probes are not retried. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.state !== "failed") {
      if (enabled && this.state === "off") this.start();
      else if (!enabled && this.state === "collecting") this.stopCollection();
    }
    this.publishStatusIfChanged();
  }

  stop(): void {
    if (this.state === "collecting") this.stopCollection();
    this.tripListeners.clear();
    this.statusListeners.clear();
  }

  getStatus(): FlightRecorderStatus {
    return { enabled: this.enabled, state: this.state };
  }

  /**
   * Fires on every status change, whoever caused it (Settings, CLI, another
   * process, a probe failure), so renderers can follow the backend without polling.
   */
  onStatusChange(listener: FlightRecorderStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onTrip(listener: FlightRecorderTripListener): () => void {
    this.tripListeners.add(listener);
    return () => this.tripListeners.delete(listener);
  }

  /** Rings stay readable after disable; they age out after the retention window. */
  getSnapshot(): FlightRecorderSnapshot {
    const nowMs = this.now();
    return {
      version: 1,
      state: this.state,
      nowMs,
      ...(this.failure !== undefined ? { failure: this.failure } : {}),
      backend: { samples: this.samples.values(nowMs), heap: this.heap.values(nowMs) },
      renderer: {
        loaf: this.rendererLoaf.values(nowMs),
        events: this.rendererEvents.values(nowMs),
        droppedLoaf: this.droppedLoaf,
        droppedEvents: this.droppedEvents,
      },
      trips: this.trips.values(nowMs),
    };
  }

  ingestRendererBatch(batch: RendererBatch): { accepted: boolean } {
    if (this.state !== "collecting") return { accepted: false };
    const nowMs = this.now();
    for (const entry of batch.loaf) {
      this.rendererLoaf.push(entry, nowMs);
      if (entry.durationMs > FLIGHT_RECORDER_LOAF_TRIP_MS) {
        this.recordTrip({
          kind: "long-animation-frame",
          atMs: entry.startMs,
          durationMs: entry.durationMs,
          rendererId: entry.rendererId,
        });
      }
    }
    for (const entry of batch.events) this.rendererEvents.push(entry, nowMs);
    this.droppedLoaf += batch.droppedLoaf;
    this.droppedEvents += batch.droppedEvents;
    return { accepted: true };
  }

  private start(): void {
    const collection: Collection = {
      histogram: null,
      gcObserver: null,
      interval: null,
      gc: emptyGcStats(),
      lastTickAtMs: 0,
      lastElu: { idleMs: 0, activeMs: 0 },
      ticks: 0,
    };
    // Published before any probe starts so a partial start is torn down completely.
    this.collection = collection;
    try {
      collection.histogram = this.probes.createLoopDelayHistogram(
        FLIGHT_RECORDER_LOOP_DELAY_RESOLUTION_MS
      );
      collection.histogram.enable();
      collection.gcObserver = this.probes.observeGc((kind, durationMs) =>
        addGc(collection.gc, kind, durationMs)
      );
      collection.lastElu = this.probes.readEventLoopUtilization();
      collection.lastTickAtMs = this.now();
      this.loopDelayTrips.reset();
      collection.interval = {
        handle: this.scheduler.setInterval(
          () => this.tick(collection),
          FLIGHT_RECORDER_SAMPLE_INTERVAL_MS
        ),
      };
      this.state = "collecting";
    } catch (error) {
      this.fail("start", error);
    }
  }

  private stopCollection(): void {
    this.teardown();
    this.loopDelayTrips.reset();
    this.state = "off";
  }

  private tick(collection: Collection): void {
    // A tick queued before a stop must not sample a torn-down collection.
    if (this.collection !== collection) return;
    try {
      this.sample(collection);
    } catch (error) {
      this.fail("sample", error);
    }
  }

  private sample(collection: Collection): void {
    const histogram = collection.histogram;
    if (histogram === null) throw new Error("loop delay histogram missing");
    const atMs = this.now();
    const loopDelay =
      histogram.count > 0
        ? {
            p50Ms: histogram.percentile(50) / NS_PER_MS,
            p99Ms: histogram.percentile(99) / NS_PER_MS,
            maxMs: histogram.max / NS_PER_MS,
            minMs: histogram.min / NS_PER_MS,
          }
        : { p50Ms: 0, p99Ms: 0, maxMs: 0, minMs: 0 };
    histogram.reset();

    const elu = this.probes.readEventLoopUtilization();
    const activeMs = Math.max(0, elu.activeMs - collection.lastElu.activeMs);
    const idleMs = Math.max(0, elu.idleMs - collection.lastElu.idleMs);
    const busyAndIdleMs = activeMs + idleMs;
    collection.lastElu = elu;

    const gc = collection.gc;
    collection.gc = emptyGcStats();

    this.samples.push(
      {
        atMs,
        windowMs: Math.max(0, atMs - collection.lastTickAtMs),
        loopDelay,
        elu: {
          utilization: busyAndIdleMs > 0 ? activeMs / busyAndIdleMs : 0,
          activeMs,
          idleMs,
        },
        gc,
      },
      atMs
    );
    collection.lastTickAtMs = atMs;
    collection.ticks += 1;

    if (collection.ticks % FLIGHT_RECORDER_HEAP_EVERY_N_SAMPLES === 0) {
      this.heap.push({ atMs, ...this.probes.readHeap() }, atMs);
    }

    const tripP99 = this.loopDelayTrips.observe(loopDelay.p99Ms);
    if (tripP99 !== null) this.recordTrip({ kind: "loop-delay-p99", atMs, p99Ms: tripP99 });
  }

  private recordTrip(trip: FlightRecorderTrip): void {
    this.trips.push(trip, this.now());
    for (const listener of this.tripListeners) {
      try {
        listener(trip);
      } catch (error) {
        if (!this.loggedListenerError) {
          this.loggedListenerError = true;
          log.warn("[perfFlightRecorder] trip listener threw", { error: errorMessage(error) });
        }
      }
    }
  }

  private publishStatusIfChanged(): void {
    const status = this.getStatus();
    const previous = this.publishedStatus;
    if (status.enabled === previous.enabled && status.state === previous.state) return;
    this.publishedStatus = status;
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (error) {
        if (!this.loggedListenerError) {
          this.loggedListenerError = true;
          log.warn("[perfFlightRecorder] status listener threw", { error: errorMessage(error) });
        }
      }
    }
  }

  private fail(phase: string, error: unknown): void {
    this.teardown();
    this.state = "failed";
    this.failure = `${phase}: ${errorMessage(error)}`.slice(0, FLIGHT_RECORDER_MAX_FAILURE_CHARS);
    // Logged once: the "failed" latch prevents any later start or tick.
    log.warn("[perfFlightRecorder] disabled after failure", { failure: this.failure });
    // A tick failure has no setEnabled caller to publish it.
    this.publishStatusIfChanged();
  }

  /** Releases everything the current collection started; each step is independent. */
  private teardown(): void {
    const collection = this.collection;
    this.collection = null;
    if (collection === null) return;
    const steps: Array<() => void> = [
      () => {
        if (collection.interval !== null) this.scheduler.clearInterval(collection.interval.handle);
      },
      () => collection.gcObserver?.disconnect(),
      () => collection.histogram?.disable(),
    ];
    for (const step of steps) {
      try {
        step();
      } catch {
        // Best effort: a probe that cannot be released must not block releasing the others.
      }
    }
  }
}

function addGc(stats: GcStats, kind: GcKind, durationMs: number): void {
  stats.count += 1;
  stats.totalMs += durationMs;
  stats.maxMs = Math.max(stats.maxMs, durationMs);
  const byKind = stats.byKind[kind];
  byKind.count += 1;
  byKind.totalMs += durationMs;
  byKind.maxMs = Math.max(byKind.maxMs, durationMs);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
