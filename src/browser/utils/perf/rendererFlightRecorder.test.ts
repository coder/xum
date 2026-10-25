import { describe, expect, test } from "bun:test";
import type { RendererBatch } from "@/common/orpc/schemas/perfFlightRecorder";
import { RendererBatchSchema } from "@/common/orpc/schemas/perfFlightRecorder";
import { perfEpochFromRelativeMs } from "@/common/utils/perf/clock";
import {
  FLIGHT_RECORDER_EVENT_DURATION_THRESHOLD_MS,
  FLIGHT_RECORDER_MAX_EVENTS_PER_BATCH,
  FLIGHT_RECORDER_MAX_FUNCTION_NAME_CHARS,
  FLIGHT_RECORDER_MAX_LOAF_PER_BATCH,
  FLIGHT_RECORDER_MAX_SCRIPTS_PER_LOAF,
  FLIGHT_RECORDER_MAX_SOURCE_URL_CHARS,
  FLIGHT_RECORDER_RENDERER_BATCH_INTERVAL_MS,
} from "@/constants/perfFlightRecorder";
import type { ObservedEntry, ObserverFactory } from "./rendererFlightRecorder";
import { startRendererFlightRecorder } from "./rendererFlightRecorder";

class FakeObservers implements ObserverFactory {
  observed: Array<{
    type: string;
    durationThreshold?: number;
    emit: (entries: readonly ObservedEntry[]) => void;
    connected: boolean;
  }> = [];
  constructor(readonly supportedEntryTypes: readonly string[]) {}
  observe(
    options: { type: string; durationThreshold?: number },
    onEntries: (entries: readonly ObservedEntry[]) => void
  ) {
    const record = { ...options, emit: onEntries, connected: true };
    this.observed.push(record);
    return {
      disconnect: () => {
        record.connected = false;
      },
    };
  }
  emit(type: string, entries: readonly ObservedEntry[]) {
    const record = this.observed.find((observer) => observer.type === type);
    if (!record) throw new Error(`no ${type} observer`);
    record.emit(entries);
  }
}

class FakeScheduler {
  callbacks = new Map<number, () => void>();
  created = 0;
  private nextHandle = 1;
  setInterval(callback: () => void, intervalMs: number) {
    expect(intervalMs).toBe(FLIGHT_RECORDER_RENDERER_BATCH_INTERVAL_MS);
    this.created += 1;
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }
  clearInterval(handle: unknown) {
    this.callbacks.delete(handle as number);
  }
  tick() {
    for (const callback of [...this.callbacks.values()]) callback();
  }
}

function loafEntry(overrides: Partial<ObservedEntry> = {}): ObservedEntry {
  return {
    entryType: "long-animation-frame",
    name: "long-animation-frame",
    startTime: 100,
    duration: 80,
    blockingDuration: 30,
    renderStart: 0,
    styleAndLayoutStart: 150,
    scripts: [],
    ...overrides,
  };
}

function eventEntry(overrides: Partial<ObservedEntry> = {}): ObservedEntry {
  return {
    entryType: "event",
    name: "click",
    startTime: 10,
    duration: 64,
    interactionId: 7,
    target: { tagName: "BUTTON", textContent: "secret prompt text" },
    ...overrides,
  };
}

function setup(supported = ["long-animation-frame", "event"]) {
  const observers = new FakeObservers(supported);
  const scheduler = new FakeScheduler();
  const pushed: RendererBatch[] = [];
  const pending: Array<(result: { accepted: boolean }) => void> = [];
  const rejections: Array<(error: Error) => void> = [];
  const push = (batch: RendererBatch) => {
    pushed.push(batch);
    return new Promise<{ accepted: boolean }>((resolve, reject) => {
      pending.push(resolve);
      rejections.push(reject);
    });
  };
  const announced: string[] = [];
  const stop = startRendererFlightRecorder({
    push,
    observers,
    scheduler,
    announceRendererId: (rendererId) => announced.push(rendererId),
  });
  return { observers, scheduler, pushed, pending, rejections, stop, announced };
}

/** Lets promise continuations from a settled push run. */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("startRendererFlightRecorder", () => {
  test("creates nothing without PerformanceObserver or supported entry types", () => {
    const scheduler = new FakeScheduler();
    const push = () => Promise.resolve({ accepted: true });
    startRendererFlightRecorder({ push, observers: null, scheduler })();
    const unsupported = new FakeObservers(["mark", "measure"]);
    startRendererFlightRecorder({ push, observers: unsupported, scheduler })();
    expect(unsupported.observed).toHaveLength(0);
    expect(scheduler.created).toBe(0);
  });

  test("observes only supported types, with the event duration threshold", () => {
    const { observers, stop } = setup(["event"]);
    expect(observers.observed).toHaveLength(1);
    expect(observers.observed[0]).toMatchObject({
      type: "event",
      durationThreshold: FLIGHT_RECORDER_EVENT_DURATION_THRESHOLD_MS,
    });
    stop();
  });

  test("announces the same rendererId its long-frame entries carry", () => {
    // The desktop main process maps this ID to the page to profile after a long-frame trip.
    const { observers, scheduler, pushed, announced, stop } = setup();
    observers.emit("long-animation-frame", [loafEntry()]);
    scheduler.tick();
    expect(announced).toHaveLength(1);
    expect(pushed[0].loaf[0].rendererId).toBe(announced[0]);
    stop();
  });

  test("pushes nothing when no entry is pending", () => {
    const { scheduler, pushed, stop } = setup();
    scheduler.tick();
    expect(pushed).toHaveLength(0);
    stop();
  });

  test("bounds batches: drops oldest entries, caps scripts and truncates strings", () => {
    const { observers, scheduler, pushed, stop } = setup();
    const scripts = Array.from({ length: FLIGHT_RECORDER_MAX_SCRIPTS_PER_LOAF + 4 }, (_, i) => ({
      sourceURL: `https://app.local/${"x".repeat(FLIGHT_RECORDER_MAX_SOURCE_URL_CHARS)}`,
      sourceFunctionName: "f".repeat(FLIGHT_RECORDER_MAX_FUNCTION_NAME_CHARS + 10),
      sourceCharPosition: i,
      invoker: "TimerHandler:setTimeout",
      invokerType: "user-callback",
      duration: 40,
      forcedStyleAndLayoutDuration: 5,
    }));
    observers.emit(
      "long-animation-frame",
      Array.from({ length: FLIGHT_RECORDER_MAX_LOAF_PER_BATCH + 3 }, (_, i) =>
        loafEntry({ startTime: i + 1, scripts })
      )
    );
    observers.emit(
      "event",
      Array.from({ length: FLIGHT_RECORDER_MAX_EVENTS_PER_BATCH + 2 }, () => eventEntry())
    );
    scheduler.tick();

    expect(pushed).toHaveLength(1);
    const batch = pushed[0];
    expect(RendererBatchSchema.safeParse(batch).success).toBe(true);
    expect(batch.loaf).toHaveLength(FLIGHT_RECORDER_MAX_LOAF_PER_BATCH);
    expect(batch.droppedLoaf).toBe(3);
    expect(batch.events).toHaveLength(FLIGHT_RECORDER_MAX_EVENTS_PER_BATCH);
    expect(batch.droppedEvents).toBe(2);
    // The oldest frames were dropped.
    expect(batch.loaf[0].startMs).toBe(perfEpochFromRelativeMs(4));
    const first = batch.loaf[0];
    expect(first.renderStartMs).toBe(0);
    expect(first.styleAndLayoutStartMs).toBe(perfEpochFromRelativeMs(150));
    expect(first.scripts).toHaveLength(FLIGHT_RECORDER_MAX_SCRIPTS_PER_LOAF);
    expect(first.scripts[0].sourceURL).toHaveLength(FLIGHT_RECORDER_MAX_SOURCE_URL_CHARS);
    expect(first.scripts[0].sourceFunctionName).toHaveLength(
      FLIGHT_RECORDER_MAX_FUNCTION_NAME_CHARS
    );
    // Every entry carries the page's renderer id.
    expect(batch.rendererId).toMatch(/^r-[a-z0-9]+$/);
    expect(first.rendererId).toBe(batch.rendererId);
    // Events keep the tag only, never text content.
    expect(batch.events[0]).toEqual({
      rendererId: batch.rendererId,
      startMs: perfEpochFromRelativeMs(10),
      name: "click",
      durationMs: 64,
      interactionId: 7,
      targetTag: "button",
    });
    stop();
  });

  test("keeps one push in flight and counts an undelivered batch as dropped", async () => {
    const { observers, scheduler, pushed, pending, rejections, stop } = setup();
    observers.emit("long-animation-frame", [loafEntry()]);
    scheduler.tick();
    observers.emit("long-animation-frame", [loafEntry(), loafEntry()]);
    scheduler.tick();
    expect(pushed).toHaveLength(1);

    // The backend refused the first batch (recorder off): no retry, its entry counts as dropped.
    pending[0]({ accepted: false });
    await settle();
    scheduler.tick();
    expect(pushed).toHaveLength(2);
    expect(pushed[1].loaf).toHaveLength(2);
    expect(pushed[1].droppedLoaf).toBe(1);

    // A failed push followed by an idle page still reports the loss: a drop-only batch.
    rejections[1](new Error("socket closed"));
    await settle();
    scheduler.tick();
    expect(pushed).toHaveLength(3);
    expect(pushed[2]).toMatchObject({ loaf: [], events: [], droppedLoaf: 3, droppedEvents: 0 });

    pending[2]({ accepted: true });
    await settle();
    scheduler.tick();
    expect(pushed).toHaveLength(3);
    observers.emit("event", [eventEntry()]);
    scheduler.tick();
    expect(pushed[3].droppedLoaf).toBe(0);
    stop();
  });

  test("stop disconnects observers and clears the push timer", () => {
    const { observers, scheduler, stop } = setup();
    expect(scheduler.callbacks.size).toBe(1);
    stop();
    expect(scheduler.callbacks.size).toBe(0);
    expect(observers.observed.every((observer) => !observer.connected)).toBe(true);
  });
});
