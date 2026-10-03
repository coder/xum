import { useEffect } from "react";
import { useAPI } from "@/browser/contexts/API";
import { usePerfFlightRecorderCollecting } from "@/browser/contexts/ExperimentsContext";
import { startRendererFlightRecorder } from "@/browser/utils/perf/rendererFlightRecorder";

/**
 * Runs the renderer side of the perf flight recorder while the backend recorder
 * collects. Following backend status (not this page's stored flag) keeps both
 * sides in step when the experiment changes through the CLI or another client.
 * Off creates no observers, timers or recorder IPC. Renders nothing.
 */
export function PerfFlightRecorder(): null {
  const collecting = usePerfFlightRecorderCollecting();
  const { api } = useAPI();

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
