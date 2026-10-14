import { readPersistedString, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { LAST_CUSTOM_MODEL_PROVIDER_KEY } from "@/common/constants/storage";
import { modelStringStartsWithProvider } from "@/common/utils/providers/modelString";
import { dropPendingModelPicks } from "@/browser/utils/aiSelectionIntent";

// Browser repair only: removing a custom provider updates config on the backend,
// but browser state can still reference provider-owned models.
export function repairLocalModelPreferencesForRemovedProvider(provider: string): void {
  const lastProvider = readPersistedString(LAST_CUSTOM_MODEL_PROVIDER_KEY);
  if (lastProvider === provider && lastProvider !== "") {
    updatePersistedState(LAST_CUSTOM_MODEL_PROVIDER_KEY, "");
  }
  dropPendingModelPicks((model) => modelStringStartsWithProvider(model, provider));
}
