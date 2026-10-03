/* eslint-disable @typescript-eslint/await-thenable -- oRPC router client calls return thenables the rule cannot see */
import { describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import type { RendererBatch } from "@/common/orpc/schemas/perfFlightRecorder";
import { FLIGHT_RECORDER_MAX_LOAF_PER_BATCH } from "@/constants/perfFlightRecorder";
import { FlightRecorder } from "@/node/services/perf/flightRecorder";
import type { ORPCContext } from "./context";
import { router } from "./router";

function createClient() {
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
  const overrides = new Map<ExperimentId, boolean>();
  const context = {
    perfFlightRecorder: recorder,
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
});
