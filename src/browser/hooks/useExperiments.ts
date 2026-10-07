import { useSyncExternalStore } from "react";
import type { ExperimentId } from "@/common/constants/experiments";
import { useAPI } from "@/browser/contexts/API";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";

/** The backend value of one experiment from the AppConfigStore snapshot (off until it loads). */
export function useExperimentValue(experimentId: ExperimentId): boolean {
  const store = getAppConfigStore();
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot()?.experiments?.[experimentId] === true
  );
}

/** Value and backend setter for one experiment, for Settings toggles. */
export function useExperiment(
  experimentId: ExperimentId
): [boolean, (enabled: boolean) => Promise<void>] {
  const enabled = useExperimentValue(experimentId);
  const { api } = useAPI();
  // No optimistic state: the toggle shows the next config snapshot after the backend write.
  const setEnabled = async (value: boolean) => {
    if (!api) throw new Error("Not connected to the backend");
    await api.experiments.set({ experimentId, enabled: value });
  };
  return [enabled, setEnabled];
}
