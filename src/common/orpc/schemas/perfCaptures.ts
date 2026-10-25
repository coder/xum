/**
 * Triggered CPU profile oRPC schemas (experiment `perfFlightRecorder`, F2).
 *
 * A capture's metadata is also its on-disk completion marker (`<id>.json`), and a
 * later "Report slowness" bundle reads it, so it carries a `version`. Timestamps are
 * perf epoch milliseconds (src/common/utils/perf/clock.ts).
 */

import { z } from "zod";
import {
  PERF_CAPTURE_LABEL,
  PERF_CAPTURE_MANUAL_LABEL,
  PERF_CAPTURE_MAX_MANUAL_DURATION_MS,
  PERF_CAPTURE_MAX_REASON_CHARS,
  PERF_CAPTURE_MIN_MANUAL_DURATION_MS,
} from "@/constants/perfCaptures";
import { FlightRecorderTripSchema } from "./perfFlightRecorder";

/** IDs are generated, never taken from input; file names derive only from them. */
export const PERF_CAPTURE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export const PerfCaptureKindSchema = z.enum(["loop-delay-p99", "long-animation-frame", "manual"]);
export type PerfCaptureKind = z.infer<typeof PerfCaptureKindSchema>;

export const PerfCaptureProcessSchema = z.enum(["backend", "renderer"]);
export type PerfCaptureProcess = z.infer<typeof PerfCaptureProcessSchema>;

export const PerfCaptureMetadataSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(PERF_CAPTURE_ID_PATTERN),
  kind: PerfCaptureKindSchema,
  process: PerfCaptureProcessSchema,
  /** The trip that started this capture; null for a manual capture. */
  trigger: FlightRecorderTripSchema.nullable(),
  startedAtMs: z.number(),
  endedAtMs: z.number(),
  samplingIntervalUs: z.number().int().positive(),
  /** Requested profiling duration. */
  durationMs: z.number().int().nonnegative(),
  xumVersion: z.string().max(200),
  platform: z.string().max(64),
  /**
   * A trip capture shows what ran after the trigger, not the stall itself. A manual
   * capture has no trigger.
   */
  label: z.enum([PERF_CAPTURE_LABEL, PERF_CAPTURE_MANUAL_LABEL]),
  /** Set when no profile was recorded (e.g. "inspector-open", "failed: <message>"). */
  skippedReason: z.string().max(PERF_CAPTURE_MAX_REASON_CHARS).optional(),
  /** Basename of the `.cpuprofile` next to this metadata file, when profiled. */
  profileFile: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}\.cpuprofile$/)
    .optional(),
  profileBytes: z.number().int().nonnegative().optional(),
});
export type PerfCaptureMetadata = z.infer<typeof PerfCaptureMetadataSchema>;

const DURATION_RANGE_MESSAGE = `must be a whole number of milliseconds from ${PERF_CAPTURE_MIN_MANUAL_DURATION_MS} to ${PERF_CAPTURE_MAX_MANUAL_DURATION_MS}`;

export const perfCaptures = {
  list: {
    input: z.void(),
    /** `dir` is absolute; captures are newest first. */
    output: z.object({ dir: z.string(), captures: z.array(PerfCaptureMetadataSchema) }),
  },
  captureNow: {
    input: z.object({
      process: PerfCaptureProcessSchema,
      // Every failure names the allowed range, so CLI users see what to pass.
      durationMs: z
        .number({ error: DURATION_RANGE_MESSAGE })
        .int(DURATION_RANGE_MESSAGE)
        .min(PERF_CAPTURE_MIN_MANUAL_DURATION_MS, DURATION_RANGE_MESSAGE)
        .max(PERF_CAPTURE_MAX_MANUAL_DURATION_MS, DURATION_RANGE_MESSAGE)
        // `.optional()`, not `.nullish()`: `xum api` (trpc-cli) cannot parse an
        // integer|null option such as `--duration-ms 2000`.
        .optional(),
    }),
    output: PerfCaptureMetadataSchema,
  },
};
