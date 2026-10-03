/* eslint-disable @typescript-eslint/await-thenable -- oRPC router client calls return thenables the rule cannot see */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRouterClient } from "@orpc/server";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import type { RendererBatch } from "@/common/orpc/schemas/perfFlightRecorder";
import { FLIGHT_RECORDER_MAX_LOAF_PER_BATCH } from "@/constants/perfFlightRecorder";
import { FlightRecorder } from "@/node/services/perf/flightRecorder";
import { PerfCaptureService } from "@/node/services/perf/perfCaptureService";
import { PerfReportService } from "@/node/services/perf/perfReportService";
import type { ORPCContext } from "./context";
import { router } from "./router";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function createClient(
  options: {
    delay?: (ms: number, signal: AbortSignal) => Promise<void>;
    /** Holds a report open (it lists captures first) to observe a concurrent call. */
    listCapturesGate?: Promise<void>;
  } = {}
) {
  // Bun has no monitorEventLoopDelay or gc entries: inert probes and a manual scheduler.
  const recorder = new FlightRecorder({
    probes: {
      createLoopDelayHistogram: () => ({
        enable: () => undefined,
        disable: () => undefined,
        reset: () => undefined,
        percentile: () => 0,
        min: 0,
        max: 0,
        count: 0,
      }),
      readEventLoopUtilization: () => ({ idleMs: 0, activeMs: 0 }),
      observeGc: () => ({ disconnect: () => undefined }),
      readHeap: () => ({ usedBytes: 0, totalBytes: 0, limitBytes: 0 }),
    },
    scheduler: { setInterval: () => 1, clearInterval: () => undefined },
  });
  const capturesDir = path.join(os.tmpdir(), `perf-captures-router-${process.pid}-${Date.now()}`);
  tempDirs.push(capturesDir);
  const perfCaptures = new PerfCaptureService({
    dir: capturesDir,
    recorder,
    // Bun's node:inspector is partial: a fake run stands in for the real profiler.
    backendProfiler: {
      start: () =>
        Promise.resolve({
          ok: true,
          run: { stop: () => Promise.resolve({ nodes: [] }), cancel: () => Promise.resolve() },
        }),
    },
    delay: options.delay ?? (() => Promise.resolve()),
  });
  const overrides = new Map<ExperimentId, boolean>();
  const reportsDir = path.join(os.tmpdir(), `perf-reports-router-${process.pid}-${Date.now()}`);
  tempDirs.push(reportsDir);
  const perfReports = new PerfReportService({
    reportsDir,
    xumHome: path.dirname(reportsDir),
    capturesDir,
    recorder,
    captures: {
      listCaptures: async () => {
        await options.listCapturesGate;
        return perfCaptures.listCaptures();
      },
    },
    isExperimentEnabled: (experimentId) => overrides.get(experimentId) === true,
  });
  const context = {
    perfFlightRecorder: recorder,
    perfCaptures,
    perfReports,
    experimentsService: {
      getOverrides: () => Promise.resolve(Object.fromEntries(overrides)),
      setOverride: (experimentId: ExperimentId, enabled: boolean | null | undefined) => {
        if (enabled == null) overrides.delete(experimentId);
        else overrides.set(experimentId, enabled);
        return Promise.resolve();
      },
      isExperimentEnabled: (experimentId: ExperimentId) => overrides.get(experimentId) === true,
    },
  } as unknown as ORPCContext;
  return { client: createRouterClient(router(), { context }), overrides };
}

function batch(loafCount: number): RendererBatch {
  return {
    rendererId: "r-test",
    sentAtMs: 1,
    loaf: Array.from({ length: loafCount }, () => ({
      rendererId: "r-test",
      startMs: 1,
      durationMs: 250,
      blockingDurationMs: 200,
      renderStartMs: 0,
      styleAndLayoutStartMs: 0,
      scripts: [],
    })),
    events: [],
    droppedLoaf: 0,
    droppedEvents: 0,
  };
}

describe("perf flight recorder procedures", () => {
  test("off: the snapshot is readable and renderer batches are refused", async () => {
    const { client } = createClient();
    await expect(client.perf.pushRendererFlightRecorderBatch(batch(1))).resolves.toEqual({
      accepted: false,
    });
    const snapshot = await client.perf.getFlightRecorderSnapshot();
    expect(snapshot).toMatchObject({
      version: 1,
      state: "off",
      backend: { samples: [], heap: [] },
      renderer: { loaf: [], events: [], droppedLoaf: 0, droppedEvents: 0 },
      trips: [],
    });
  });

  test("experiment overrides start and stop collection without a restart", async () => {
    const { client, overrides } = createClient();
    await client.experiments.setOverride({
      experimentId: EXPERIMENT_IDS.PERF_FLIGHT_RECORDER,
      enabled: true,
    });
    await expect(client.perf.pushRendererFlightRecorderBatch(batch(1))).resolves.toEqual({
      accepted: true,
    });
    const snapshot = await client.perf.getFlightRecorderSnapshot();
    expect(snapshot.state).toBe("collecting");
    expect(snapshot.renderer.loaf).toHaveLength(1);
    expect(snapshot.trips).toEqual([
      { kind: "long-animation-frame", atMs: 1, durationMs: 250, rendererId: "r-test" },
    ]);

    // Another process turned it off on disk; the next overrides read adopts that state.
    overrides.delete(EXPERIMENT_IDS.PERF_FLIGHT_RECORDER);
    await client.experiments.getOverrides();
    expect((await client.perf.getFlightRecorderSnapshot()).state).toBe("off");
  });

  test("open status streams follow override writes made by any client (e.g. the CLI)", async () => {
    // Renderers follow this stream; without it a CLI toggle left the open page diverged.
    const { client } = createClient();
    const controller = new AbortController();
    const stream = await client.experiments.onPerfFlightRecorderChange(undefined, {
      signal: controller.signal,
    });
    try {
      expect((await stream.next()).value).toEqual({ enabled: false, state: "off" });
      const setPerf = (enabled: boolean) =>
        client.experiments.setOverride({
          experimentId: EXPERIMENT_IDS.PERF_FLIGHT_RECORDER,
          enabled,
        });
      await setPerf(true);
      expect((await stream.next()).value).toEqual({ enabled: true, state: "collecting" });
      await setPerf(false);
      expect((await stream.next()).value).toEqual({ enabled: false, state: "off" });
    } finally {
      controller.abort();
    }
  });

  test("an oversized renderer batch is rejected at the schema boundary", async () => {
    const { client } = createClient();
    await client.experiments.setOverride({
      experimentId: EXPERIMENT_IDS.PERF_FLIGHT_RECORDER,
      enabled: true,
    });
    // Rejected by input validation, not by some unrelated handler failure.
    await expect(
      client.perf.pushRendererFlightRecorderBatch(batch(FLIGHT_RECORDER_MAX_LOAF_PER_BATCH + 1))
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await client.perf.getFlightRecorderSnapshot()).renderer.loaf).toHaveLength(0);
  });

  test("collecting: real procedure calls and subscription values are attributed to their paths", async () => {
    // The path reaches subscription handlers only through the middleware's context; a broken
    // hand-off would leave subscriptions unrecorded while procedure stats still look fine.
    const { client } = createClient();
    await client.experiments.setOverride({
      experimentId: EXPERIMENT_IDS.PERF_FLIGHT_RECORDER,
      enabled: true,
    });
    await client.experiments.getOverrides();
    const controller = new AbortController();
    const stream = await client.experiments.onPerfFlightRecorderChange(undefined, {
      signal: controller.signal,
    });
    expect((await stream.next()).value).toEqual({ enabled: true, state: "collecting" });
    const live = (await client.perf.getFlightRecorderSnapshot()).rpc;
    expect(live.procedures).toMatchObject([
      { path: "experiments.getOverrides", count: 1, errorCount: 0 },
    ]);
    expect(live.subscriptions).toMatchObject([
      { path: "experiments.onPerfFlightRecorderChange", live: 1, opened: 1, events: 1 },
    ]);

    controller.abort();
    await stream.return(undefined);
    const closed = (await client.perf.getFlightRecorderSnapshot()).rpc;
    expect(closed.subscriptions).toMatchObject([{ live: 0, events: 1 }]);
    expect(closed.procedures.map((p) => [p.path, p.count])).toEqual([
      ["experiments.getOverrides", 1],
      ["perf.getFlightRecorderSnapshot", 1],
    ]);
  });

  test("perfCaptures: captureNow bounds its duration and list returns the capture", async () => {
    const { client } = createClient();
    await expect(
      client.perfCaptures.captureNow({ process: "backend", durationMs: 60_000 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await client.experiments.setOverride({
      experimentId: EXPERIMENT_IDS.PERF_FLIGHT_RECORDER,
      enabled: true,
    });
    const capture = await client.perfCaptures.captureNow({ process: "backend", durationMs: 1000 });
    expect(capture).toMatchObject({ kind: "manual", process: "backend", durationMs: 1000 });
    const listed = await client.perfCaptures.list();
    expect(path.isAbsolute(listed.dir)).toBe(true);
    expect(listed.captures).toEqual([capture]);
  });

  test("perfCaptures: refusals carry a code, so callers can tell 'enable it' from 'retry later'", async () => {
    let releaseCapture: () => void = () => undefined;
    const { client } = createClient({
      delay: () => new Promise((resolve) => (releaseCapture = resolve)),
    });
    await expect(client.perfCaptures.captureNow({ process: "backend" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await client.experiments.setOverride({
      experimentId: EXPERIMENT_IDS.PERF_FLIGHT_RECORDER,
      enabled: true,
    });
    const first = client.perfCaptures.captureNow({ process: "backend", durationMs: 1000 });
    await expect(client.perfCaptures.captureNow({ process: "backend" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    releaseCapture();
    await expect(first).resolves.toMatchObject({ kind: "manual", label: "manual capture" });
  });

  test("perfReports: create writes a bundle; refusals carry a code", async () => {
    let releaseList: () => void = () => undefined;
    const { client } = createClient({
      listCapturesGate: new Promise((resolve) => (releaseList = resolve)),
    });
    await expect(client.perfReports.create()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await client.experiments.setOverride({
      experimentId: EXPERIMENT_IDS.PERF_FLIGHT_RECORDER,
      enabled: true,
    });
    const first = client.perfReports.create();
    await expect(client.perfReports.create()).rejects.toMatchObject({ code: "CONFLICT" });
    releaseList();
    const report = await first;
    expect(path.isAbsolute(report.dir)).toBe(true);
    expect((await fs.stat(path.join(report.dir, "snapshot.json"))).isFile()).toBe(true);
  });
});
