import { readPersistedState } from "./usePersistedState";
import {
  type ExperimentId,
  getExperimentKey,
  isExperimentSupportedOnPlatform,
} from "@/common/constants/experiments";

// Re-export reactive hooks from context for convenience
export {
  useExperimentValue,
  useExperimentOverrideValue,
} from "@/browser/contexts/ExperimentsContext";

/**
 * Non-hook version to read experiment state.
 * Use when you need a one-time read (e.g., constructing send options at send time)
 * or outside of React components.
 *
 * For reactive updates in React components, use useExperimentValue (UI gating) or
 * useExperimentOverrideValue (backend send options).
 *
 * For user-overridable experiments, returns `undefined` when no explicit localStorage
 * override exists, so send options can distinguish "user chose off" from "user never chose".
 */
export function isExperimentEnabled(experimentId: ExperimentId): boolean | undefined {
  if (!isExperimentSupportedOnPlatform(experimentId, window.api?.platform)) {
    return false;
  }

  const stored = readPersistedState<unknown>(getExperimentKey(experimentId), undefined);
  return typeof stored === "boolean" ? stored : undefined;
}
