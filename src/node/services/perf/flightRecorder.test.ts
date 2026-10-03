import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import type { GcKind, RendererBatch } from "@/common/orpc/schemas/perfFlightRecorder";
import { FlightRecorderSnapshotSchema } from "@/common/orpc/schemas/perfFlightRecorder";
import {
  FLIGHT_RECORDER_HEAP_EVERY_N_SAMPLES,
  FLIGHT_RECORDER_SAMPLE_INTERVAL_MS,
} from "@/constants/perfFlightRecorder";
import { log } from "@/node/services/log";
import type {
  FlightRecorderProbes,
  FlightRecorderScheduler,
  LoopDelayHistogram,
} from "./flightRecorder";
import { FlightRecorder } from "./flightRecorder";

const NS_PER_MS = 1e6;

class FakeHistogram implements LoopDelayHistogram {
  enabled = false;
  p50Ms = 20;
  p99Ms = 25;
  min = 19 * NS_PER_MS;
  max = 30 * NS_PER_MS;
  count = 50;
  resets = 0;
  enable() {
    this.enabled = true;
  }
  disable() {
    this.enabled = false;
  }
  reset() {
    this.resets += 1;
  }
  percentile(percentile: number) {
    return (percentile >= 99 ? this.p99Ms : this.p50Ms) * NS_PER_MS;
  }
}

/** Fake runtime so tests drive loop delay, GC, ELU and heap values deterministically. */
class FakeProbes implements FlightRecorderProbes {
  histograms: FakeHistogram[] = [];
  gcObservers: Array<{ connected: boolean; emit: (kind: GcKind, ms: number) => void }> = [];
  elu = { idleMs: 0, activeMs: 0 };
  heapReads = 0;
  failOn: "histogram" | "gc" | "elu" | "heap" | null = null;

  createLoopDelayHistogram() {
    if (this.failOn === "histogram") throw new Error("no histogram");
    const histogram = new FakeHistogram();
    this.histograms.push(histogram);
    return histogram;
  }
  readEventLoopUtilization() {
    if (this.failOn === "elu") throw new Error("no elu");
    return { ...this.elu };
  }
  observeGc(onGc: (kind: GcKind, durationMs: number) => void) {
    if (this.failOn === "gc") throw new Error("no gc observer");
    const observer = { connected: true, emit: onGc };
    this.gcObservers.push(observer);
    return {
      disconnect: () => {
        observer.connected = false;
      },
    };
  }
  readHeap() {
    if (this.failOn === "heap") throw new Error("no heap");
    this.heapReads += 1;
    return { usedBytes: 10, totalBytes: 20, limitBytes: 30 };
  }
}

class FakeScheduler implements FlightRecorderScheduler {
  active = new Map<number, () => void>();
  created = 0;
  private nextHandle = 1;
  setInterval(callback: () => void, intervalMs: number) {
    expect(intervalMs).toBe(FLIGHT_RECORDER_SAMPLE_INTERVAL_MS);
    const handle = this.nextHandle++;
    this.active.set(handle, callback);
    this.created += 1;
    return handle;
  }
  clearInterval(handle: unknown) {
    this.active.delete(handle as number);
  }
  tick() {
    for (const callback of [...this.active.values()]) callback();
  }
}

function makeRecorder() {
  const probes = new FakeProbes();
  const scheduler = new FakeScheduler();
  let nowMs = 1_000_000;
  const clock = {
    advance(ms: number) {
      nowMs += ms;
    },
  };
  const recorder = new FlightRecorder({ probes, scheduler, now: () => nowMs });
  /** One 1 s sampling window. */
  const tick = () => {
    clock.advance(FLIGHT_RECORDER_SAMPLE_INTERVAL_MS);
    scheduler.tick();
  };
  return { recorder, probes, scheduler, clock, tick };
}

function batch(overrides: Partial<RendererBatch> = {}): RendererBatch {
  return {
    rendererId: "r-test",
    sentAtMs: 1,
    loaf: [],
    events: [],
    droppedLoaf: 0,
    droppedEvents: 0,
    ...overrides,
  };
}

function loaf(durationMs: number) {
  return {
    rendererId: "r-test",
    startMs: 500,
    durationMs,
    blockingDurationMs: 0,
    renderStartMs: 0,
    styleAndLayoutStartMs: 0,
    scripts: [],
  };
}

describe("FlightRecorder", () => {
  let warn: Mock<typeof log.warn>;
  beforeEach(() => {
    warn = spyOn(log, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  test("off creates no probes or timers", () => {
    const { recorder, probes, scheduler } = makeRecorder();
    recorder.setEnabled(false);
    expect(probes.histograms).toHaveLength(0);
    expect(probes.gcObservers).toHaveLength(0);
    expect(scheduler.created).toBe(0);
    expect(recorder.getSnapshot().state).toBe("off");
  });

  test("enable starts probes once; disable releases them and keeps samples readable", () => {
    const { recorder, probes, scheduler, tick } = makeRecorder();
    recorder.setEnabled(true);
    recorder.setEnabled(true);
    expect(probes.histograms).toHaveLength(1);
    expect(probes.histograms[0].enabled).toBe(true);
    expect(probes.gcObservers[0].connected).toBe(true);
    expect(scheduler.active.size).toBe(1);
    tick();

    recorder.setEnabled(false);
    expect(probes.histograms[0].enabled).toBe(false);
    expect(probes.gcObservers[0].connected).toBe(false);
    expect(scheduler.active.size).toBe(0);
    const snapshot = recorder.getSnapshot();
    expect(snapshot.state).toBe("off");
    expect(snapshot.backend.samples).toHaveLength(1);

    // Re-enabling starts a fresh collection.
    recorder.setEnabled(true);
    expect(probes.histograms).toHaveLength(2);
    expect(scheduler.active.size).toBe(1);
    recorder.stop();
    expect(scheduler.active.size).toBe(0);
  });

  test("stop is final: a late enable after shutdown creates no probes or timers", () => {
    // A timed-out startup step can still resolve and sync the flag after shutdown.
    const { recorder, probes, scheduler } = makeRecorder();
    recorder.stop();
    recorder.setEnabled(true);
    expect(probes.histograms).toHaveLength(0);
    expect(probes.gcObservers).toHaveLength(0);
    expect(scheduler.created).toBe(0);
    expect(recorder.getStatus()).toEqual({ enabled: false, state: "off" });
  });

  test("each tick records loop delay, ELU deltas and per-window GC", () => {
    const { recorder, probes, tick } = makeRecorder();
    recorder.setEnabled(true);
    const histogram = probes.histograms[0];
    histogram.p50Ms = 21;
    histogram.p99Ms = 42;
    probes.gcObservers[0].emit("minor", 2);
    probes.gcObservers[0].emit("minor", 3);
    probes.gcObservers[0].emit("major", 7);
    probes.elu = { idleMs: 750, activeMs: 250 };
    tick();
    probes.elu = { idleMs: 1650, activeMs: 350 };
    tick();

    const [first, second] = recorder.getSnapshot().backend.samples;
    expect(first.windowMs).toBe(FLIGHT_RECORDER_SAMPLE_INTERVAL_MS);
    expect(first.samplerLagMs).toBe(0);
    expect(first.loopDelay).toEqual({
      sampleCount: 50,
      p50Ms: 21,
      p99Ms: 42,
      maxMs: 30,
      minMs: 19,
    });
    expect(first.elu).toEqual({ utilization: 0.25, activeMs: 250, idleMs: 750 });
    expect(first.gc.count).toBe(3);
    expect(first.gc.totalMs).toBe(12);
    expect(first.gc.maxMs).toBe(7);
    expect(first.gc.byKind.minor).toEqual({ count: 2, totalMs: 5, maxMs: 3 });
    expect(first.gc.byKind.major).toEqual({ count: 1, totalMs: 7, maxMs: 7 });
    expect(histogram.resets).toBe(2);
    // The second window only sees its own deltas and no GC.
    expect(second.elu).toEqual({ utilization: 0.1, activeMs: 100, idleMs: 900 });
    expect(second.gc.count).toBe(0);
  });

  test("an empty histogram window reports no percentiles instead of zero or the sentinel min", () => {
    const { recorder, probes, tick } = makeRecorder();
    recorder.setEnabled(true);
    probes.histograms[0].count = 0;
    probes.histograms[0].min = Number.MAX_SAFE_INTEGER;
    tick();
    expect(recorder.getSnapshot().backend.samples[0]).toMatchObject({
      samplerLagMs: 0,
      loopDelay: { sampleCount: 0, p50Ms: null, p99Ms: null, maxMs: null, minMs: null },
    });
  });

  test("a block spanning whole windows trips on sampler lag when the histogram is empty", () => {
    // Real node: a tick that runs before the overdue histogram timer sees count 0,
    // and reset() drops that delay sample, so only the late tick shows the block.
    const { recorder, probes, scheduler, clock } = makeRecorder();
    const trips: unknown[] = [];
    recorder.onTrip((trip) => trips.push(trip));
    recorder.setEnabled(true);
    probes.histograms[0].count = 0;
    const lateTick = () => {
      clock.advance(FLIGHT_RECORDER_SAMPLE_INTERVAL_MS + 1500);
      scheduler.tick();
    };
    lateTick();
    expect(trips).toHaveLength(0);
    lateTick();
    const blocked = { p99Ms: null, samplerLagMs: 1500 };
    expect(trips).toEqual([expect.objectContaining({ windows: [blocked, blocked] })]);
    expect(recorder.getSnapshot().backend.samples.map((s) => s.samplerLagMs)).toEqual([1500, 1500]);
  });

  test("heap is read on every Nth tick only", () => {
    const { recorder, probes, tick } = makeRecorder();
    recorder.setEnabled(true);
    for (let i = 0; i < FLIGHT_RECORDER_HEAP_EVERY_N_SAMPLES * 2 + 1; i++) tick();
    expect(probes.heapReads).toBe(2);
    const snapshot = recorder.getSnapshot();
    expect(snapshot.backend.heap).toHaveLength(2);
    expect(snapshot.backend.heap[0]).toMatchObject({
      usedBytes: 10,
      totalBytes: 20,
      limitBytes: 30,
    });
    expect(FlightRecorderSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  test("a partial start failure releases what started and latches failed", () => {
    const { recorder, probes, scheduler } = makeRecorder();
    probes.failOn = "gc";
    recorder.setEnabled(true);
    expect(probes.histograms[0].enabled).toBe(false);
    expect(scheduler.created).toBe(0);
    expect(recorder.getSnapshot()).toMatchObject({
      state: "failed",
      failure: "start: no gc observer",
    });
    expect(warn).toHaveBeenCalledTimes(1);

    // Broken probes are not retried until the process restarts.
    probes.failOn = null;
    recorder.setEnabled(false);
    recorder.setEnabled(true);
    expect(probes.histograms).toHaveLength(1);
    expect(recorder.getSnapshot().state).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a sampling failure tears everything down, latches failed and notifies renderers", () => {
    const { recorder, probes, scheduler, tick } = makeRecorder();
    // Renderers follow these statuses; a missed failure would keep them collecting.
    const statuses: unknown[] = [];
    recorder.onStatusChange((status) => statuses.push(status));
    recorder.setEnabled(true);
    recorder.setEnabled(true);
    tick();
    probes.failOn = "elu";
    tick();
    recorder.setEnabled(true);
    expect(statuses).toEqual([
      { enabled: true, state: "collecting" },
      { enabled: true, state: "failed" },
    ]);
    expect(scheduler.active.size).toBe(0);
    expect(probes.gcObservers[0].connected).toBe(false);
    expect(probes.histograms[0].enabled).toBe(false);
    const snapshot = recorder.getSnapshot();
    expect(snapshot.state).toBe("failed");
    expect(snapshot.backend.samples).toHaveLength(1);
    expect(recorder.ingestRendererBatch(batch({ loaf: [loaf(10)] }))).toEqual({ accepted: false });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("loop-delay trips once per high streak and the streak resets on disable", () => {
    const { recorder, probes, tick } = makeRecorder();
    const trips: unknown[] = [];
    recorder.onTrip((trip) => trips.push(trip));
    recorder.setEnabled(true);
    probes.histograms[0].p99Ms = 150;
    tick();
    expect(trips).toHaveLength(0);
    probes.histograms[0].p99Ms = 160;
    tick();
    tick();
    expect(trips).toEqual([
      expect.objectContaining({
        kind: "loop-delay-p99",
        windows: [
          { p99Ms: 150, samplerLagMs: 0 },
          { p99Ms: 160, samplerLagMs: 0 },
        ],
      }),
    ]);

    // One high window, then disable/enable: the old window must not count toward a new streak.
    recorder.setEnabled(false);
    recorder.setEnabled(true);
    probes.histograms[1].p99Ms = 150;
    tick();
    expect(trips).toHaveLength(1);
    tick();
    expect(trips).toHaveLength(2);
    expect(recorder.getSnapshot().trips).toHaveLength(2);
  });

  test("renderer batches are dropped while off and stored while collecting", () => {
    const { recorder } = makeRecorder();
    expect(recorder.ingestRendererBatch(batch({ loaf: [loaf(10)] }))).toEqual({ accepted: false });
    expect(recorder.getSnapshot().renderer.loaf).toHaveLength(0);

    recorder.setEnabled(true);
    const event = {
      rendererId: "r-test",
      startMs: 1,
      name: "click",
      durationMs: 64,
      interactionId: 3,
      targetTag: "button",
    };
    const result = recorder.ingestRendererBatch(
      batch({ loaf: [loaf(10)], events: [event], droppedLoaf: 2, droppedEvents: 1 })
    );
    expect(result).toEqual({ accepted: true });
    const renderer = recorder.getSnapshot().renderer;
    expect(renderer.loaf).toHaveLength(1);
    expect(renderer.events).toEqual([event]);
    expect(renderer.droppedLoaf).toBe(2);
    expect(renderer.droppedEvents).toBe(1);
  });

  test("a long animation frame over the threshold trips; a throwing listener is contained", () => {
    const { recorder } = makeRecorder();
    const received: unknown[] = [];
    recorder.onTrip(() => {
      throw new Error("listener bug");
    });
    recorder.onTrip((trip) => received.push(trip));
    recorder.setEnabled(true);

    expect(() =>
      recorder.ingestRendererBatch(batch({ loaf: [loaf(200), loaf(250), loaf(300)] }))
    ).not.toThrow();
    expect(received).toEqual([
      { kind: "long-animation-frame", atMs: 500, durationMs: 250, rendererId: "r-test" },
      { kind: "long-animation-frame", atMs: 500, durationMs: 300, rendererId: "r-test" },
    ]);
    // The listener error is logged once, not per trip.
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
