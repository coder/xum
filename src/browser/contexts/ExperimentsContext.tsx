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
  EXPERIMENTS_BACKEND_AUTHORITATIVE_KEY,
  getExperimentKey,
  getLegacyPtcExclusiveExperimentKey,
  isExperimentSupportedOnPlatform,
} from "@/common/constants/experiments";
import { getStorageChangeEvent } from "@/common/constants/events";
import {
  readPersistedState,
  syncPersistedStateFromBackend,
  updatePersistedState,
} from "@/browser/hooks/usePersistedState";
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
 * Upgrade alias (see LEGACY_PTC_EXCLUSIVE_EXPERIMENT_ID): a stored legacy
 * exclusive `true` opted into exactly the posture merged PTC activates, so PTC
 * reads as enabled — winning even over an explicit supplement-off value,
 * matching the backend read alias. setExperimentState rewrites the legacy key
 * on every PTC toggle, so the alias never overrides a choice made in this
 * build.
 */
export function hasLegacyPtcExclusiveOverride(): boolean {
  return readPersistedState<unknown>(getLegacyPtcExclusiveExperimentKey(), undefined) === true;
}

/**
 * Get explicit localStorage override for an experiment.
 * Returns undefined if no value is set or parsing fails.
 */
function getExperimentOverrideSnapshot(experimentId: ExperimentId): boolean | undefined {
  if (
    experimentId === EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING &&
    hasLegacyPtcExclusiveOverride()
  ) {
    return true;
  }

  const key = getExperimentKey(experimentId);

  try {
    const stored = window.localStorage.getItem(key);
    // Check for literal "undefined" string defensively - this can occur if
    // JSON.stringify(undefined) is accidentally stored (it returns "undefined")
    if (stored === null || stored === "undefined") {
      return undefined;
    }

    const parsed = JSON.parse(stored) as unknown;
    return typeof parsed === "boolean" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function getExplicitLocalExperimentOverrides(): Partial<Record<ExperimentId, boolean>> {
  const overrides: Partial<Record<ExperimentId, boolean>> = {};

  for (const experimentId of Object.keys(EXPERIMENTS) as ExperimentId[]) {
    if (experimentId === EXPERIMENT_IDS.CLAUDE_DESIGN_MCP || !isExperimentSupported(experimentId)) {
      continue;
    }

    const override = getExperimentOverrideSnapshot(experimentId);
    if (override === undefined) {
      continue;
    }

    overrides[experimentId] = override;
  }

  return overrides;
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
    window.localStorage.setItem(key, JSON.stringify(enabled));

    // Downgrade sync (see LEGACY_PTC_EXCLUSIVE_EXPERIMENT_ID): a downgraded
    // renderer reads the pre-merge exclusive key as an explicit override that
    // wins over the mirrored backend value in its send options, so a stale
    // entry would resurrect supplement mode (stale false) or re-enable PTC
    // after the user turned it off (stale true). Keep it equal to PTC.
    // Routed through updatePersistedState so the mirror participates in the
    // shared write-listener/subscriber notification path like other
    // persisted preferences.
    if (experimentId === EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING) {
      updatePersistedState(getLegacyPtcExclusiveExperimentKey(), enabled);
    }

    // Dispatch custom event for same-tab synchronization
    const customEvent = new CustomEvent(getStorageChangeEvent(key), {
      detail: { key, newValue: enabled },
    });
    window.dispatchEvent(customEvent);
  } catch (error) {
    console.warn(`Error writing experiment state for "${experimentId}":`, error);
  }
}

/**
 * Rewrites an experiment's localStorage mirror to the backend's override (undefined: none).
 * Goes through the backend-sourced write path so listeners do not treat it as a local choice,
 * and keeps the legacy exclusive mirror equal to PTC as setExperimentState does.
 */
function syncExperimentStateFromBackend(
  experimentId: ExperimentId,
  enabled: boolean | undefined
): void {
  if (getExperimentOverrideSnapshot(experimentId) === enabled) return;
  syncPersistedStateFromBackend(getExperimentKey(experimentId), enabled);
  if (experimentId === EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING) {
    syncPersistedStateFromBackend(getLegacyPtcExclusiveExperimentKey(), enabled);
  }
}

/** A local choice, compared by identity so only the latest one clears its pending entry. */
interface ExperimentChoice {
  enabled: boolean;
}

function persistChoice(
  pending: Map<ExperimentId, ExperimentChoice>,
  persist: (experimentId: ExperimentId, enabled: boolean) => Promise<boolean>,
  experimentId: ExperimentId,
  choice: ExperimentChoice
): Promise<boolean> {
  return persist(experimentId, choice.enabled).then((persisted) => {
    if (persisted && pending.get(experimentId) === choice) pending.delete(experimentId);
    return persisted;
  });
}

/**
 * Upgrade reconciliation for the legacy exclusive mirror (r33): an old
 * renderer can leave `programmatic-tool-calling: true` alongside a stale
 * legacy exclusive `false` (or none), and setExperimentState rewrites the
 * mirror only on toggles — a user who upgrades and never touches the setting
 * would downgrade into the removed supplement posture, because a downgraded
 * renderer treats the stale explicit legacy key as an override that wins over
 * the backend's mirrored flag. Keep the mirror stamped whenever the EFFECTIVE
 * PTC state (local override first, else the backend override) is enabled.
 * Only the enabled state needs stamping: a legacy `true` already aliases
 * effective PTC to true, so a disagreeing pair can only be
 * (ptc: true, legacy: false/absent).
 */
function reconcileLegacyPtcExclusiveMirror(
  backendOverrides: Partial<Record<ExperimentId, boolean>> | null
): void {
  const local = getExperimentOverrideSnapshot(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);
  const effective = local ?? backendOverrides?.[EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING];
  if (effective !== true || hasLegacyPtcExclusiveOverride()) return;
  updatePersistedState(getLegacyPtcExclusiveExperimentKey(), true);
}

/**
 * Context value type - provides setter function.
 * Individual experiment values are accessed via useExperimentValue hook.
 */
interface ExperimentsContextValue {
  designRevision: number;
  setExperiment: (experimentId: ExperimentId, enabled: boolean) => void;
  backendOverrides: Partial<Record<ExperimentId, boolean>> | null;
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

  // The strategy is stored as two legacy flags. Order their actual writes (including
  // reconnect uploads) so rapid choices cannot persist a stale pair. Provider ownership
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
          await apiState.api.experiments.setOverride({ experimentId, enabled });
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

  // Local choices the backend has not acknowledged: in flight, or failed in this session
  // (offline, a rejected write). Adopting backend state skips them so a snapshot older than
  // the choice cannot revert it, and the next connect retries them.
  const pendingChoices = useRef(new Map<ExperimentId, ExperimentChoice>());

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
      publish();
      const choice = { enabled };
      pendingChoices.current.set(experimentId, choice);
      persistChoice(pendingChoices.current, persistOverride, experimentId, choice).catch(
        () => undefined
      );
    },
    [persistOverride]
  );

  useEffect(() => {
    if (!apiState.api) {
      setBackendOverrides((previous) =>
        previous
          ? { [EXPERIMENT_IDS.CLAUDE_DESIGN_MCP]: previous[EXPERIMENT_IDS.CLAUDE_DESIGN_MCP] }
          : null
      );
      return;
    }

    const api = apiState.api;
    const controller = new AbortController();
    let cancelled = false;
    const pending = pendingChoices.current;

    const markOffline = () => {
      setBackendOverrides((previous) =>
        previous
          ? { [EXPERIMENT_IDS.CLAUDE_DESIGN_MCP]: previous[EXPERIMENT_IDS.CLAUDE_DESIGN_MCP] }
          : null
      );
      // Still reconciles the purely-local stale pair (ptc: true,
      // legacy: false/absent) even when the backend is unreachable.
      reconcileLegacyPtcExclusiveMirror(null);
    };

    // The backend is authoritative: its overrides replace this origin's mirrors, including
    // removing ones it no longer holds, so a restore or another window's toggle reaches the
    // UI and the send options that read the mirrors.
    const adopt = (overrides: Partial<Record<ExperimentId, boolean>>) => {
      setBackendOverrides((previous) => ({
        ...overrides,
        [EXPERIMENT_IDS.CLAUDE_DESIGN_MCP]: previous?.[EXPERIMENT_IDS.CLAUDE_DESIGN_MCP],
      }));
      for (const experimentId of Object.keys(EXPERIMENTS) as ExperimentId[]) {
        if (
          experimentId === EXPERIMENT_IDS.CLAUDE_DESIGN_MCP ||
          !isExperimentSupported(experimentId) ||
          pending.has(experimentId)
        ) {
          continue;
        }
        syncExperimentStateFromBackend(experimentId, overrides[experimentId]);
      }
      reconcileLegacyPtcExclusiveMirror(overrides);
    };

    const uploadPendingChoices = async () => {
      // Once per origin, overrides kept in localStorage from before the backend persisted
      // them are uploaded. Afterwards only this session's unacknowledged choices are: a stale
      // mirror would otherwise push old values back over a restore or another window's change.
      const migrating =
        readPersistedState<unknown>(EXPERIMENTS_BACKEND_AUTHORITATIVE_KEY, false) !== true;
      if (migrating) {
        for (const [id, enabled] of Object.entries(getExplicitLocalExperimentOverrides())) {
          const experimentId = id as ExperimentId;
          if (!pending.has(experimentId)) pending.set(experimentId, { enabled });
        }
      }
      // Per experiment: this client's localStorage is origin-scoped and may legitimately be
      // empty, so it must never clear overrides another client set.
      const results = await Promise.all(
        [...pending].map(([experimentId, choice]) =>
          persistChoice(pending, persistOverride, experimentId, choice)
        )
      );
      // A failed upload keeps the marker unset so the next launch migrates from the mirrors
      // again; the pending entry keeps adoption from clearing that mirror meanwhile.
      if (migrating && !cancelled && results.every(Boolean)) {
        updatePersistedState(EXPERIMENTS_BACKEND_AUTHORITATIVE_KEY, true);
      }
    };

    const followOverrides = async () => {
      await uploadPendingChoices().catch(() => undefined);
      if (cancelled) return;

      let adopted = false;
      try {
        // Subscribed after the uploads so its opening snapshot already includes them; later
        // values arrive in write order, so the newest always wins.
        const stream = await api.experiments.onOverridesChange(undefined, {
          signal: controller.signal,
        });
        for await (const overrides of stream) {
          if (cancelled) break;
          adopted = true;
          adopt(overrides);
        }
      } catch {
        // Falls back to a single read below.
      }
      if (cancelled || adopted) return;

      try {
        const overrides = await api.experiments.getOverrides();
        if (!cancelled) adopt(overrides);
      } catch {
        if (!cancelled) markOffline();
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
    followOverrides().catch(() => undefined);
    followDesign().catch(() => undefined);

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiState.api, persistOverride]);

  return (
    <ExperimentsContext.Provider value={{ setExperiment, backendOverrides, designRevision }}>
      {props.children}
    </ExperimentsContext.Provider>
  );
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

  // The mirror follows the backend except for choices it has not acknowledged yet, so it
  // wins: a toggle made while a backend read is in flight is not overwritten when it resolves.
  if (localOverride !== undefined) {
    return localOverride;
  }

  return context?.backendOverrides?.[experimentId] ?? EXPERIMENTS[experimentId].enabledByDefault;
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
