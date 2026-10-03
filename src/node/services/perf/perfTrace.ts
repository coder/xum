import type { PerfCaptureMetadata } from "@/common/orpc/schemas/perfCaptures";
import type { FlightRecorderSnapshot } from "@/common/orpc/schemas/perfFlightRecorder";

/**
 * Chrome trace-event JSON for a "Report slowness" bundle (F4). It loads in
 * ui.perfetto.dev and the Chrome DevTools Performance panel.
 *
 * Clock: every `ts`/`dur` is microseconds on the shared perf epoch
 * (src/common/utils/perf/clock.ts), i.e. perf epoch ms * 1000. snapshot.json and the
 * capture metadata use the same axis in milliseconds. Hang records use wall-clock
 * time, so they are not in the trace.
 */

export type PerfTraceEvent =
  | {
      name: "process_name" | "thread_name";
      ph: "M";
      pid: number;
      tid: number;
      args: { name: string };
    }
  | {
      name: string;
      cat: string;
      ph: "C";
      pid: number;
      tid: number;
      ts: number;
      args: Record<string, number>;
    }
  | {
      name: string;
      cat: string;
      ph: "X";
      pid: number;
      tid: number;
      ts: number;
      dur: number;
      args: Record<string, unknown>;
    }
  | {
      name: string;
      cat: string;
      ph: "i";
      /** Instant scope: "g" global, "p" process. */
      s: "g" | "p";
      pid: number;
      tid: number;
      ts: number;
      args: Record<string, unknown>;
    };

type TimedTraceEvent = Exclude<PerfTraceEvent, { ph: "M" }>;

export interface PerfTrace {
  traceEvents: PerfTraceEvent[];
  displayTimeUnit: "ms";
  metadata: Record<string, unknown>;
}

const BACKEND_PID = 1;
const RENDERER_PID = 2;
const CAPTURES_PID = 3;
const BACKEND_MAIN_TID = 1;
const BACKEND_RPC_TID = 2;
const BACKEND_WS_TID = 3;
const CAPTURE_TIDS = { backend: 1, renderer: 2 } as const;

const MB = 1024 * 1024;

/** Perf epoch ms -> trace microseconds. */
function us(ms: number): number {
  return ms * 1000;
}

function durUs(startMs: number, endMs: number): number {
  return Math.max(0, us(endMs - startMs));
}

/** Counter series must be numbers; null percentiles (an empty window) are left out. */
function numericArgs(values: Record<string, number | null>): Record<string, number> {
  const args: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && Number.isFinite(value)) args[key] = value;
  }
  return args;
}

export function buildPerfTrace(input: {
  snapshot: FlightRecorderSnapshot;
  captures: readonly PerfCaptureMetadata[];
}): PerfTrace {
  const { snapshot, captures } = input;
  const meta: PerfTraceEvent[] = [];
  const timed: TimedTraceEvent[] = [];

  const nameProcess = (pid: number, name: string) =>
    meta.push({ name: "process_name", ph: "M", pid, tid: 0, args: { name } });
  const nameThread = (pid: number, tid: number, name: string) =>
    meta.push({ name: "thread_name", ph: "M", pid, tid, args: { name } });

  nameProcess(BACKEND_PID, "Xum backend");
  nameThread(BACKEND_PID, BACKEND_MAIN_TID, "Event loop");
  nameThread(BACKEND_PID, BACKEND_RPC_TID, "oRPC slow calls");
  nameThread(BACKEND_PID, BACKEND_WS_TID, "WebSocket flow control");
  nameProcess(RENDERER_PID, "Xum renderer");
  nameProcess(CAPTURES_PID, "CPU profile captures");
  nameThread(CAPTURES_PID, CAPTURE_TIDS.backend, "Backend captures");
  nameThread(CAPTURES_PID, CAPTURE_TIDS.renderer, "Renderer captures");

  // One thread per renderer, in order of first appearance.
  const rendererTids = new Map<string, number>();
  const rendererTid = (rendererId: string): number => {
    let tid = rendererTids.get(rendererId);
    if (tid === undefined) {
      tid = rendererTids.size + 1;
      rendererTids.set(rendererId, tid);
      nameThread(RENDERER_PID, tid, `Renderer ${rendererId}`);
    }
    return tid;
  };

  const counter = (name: string, atMs: number, values: Record<string, number | null>) => {
    const args = numericArgs(values);
    if (Object.keys(args).length === 0) return;
    timed.push({
      name,
      cat: "backend",
      ph: "C",
      pid: BACKEND_PID,
      tid: BACKEND_MAIN_TID,
      ts: us(atMs),
      args,
    });
  };

  for (const sample of snapshot.backend.samples) {
    counter("Loop delay (ms)", sample.atMs, {
      p50: sample.loopDelay.p50Ms,
      p99: sample.loopDelay.p99Ms,
      max: sample.loopDelay.maxMs,
    });
    counter("Sampler lag (ms)", sample.atMs, { lag: sample.samplerLagMs });
    counter("Event loop utilization", sample.atMs, { utilization: sample.elu.utilization });
    counter("GC (ms per window)", sample.atMs, { total: sample.gc.totalMs });
  }
  for (const heap of snapshot.backend.heap) {
    counter("Heap (MB)", heap.atMs, { used: heap.usedBytes / MB, total: heap.totalBytes / MB });
  }

  for (const loaf of snapshot.renderer.loaf) {
    timed.push({
      name: "Long animation frame",
      cat: "renderer",
      ph: "X",
      pid: RENDERER_PID,
      tid: rendererTid(loaf.rendererId),
      ts: us(loaf.startMs),
      dur: Math.max(0, us(loaf.durationMs)),
      // Script attribution is bounded by the recorder schema (count and string lengths).
      args: { blockingDurationMs: loaf.blockingDurationMs, scripts: loaf.scripts },
    });
  }
  for (const event of snapshot.renderer.events) {
    timed.push({
      name: `Event: ${event.name}`,
      cat: "renderer",
      ph: "X",
      pid: RENDERER_PID,
      tid: rendererTid(event.rendererId),
      ts: us(event.startMs),
      dur: Math.max(0, us(event.durationMs)),
      args: { interactionId: event.interactionId, targetTag: event.targetTag },
    });
  }

  for (const call of snapshot.rpc.slowCalls) {
    timed.push({
      name: call.path,
      cat: "rpc",
      ph: "X",
      pid: BACKEND_PID,
      tid: BACKEND_RPC_TID,
      ts: us(call.startMs),
      dur: durUs(call.startMs, call.endMs),
      args: { ok: call.ok, ...(call.errorCode !== undefined ? { errorCode: call.errorCode } : {}) },
    });
  }
  for (const wait of snapshot.rpc.wsFlowControlWaits) {
    timed.push({
      name: "WebSocket send window full",
      cat: "rpc",
      ph: "X",
      pid: BACKEND_PID,
      tid: BACKEND_WS_TID,
      ts: us(wait.startMs),
      dur: durUs(wait.startMs, wait.endMs),
      args: {
        bufferedBytes: wait.bufferedBytes,
        maxQueuedFrames: wait.maxQueuedFrames,
        closed: wait.closed,
      },
    });
  }

  for (const capture of captures) {
    timed.push({
      name: `${capture.kind} capture`,
      cat: "capture",
      ph: "X",
      pid: CAPTURES_PID,
      tid: CAPTURE_TIDS[capture.process],
      ts: us(capture.startedAtMs),
      dur: durUs(capture.startedAtMs, capture.endedAtMs),
      args: {
        id: capture.id,
        kind: capture.kind,
        process: capture.process,
        label: capture.label,
        ...(capture.skippedReason !== undefined ? { skippedReason: capture.skippedReason } : {}),
      },
    });
  }

  for (const trip of snapshot.trips) {
    const onRenderer = trip.kind === "long-animation-frame";
    timed.push({
      name: `Trip: ${trip.kind}`,
      cat: "trip",
      ph: "i",
      s: "p",
      pid: onRenderer ? RENDERER_PID : BACKEND_PID,
      tid: onRenderer
        ? rendererTid(trip.rendererId)
        : trip.kind === "slow-rpc"
          ? BACKEND_RPC_TID
          : BACKEND_MAIN_TID,
      ts: us(trip.atMs),
      args: { ...trip },
    });
  }

  // Stable sort: equal timestamps keep their insertion order.
  timed.sort((a, b) => a.ts - b.ts);
  return {
    traceEvents: [...meta, ...timed],
    displayTimeUnit: "ms",
    metadata: {
      "xum-trace-version": 1,
      clock: "perf epoch microseconds (perf epoch ms * 1000)",
      recorderState: snapshot.state,
      ...(snapshot.failure !== undefined ? { recorderFailure: snapshot.failure } : {}),
    },
  };
}
