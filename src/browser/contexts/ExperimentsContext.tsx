import React, {
  createContext,
  useContext,
  useSyncExternalStore,
  useCallback,
  useEffect,
  useState,
  useRef,
} from "react";
import {
  type ExperimentId,
  EXPERIMENT_IDS,
  EXPERIMENTS,
  getExperimentKey,
  isExperimentSupportedOnPlatform,
} from "@/common/constants/experiments";
import { getStorageChangeEvent } from "@/common/constants/events";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { useAPI } from "@/browser/contexts/API";

/**
 * Subscribe to experiment changes for a specific experiment ID.
 * Uses localStorage + custom events for cross-component sync.
 */
function subscribeToExperiment(experimentId: ExperimentId, callback: () => void): () => void {
  const key = getExperimentKey(experimentId);
  const storageChangeEvent = getStorageChangeEvent(key);

  const handleChange = () => callback();

  // Listen to both storage events (cross-tab) and custom events (same-tab)
  window.addEventListener("storage", handleChange);
  window.addEventListener(storageChangeEvent, handleChange);

  return () => {
    window.removeEventListener("storage", handleChange);
    window.removeEventListener(storageChangeEvent, handleChange);
  };
}

function isCompactionExperiment(experimentId: ExperimentId): boolean {
  return (
    experimentId === EXPERIMENT_IDS.CONTINUOUS_COMPACTION ||
    experimentId === EXPERIMENT_IDS.TOKEN_BUDGET
  );
}

function getCurrentDesktopPlatform(): NodeJS.Platform | undefined {
  return window.api?.platform;
}

function isExperimentSupported(experimentId: ExperimentId): boolean {
  return isExperimentSupportedOnPlatform(experimentId, getCurrentDesktopPlatform());
}

/**
 * Get explicit localStorage override for an experiment.
 * Returns undefined if no value is set or parsing fails.
 */
function getExperimentOverrideSnapshot(experimentId: ExperimentId): boolean | undefined {
  const parsed = readPersistedState<unknown>(getExperimentKey(experimentId), undefined);
  return typeof parsed === "boolean" ? parsed : undefined;
}

/**
 * Experiments whose value only an ordered backend stream sets. Browser storage
 * is origin-scoped and can be stale (another origin, the CLI, or another process
 * changed the backend), so these are never read from it.
 */
function isStreamOwnedExperiment(experimentId: ExperimentId): boolean {
  return (
    experimentId === EXPERIMENT_IDS.CLAUDE_DESIGN_MCP ||
    experimentId === EXPERIMENT_IDS.PERF_FLIGHT_RECORDER
  );
}

/** Keeps the stream-owned values across reads that must not overwrite them. */
function keepStreamOwnedOverrides(
  previous: Partial<Record<ExperimentId, boolean>> | null
): Partial<Record<ExperimentId, boolean>> {
  return {
    [EXPERIMENT_IDS.CLAUDE_DESIGN_MCP]: previous?.[EXPERIMENT_IDS.CLAUDE_DESIGN_MCP],
    [EXPERIMENT_IDS.PERF_FLIGHT_RECORDER]: previous?.[EXPERIMENT_IDS.PERF_FLIGHT_RECORDER],
  };
}

/**
 * Set experiment state to localStorage and dispatch sync event.
 */
function setExperimentState(experimentId: ExperimentId, enabled: boolean): void {
  if (!isExperimentSupported(experimentId)) {
    return;
  }

  const key = getExperimentKey(experimentId);

  try {
    // Also dispatches the same-tab storage-change event subscribeToExperiment listens to.
    updatePersistedState(key, enabled);
  } catch (error) {
    console.warn(`Error writing experiment state for "${experimentId}":`, error);
  }
}

/**
 * Context value type - provides setter function.
 * Individual experiment values are accessed via useExperimentValue hook.
 */
interface ExperimentsContextValue {
  designRevision: number;
  setExperiment: (experimentId: ExperimentId, enabled: boolean) => void;
  backendOverrides: Partial<Record<ExperimentId, boolean>> | null;
  /** True once this connection's backend override read succeeded (see useSettledExperimentValue). */
  backendOverridesLoaded: boolean;
  /** Whether the backend perf flight recorder is collecting (renderer collects only then). */
  perfFlightRecorderCollecting: boolean;
}

const ExperimentsContext = createContext<ExperimentsContextValue | null>(null);

/**
 * Provider component for experiments.
 * Must wrap the app to enable useExperimentValue hook.
 */
export function ExperimentsProvider(props: { children: React.ReactNode }) {
  const apiState = useAPI();
  const [designRevision, setDesignRevision] = useState(0);
  const [backendOverrides, setBackendOverrides] = useState<Partial<
    Record<ExperimentId, boolean>
  > | null>(null);
  const [backendOverridesLoaded, setBackendOverridesLoaded] = useState(false);
  const [perfFlightRecorderCollecting, setPerfFlightRecorderCollecting] = useState(false);

  // The strategy is stored as two legacy flags. Order their actual writes so rapid choices cannot persist a stale pair. Provider ownership
  // keeps the queue alive when Settings closes; this is not a cross-client transaction.
  const compactionWrites = useRef(Promise.resolve(true));
  const persistOverride = useCallback(
    (experimentId: ExperimentId, enabled: boolean) => {
      const persist = async () => {
        // A degraded (slow) connection still has a usable api; only a missing api means offline.
        if (!apiState.api) {
          return false;
        }

        try {
          await apiState.api.experiments.set({ experimentId, enabled });
          return true;
        } catch {
          return false;
        }
      };
      if (isCompactionExperiment(experimentId)) {
        compactionWrites.current = compactionWrites.current.then(persist);
        return compactionWrites.current;
      }
      return persist();
    },
    [apiState.api]
  );

  const designTogglePending = useRef(false);

  const setExperiment = useCallback(
    (experimentId: ExperimentId, enabled: boolean) => {
      const publish = () => {
        setExperimentState(experimentId, enabled);
        setBackendOverrides((prev) => ({ ...prev, [experimentId]: enabled }));
      };
      if (experimentId === EXPERIMENT_IDS.CLAUDE_DESIGN_MCP) {
        // Hiding credential controls must follow backend shutdown, even offline or
        // when a write fails. Serialize toggles so late acknowledgements cannot undo one.
        if (designTogglePending.current) return;
        designTogglePending.current = true;
        // The ordered backend stream owns Design state. An acknowledgement/read
        // can already be stale when it reaches this renderer after a sibling toggle.
        persistOverride(experimentId, enabled)
          .finally(() => {
            designTogglePending.current = false;
          })
          .catch(() => undefined);
        return;
      }
      if (experimentId === EXPERIMENT_IDS.PERF_FLIGHT_RECORDER) {
        // The backend status stream publishes the adopted value, so a failed
        // write cannot leave this renderer showing a state the backend lacks.
        persistOverride(experimentId, enabled).catch(() => undefined);
        return;
      }
      // Publish only acknowledged writes: nothing re-uploads a failed one, so a value shown
      // before it failed would never reach the backend that runs the turns.
      persistOverride(experimentId, enabled)
        .then((saved) => {
          if (saved) publish();
        })
        .catch(() => undefined);
    },
    [persistOverride]
  );

  useEffect(() => {
    if (!apiState.api) {
      setBackendOverrides((previous) => (previous ? keepStreamOwnedOverrides(previous) : null));
      setBackendOverridesLoaded(false);
      setPerfFlightRecorderCollecting(false);
      return;
    }

    const api = apiState.api;
    const controller = new AbortController();
    let cancelled = false;

    const loadOverrides = async () => {
      try {
        const overrides = await api.experiments.getOverrides();
        if (!cancelled) {
          setBackendOverrides((previous) => ({
            ...overrides,
            ...keepStreamOwnedOverrides(previous),
          }));
          setBackendOverridesLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setBackendOverrides((previous) => (previous ? keepStreamOwnedOverrides(previous) : null));
        }
      }
    };

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
          setBackendOverrides((previous) => ({
            ...previous,
            [EXPERIMENT_IDS.CLAUDE_DESIGN_MCP]: snapshot.enabled,
          }));
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
          setBackendOverrides((previous) => ({
            ...previous,
            [EXPERIMENT_IDS.PERF_FLIGHT_RECORDER]: status.enabled,
          }));
          setPerfFlightRecorderCollecting(status.state === "collecting");
        }
      } catch {
        // Fall through: without the authoritative status the renderer must not collect.
      }
      if (!cancelled) setPerfFlightRecorderCollecting(false);
    };
    loadOverrides().catch(() => undefined);
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
        backendOverrides,
        backendOverridesLoaded,
        designRevision,
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

/**
 * Hook to get a single experiment's enabled state with reactive updates.
 * Uses useSyncExternalStore for efficient, selective re-renders.
 * Only re-renders when THIS specific experiment changes.
 *
 * @param experimentId - The experiment to subscribe to
 * @returns Whether the experiment is enabled
 */
export function useExperimentValue(experimentId: ExperimentId): boolean {
  const subscribe = useCallback(
    (callback: () => void) => subscribeToExperiment(experimentId, callback),
    [experimentId]
  );

  const getSnapshot = useCallback(
    () => getExperimentOverrideSnapshot(experimentId),
    [experimentId]
  );

  const localOverride = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const context = useContext(ExperimentsContext);

  if (!isExperimentSupported(experimentId)) {
    return false;
  }

  // Design consent is backend-authoritative: stale browser storage must never
  // re-enable it on reconnect or override a confirmed backend disable.
  if (experimentId === EXPERIMENT_IDS.CLAUDE_DESIGN_MCP)
    return context?.backendOverrides?.[experimentId] ?? false;

  // The flight recorder follows the backend status stream; stale browser storage
  // must not show a state the backend does not have.
  if (experimentId === EXPERIMENT_IDS.PERF_FLIGHT_RECORDER)
    return context?.backendOverrides?.[experimentId] ?? EXPERIMENTS[experimentId].enabledByDefault;

  // An explicit local toggle wins, which also settles the race against an in-flight
  // backend read: a toggle made while it loads is not overwritten when it resolves.
  if (localOverride !== undefined) {
    return localOverride;
  }

  return context?.backendOverrides?.[experimentId] ?? EXPERIMENTS[experimentId].enabledByDefault;
}

/**
 * useExperimentValue, or null while that value is still provisional: no explicit local override
 * decides it and the backend overrides have not loaded (first render, offline, or a failed read).
 * Code that rewrites persisted state from a flag (the right-sidebar tab sync) must wait on null:
 * acting on the provisional default and then on the loaded value removed a saved Artifacts tab
 * and re-added it at the end without its selection on every reload.
 */
export function useSettledExperimentValue(experimentId: ExperimentId): boolean | null {
  const value = useExperimentValue(experimentId);
  const localOverride = useExperimentOverrideValue(experimentId);
  const context = useContext(ExperimentsContext);
  // Without a provider there is no backend to wait for, and unsupported experiments are always off.
  if (context == null || !isExperimentSupported(experimentId)) {
    return value;
  }
  // useExperimentValue lets an explicit local toggle win, except for stream-owned experiments.
  if (localOverride !== undefined && !isStreamOwnedExperiment(experimentId)) {
    return value;
  }
  return context.backendOverridesLoaded ? value : null;
}

/**
 * Hook to read only an explicit local override for an experiment.
 *
 * Returns `undefined` when the user has not explicitly set a value in localStorage,
 * which lets send options distinguish "user chose off" from "user never chose".
 */
export function useExperimentOverrideValue(experimentId: ExperimentId): boolean | undefined {
  const isSupported = isExperimentSupported(experimentId);
  const subscribe = useCallback(
    (callback: () => void) => subscribeToExperiment(experimentId, callback),
    [experimentId]
  );

  const getSnapshot = useCallback(
    () => getExperimentOverrideSnapshot(experimentId),
    [experimentId]
  );

  const override = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!isSupported) {
    return undefined;
  }

  return override;
}

/**
 * Hook to get setter function for experiments.
 * Use this in components that need to toggle experiments (e.g., Settings).
 *
 * @returns Function to set experiment state
 */

export function useSetExperiment(): (experimentId: ExperimentId, enabled: boolean) => void {
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
export function useExperiment(experimentId: ExperimentId): [boolean, (enabled: boolean) => void] {
  const enabled = useExperimentValue(experimentId);
  const setExperiment = useSetExperiment();

  const setEnabled = useCallback(
    (value: boolean) => setExperiment(experimentId, value),
    [setExperiment, experimentId]
  );

  return [enabled, setEnabled];
}
