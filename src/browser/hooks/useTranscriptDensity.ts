import { usePersistedState } from "@/browser/hooks/usePersistedState";
import {
  DEFAULT_TRANSCRIPT_DENSITY,
  normalizeTranscriptDensity,
  TRANSCRIPT_DENSITY_KEY,
  type TranscriptDensity,
} from "@/common/constants/storage";

export function useTranscriptDensity(): [TranscriptDensity, (density: TranscriptDensity) => void] {
  const [rawDensity, setRawDensity] = usePersistedState<unknown>(
    TRANSCRIPT_DENSITY_KEY,
    DEFAULT_TRANSCRIPT_DENSITY,
    { listener: true }
  );

  return [normalizeTranscriptDensity(rawDensity), setRawDensity];
}
