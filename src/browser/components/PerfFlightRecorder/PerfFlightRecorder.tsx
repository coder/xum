import { useEffect } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useExperimentValue } from "@/browser/hooks/useExperiments";
import { startRendererFlightRecorder } from "@/browser/utils/perf/rendererFlightRecorder";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";

/**
 * Runs the renderer side of the perf flight recorder while the experiment is on.
 * Off creates no observers, timers or recorder IPC. Renders nothing.
 */
export function PerfFlightRecorder(): null {
  const enabled = useExperimentValue(EXPERIMENT_IDS.PERF_FLIGHT_RECORDER);
  const { api } = useAPI();

  // External-system subscription (PerformanceObserver + push timer): a valid effect.
  useEffect(() => {
    if (!enabled || api === null) return;
    return startRendererFlightRecorder({
      push: (batch) => api.perf.pushRendererFlightRecorderBatch(batch),
    });
  }, [enabled, api]);

  return null;
}
