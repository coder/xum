import { Session, url as nodeInspectorUrl } from "node:inspector/promises";
import type { CpuProfiler, CpuProfilerStartResult } from "./perfCaptureService";

/** The part of a node:inspector/promises Session this profiler uses. */
export interface InspectorSessionLike {
  connect(): void;
  post(method: string, params?: Record<string, unknown>): Promise<unknown>;
  disconnect(): void;
}

export interface BackendCpuProfilerDeps {
  createSession(): InspectorSessionLike;
  /** node:inspector `url()`: defined while an inspector endpoint is exposed (--inspect, inspector.open). */
  inspectorUrl(): string | undefined;
}

const nodeDeps: BackendCpuProfilerDeps = {
  createSession: () => new Session(),
  inspectorUrl: () => nodeInspectorUrl(),
};

/**
 * Profiles this process's main thread through an in-process node:inspector Session.
 * It never pauses the debugger and never connects to another thread.
 *
 * Cost: both calls run on the main thread and block the event loop.
 * - `Profiler.start` is the large block. V8 logs every existing code object first, so the
 *   cost grows with the heap and the amount of compiled code, not with the sampling
 *   interval or the duration. Measured: about 150-250 ms on a fresh `xum server`, 0.4-0.76 s
 *   on a long-running desktop backend, up to 1.7 s on a loaded host. The profile's first
 *   `timeDeltas` entry is this block (attributed to the inspector `post` call), so
 *   analyzers that rank `post` self time are measuring the start, not the stop.
 * - `Profiler.stop` serializes the profile and node:inspector parses it: about 15 ms for a
 *   450 KB profile, nearly the same at a 5 ms interval or a 4 s duration.
 * PerfCaptureService reports both blocks to the flight recorder so they cannot trip it.
 */
export function createBackendCpuProfiler(deps: BackendCpuProfilerDeps = nodeDeps): CpuProfiler {
  return {
    async start({ samplingIntervalUs }): Promise<CpuProfilerStartResult> {
      // Do not interfere with a developer's debugger. Limit: url() only says an inspector
      // endpoint is exposed, not whether a client is attached, and its absence does not prove
      // that no other in-process Session exists. Node has no "client attached" API, so this is
      // a conservative check, not complete attachment detection.
      if (deps.inspectorUrl() !== undefined) return { ok: false, skippedReason: "inspector-open" };

      const session = deps.createSession();
      let connected = false;
      const release = () => {
        if (!connected) return;
        connected = false;
        try {
          session.disconnect();
        } catch {
          // Best effort: disconnecting also ends this session's profiling.
        }
      };

      try {
        session.connect();
        connected = true;
        await session.post("Profiler.enable");
        await session.post("Profiler.setSamplingInterval", { interval: samplingIntervalUs });
        await session.post("Profiler.start");
      } catch (error) {
        release();
        throw error;
      }

      let stopping: Promise<unknown> | null = null;
      const stop = async (): Promise<unknown> => {
        try {
          if (!connected) throw new Error("profiler session already released");
          const result = await session.post("Profiler.stop");
          await session.post("Profiler.disable");
          if (typeof result !== "object" || result === null || !("profile" in result)) {
            throw new Error("Profiler.stop returned no profile");
          }
          return result.profile;
        } finally {
          release();
        }
      };
      return {
        ok: true,
        run: {
          stop: () => (stopping ??= stop()),
          cancel: () => {
            release();
            return Promise.resolve();
          },
        },
      };
    },
  };
}
