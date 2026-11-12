import type { APIClient } from "@/browser/contexts/API";
import type { VoiceModelId } from "@/common/constants/localVoiceModels";
import type { Result } from "@/common/types/result";
import { transcribeLocally } from "./localTranscription";

export async function transcribeVoiceRecording(
  model: VoiceModelId | null,
  audio: Blob,
  api: APIClient | null | undefined,
  signal: AbortSignal,
  localTranscribe = transcribeLocally
): Promise<Result<string, string>> {
  if (model === null) return { success: false, error: "Select a voice model in Settings → Voice." };
  // Never send a local recording to the backend, including when local inference fails.
  if (model !== "openai")
    return { success: true, data: await localTranscribe(model, audio, signal) };
  if (!api) return { success: false, error: "Voice API not available" };
  const buffer = await audio.arrayBuffer();
  const base64 = btoa(
    new Uint8Array(buffer).reduce((str, byte) => str + String.fromCharCode(byte), "")
  );
  return api.voice.transcribe({ audioBase64: base64 }, { signal });
}
