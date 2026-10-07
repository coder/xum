import type { ExperimentId } from "@/common/constants/experiments";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";

export { useExperimentValue } from "@/browser/contexts/ExperimentsContext";

/** Non-hook read of an experiment's backend value, for code outside React components. */
export function isExperimentEnabled(experimentId: ExperimentId): boolean {
  return getAppConfigStore().getSnapshot()?.experiments?.[experimentId] === true;
}
