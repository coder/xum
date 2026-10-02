/**
 * Perf flight recorder oRPC schemas (experiment `perfFlightRecorder`).
 *
 * Every array and string carries a `.max()` so a renderer batch or a snapshot
 * can never grow past the recorder's ring capacities. All timestamps are perf
 * epoch milliseconds (see src/common/utils/perf/clock.ts).
 */

import { z } from "zod";
import {
  FLIGHT_RECORDER_BACKEND_SAMPLE_CAPACITY,
  FLIGHT_RECORDER_HEAP_SAMPLE_CAPACITY,
  FLIGHT_RECORDER_MAX_EVENT_NAME_CHARS,
  FLIGHT_RECORDER_MAX_EVENTS_PER_BATCH,
  FLIGHT_RECORDER_MAX_FAILURE_CHARS,
  FLIGHT_RECORDER_MAX_FUNCTION_NAME_CHARS,
  FLIGHT_RECORDER_MAX_INVOKER_CHARS,
  FLIGHT_RECORDER_MAX_LOAF_PER_BATCH,
  FLIGHT_RECORDER_MAX_RENDERER_ID_CHARS,
  FLIGHT_RECORDER_MAX_SCRIPTS_PER_LOAF,
  FLIGHT_RECORDER_MAX_SOURCE_URL_CHARS,
  FLIGHT_RECORDER_MAX_TAG_CHARS,
  FLIGHT_RECORDER_RENDERER_EVENT_CAPACITY,
  FLIGHT_RECORDER_RENDERER_LOAF_CAPACITY,
  FLIGHT_RECORDER_TRIP_CAPACITY,
} from "@/constants/perfFlightRecorder";

export const GC_KINDS = ["minor", "major", "incremental", "weakcb", "unknown"] as const;
export type GcKind = (typeof GC_KINDS)[number];

const GcKindStatsSchema = z.object({
  count: z.number().int().nonnegative(),
  totalMs: z.number().nonnegative(),
  maxMs: z.number().nonnegative(),
});

export const BackendHealthSampleSchema = z.object({
  atMs: z.number(),
  windowMs: z.number().nonnegative(),
  loopDelay: z.object({
    p50Ms: z.number().nonnegative(),
    p99Ms: z.number().nonnegative(),
    maxMs: z.number().nonnegative(),
    minMs: z.number().nonnegative(),
  }),
  elu: z.object({
    utilization: z.number().min(0).max(1),
    activeMs: z.number().nonnegative(),
    idleMs: z.number().nonnegative(),
  }),
  gc: z.object({
    count: z.number().int().nonnegative(),
    totalMs: z.number().nonnegative(),
    maxMs: z.number().nonnegative(),
    byKind: z.object({
      minor: GcKindStatsSchema,
      major: GcKindStatsSchema,
      incremental: GcKindStatsSchema,
      weakcb: GcKindStatsSchema,
      unknown: GcKindStatsSchema,
    }),
  }),
});
export type BackendHealthSample = z.infer<typeof BackendHealthSampleSchema>;

export const HeapSampleSchema = z.object({
  atMs: z.number(),
  usedBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  limitBytes: z.number().nonnegative(),
});
export type HeapSample = z.infer<typeof HeapSampleSchema>;

const RendererIdSchema = z.string().min(1).max(FLIGHT_RECORDER_MAX_RENDERER_ID_CHARS);

export const RendererLoafScriptSchema = z.object({
  sourceURL: z.string().max(FLIGHT_RECORDER_MAX_SOURCE_URL_CHARS),
  sourceFunctionName: z.string().max(FLIGHT_RECORDER_MAX_FUNCTION_NAME_CHARS),
  sourceCharPosition: z.number(),
  invoker: z.string().max(FLIGHT_RECORDER_MAX_INVOKER_CHARS),
  invokerType: z.string().max(FLIGHT_RECORDER_MAX_INVOKER_CHARS),
  durationMs: z.number().nonnegative(),
  forcedStyleAndLayoutDurationMs: z.number().nonnegative(),
});
export type RendererLoafScript = z.infer<typeof RendererLoafScriptSchema>;

export const RendererLoafEntrySchema = z.object({
  rendererId: RendererIdSchema,
  startMs: z.number(),
  durationMs: z.number().nonnegative(),
  blockingDurationMs: z.number().nonnegative(),
  /** Perf epoch ms, or 0 when the frame had no rendering phase. */
  renderStartMs: z.number(),
  /** Perf epoch ms, or 0 when the frame had no style/layout phase. */
  styleAndLayoutStartMs: z.number(),
  scripts: z.array(RendererLoafScriptSchema).max(FLIGHT_RECORDER_MAX_SCRIPTS_PER_LOAF),
});
export type RendererLoafEntry = z.infer<typeof RendererLoafEntrySchema>;

/** Slow event-timing entry. Carries the target tag only, never text content. */
export const RendererEventEntrySchema = z.object({
  rendererId: RendererIdSchema,
  startMs: z.number(),
  name: z.string().max(FLIGHT_RECORDER_MAX_EVENT_NAME_CHARS),
  durationMs: z.number().nonnegative(),
  interactionId: z.number().int().nonnegative(),
  targetTag: z.string().max(FLIGHT_RECORDER_MAX_TAG_CHARS).nullable(),
});
export type RendererEventEntry = z.infer<typeof RendererEventEntrySchema>;

export const RendererBatchSchema = z.object({
  rendererId: RendererIdSchema,
  sentAtMs: z.number(),
  loaf: z.array(RendererLoafEntrySchema).max(FLIGHT_RECORDER_MAX_LOAF_PER_BATCH),
  events: z.array(RendererEventEntrySchema).max(FLIGHT_RECORDER_MAX_EVENTS_PER_BATCH),
  /** Entries the renderer dropped since its previous accepted batch. */
  droppedLoaf: z.number().int().nonnegative(),
  droppedEvents: z.number().int().nonnegative(),
});
export type RendererBatch = z.infer<typeof RendererBatchSchema>;

export const FlightRecorderTripSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("loop-delay-p99"),
    atMs: z.number(),
    /** p99 of the previous and the current window, both above the threshold. */
    p99Ms: z.tuple([z.number(), z.number()]),
  }),
  z.object({
    kind: z.literal("long-animation-frame"),
    atMs: z.number(),
    durationMs: z.number(),
    rendererId: RendererIdSchema,
  }),
]);
export type FlightRecorderTrip = z.infer<typeof FlightRecorderTripSchema>;

export const FlightRecorderStateSchema = z.enum(["off", "collecting", "failed"]);
export type FlightRecorderState = z.infer<typeof FlightRecorderStateSchema>;

export const FlightRecorderSnapshotSchema = z.object({
  version: z.literal(1),
  state: FlightRecorderStateSchema,
  nowMs: z.number(),
  failure: z.string().max(FLIGHT_RECORDER_MAX_FAILURE_CHARS).optional(),
  backend: z.object({
    samples: z.array(BackendHealthSampleSchema).max(FLIGHT_RECORDER_BACKEND_SAMPLE_CAPACITY),
    heap: z.array(HeapSampleSchema).max(FLIGHT_RECORDER_HEAP_SAMPLE_CAPACITY),
  }),
  renderer: z.object({
    loaf: z.array(RendererLoafEntrySchema).max(FLIGHT_RECORDER_RENDERER_LOAF_CAPACITY),
    events: z.array(RendererEventEntrySchema).max(FLIGHT_RECORDER_RENDERER_EVENT_CAPACITY),
    droppedLoaf: z.number().int().nonnegative(),
    droppedEvents: z.number().int().nonnegative(),
  }),
  trips: z.array(FlightRecorderTripSchema).max(FLIGHT_RECORDER_TRIP_CAPACITY),
});
export type FlightRecorderSnapshot = z.infer<typeof FlightRecorderSnapshotSchema>;

export const perf = {
  getFlightRecorderSnapshot: {
    input: z.void(),
    output: FlightRecorderSnapshotSchema,
  },
  pushRendererFlightRecorderBatch: {
    input: RendererBatchSchema,
    output: z.object({ accepted: z.boolean() }),
  },
};
