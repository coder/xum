import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "@/common/utils/assert";
import {
  PERF_CAPTURE_ID_PATTERN,
  PerfCaptureMetadataSchema,
  type PerfCaptureKind,
  type PerfCaptureMetadata,
  type PerfCaptureProcess,
} from "@/common/orpc/schemas/perfCaptures";
import type { FlightRecorderTrip } from "@/common/orpc/schemas/perfFlightRecorder";
import { getErrorMessage } from "@/common/utils/errors";
import { perfEpochNowMs } from "@/common/utils/perf/clock";
import {
  PERF_CAPTURE_COOLDOWN_MS,
  PERF_CAPTURE_LABEL,
  PERF_CAPTURE_MANUAL_LABEL,
  PERF_CAPTURE_MAX_CAPTURES,
  PERF_CAPTURE_MAX_REASON_CHARS,
  PERF_CAPTURE_MAX_SKIPPED_RECORDS,
  PERF_CAPTURE_MAX_TOTAL_BYTES,
  PERF_CAPTURE_SAMPLING_INTERVAL_US,
  PERF_CAPTURE_STALE_TEMP_MS,
  PERF_CAPTURE_TRIP_DURATION_MS,
} from "@/constants/perfCaptures";
import { log } from "@/node/services/log";
import { ensurePrivateDir, isErrnoWithCode } from "@/node/utils/fs";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import { VERSION } from "@/version";
import type { FlightRecorder } from "./flightRecorder";

/** One profiling run. stop() and cancel() are idempotent and both release the session. */
export interface ProfilerRun {
  /** Ends profiling and resolves with the `.cpuprofile` JSON. */
  stop(): Promise<unknown>;
  cancel(): Promise<void>;
}

export type CpuProfilerStartResult =
  | { ok: true; run: ProfilerRun }
  | { ok: false; skippedReason: string };

export interface CpuProfiler {
  /** `rendererId` picks the renderer page; absent means the profiler's default target. */
  start(options: {
    samplingIntervalUs: number;
    rendererId?: string;
  }): Promise<CpuProfilerStartResult>;
}

export interface PerfCaptureServiceOptions {
  dir: string;
  recorder: Pick<FlightRecorder, "onTrip" | "noteSelfInducedBlock">;
  backendProfiler: CpuProfiler;
  /** Perf epoch ms: metadata timestamps and cooldowns. */
  now?: () => number;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  createId?: () => string;
}

interface CaptureSpec {
  kind: PerfCaptureKind;
  process: PerfCaptureProcess;
  trigger: FlightRecorderTrip | null;
  durationMs: number;
}

/** The files on disk that share one capture ID. */
interface CaptureGroup {
  id: string;
  files: string[];
  bytes: number;
  mtimeMs: number;
  profilePath?: string;
}

interface CaptureSlot {
  controller: AbortController;
  done: Promise<void>;
}

/** Why a capture request was refused. The router maps each refusal to an error code clients see. */
export type PerfCaptureRefusal = "experiment-off" | "in-progress" | "cancelled";

export class PerfCaptureRefusedError extends Error {
  constructor(
    readonly refusal: PerfCaptureRefusal,
    message: string
  ) {
    super(message);
    this.name = "PerfCaptureRefusedError";
  }
}

/** A capture being cancelled stops writing; disable and dispose do this. */
class CaptureCancelledError extends PerfCaptureRefusedError {
  constructor() {
    super("cancelled", "perf capture cancelled");
  }
}

/** dispose() waits this long for an in-flight capture to release its profiler (a hung renderer). */
const DISPOSE_WAIT_MS = 5000;

const FINAL_FILE_PATTERN = /^([A-Za-z0-9-]{1,64})\.(json|cpuprofile)$/;
// writeFileAtomic writes `<target>.<12 hex>` and renames it into place.
const TEMP_FILE_PATTERN = /^([A-Za-z0-9-]{1,64})\.(json|cpuprofile)\.[0-9a-f]{12}$/;

function defaultDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // A capture must never keep the process alive.
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Sortable and readable: `20261003T013338383Z-1a2b3c4d`. */
function defaultCreateId(): string {
  return `${new Date().toISOString().replace(/[^0-9TZ]/g, "")}-${randomBytes(4).toString("hex")}`;
}

/**
 * Triggered CPU profiles (experiment perfFlightRecorder, F2). After a flight recorder
 * trip it profiles the affected process for a few seconds and stores the profile under
 * `<xum home>/perf/captures`. The profile shows the activity AFTER the trigger, not the
 * stall that tripped it.
 *
 * Bounds: one capture in flight for the whole process (trips during a capture are
 * dropped), a cooldown per trip kind, and retention by count and bytes.
 */
export class PerfCaptureService {
  private readonly dir: string;
  private readonly recorder: PerfCaptureServiceOptions["recorder"];
  private readonly backendProfiler: CpuProfiler;
  private rendererProfiler: CpuProfiler | null = null;
  private readonly now: () => number;
  private readonly delay: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly createId: () => string;

  private enabled = false;
  private disposed = false;
  private unsubscribeTrip: (() => void) | null = null;
  private inFlight: CaptureSlot | null = null;
  private readonly lastTripCaptureAt = new Map<FlightRecorderTrip["kind"], number>();

  constructor(options: PerfCaptureServiceOptions) {
    this.dir = options.dir;
    this.recorder = options.recorder;
    this.backendProfiler = options.backendProfiler;
    this.now = options.now ?? perfEpochNowMs;
    this.delay = options.delay ?? defaultDelay;
    this.createId = options.createId ?? defaultCreateId;
  }

  /**
   * Follows the experiment. On: exactly one trip listener. Off: no listener at all and
   * any in-flight capture is cancelled (it writes nothing more).
   */
  setEnabled(enabled: boolean): void {
    if (this.disposed || enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.unsubscribeTrip = this.recorder.onTrip((trip) => this.handleTrip(trip));
      return;
    }
    this.unsubscribeTrip?.();
    this.unsubscribeTrip = null;
    this.inFlight?.controller.abort();
  }

  /** Desktop registers its Electron renderer profiler; `xum server` has none. */
  setRendererProfiler(profiler: CpuProfiler | null): void {
    this.rendererProfiler = profiler;
  }

  /** Manual capture (no cooldown). Rejects when the experiment is off or a capture runs. */
  captureNow(input: {
    process: PerfCaptureProcess;
    durationMs?: number;
  }): Promise<PerfCaptureMetadata> {
    if (!this.enabled || this.disposed) {
      return Promise.reject(
        new PerfCaptureRefusedError(
          "experiment-off",
          "perf captures need the perfFlightRecorder experiment"
        )
      );
    }
    if (this.inFlight !== null) {
      return Promise.reject(
        new PerfCaptureRefusedError("in-progress", "a perf capture is already in progress")
      );
    }
    return this.begin({
      kind: "manual",
      process: input.process,
      trigger: null,
      durationMs: input.durationMs ?? PERF_CAPTURE_TRIP_DURATION_MS,
    });
  }

  /** Completed captures (those with valid metadata), newest first. */
  async listCaptures(): Promise<{ dir: string; captures: PerfCaptureMetadata[] }> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT")) return { dir: this.dir, captures: [] };
      throw error;
    }
    const captures: PerfCaptureMetadata[] = [];
    const present = new Set(names);
    for (const name of names) {
      const match = FINAL_FILE_PATTERN.exec(name);
      if (match?.[2] !== "json") continue;
      const metadata = await this.readMetadata(match[1]);
      // A record whose profile was deleted would point readers at a missing file.
      if (metadata === null) continue;
      if (metadata.profileFile !== undefined && !present.has(metadata.profileFile)) continue;
      captures.push(metadata);
    }
    captures.sort((a, b) => b.startedAtMs - a.startedAtMs);
    return { dir: this.dir, captures };
  }

  /** Final: unsubscribes and cancels the in-flight capture, waiting for it to release its profiler. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.enabled = false;
    this.unsubscribeTrip?.();
    this.unsubscribeTrip = null;
    const slot = this.inFlight;
    if (slot === null) return;
    slot.controller.abort();
    const waitBound = new AbortController();
    await Promise.race([slot.done, this.delay(DISPOSE_WAIT_MS, waitBound.signal)]);
    waitBound.abort();
  }

  /** The capture's metadata, or null when `<id>.json` is missing, unreadable or invalid. */
  private async readMetadata(id: string): Promise<PerfCaptureMetadata | null> {
    try {
      const parsed = PerfCaptureMetadataSchema.safeParse(
        JSON.parse(await fs.readFile(path.join(this.dir, `${id}.json`), "utf8"))
      );
      if (!parsed.success || parsed.data.id !== id) return null;
      // A record that names another capture's profile would attribute it to this one.
      const profileFile = parsed.data.profileFile;
      return profileFile === undefined || profileFile === `${id}.cpuprofile` ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private handleTrip(trip: FlightRecorderTrip): void {
    let target: PerfCaptureProcess;
    switch (trip.kind) {
      case "loop-delay-p99":
        target = "backend";
        break;
      case "long-animation-frame":
        target = "renderer";
        break;
      case "slow-rpc":
        // Not profiled: a slow call is often I/O wait rather than CPU, and a profile
        // started after the call ended would not show it.
        return;
      default:
        // Other trip kinds (added by later recorder versions) are not profiled.
        return;
    }
    // Manual captures neither check nor set the per-kind cooldown. The backend profiler's
    // own start and stop blocks cannot trip the recorder (see profile()), so neither kind
    // of capture triggers the next one.
    if (!this.enabled || this.inFlight !== null) return;
    const nowMs = this.now();
    const last = this.lastTripCaptureAt.get(trip.kind);
    if (last !== undefined && nowMs - last < PERF_CAPTURE_COOLDOWN_MS) return;
    this.lastTripCaptureAt.set(trip.kind, nowMs);
    this.begin({
      kind: trip.kind,
      process: target,
      trigger: trip,
      durationMs: PERF_CAPTURE_TRIP_DURATION_MS,
    })
      .then((metadata) => {
        log.info("[perfCaptures] captured", {
          id: metadata.id,
          kind: metadata.kind,
          skippedReason: metadata.skippedReason,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof CaptureCancelledError) return;
        log.warn("[perfCaptures] capture failed", { error: getErrorMessage(error) });
      });
  }

  /** Reserves the single-flight slot synchronously; it is held until retention finishes. */
  private begin(spec: CaptureSpec): Promise<PerfCaptureMetadata> {
    assert(this.inFlight === null, "perf capture slot already taken");
    const slot: CaptureSlot = { controller: new AbortController(), done: Promise.resolve() };
    this.inFlight = slot;
    const result = this.capture(spec, slot);
    slot.done = result.then(
      () => undefined,
      () => undefined
    );
    return result.finally(() => {
      if (this.inFlight === slot) this.inFlight = null;
    });
  }

  private async capture(spec: CaptureSpec, slot: CaptureSlot): Promise<PerfCaptureMetadata> {
    const checkpoint = () => {
      if (slot.controller.signal.aborted) throw new CaptureCancelledError();
      assert(this.inFlight === slot, "perf capture lost its slot");
    };
    const id = this.createId();
    assert(PERF_CAPTURE_ID_PATTERN.test(id), `invalid perf capture id: ${id}`);
    const startedAtMs = this.now();
    const { profile, skippedReason } = await this.profile(spec, slot);
    checkpoint();
    const endedAtMs = this.now();

    await ensurePrivateDir(this.dir);
    checkpoint();
    let profileFile: string | undefined;
    let profileBytes: number | undefined;
    if (profile !== undefined) {
      const data = JSON.stringify(profile);
      profileFile = `${id}.cpuprofile`;
      profileBytes = Buffer.byteLength(data);
      await writeFileAtomic(path.join(this.dir, profileFile), data, { mode: 0o600 });
      checkpoint();
    }
    const metadata = PerfCaptureMetadataSchema.parse({
      version: 1,
      id,
      kind: spec.kind,
      process: spec.process,
      trigger: spec.trigger,
      startedAtMs,
      endedAtMs,
      samplingIntervalUs: PERF_CAPTURE_SAMPLING_INTERVAL_US,
      durationMs: spec.durationMs,
      xumVersion: String(VERSION.git_describe).slice(0, 200),
      platform: process.platform,
      // A manual capture has no trigger, so it is not labelled as the activity after one.
      label: spec.trigger === null ? PERF_CAPTURE_MANUAL_LABEL : PERF_CAPTURE_LABEL,
      skippedReason,
      profileFile,
      profileBytes,
    } satisfies PerfCaptureMetadata);
    // Written last: the metadata file marks the capture complete. Once it is in place
    // the capture is done, so a cancellation that lands now does not disown it.
    await writeFileAtomic(path.join(this.dir, `${id}.json`), JSON.stringify(metadata, null, 2), {
      mode: 0o600,
    });
    if (!slot.controller.signal.aborted) await this.prune();
    return metadata;
  }

  /**
   * Runs the profiler. A profiler failure becomes `skippedReason: "failed: ..."`;
   * cancellation throws. Every path releases the profiler session before returning.
   */
  private async profile(
    spec: CaptureSpec,
    slot: CaptureSlot
  ): Promise<{ profile?: unknown; skippedReason?: string }> {
    const signal = slot.controller.signal;
    const profiler = spec.process === "backend" ? this.backendProfiler : this.rendererProfiler;
    if (profiler === null) return { skippedReason: "renderer-profiling-unavailable" };
    const rendererId =
      spec.trigger?.kind === "long-animation-frame" ? spec.trigger.rendererId : undefined;
    // The in-process backend profiler blocks this event loop while V8 starts and stops
    // profiling (see createBackendCpuProfiler). The recorder learns where each block
    // ended, so the block cannot trip it and start another capture. The note runs as a
    // microtask right after the block, before the recorder's next sampling timer.
    // Renderer profiling runs in another process and does not block this loop, and a
    // skipped start (`ok: false`) did no profiling work.
    const ownBlock = <T>(step: Promise<T>, blocked: (value: T) => boolean = () => true) => {
      if (spec.process !== "backend") return step;
      const note = () => this.recorder.noteSelfInducedBlock(this.now());
      return step.then(
        (value) => {
          if (blocked(value)) note();
          return value;
        },
        (error: unknown) => {
          note();
          throw error;
        }
      );
    };
    let run: ProfilerRun | null = null;
    try {
      const started = await ownBlock(
        profiler.start({
          samplingIntervalUs: PERF_CAPTURE_SAMPLING_INTERVAL_US,
          ...(rendererId !== undefined ? { rendererId } : {}),
        }),
        (result) => result.ok
      );
      if (!started.ok) return { skippedReason: started.skippedReason };
      run = started.run;
      if (signal.aborted) throw new CaptureCancelledError();
      await this.delay(spec.durationMs, signal);
      if (signal.aborted) throw new CaptureCancelledError();
      return { profile: await ownBlock(run.stop()) };
    } catch (error) {
      if (run !== null) await ownBlock(run.cancel());
      if (error instanceof CaptureCancelledError || signal.aborted) {
        throw new CaptureCancelledError();
      }
      return {
        skippedReason: `failed: ${getErrorMessage(error)}`.slice(0, PERF_CAPTURE_MAX_REASON_CHARS),
      };
    }
  }

  /**
   * Keeps the newest PERF_CAPTURE_MAX_CAPTURES profiled captures within
   * PERF_CAPTURE_MAX_TOTAL_BYTES, and apart from them the newest
   * PERF_CAPTURE_MAX_SKIPPED_RECORDS metadata-only records. Only groups with valid
   * metadata (as in list) count, so unrelated or junk files never evict real captures.
   * Stale orphan profiles (an interrupted metadata write) and stale writeFileAtomic
   * temp files are removed.
   */
  private async prune(): Promise<void> {
    const groups = new Map<string, CaptureGroup>();
    const wallNowMs = Date.now();
    const isStale = (mtimeMs: number) => wallNowMs - mtimeMs > PERF_CAPTURE_STALE_TEMP_MS;
    for (const name of await fs.readdir(this.dir)) {
      const filePath = path.join(this.dir, name);
      const temp = TEMP_FILE_PATTERN.test(name);
      const match = FINAL_FILE_PATTERN.exec(name);
      if (!temp && match === null) continue;
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (temp) {
        if (isStale(stat.mtimeMs)) await removeFile(filePath);
        continue;
      }
      assert(match !== null, "perf capture file name must match");
      const id = match[1];
      const group = groups.get(id) ?? { id, files: [], bytes: 0, mtimeMs: 0 };
      group.files.push(filePath);
      group.bytes += stat.size;
      group.mtimeMs = Math.max(group.mtimeMs, stat.mtimeMs);
      if (match[2] === "cpuprofile") group.profilePath = filePath;
      groups.set(id, group);
    }
    const profiled: CaptureGroup[] = [];
    const skipped: CaptureGroup[] = [];
    for (const group of groups.values()) {
      const metadata = await this.readMetadata(group.id);
      if (metadata === null) {
        // A fresh orphan may be another process's capture between its two writes.
        if (group.profilePath !== undefined && isStale(group.mtimeMs)) {
          await removeFile(group.profilePath);
        }
        continue;
      }
      // A record whose profile file is gone holds no profile: it ages out with the
      // metadata-only records instead of displacing intact captures.
      const hasProfile =
        metadata.profileFile !== undefined &&
        group.profilePath === path.join(this.dir, metadata.profileFile);
      if (!hasProfile && group.profilePath !== undefined) {
        // Metadata is written after its profile and always names it, so a same-ID
        // profile the metadata does not claim is a corrupt leftover outside every bound.
        await removeFile(group.profilePath);
      }
      (hasProfile ? profiled : skipped).push(group);
    }
    await keepNewest(
      profiled,
      (count, bytes) => count <= PERF_CAPTURE_MAX_CAPTURES && bytes <= PERF_CAPTURE_MAX_TOTAL_BYTES
    );
    await keepNewest(skipped, (count) => count <= PERF_CAPTURE_MAX_SKIPPED_RECORDS);
  }
}

/** Removes every group past the first (newest-first) one outside `withinBounds`. */
async function keepNewest(
  groups: CaptureGroup[],
  withinBounds: (count: number, bytes: number) => boolean
): Promise<void> {
  // Newest first; generated IDs start with a timestamp, so they break mtime ties.
  groups.sort((a, b) => b.mtimeMs - a.mtimeMs || b.id.localeCompare(a.id));
  let keptBytes = 0;
  let keeping = true;
  for (const [index, group] of groups.entries()) {
    keptBytes += group.bytes;
    // Once one group falls outside the bounds, every older group goes too.
    keeping &&= withinBounds(index + 1, keptBytes);
    if (keeping) continue;
    for (const filePath of group.files) await removeFile(filePath);
  }
}

async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isErrnoWithCode(error, "ENOENT")) {
      log.warn("[perfCaptures] could not remove file", { error: getErrorMessage(error) });
    }
  }
}
