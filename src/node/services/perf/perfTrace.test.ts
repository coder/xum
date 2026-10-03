import { describe, expect, test } from "bun:test";
import {
  PerfCaptureMetadataSchema,
  type PerfCaptureMetadata,
} from "@/common/orpc/schemas/perfCaptures";
import type {
  BackendHealthSample,
  FlightRecorderSnapshot,
} from "@/common/orpc/schemas/perfFlightRecorder";
import { buildPerfTrace } from "./perfTrace";

// Realistic perf epoch milliseconds (fractional, like performance.timeOrigin + now()).
const T0 = 1_759_450_000_000.25;

const gcStats = { count: 1, totalMs: 4, maxMs: 4 };
const sample: BackendHealthSample = {
  atMs: T0 + 1000,
  windowMs: 1000,
  samplerLagMs: 3,
  loopDelay: { sampleCount: 0, p50Ms: null, p99Ms: null, maxMs: null, minMs: null },
  elu: { utilization: 0.5, activeMs: 500, idleMs: 500 },
  gc: {
    ...gcStats,
    byKind: {
      minor: gcStats,
      major: gcStats,
      incremental: gcStats,
      weakcb: gcStats,
      unknown: gcStats,
    },
  },
};

const snapshot: FlightRecorderSnapshot = {
  version: 1,
  state: "collecting",
  nowMs: T0 + 9000,
  backend: {
    samples: [sample],
    heap: [
      { atMs: T0 + 500, usedBytes: 50 * 1024 * 1024, totalBytes: 80 * 1024 * 1024, limitBytes: 1 },
    ],
  },
  renderer: {
    loaf: [
      {
        rendererId: "r-1",
        startMs: T0 + 3000,
        durationMs: 120,
        blockingDurationMs: 70,
        renderStartMs: 0,
        styleAndLayoutStartMs: 0,
        scripts: [],
      },
    ],
    events: [
      {
        rendererId: "r-2",
        startMs: T0 + 2000,
        name: "keydown",
        durationMs: 200,
        interactionId: 7,
        targetTag: "TEXTAREA",
      },
    ],
    droppedLoaf: 0,
    droppedEvents: 0,
  },
  trips: [
    { kind: "long-animation-frame", atMs: T0 + 3120, durationMs: 120, rendererId: "r-1" },
    {
      kind: "slow-rpc",
      atMs: T0 + 6000,
      path: "workspace.list",
      startMs: T0 + 4000,
      durationMs: 2000,
      ok: false,
    },
  ],
  rpc: {
    version: 1,
    windowMs: 60_000,
    procedures: [],
    subscriptions: [],
    // A clock step can make endMs < startMs; the slice must not get a negative duration.
    slowCalls: [
      {
        path: "workspace.list",
        startMs: T0 + 4000,
        endMs: T0 + 6000,
        ok: false,
        errorCode: "TIMEOUT",
      },
      { path: "x.y", startMs: T0 + 7000, endMs: T0 + 6990, ok: true },
    ],
    wsFlowControlWaits: [
      { startMs: T0 + 100, endMs: T0 + 400, bufferedBytes: 1, maxQueuedFrames: 2, closed: false },
    ],
    droppedPaths: 0,
  },
};

const capture: PerfCaptureMetadata = PerfCaptureMetadataSchema.parse({
  version: 1,
  id: "c-1",
  kind: "long-animation-frame",
  process: "renderer",
  trigger: snapshot.trips[0],
  startedAtMs: T0 + 3200,
  endedAtMs: T0 + 11_200,
  samplingIntervalUs: 1000,
  durationMs: 8000,
  xumVersion: "test",
  platform: "linux",
  label: "activity after trigger",
  profileFile: "c-1.cpuprofile",
} satisfies PerfCaptureMetadata);

describe("buildPerfTrace", () => {
  const trace = buildPerfTrace({ snapshot, captures: [capture] });
  const events = trace.traceEvents;
  const timed = events.filter((event) => event.ph !== "M");

  test("emits only well-formed Chrome trace events, metadata first and the rest in time order", () => {
    expect(new Set(events.map((event) => event.ph))).toEqual(new Set(["M", "C", "X", "i"]));
    const firstTimed = events.findIndex((event) => event.ph !== "M");
    expect(events.slice(firstTimed).every((event) => event.ph !== "M")).toBe(true);
    const timestamps = timed.map((event) => event.ts);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    for (const event of timed) {
      if (event.ph === "X") expect(event.dur).toBeGreaterThanOrEqual(0);
      if (event.ph === "i") expect(["g", "p"]).toContain(event.s);
      // Counter series are numbers only: null percentiles of an empty window are left out.
      if (event.ph === "C") {
        expect(Object.values(event.args).every((value) => typeof value === "number")).toBe(true);
      }
    }
    expect(JSON.parse(JSON.stringify(trace))).toEqual(trace);
  });

  test("puts every source on the perf epoch in microseconds", () => {
    const find = (name: string) => timed.find((event) => event.name === name);
    expect(find("Long animation frame")).toMatchObject({ ts: (T0 + 3000) * 1000, dur: 120_000 });
    expect(find("workspace.list")).toMatchObject({
      ts: (T0 + 4000) * 1000,
      dur: 2_000_000,
      args: { ok: false, errorCode: "TIMEOUT" },
    });
    expect(find("Trip: slow-rpc")).toMatchObject({ ph: "i", ts: (T0 + 6000) * 1000 });
    expect(find("long-animation-frame capture")).toMatchObject({
      ts: (T0 + 3200) * 1000,
      dur: 8_000_000,
      args: { id: "c-1", label: "activity after trigger" },
    });
    expect(find("Loop delay (ms)")).toBeUndefined();
    expect(find("Sampler lag (ms)")).toMatchObject({ ts: (T0 + 1000) * 1000, args: { lag: 3 } });
  });

  test("gives each renderer its own named thread and puts its trips there", () => {
    const loaf = timed.find((event) => event.name === "Long animation frame");
    const trip = timed.find((event) => event.name === "Trip: long-animation-frame");
    const keydown = timed.find((event) => event.name === "Event: keydown");
    expect(trip).toMatchObject({ pid: loaf?.pid, tid: loaf?.tid });
    expect(keydown?.pid).toBe(loaf?.pid);
    expect(keydown?.tid).not.toBe(loaf?.tid);
    const threadNames = events
      .filter(
        (event) => event.ph === "M" && event.name === "thread_name" && event.pid === loaf?.pid
      )
      .map((event) => (event.ph === "M" ? event.args.name : ""));
    expect(threadNames.sort()).toEqual(["Renderer r-1", "Renderer r-2"]);
  });
});
