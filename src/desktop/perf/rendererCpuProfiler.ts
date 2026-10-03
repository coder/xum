/**
 * Renderer CPU profiles for the perf flight recorder (experiment perfFlightRecorder, F2).
 *
 * The Electron main process profiles a renderer through `webContents.debugger` (CDP).
 * Each renderer page announces its flight recorder `rendererId` over preload IPC, so a
 * `long-animation-frame` trip profiles exactly the page that reported it.
 *
 * This module has no Electron imports so its logic stays unit-testable under bun.
 */

import { FLIGHT_RECORDER_MAX_RENDERER_ID_CHARS } from "@/constants/perfFlightRecorder";
import type { CpuProfiler, CpuProfilerStartResult } from "@/node/services/perf/perfCaptureService";

/** The part of Electron's `webContents.debugger` this profiler uses. */
export interface ProfilableDebugger {
  isAttached(): boolean;
  attach(protocolVersion: string): void;
  detach(): void;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: "detach", listener: () => void): unknown;
  removeListener(event: "detach", listener: () => void): unknown;
}

/** The part of Electron's `WebContents` this profiler uses. */
export interface ProfilableWebContents {
  readonly debugger: ProfilableDebugger;
  isDestroyed(): boolean;
  isDevToolsOpened(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
}

/** Announced pages kept at most (one per webContents). */
const MAX_RENDERER_TARGETS = 32;

/** Maps announced flight recorder rendererIds to the webContents that announced them. */
export class RendererTargetRegistry<T extends ProfilableWebContents = ProfilableWebContents> {
  private readonly targets = new Map<string, T>();
  private readonly watched = new WeakSet<T>();

  /** Callers must accept announcements only from trusted local main frames. */
  announce(rendererId: unknown, contents: T): void {
    if (
      typeof rendererId !== "string" ||
      rendererId.length === 0 ||
      rendererId.length > FLIGHT_RECORDER_MAX_RENDERER_ID_CHARS ||
      contents.isDestroyed()
    ) {
      return;
    }
    // A reload or renderer crash keeps the webContents but announces a new ID: the old
    // page is gone, so its ID must not resolve to the replacement document.
    for (const [id, target] of this.targets) {
      if (target === contents) this.targets.delete(id);
    }
    this.targets.set(rendererId, contents);
    while (this.targets.size > MAX_RENDERER_TARGETS) {
      const oldest = this.targets.keys().next().value;
      if (oldest === undefined) break;
      this.targets.delete(oldest);
    }
    if (!this.watched.has(contents)) {
      this.watched.add(contents);
      contents.once("destroyed", () => {
        for (const [id, target] of this.targets) {
          if (target === contents) this.targets.delete(id);
        }
      });
    }
  }

  get(rendererId: string): T | undefined {
    return this.targets.get(rendererId);
  }
}

/**
 * A hung renderer can leave a CDP command pending forever, which would hold the single
 * capture slot. Each command gets this long before the session is released.
 */
const RENDERER_COMMAND_TIMEOUT_MS = 10_000;

export interface RendererCpuProfilerOptions {
  registry: RendererTargetRegistry;
  /** Manual captures (no rendererId) profile the main window. */
  getMainWebContents(): ProfilableWebContents | null;
  commandTimeoutMs?: number;
}

export function createRendererCpuProfiler(options: RendererCpuProfilerOptions): CpuProfiler {
  return {
    async start({ samplingIntervalUs, rendererId }): Promise<CpuProfilerStartResult> {
      const contents =
        rendererId === undefined ? options.getMainWebContents() : options.registry.get(rendererId);
      // Unannounced IDs include browser tabs connected to this backend: they have no
      // webContents here.
      if (contents == null) {
        return {
          ok: false,
          skippedReason: rendererId === undefined ? "renderer-unavailable" : "renderer-unknown",
        };
      }
      if (contents.isDestroyed()) return { ok: false, skippedReason: "renderer-unavailable" };
      // Never take over a developer's DevTools or another debugger client.
      if (contents.isDevToolsOpened()) return { ok: false, skippedReason: "devtools-open" };
      const dbg = contents.debugger;
      if (dbg.isAttached()) return { ok: false, skippedReason: "debugger-attached" };

      dbg.attach("1.3");
      // Only a session this run attached, and that has not detached, is ever detached.
      let attached = true;
      const onDetach = () => {
        attached = false;
      };
      dbg.on("detach", onDetach);
      const release = () => {
        dbg.removeListener("detach", onDetach);
        if (!attached) return;
        attached = false;
        if (contents.isDestroyed()) return;
        try {
          dbg.detach();
        } catch {
          // Best effort: the renderer may be going away.
        }
      };

      const timeoutMs = options.commandTimeoutMs ?? RENDERER_COMMAND_TIMEOUT_MS;
      const command = async (method: string, params?: Record<string, unknown>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            dbg.sendCommand(method, params),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`${method} timed out after ${timeoutMs} ms`)),
                timeoutMs
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };

      try {
        await command("Profiler.enable");
        await command("Profiler.setSamplingInterval", { interval: samplingIntervalUs });
        await command("Profiler.start");
      } catch (error) {
        release();
        throw error;
      }

      let stopping: Promise<unknown> | null = null;
      const stop = async (): Promise<unknown> => {
        try {
          if (!attached) throw new Error("debugger detached during capture");
          const result = await command("Profiler.stop");
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
