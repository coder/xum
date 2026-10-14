import type {
  RpcProcedureStats,
  RpcSlowCall,
  RpcSnapshot,
  RpcSubscriptionStats,
  WsFlowControlWait,
} from "@/common/orpc/schemas/perfFlightRecorder";
import { getErrorMessage } from "@/common/utils/errors";
import {
  FLIGHT_RECORDER_RETENTION_MS,
  FLIGHT_RECORDER_RPC_EVENT_RATE_BUCKET_MS,
  FLIGHT_RECORDER_RPC_MAX_ERROR_CODE_CHARS,
  FLIGHT_RECORDER_RPC_MAX_PATH_CHARS,
  FLIGHT_RECORDER_RPC_MAX_PATHS,
  FLIGHT_RECORDER_RPC_SLOW_CALL_CAPACITY,
  FLIGHT_RECORDER_RPC_WINDOW_MS,
  FLIGHT_RECORDER_RPC_WINDOW_SLICES,
  FLIGHT_RECORDER_RPC_WS_WAIT_CAPACITY,
  FLIGHT_RECORDER_SLOW_RPC_MS,
} from "@/constants/perfFlightRecorder";
import { log } from "@/node/services/log";
import { BoundedRing } from "./boundedRing";

/** Counts one subscription's delivered values; `close()` runs once when it ends. */
export interface RpcSubscriptionTap {
  event(): void;
  close(): void;
}

/**
 * Latency histogram buckets: bucket 0 holds durations <= 0.25 ms, bucket k holds
 * (0.25 * 2^(k-1), 0.25 * 2^k] ms up to 0.25 * 2^18 ms (~65 s), and the last
 * bucket holds everything longer.
 */
const LATENCY_BUCKET_BASE_MS = 0.25;
const LATENCY_BOUNDED_BUCKETS = 19;
const LATENCY_BUCKETS = LATENCY_BOUNDED_BUCKETS + 1;
const SLICE_MS = FLIGHT_RECORDER_RPC_WINDOW_MS / FLIGHT_RECORDER_RPC_WINDOW_SLICES;
const RATE_BUCKETS = FLIGHT_RECORDER_RPC_WINDOW_MS / FLIGHT_RECORDER_RPC_EVENT_RATE_BUCKET_MS;

function latencyBucketIndex(durationMs: number): number {
  if (!(durationMs > LATENCY_BUCKET_BASE_MS)) return 0;
  const k = Math.ceil(Math.log2(durationMs / LATENCY_BUCKET_BASE_MS));
  return k < LATENCY_BOUNDED_BUCKETS ? k : LATENCY_BOUNDED_BUCKETS;
}

function latencyBucketUpperBoundMs(k: number): number {
  return k < LATENCY_BOUNDED_BUCKETS ? LATENCY_BUCKET_BASE_MS * 2 ** k : Number.POSITIVE_INFINITY;
}

/** Upper bound of the bucket holding rank ceil(p * total), clamped to the exact max. */
function bucketPercentileMs(counts: Uint32Array, total: number, maxMs: number, p: number): number {
  const rank = Math.max(1, Math.ceil(p * total));
  let seen = 0;
  for (let k = 0; k < LATENCY_BUCKETS; k++) {
    seen += counts[k];
    if (seen >= rank) return Math.min(latencyBucketUpperBoundMs(k), maxMs);
  }
  return maxMs;
}

/** Whether a slice or bucket stamped `epoch` lies inside the window ending at `currentEpoch`. */
function inWindow(epoch: number, currentEpoch: number, size: number): boolean {
  return epoch <= currentEpoch && currentEpoch - epoch < size;
}

function ringIndex(epoch: number, size: number): number {
  return ((epoch % size) + size) % size;
}

function truncatePath(path: string): string {
  return path.length > FLIGHT_RECORDER_RPC_MAX_PATH_CHARS
    ? path.slice(0, FLIGHT_RECORDER_RPC_MAX_PATH_CHARS)
    : path;
}

interface LatencySlice {
  epoch: number;
  counts: Uint32Array;
  count: number;
  errorCount: number;
  maxMs: number;
}

class ProcedureEntry {
  count = 0;
  errorCount = 0;
  lastRecordedMs = Number.NEGATIVE_INFINITY;
  /** Allocated on the first recorded call: a path that is never called costs nothing. */
  private slices: LatencySlice[] | null = null;

  constructor(readonly path: string) {}

  record(endMs: number, durationMs: number, ok: boolean): void {
    this.count += 1;
    if (!ok) this.errorCount += 1;
    this.lastRecordedMs = endMs;
    this.slices ??= Array.from({ length: FLIGHT_RECORDER_RPC_WINDOW_SLICES }, () => ({
      epoch: Number.NEGATIVE_INFINITY,
      counts: new Uint32Array(LATENCY_BUCKETS),
      count: 0,
      errorCount: 0,
      maxMs: 0,
    }));
    const epoch = Math.floor(endMs / SLICE_MS);
    const slice = this.slices[ringIndex(epoch, FLIGHT_RECORDER_RPC_WINDOW_SLICES)];
    if (slice.epoch !== epoch) {
      slice.epoch = epoch;
      slice.counts.fill(0);
      slice.count = 0;
      slice.errorCount = 0;
      slice.maxMs = 0;
    }
    slice.counts[latencyBucketIndex(durationMs)] += 1;
    slice.count += 1;
    if (!ok) slice.errorCount += 1;
    slice.maxMs = Math.max(slice.maxMs, durationMs);
  }

  stats(nowMs: number): RpcProcedureStats {
    const merged = new Uint32Array(LATENCY_BUCKETS);
    let count = 0;
    let errorCount = 0;
    let maxMs = 0;
    const currentEpoch = Math.floor(nowMs / SLICE_MS);
    for (const slice of this.slices ?? []) {
      if (!inWindow(slice.epoch, currentEpoch, FLIGHT_RECORDER_RPC_WINDOW_SLICES)) continue;
      for (let k = 0; k < LATENCY_BUCKETS; k++) merged[k] += slice.counts[k];
      count += slice.count;
      errorCount += slice.errorCount;
      maxMs = Math.max(maxMs, slice.maxMs);
    }
    const window =
      count > 0
        ? {
            count,
            errorCount,
            p50Ms: bucketPercentileMs(merged, count, maxMs, 0.5),
            p95Ms: bucketPercentileMs(merged, count, maxMs, 0.95),
            p99Ms: bucketPercentileMs(merged, count, maxMs, 0.99),
            maxMs,
          }
        : { count: 0, errorCount: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
    return { path: this.path, count: this.count, errorCount: this.errorCount, window };
  }
}

/**
 * One entry per subscription path, shared by every open subscription on it: it
 * is also their tap, so opening a subscription allocates nothing per subscription.
 */
class SubscriptionEntry implements RpcSubscriptionTap {
  live = 0;
  opened = 0;
  events = 0;
  lastRecordedMs = Number.NEGATIVE_INFINITY;
  /** Events per one-second bucket, allocated on the first recorded event. */
  private rate: { epochs: Float64Array; counts: Uint32Array } | null = null;

  constructor(
    readonly path: string,
    private readonly owner: RpcRecorder
  ) {}

  event(): void {
    // Off: one boolean check per delivered value.
    if (!this.owner.recording) return;
    try {
      const nowMs = this.owner.now();
      this.events += 1;
      this.lastRecordedMs = nowMs;
      this.rate ??= {
        epochs: new Float64Array(RATE_BUCKETS).fill(Number.NEGATIVE_INFINITY),
        counts: new Uint32Array(RATE_BUCKETS),
      };
      const epoch = Math.floor(nowMs / FLIGHT_RECORDER_RPC_EVENT_RATE_BUCKET_MS);
      const index = ringIndex(epoch, RATE_BUCKETS);
      if (this.rate.epochs[index] !== epoch) {
        this.rate.epochs[index] = epoch;
        this.rate.counts[index] = 0;
      }
      this.rate.counts[index] += 1;
    } catch (error) {
      this.owner.reportError(error);
    }
  }

  /** Always decrements, recording or not, so live counts stay right across disable/enable. */
  close(): void {
    if (this.live > 0) this.live -= 1;
  }

  stats(nowMs: number): RpcSubscriptionStats {
    let windowEvents = 0;
    let peak = 0;
    if (this.rate !== null) {
      const currentEpoch = Math.floor(nowMs / FLIGHT_RECORDER_RPC_EVENT_RATE_BUCKET_MS);
      for (let i = 0; i < RATE_BUCKETS; i++) {
        if (!inWindow(this.rate.epochs[i], currentEpoch, RATE_BUCKETS)) continue;
        windowEvents += this.rate.counts[i];
        peak = Math.max(peak, this.rate.counts[i]);
      }
    }
    return {
      path: this.path,
      live: this.live,
      opened: this.opened,
      events: this.events,
      eventsPerSecond: windowEvents / (FLIGHT_RECORDER_RPC_WINDOW_MS / 1000),
      peakEventsPerSecond: peak,
    };
  }
}

export interface RpcRecorderOptions {
  now: () => number;
  /** Called for every recorded slow call; FlightRecorder turns it into a `slow-rpc` trip. */
  onSlowCall: (span: RpcSlowCall) => void;
}

/**
 * oRPC procedure, subscription and WebSocket flow-control recording for the
 * flight recorder (F3). Records only while `recording` (the recorder is
 * collecting). Every public method catches its own failures: instrumentation
 * must never throw into an oRPC call. Memory is bounded by the path cap, the
 * fixed per-path slices and buckets, and the span and wait rings.
 */
export class RpcRecorder {
  recording = false;
  readonly now: () => number;
  private readonly onSlowCall: (span: RpcSlowCall) => void;
  /**
   * Clock value when the current collection started. Calls and waits that began
   * before it belong to an earlier collection and are dropped, so a quick
   * disable/enable cannot admit them.
   */
  private collectionStartMs = Number.POSITIVE_INFINITY;
  private readonly procedures = new Map<string, ProcedureEntry>();
  private readonly subscriptions = new Map<string, SubscriptionEntry>();
  private droppedPaths = 0;
  private readonly slowCalls = new BoundedRing<RpcSlowCall>(
    FLIGHT_RECORDER_RPC_SLOW_CALL_CAPACITY,
    FLIGHT_RECORDER_RETENTION_MS
  );
  private readonly wsWaits = new BoundedRing<WsFlowControlWait>(
    FLIGHT_RECORDER_RPC_WS_WAIT_CAPACITY,
    FLIGHT_RECORDER_RETENTION_MS
  );
  private loggedError = false;

  constructor(options: RpcRecorderOptions) {
    this.now = options.now;
    this.onSlowCall = options.onSlowCall;
  }

  startCollection(nowMs: number): void {
    this.collectionStartMs = nowMs;
    this.recording = true;
  }

  stopCollection(): void {
    this.recording = false;
  }

  /** Start time of a call (perf epoch ms), or null while not recording. */
  beginCall(): number | null {
    if (!this.recording) return null;
    try {
      return this.now();
    } catch (error) {
      this.reportError(error);
      return null;
    }
  }

  /**
   * Records a completed call; `errorCode` null means it succeeded. Payload sizes
   * are not recorded: the middleware only sees deserialized values, and a size
   * would cost an extra JSON.stringify per call.
   */
  endCall(pathKey: string, startMs: number, errorCode: string | null): void {
    if (!this.recording || !(startMs >= this.collectionStartMs)) return;
    try {
      const endMs = this.now();
      const durationMs = Math.max(0, endMs - startMs);
      const path = truncatePath(pathKey);
      const ok = errorCode === null;
      this.procedureEntry(path)?.record(endMs, durationMs, ok);
      if (durationMs > FLIGHT_RECORDER_SLOW_RPC_MS) {
        const span: RpcSlowCall = ok
          ? { path, startMs, endMs, ok }
          : {
              path,
              startMs,
              endMs,
              ok,
              errorCode: errorCode.slice(0, FLIGHT_RECORDER_RPC_MAX_ERROR_CODE_CHARS),
            };
        this.slowCalls.push(span, endMs);
        this.onSlowCall(span);
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  /**
   * Registers an open subscription even while not recording, so live counts and
   * attribution stay right when recording starts while it is open. Null only
   * past the path cap.
   */
  openSubscription(path: readonly string[]): RpcSubscriptionTap | null {
    try {
      const key = truncatePath(path.join("."));
      let entry = this.subscriptions.get(key);
      if (entry === undefined) {
        if (this.subscriptions.size >= FLIGHT_RECORDER_RPC_MAX_PATHS) {
          if (this.recording) this.droppedPaths += 1;
          return null;
        }
        entry = new SubscriptionEntry(key, this);
        this.subscriptions.set(key, entry);
      }
      // Read the clock first: a throw must not leave live incremented without a tap to close it.
      if (this.recording) {
        entry.lastRecordedMs = this.now();
        entry.opened += 1;
      }
      entry.live += 1;
      return entry;
    } catch (error) {
      this.reportError(error);
      return null;
    }
  }

  recordWsWait(wait: WsFlowControlWait): void {
    if (!this.recording || !(wait.startMs >= this.collectionStartMs)) return;
    try {
      this.wsWaits.push(wait, wait.endMs);
    } catch (error) {
      this.reportError(error);
    }
  }

  /**
   * Data stays readable after recording stops and ages out with the retention
   * window: entries with no recorded activity inside it (and no open
   * subscription) are pruned here.
   */
  snapshot(nowMs: number): RpcSnapshot {
    const cutoff = nowMs - FLIGHT_RECORDER_RETENTION_MS;
    const procedures: RpcProcedureStats[] = [];
    for (const [key, entry] of this.procedures) {
      if (entry.lastRecordedMs < cutoff) this.procedures.delete(key);
      else procedures.push(entry.stats(nowMs));
    }
    const subscriptions: RpcSubscriptionStats[] = [];
    for (const [key, entry] of this.subscriptions) {
      if (entry.live === 0 && entry.lastRecordedMs < cutoff) {
        this.subscriptions.delete(key);
        continue;
      }
      // A subscription opened while off shows up once recording runs (or once it recorded).
      const recorded = entry.opened > 0 || entry.events > 0;
      if (recorded || (this.recording && entry.live > 0)) subscriptions.push(entry.stats(nowMs));
    }
    return {
      version: 1,
      windowMs: FLIGHT_RECORDER_RPC_WINDOW_MS,
      procedures,
      subscriptions,
      slowCalls: this.slowCalls.values(nowMs),
      wsFlowControlWaits: this.wsWaits.values(nowMs),
      droppedPaths: this.droppedPaths,
    };
  }

  reportError(error: unknown): void {
    if (this.loggedError) return;
    this.loggedError = true;
    log.warn("[perfFlightRecorder] rpc recording failed", { error: getErrorMessage(error) });
  }

  private procedureEntry(path: string): ProcedureEntry | null {
    const existing = this.procedures.get(path);
    if (existing !== undefined) return existing;
    if (this.procedures.size >= FLIGHT_RECORDER_RPC_MAX_PATHS) {
      this.droppedPaths += 1;
      return null;
    }
    const entry = new ProcedureEntry(path);
    this.procedures.set(path, entry);
    return entry;
  }
}
