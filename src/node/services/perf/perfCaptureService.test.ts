/* eslint-disable @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PerfCaptureMetadataSchema } from "@/common/orpc/schemas/perfCaptures";
import type { FlightRecorderTrip } from "@/common/orpc/schemas/perfFlightRecorder";
import {
  PERF_CAPTURE_COOLDOWN_MS,
  PERF_CAPTURE_MAX_CAPTURES,
  PERF_CAPTURE_MAX_SKIPPED_RECORDS,
  PERF_CAPTURE_STALE_TEMP_MS,
} from "@/constants/perfCaptures";
import { FLIGHT_RECORDER_SAMPLE_INTERVAL_MS } from "@/constants/perfFlightRecorder";
import { log } from "@/node/services/log";
import { FlightRecorder, type FlightRecorderTripListener } from "./flightRecorder";
import {
  PerfCaptureService,
  type CpuProfiler,
  type CpuProfilerStartResult,
  type ProfilerRun,
} from "./perfCaptureService";

const LOOP_TRIP: FlightRecorderTrip = {
  kind: "loop-delay-p99",
  atMs: 1,
  windows: [
    { p99Ms: 300, samplerLagMs: 0 },
    { p99Ms: 400, samplerLagMs: 0 },
  ],
};
const LOAF_TRIP: FlightRecorderTrip = {
  kind: "long-animation-frame",
  atMs: 2,
  durationMs: 500,
  rendererId: "r-page1",
};

class FakeRecorder {
  readonly listeners = new Set<FlightRecorderTripListener>();
  onTrip(listener: FlightRecorderTripListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Event-loop blocks the service reported; the real recorder's handling is tested below. */
  blockNotes = 0;
  noteSelfInducedBlock(): void {
    this.blockNotes += 1;
  }
  /** Like the real recorder, stamps the trip with the shared perf clock. */
  trip(trip: FlightRecorderTrip): void {
    for (const listener of this.listeners) listener({ ...trip, atMs: clockMs });
  }
}

/** A profiler whose runs record whether their session was released. */
class FakeProfiler implements CpuProfiler {
  readonly starts: Array<{ samplingIntervalUs: number; rendererId?: string }> = [];
  readonly runs: Array<{ released: boolean; cancels: number }> = [];
  nextStart: (() => Promise<CpuProfilerStartResult>) | null = null;
  stopError: Error | null = null;
  /** How long start and stop block the event loop, as the shared clock sees it. */
  blockMs = 0;

  start(options: { samplingIntervalUs: number; rendererId?: string }) {
    this.starts.push(options);
    clockMs += this.blockMs;
    if (this.nextStart !== null) {
      const next = this.nextStart;
      this.nextStart = null;
      return next();
    }
    return Promise.resolve(this.okRun());
  }

  okRun(): CpuProfilerStartResult {
    const state = { released: false, cancels: 0 };
    this.runs.push(state);
    const run: ProfilerRun = {
      stop: () => {
        clockMs += this.blockMs;
        state.released = true;
        if (this.stopError !== null) return Promise.reject(this.stopError);
        return Promise.resolve({
          nodes: [],
          startTime: 0,
          endTime: 1,
          samples: [],
          timeDeltas: [],
        });
      },
      cancel: () => {
        state.released = true;
        state.cancels += 1;
        return Promise.resolve();
      },
    };
    return { ok: true, run };
  }
}

/** Delays resolve only when released by the test (or on abort). */
class ManualDelay {
  private readonly pending: Array<() => void> = [];
  readonly delay = (_ms: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      this.pending.push(resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  get count(): number {
    return this.pending.length;
  }
  releaseAll(): void {
    for (const resolve of this.pending.splice(0)) resolve();
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let rootDir: string;
let dir: string;
interface LogSpy {
  mock: { calls: unknown[][] };
  mockRestore(): void;
}
let infoSpy: LogSpy;
let warnSpy: LogSpy;
let clockMs = 1_000_000;
let idCounter = 0;

function capturedLogCount(): number {
  return infoSpy.mock.calls.filter((call) => call[0] === "[perfCaptures] captured").length;
}

function createService(options: { delay?: ManualDelay } = {}) {
  const recorder = new FakeRecorder();
  const backend = new FakeProfiler();
  const service = new PerfCaptureService({
    dir,
    recorder,
    backendProfiler: backend,
    now: () => clockMs,
    delay: options.delay?.delay ?? (() => Promise.resolve()),
    // Zero-padded so retention's ID tie-break orders them like generated IDs.
    createId: () => `cap-${String(++idCounter).padStart(4, "0")}`,
  });
  return { service, recorder, backend };
}

/** Writes a valid capture as if an earlier run had recorded it; `profileBytes` makes it profiled. */
async function writeCapture(id: string, mtimeSec: number, profileBytes?: number): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const metadata = PerfCaptureMetadataSchema.parse({
    version: 1,
    id,
    kind: "manual",
    process: "backend",
    trigger: null,
    startedAtMs: mtimeSec * 1000,
    endedAtMs: mtimeSec * 1000,
    samplingIntervalUs: 1000,
    durationMs: 1000,
    xumVersion: "test",
    platform: "linux",
    label: "manual capture",
    ...(profileBytes === undefined
      ? { skippedReason: "inspector-open" }
      : { profileFile: `${id}.cpuprofile`, profileBytes }),
  });
  const files = [path.join(dir, `${id}.json`)];
  await fs.writeFile(files[0], JSON.stringify(metadata));
  if (profileBytes !== undefined) {
    files.push(path.join(dir, `${id}.cpuprofile`));
    // Sparse files keep large sizes cheap.
    await fs.writeFile(files[1], "");
    await fs.truncate(files[1], profileBytes);
  }
  for (const file of files) await fs.utimes(file, mtimeSec, mtimeSec);
}

async function listFiles(): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}

beforeEach(async () => {
  clockMs = 1_000_000;
  idCounter = 0;
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "perf-captures-"));
  dir = path.join(rootDir, "perf", "captures");
  infoSpy = spyOn(log, "info").mockImplementation(() => undefined);
  warnSpy = spyOn(log, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  infoSpy.mockRestore();
  warnSpy.mockRestore();
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe("PerfCaptureService", () => {
  test("off holds no trip listener and never profiles; enabling subscribes exactly once", async () => {
    const { service, recorder, backend } = createService();
    expect(recorder.listeners.size).toBe(0);
    await expect(service.captureNow({ process: "backend" })).rejects.toThrow("experiment");

    service.setEnabled(true);
    service.setEnabled(true);
    expect(recorder.listeners.size).toBe(1);
    service.setEnabled(false);
    expect(recorder.listeners.size).toBe(0);
    recorder.trip(LOOP_TRIP);
    expect(backend.starts).toHaveLength(0);
    expect(await listFiles()).toEqual([]);
  });

  test("a backend trip writes a private profile plus metadata; the same kind cools down", async () => {
    const { service, recorder, backend } = createService();
    service.setEnabled(true);
    recorder.trip(LOOP_TRIP);
    await waitUntil(() => capturedLogCount() === 1);

    expect(await listFiles()).toEqual(["cap-0001.cpuprofile", "cap-0001.json"]);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    for (const name of await listFiles()) {
      expect((await fs.stat(path.join(dir, name))).mode & 0o777).toBe(0o600);
    }
    const listed = await service.listCaptures();
    expect(listed.dir).toBe(dir);
    expect(listed.captures).toHaveLength(1);
    expect(listed.captures[0]).toMatchObject({
      id: "cap-0001",
      kind: "loop-delay-p99",
      process: "backend",
      trigger: { ...LOOP_TRIP, atMs: clockMs },
      label: "activity after trigger",
      profileFile: "cap-0001.cpuprofile",
    });
    expect(listed.captures[0].skippedReason).toBeUndefined();
    expect(backend.runs[0].released).toBe(true);

    // Within the cooldown: ignored. Another kind is not affected by this kind's cooldown.
    clockMs += PERF_CAPTURE_COOLDOWN_MS - 1;
    recorder.trip(LOOP_TRIP);
    expect(backend.starts).toHaveLength(1);
    recorder.trip(LOAF_TRIP);
    await waitUntil(() => capturedLogCount() === 2);

    clockMs += 1;
    recorder.trip(LOOP_TRIP);
    await waitUntil(() => capturedLogCount() === 3);
    expect(backend.starts).toHaveLength(2);
  });

  test("one capture at a time: trips during a capture are dropped and captureNow rejects", async () => {
    const delay = new ManualDelay();
    const { service, recorder, backend } = createService({ delay });
    service.setEnabled(true);
    recorder.trip(LOOP_TRIP);
    await waitUntil(() => delay.count === 1);

    // A different kind is out of cooldown, but the slot is taken: dropped, not queued.
    recorder.trip(LOAF_TRIP);
    await expect(service.captureNow({ process: "backend" })).rejects.toThrow("in progress");
    delay.releaseAll();
    await waitUntil(() => capturedLogCount() === 1);
    expect(backend.starts).toHaveLength(1);
    expect((await service.listCaptures()).captures.map((c) => c.kind)).toEqual(["loop-delay-p99"]);

    // The dropped renderer trip did not start that kind's cooldown.
    recorder.trip(LOAF_TRIP);
    await waitUntil(() => capturedLogCount() === 2);
  });

  test("a skipped or failing profiler still writes metadata with the reason, and releases the run", async () => {
    const { service, recorder, backend } = createService();
    service.setEnabled(true);

    backend.nextStart = () => Promise.resolve({ ok: false, skippedReason: "inspector-open" });
    const skipped = await service.captureNow({ process: "backend" });
    // A skipped start did no profiling work, so it reports no event-loop block.
    expect(recorder.blockNotes).toBe(0);
    expect(skipped).toMatchObject({
      kind: "manual",
      trigger: null,
      label: "manual capture",
      skippedReason: "inspector-open",
    });
    expect(skipped.profileFile).toBeUndefined();

    backend.stopError = new Error("Profiler.stop exploded");
    const failed = await service.captureNow({ process: "backend", durationMs: 2000 });
    expect(failed.skippedReason).toBe("failed: Profiler.stop exploded");
    expect(failed.durationMs).toBe(2000);
    expect(backend.runs.at(-1)?.released).toBe(true);
    // The start, the failed stop and the cancel after it each report a possible block.
    expect(recorder.blockNotes).toBe(3);

    backend.nextStart = () => Promise.reject(new Error("attach refused"));
    expect((await service.captureNow({ process: "backend" })).skippedReason).toBe(
      "failed: attach refused"
    );
    expect(recorder.blockNotes).toBe(4);

    expect(await listFiles()).toEqual(["cap-0001.json", "cap-0002.json", "cap-0003.json"]);
    for (const capture of (await service.listCaptures()).captures) {
      expect(PerfCaptureMetadataSchema.safeParse(capture).success).toBe(true);
    }
  });

  test("renderer trips profile the reporting page, or record why they could not", async () => {
    const { service, recorder } = createService();
    service.setEnabled(true);

    // xum server: no renderer profiler is registered.
    recorder.trip(LOAF_TRIP);
    await waitUntil(() => capturedLogCount() === 1);
    expect((await service.listCaptures()).captures[0]).toMatchObject({
      process: "renderer",
      skippedReason: "renderer-profiling-unavailable",
    });

    const renderer = new FakeProfiler();
    service.setRendererProfiler(renderer);
    clockMs += PERF_CAPTURE_COOLDOWN_MS;
    recorder.trip(LOAF_TRIP);
    await waitUntil(() => capturedLogCount() === 2);
    expect(renderer.starts).toEqual([{ samplingIntervalUs: 1000, rendererId: "r-page1" }]);

    // A manual renderer capture names no page: the profiler picks the main window.
    await service.captureNow({ process: "renderer" });
    expect(renderer.starts[1]).toEqual({ samplingIntervalUs: 1000 });
    // Renderer profiling runs in another process and never blocks the backend loop.
    expect(recorder.blockNotes).toBe(0);
  });

  test("slow-rpc trips and trip kinds it does not know are ignored", async () => {
    const { service, recorder, backend } = createService();
    service.setEnabled(true);
    recorder.trip({
      kind: "slow-rpc",
      atMs: 3,
      path: "workspace.sendMessage",
      startMs: 1,
      durationMs: 2,
      ok: true,
    });
    recorder.trip({ kind: "future-kind", atMs: 3 } as unknown as FlightRecorderTrip);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(backend.starts).toHaveLength(0);
    expect(await listFiles()).toEqual([]);
  });

  test("disable while profiling cancels the run and writes nothing", async () => {
    const delay = new ManualDelay();
    const { service, backend } = createService({ delay });
    service.setEnabled(true);
    const capture = service.captureNow({ process: "backend" });
    await waitUntil(() => delay.count === 1);

    service.setEnabled(false);
    await expect(capture).rejects.toThrow("cancelled");
    expect(backend.runs[0]).toEqual({ released: true, cancels: 1 });
    expect(await listFiles()).toEqual([]);
  });

  for (const stopper of ["disable", "dispose"] as const) {
    test(`${stopper} while profiler start is pending releases the late session and writes nothing`, async () => {
      // A manual delay keeps dispose's wait bound from resolving on its own.
      const { service, recorder, backend } = createService({ delay: new ManualDelay() });
      service.setEnabled(true);
      let resolveStart: (result: CpuProfilerStartResult) => void = () => undefined;
      backend.nextStart = () => new Promise((resolve) => (resolveStart = resolve));
      recorder.trip(LOOP_TRIP);
      await waitUntil(() => backend.starts.length === 1);

      let disposed = false;
      const stopped =
        stopper === "dispose"
          ? service.dispose().then(() => (disposed = true))
          : Promise.resolve(service.setEnabled(false));
      // dispose waits for the late session to be released, not just for the abort.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(disposed).toBe(false);
      resolveStart(backend.okRun());
      await stopped;
      await waitUntil(() => backend.runs[0]?.cancels === 1);
      expect(backend.runs[0].released).toBe(true);
      expect(recorder.listeners.size).toBe(0);
      expect(await listFiles()).toEqual([]);
    });
  }

  test("a loop-delay trip right after a manual capture is profiled; one right after that trip capture cools down", async () => {
    const { service, recorder, backend } = createService();
    service.setEnabled(true);
    await service.captureNow({ process: "backend", durationMs: 1000 });

    // A manual capture neither checks nor starts the cooldown, so a real stall right
    // after it starts a trip capture.
    clockMs += 1;
    recorder.trip(LOOP_TRIP);
    await waitUntil(() => capturedLogCount() === 1);
    expect(backend.starts).toHaveLength(2);

    // A stall right after that trip capture cannot start another: its kind is cooling down.
    clockMs += 1;
    recorder.trip(LOOP_TRIP);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(backend.starts).toHaveLength(2);
  });

  test("the backend profiler's own start and stop blocks never trip the recorder into another capture", async () => {
    // A real recorder on a fake runtime. Each window holding a profiler block reads high,
    // and so does one real busy window right after it. Before the recorder learned about
    // the blocks, each pair tripped, and the trip after a manual capture started a new one.
    let p99Ms = 25;
    let sampleTick: () => void = () => undefined;
    const histogramMs = () => p99Ms * 1e6;
    const recorder = new FlightRecorder({
      now: () => clockMs,
      probes: {
        createLoopDelayHistogram: () => ({
          enable: () => undefined,
          disable: () => undefined,
          reset: () => undefined,
          percentile: histogramMs,
          count: 1,
          get min() {
            return histogramMs();
          },
          get max() {
            return histogramMs();
          },
        }),
        readEventLoopUtilization: () => ({ idleMs: 0, activeMs: 0 }),
        observeGc: () => ({ disconnect: () => undefined }),
        readHeap: () => ({ usedBytes: 1, totalBytes: 1, limitBytes: 1 }),
      },
      scheduler: {
        setInterval: (callback) => {
          sampleTick = callback;
          return 1;
        },
        clearInterval: () => undefined,
      },
    });
    const tick = (windowP99Ms: number) => {
      p99Ms = windowP99Ms;
      clockMs += FLIGHT_RECORDER_SAMPLE_INTERVAL_MS;
      sampleTick();
    };
    const delay = new ManualDelay();
    const backend = new FakeProfiler();
    backend.blockMs = 300;
    const service = new PerfCaptureService({
      dir,
      recorder,
      backendProfiler: backend,
      now: () => clockMs,
      delay: delay.delay,
      createId: () => "cap-0001",
    });
    recorder.setEnabled(true);
    service.setEnabled(true);

    const capture = service.captureNow({ process: "backend" });
    await waitUntil(() => delay.count === 1);
    tick(400); // holds the start block
    tick(400); // real busy window
    tick(25);
    delay.releaseAll();
    await capture;
    tick(400); // holds the stop block
    tick(400); // real busy window
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(recorder.getSnapshot().trips).toEqual([]);
    expect(backend.starts).toHaveLength(1);
    expect(recorder.getSnapshot().backend.samples).toHaveLength(5);
    await service.dispose();
    recorder.stop();
  });

  test("retention keeps the newest profiled captures within count and bytes", async () => {
    const oldSec = Date.now() / 1000 - 3600;
    for (let i = 1; i <= PERF_CAPTURE_MAX_CAPTURES + 2; i++) {
      await writeCapture(`old-${String(i).padStart(2, "0")}`, oldSec + i, 2);
    }
    // A stale orphan profile (interrupted metadata write) is removed; a fresh one may be
    // another process's capture between its two writes. Neither takes a capture's place.
    await fs.writeFile(path.join(dir, "old-00.cpuprofile"), "{}");
    await fs.utimes(path.join(dir, "old-00.cpuprofile"), oldSec, oldSec);
    await fs.writeFile(path.join(dir, "fresh-orphan.cpuprofile"), "{}");
    // A stale temp file is removed; a fresh one may belong to a write in progress.
    const staleTemp = path.join(dir, "old-05.json.0123456789ab");
    const freshTemp = path.join(dir, "old-06.json.ba9876543210");
    await fs.writeFile(staleTemp, "x");
    await fs.writeFile(freshTemp, "x");
    const staleSec = (Date.now() - PERF_CAPTURE_STALE_TEMP_MS - 60_000) / 1000;
    await fs.utimes(staleTemp, staleSec, staleSec);
    await fs.writeFile(path.join(dir, "notes.txt"), "not ours");

    const { service } = createService();
    service.setEnabled(true);
    await service.captureNow({ process: "backend" });

    const listed = (await service.listCaptures()).captures.map((c) => c.id);
    expect(listed).toHaveLength(PERF_CAPTURE_MAX_CAPTURES);
    expect(listed).toContain("cap-0001");
    // The three oldest captures went, with both their files.
    expect(listed).not.toContain("old-03");
    expect(listed).toContain("old-04");
    const remaining = await listFiles();
    expect(remaining).not.toContain("old-03.cpuprofile");
    expect(remaining).not.toContain("old-00.cpuprofile");
    expect(remaining).toContain("fresh-orphan.cpuprofile");
    expect(remaining).toContain("old-06.json.ba9876543210");
    expect(remaining).not.toContain("old-05.json.0123456789ab");
    expect(remaining).toContain("notes.txt");

    // Bytes: a newer 150 MB capture plus an older 60 MB one exceed 200 MB; the older
    // one goes, and so does every capture older than it.
    const nowSec = Date.now() / 1000;
    await writeCapture("big-a", nowSec - 20, 60 * 1024 * 1024);
    await writeCapture("big-b", nowSec - 10, 150 * 1024 * 1024);
    await service.captureNow({ process: "backend" });
    expect((await service.listCaptures()).captures.map((c) => c.id).sort()).toEqual([
      "big-b",
      "cap-0001",
      "cap-0002",
    ]);
    expect(await listFiles()).not.toContain("big-a.cpuprofile");
  });

  test("junk files and metadata-only records never evict real profiles", async () => {
    // Future-dated junk files and a burst of skipped captures must not push out real
    // profiles, including the one captureNow just returned.
    const futureSec = Date.now() / 1000 + 3600;
    const oldSec = Date.now() / 1000 - 3600;
    for (let i = 0; i < PERF_CAPTURE_MAX_CAPTURES; i++) {
      await writeCapture(`real-${String(i).padStart(2, "0")}`, oldSec + i, 2);
    }
    const junk = Array.from({ length: PERF_CAPTURE_MAX_CAPTURES }, (_, i) => [
      `junk-${i}.json`,
      `junkprof-${i}.cpuprofile`,
    ]).flat();
    for (const name of junk) {
      await fs.writeFile(path.join(dir, name), JSON.stringify({ version: 2 }));
      await fs.utimes(path.join(dir, name), futureSec, futureSec);
    }
    for (let i = 0; i < PERF_CAPTURE_MAX_SKIPPED_RECORDS + 3; i++) {
      await writeCapture(`skip-${String(i).padStart(2, "0")}`, futureSec + i);
    }
    const { service, backend } = createService();
    service.setEnabled(true);
    const profiled = await service.captureNow({ process: "backend" });
    backend.nextStart = () => Promise.resolve({ ok: false, skippedReason: "inspector-open" });
    await service.captureNow({ process: "backend" });

    const captures = (await service.listCaptures()).captures;
    const profiles = captures.filter((c) => c.profileFile !== undefined).map((c) => c.id);
    // Newest profiles within the count bound: the new one replaced the oldest.
    expect(profiles).toHaveLength(PERF_CAPTURE_MAX_CAPTURES);
    expect(profiles).toContain(profiled.id);
    expect(profiles).not.toContain("real-00");
    // Metadata-only records are bounded on their own.
    expect(captures.filter((c) => c.profileFile === undefined)).toHaveLength(
      PERF_CAPTURE_MAX_SKIPPED_RECORDS
    );
    const remaining = await listFiles();
    for (const name of junk) expect(remaining).toContain(name);
  });

  test("a record whose profile file is missing or belongs to another capture is not listed and never evicts intact captures", async () => {
    const oldSec = Date.now() / 1000 - 3600;
    for (let i = 0; i < PERF_CAPTURE_MAX_CAPTURES; i++) {
      await writeCapture(`real-${String(i).padStart(2, "0")}`, oldSec + i, 2);
    }
    // Newer records whose .cpuprofile someone deleted.
    const dangling = Array.from({ length: 5 }, (_, i) => `gone-${i}`);
    for (const [i, id] of dangling.entries()) {
      await writeCapture(id, oldSec + 100 + i, 2);
      await fs.rm(path.join(dir, `${id}.cpuprofile`));
    }
    // A record that names another capture's (present) profile is not attributed it.
    await writeCapture("cross", oldSec + 200);
    const crossPath = path.join(dir, "cross.json");
    const cross = JSON.parse(await fs.readFile(crossPath, "utf8")) as Record<string, unknown>;
    delete cross.skippedReason;
    await fs.writeFile(
      crossPath,
      JSON.stringify({ ...cross, profileFile: "real-05.cpuprofile", profileBytes: 2 })
    );
    // A profile whose own metadata does not claim it is removed, not kept unbounded.
    await writeCapture("unclaimed", oldSec + 300);
    await fs.writeFile(path.join(dir, "unclaimed.cpuprofile"), "{}");
    const { service } = createService();
    service.setEnabled(true);
    const fresh = await service.captureNow({ process: "backend" });

    expect(await listFiles()).not.toContain("unclaimed.cpuprofile");
    const ids = (await service.listCaptures()).captures.map((c) => c.id);
    for (const id of [...dangling, "cross"]) expect(ids).not.toContain(id);
    // Only the new capture displaced an intact one.
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain("real-00");
    for (let i = 1; i < PERF_CAPTURE_MAX_CAPTURES; i++) {
      expect(ids).toContain(`real-${String(i).padStart(2, "0")}`);
    }
  });

  test("list skips invalid metadata and returns newest first", async () => {
    const { service } = createService();
    service.setEnabled(true);
    await service.captureNow({ process: "backend" });
    clockMs += 5000;
    await service.captureNow({ process: "backend" });
    await fs.writeFile(path.join(dir, "junk-1.json"), "{not json");
    await fs.writeFile(path.join(dir, "junk-2.json"), JSON.stringify({ version: 2 }));
    expect((await service.listCaptures()).captures.map((c) => c.id)).toEqual([
      "cap-0002",
      "cap-0001",
    ]);
  });
});
