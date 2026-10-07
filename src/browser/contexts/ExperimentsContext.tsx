import React, { createContext, useContext, useSyncExternalStore, useEffect, useState } from "react";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { useAPI } from "@/browser/contexts/API";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";

interface ExperimentsContextValue {
  designRevision: number;
  /** Claude Design enablement as the ordered Design stream reports it. */
  designEnabled: boolean;
  setExperiment: (experimentId: ExperimentId, enabled: boolean) => Promise<void>;
  /** Whether the backend perf flight recorder is collecting (renderer collects only then). */
  perfFlightRecorderCollecting: boolean;
}

const ExperimentsContext = createContext<ExperimentsContextValue | null>(null);

/**
 * Provider for experiment writes and backend status streams. Experiment values come only from
 * the AppConfigStore snapshot, which refetches after every backend experiment write.
 */
export function ExperimentsProvider(props: { children: React.ReactNode }) {
  const apiState = useAPI();
  const [designRevision, setDesignRevision] = useState(0);
  const [designEnabled, setDesignEnabled] = useState(false);
  const [perfFlightRecorderCollecting, setPerfFlightRecorderCollecting] = useState(false);

  // No optimistic state: the toggle shows the next config snapshot after the backend write.
  const setExperiment = async (experimentId: ExperimentId, enabled: boolean) => {
    if (!apiState.api) throw new Error("Not connected to the backend");
    await apiState.api.experiments.set({ experimentId, enabled });
    await getAppConfigStore().refresh();
  };

  useEffect(() => {
    if (!apiState.api) {
      setPerfFlightRecorderCollecting(false);
      return;
    }

    const api = apiState.api;
    const controller = new AbortController();
    let cancelled = false;

    const followDesign = async () => {
      let revision = -1;
      try {
        const stream = await api.experiments.onDesignChange(undefined, {
          signal: controller.signal,
        });
        for await (const snapshot of stream) {
          if (cancelled) break;
          if (snapshot.revision < revision) continue;
          revision = snapshot.revision;
          setDesignRevision(snapshot.revision);
          setDesignEnabled(snapshot.enabled);
        }
      } catch {
        // Keep credential controls accessible on a lost connection; reconnect
        // establishes a fresh subscription and revision domain.
      }
    };
    // The perf flight recorder follows backend status, so a toggle made through the
    // CLI or another client starts or stops this renderer's collection live.
    const followPerfFlightRecorder = async () => {
      try {
        const stream = await api.experiments.onPerfFlightRecorderChange(undefined, {
          signal: controller.signal,
        });
        for await (const status of stream) {
          if (cancelled) break;
          setPerfFlightRecorderCollecting(status.state === "collecting");
        }
      } catch {
        // Fall through: without the authoritative status the renderer must not collect.
      }
      if (!cancelled) setPerfFlightRecorderCollecting(false);
    };
    followDesign().catch(() => undefined);
    followPerfFlightRecorder().catch(() => undefined);

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiState.api]);

  return (
    <ExperimentsContext.Provider
      value={{
        setExperiment,
        designRevision,
        designEnabled,
        perfFlightRecorderCollecting,
      }}
    >
      {props.children}
    </ExperimentsContext.Provider>
  );
}

/** True while the backend perf flight recorder collects; the renderer side follows it. */
export function usePerfFlightRecorderCollecting(): boolean {
  return useContext(ExperimentsContext)?.perfFlightRecorderCollecting ?? false;
}

/** Settings revisions also cover sibling Disconnect, source, and allowlist changes. */
export function useClaudeDesignRevision(): number {
  return useContext(ExperimentsContext)?.designRevision ?? 0;
}

/** The backend value of one experiment from the AppConfigStore snapshot (off until it loads). */
export function useExperimentValue(experimentId: ExperimentId): boolean {
  const store = getAppConfigStore();
  const designEnabled = useContext(ExperimentsContext)?.designEnabled === true;
  const enabled = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot()?.experiments?.[experimentId] === true
  );
  // Credential controls may hide only after the backend retired affected clients, which the
  // ordered Design stream reports; the config snapshot can arrive first.
  return experimentId === EXPERIMENT_IDS.CLAUDE_DESIGN_MCP ? designEnabled : enabled;
}

/**
 * useExperimentValue, or null until the first config snapshot with experiments arrives. Code that
 * rewrites persisted state from a flag (the right-sidebar tab sync) must wait on null: acting on
 * the provisional default and then on the loaded value removed a saved Artifacts tab and re-added
 * it at the end without its selection on every reload.
 */
export function useSettledExperimentValue(experimentId: ExperimentId): boolean | null {
  const store = getAppConfigStore();
  return useSyncExternalStore(store.subscribe, () => {
    const experiments = store.getSnapshot()?.experiments;
    return experiments ? experiments[experimentId] === true : null;
  });
}

/**
 * Hook to get setter function for experiments.
 * Use this in components that need to toggle experiments (e.g., Settings).
 *
 * @returns Function to set experiment state
 */

export function useSetExperiment(): (
  experimentId: ExperimentId,
  enabled: boolean
) => Promise<void> {
  const context = useContext(ExperimentsContext);
  if (!context) {
    throw new Error("useSetExperiment must be used within ExperimentsProvider");
  }
  return context.setExperiment;
}

/**
 * Hook to get both value and setter for an experiment.
 * Combines useExperimentValue and useSetExperiment for convenience.
 *
 * @param experimentId - The experiment to subscribe to
 * @returns [enabled, setEnabled] tuple
 */
export function useExperiment(
  experimentId: ExperimentId
): [boolean, (enabled: boolean) => Promise<void>] {
  const enabled = useExperimentValue(experimentId);
  const setExperiment = useSetExperiment();
  return [enabled, (value: boolean) => setExperiment(experimentId, value)];
}
