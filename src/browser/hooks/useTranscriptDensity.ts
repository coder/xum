import { updateUserPreferences, useUserPreferences } from "@/browser/stores/AppConfigStore";
import { normalizeTranscriptDensity, type TranscriptDensity } from "@/common/constants/storage";

function setTranscriptDensity(transcriptDensity: TranscriptDensity): void {
  updateUserPreferences({ appearance: { transcriptDensity } });
}

export function useTranscriptDensity(): [TranscriptDensity, (density: TranscriptDensity) => void] {
  const density = useUserPreferences((preferences) =>
    normalizeTranscriptDensity(preferences.appearance?.transcriptDensity)
  );

  return [density, setTranscriptDensity];
}
