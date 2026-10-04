import type { PerfCaptureMetadata } from "@/common/orpc/schemas/perfCaptures";
import type { FlightRecorderSnapshot } from "@/common/orpc/schemas/perfFlightRecorder";

/**
 * Chrome trace-event JSON for a "Report slowness" bundle (F4). It loads in
 * ui.perfetto.dev and the Chrome DevTools Performance panel.
 *
 * Clock: every `ts`/`dur` is microseconds on the shared perf epoch
 * (src/common/utils/perf/clock.ts), i.e. perf epoch ms * 1000 rounded to whole
 * microseconds. snapshot.json and the capture metadata use the same axis in
 * milliseconds. Hang records use wall-clock time, so they are not in the trace.
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

const MB = 1024 * 1024;

/**
 * Perf epoch ms -> whole trace microseconds. Integers convert to Perfetto's integer
 * nanoseconds exactly, so a slice that ends where the next one starts never gains a
 * rounding overlap.
 */
function us(ms: number): number {
  return Math.round(ms * 1000);
}

function durUs(startMs: number, endMs: number): number {
  return Math.max(0, us(endMs) - us(startMs));
}

/** Counter series must be numbers; null percentiles (an empty window) are left out. */
function numericArgs(values: Record<string, number | null>): Record<string, number> {
  const args: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && Number.isFinite(value)) args[key] = value;
  }
  return args;
}

type Slice = Omit<Extract<TimedTraceEvent, { ph: "X" }>, "pid" | "tid">;

/**
 * One named timeline row. Perfetto rejects complete events that overlap on one thread
 * without nesting ("slice_spill_overlapping_complete_event"), and LoAF, input events
 * and concurrent oRPC calls do overlap. So each track spreads its slices over as many
 * threads ("lanes") as it needs, and no lane holds two overlapping slices.
 */
interface Track {
  pid: number;
  name: string;
  /** Lane 0 is created with the track; trips and counters use it. */
  tids: number[];
  slices: Slice[];
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
  const lastTid = new Map<number, number>();
  const newThread = (pid: number, name: string): number => {
    const tid = (lastTid.get(pid) ?? 0) + 1;
    lastTid.set(pid, tid);
    meta.push({ name: "thread_name", ph: "M", pid, tid, args: { name } });
    return tid;
  };
  const tracks = new Map<string, Track>();
  const track = (key: string, pid: number, name: string): Track => {
    let found = tracks.get(key);
    if (found === undefined) {
      found = { pid, name, tids: [newThread(pid, name)], slices: [] };
      tracks.set(key, found);
    }
    return found;
  };

  nameProcess(BACKEND_PID, "Xum backend");
  nameProcess(RENDERER_PID, "Xum renderer");
  nameProcess(CAPTURES_PID, "CPU profile captures");
  const backendMain = track("backend:main", BACKEND_PID, "Event loop");
  const backendRpc = track("backend:rpc", BACKEND_PID, "oRPC slow calls");
  const backendWs = track("backend:ws", BACKEND_PID, "WebSocket flow control");
  const captureTracks = {
    backend: track("captures:backend", CAPTURES_PID, "Backend captures"),
    renderer: track("captures:renderer", CAPTURES_PID, "Renderer captures"),
  };
  // Long animation frames, trips and input events of one renderer, created on first use.
  const rendererTrack = (rendererId: string) =>
    track(`renderer:${rendererId}`, RENDERER_PID, `Renderer ${rendererId}`);
  const rendererEventsTrack = (rendererId: string) =>
    track(`renderer-events:${rendererId}`, RENDERER_PID, `Renderer ${rendererId} input events`);

  const counter = (name: string, atMs: number, values: Record<string, number | null>) => {
    const args = numericArgs(values);
    if (Object.keys(args).length === 0) return;
    timed.push({
      name,
      cat: "backend",
      ph: "C",
      pid: BACKEND_PID,
      tid: backendMain.tids[0],
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
    rendererTrack(loaf.rendererId).slices.push({
      name: "Long animation frame",
      cat: "renderer",
      ph: "X",
      ts: us(loaf.startMs),
      dur: durUs(loaf.startMs, loaf.startMs + loaf.durationMs),
      // Script attribution is bounded by the recorder schema (count and string lengths).
      args: { blockingDurationMs: loaf.blockingDurationMs, scripts: loaf.scripts },
    });
  }
  for (const event of snapshot.renderer.events) {
    rendererEventsTrack(event.rendererId).slices.push({
      name: `Event: ${event.name}`,
      cat: "renderer",
      ph: "X",
      ts: us(event.startMs),
      dur: durUs(event.startMs, event.startMs + event.durationMs),
      args: { interactionId: event.interactionId, targetTag: event.targetTag },
    });
  }

  for (const call of snapshot.rpc.slowCalls) {
    backendRpc.slices.push({
      name: call.path,
      cat: "rpc",
      ph: "X",
      ts: us(call.startMs),
      dur: durUs(call.startMs, call.endMs),
      args: { ok: call.ok, ...(call.errorCode !== undefined ? { errorCode: call.errorCode } : {}) },
    });
  }
  for (const wait of snapshot.rpc.wsFlowControlWaits) {
    backendWs.slices.push({
      name: "WebSocket send window full",
      cat: "rpc",
      ph: "X",
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
    captureTracks[capture.process].slices.push({
      name: `${capture.kind} capture`,
      cat: "capture",
      ph: "X",
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
    const tripTrack =
      trip.kind === "long-animation-frame"
        ? rendererTrack(trip.rendererId)
        : trip.kind === "slow-rpc"
          ? backendRpc
          : backendMain;
    timed.push({
      name: `Trip: ${trip.kind}`,
      cat: "trip",
      ph: "i",
      s: "p",
      pid: tripTrack.pid,
      tid: tripTrack.tids[0],
      ts: us(trip.atMs),
      args: { ...trip },
    });
  }

  // Greedy lane assignment in start order: a slice goes to the first lane whose last
  // slice has ended; when none has, the track gets one more lane.
  for (const { pid, name, tids, slices } of tracks.values()) {
    const laneEnds: number[] = [];
    for (const slice of [...slices].sort((a, b) => a.ts - b.ts)) {
      let lane = laneEnds.findIndex((end) => end <= slice.ts);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(0);
        if (lane >= tids.length) tids.push(newThread(pid, `${name} (${lane + 1})`));
      }
      laneEnds[lane] = slice.ts + slice.dur;
      timed.push({ ...slice, pid, tid: tids[lane] });
    }
  }

  // Stable sort: equal timestamps keep their insertion order.
  timed.sort((a, b) => a.ts - b.ts);
  return {
    traceEvents: [...meta, ...timed],
    displayTimeUnit: "ms",
    metadata: {
      "xum-trace-version": 1,
      clock: "perf epoch microseconds (perf epoch ms * 1000, rounded)",
      recorderState: snapshot.state,
      ...(snapshot.failure !== undefined ? { recorderFailure: snapshot.failure } : {}),
    },
  };
}
