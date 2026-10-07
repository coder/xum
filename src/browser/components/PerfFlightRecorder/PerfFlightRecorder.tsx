import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { startRendererFlightRecorder } from "@/browser/utils/perf/rendererFlightRecorder";

/**
 * Runs the renderer side of the perf flight recorder while the backend recorder
 * collects. Following backend status (not this page's stored flag) keeps both
 * sides in step when the experiment changes through the CLI or another client.
 * Off creates no observers, timers or recorder IPC. Renders nothing.
 */
export function PerfFlightRecorder(): null {
  const { api } = useAPI();
  const [collecting, setCollecting] = useState(false);

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
          setCollecting(status.state === "collecting");
        }
      } catch {
        // Fall through: without the authoritative status the renderer must not collect.
      }
      if (!controller.signal.aborted) setCollecting(false);
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
