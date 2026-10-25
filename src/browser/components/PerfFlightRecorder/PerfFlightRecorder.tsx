import { useEffect, useState } from "react";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import { startRendererFlightRecorder } from "@/browser/utils/perf/rendererFlightRecorder";

/**
 * Runs the renderer side of the perf flight recorder while the backend recorder
 * collects. Following backend status (not this page's stored flag) keeps both
 * sides in step when the experiment changes through the CLI or another client.
 * Off creates no observers, timers or recorder IPC. Renders nothing.
 */
export function PerfFlightRecorder(): null {
  const { api } = useAPI();
  // Set only by a client's own stream, so a reconnected client waits for its status.
  const [collectingApi, setCollectingApi] = useState<APIClient | null>(null);
  const collecting = api !== null && collectingApi === api;

  // External-system subscription (backend status stream): a valid effect.
  useEffect(() => {
    if (api === null) return;
    const controller = new AbortController();
    const follow = async () => {
      try {
        const stream = await api.experiments.onPerfFlightRecorderChange(undefined, {
          signal: controller.signal,
        });
        for await (const status of stream) {
          if (controller.signal.aborted) break;
          // The oRPC client is a callable proxy, which React would invoke as an updater.
          setCollectingApi(() => (status.state === "collecting" ? api : null));
        }
      } catch {
        // Fall through: without the authoritative status the renderer must not collect.
      }
      if (!controller.signal.aborted) setCollectingApi(null);
    };
    follow().catch(() => undefined);
    return () => controller.abort();
  }, [api]);

  // External-system subscription (PerformanceObserver + push timer): a valid effect.
  useEffect(() => {
    if (!collecting || api === null) return;
    return startRendererFlightRecorder({
      push: (batch) => api.perf.pushRendererFlightRecorderBatch(batch),
      // Electron only: lets the main process profile this page after a long-frame trip.
      announceRendererId: window.api?.announcePerfRendererId,
    });
  }, [collecting, api]);

  return null;
}
