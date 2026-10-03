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
 * Cost: `Profiler.start` runs on the main thread and blocks the event loop while V8
 * prepares the profile. UAT measured about 150 ms on a quiet host and up to 1.7 s on a
 * loaded one. The profile's first `timeDeltas` entry shows this pause (attributed to the
 * inspector `post` call), and the pause can itself trip the loop-delay detector. Single
 * flight and the per-kind trip cooldown bound how often that feeds back into a capture.
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
