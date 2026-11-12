import { useSyncExternalStore } from "react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { localVoiceStore } from "@/browser/stores/LocalVoiceStore";
import { VOICE_MODEL_KEY } from "@/common/constants/storage";
import { isLocalVoiceModelId, type VoiceModelId } from "@/common/constants/localVoiceModels";

export function useVoiceModel() {
  const [storedModel, setModel] = usePersistedState<VoiceModelId>(VOICE_MODEL_KEY, "openai", {
    listener: true,
  });
  const state = useSyncExternalStore(localVoiceStore.subscribe, localVoiceStore.getSnapshot);
  // Invalid saved values must not silently send audio to the cloud.
  const model = storedModel === "openai" || isLocalVoiceModelId(storedModel) ? storedModel : null;
  return { model, setModel, state };
}
