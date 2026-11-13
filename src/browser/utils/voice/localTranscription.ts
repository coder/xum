import {
  LOCAL_VOICE_INFERENCE_LOCK,
  LOCAL_VOICE_MODELS,
  LOCAL_VOICE_MAX_SECONDS,
  LOCAL_VOICE_SAMPLE_RATE,
  LOCAL_VOICE_TIMEOUT_MS,
  voiceModelCacheName,
  voiceModelFileUrl,
  type LocalVoiceModelId,
} from "@/common/constants/localVoiceModels";
import type { LocalVoiceRequest, LocalVoiceResponse } from "@/browser/workers/localVoiceWorker";

/** Local mode never uploads audio or falls back to a cloud provider. */
export async function transcribeLocally(
  id: LocalVoiceModelId,
  audio: Blob,
  signal: AbortSignal
): Promise<string> {
  // Queue completed recordings across windows instead of discarding them during another transcription.
  // Hold the inference lock through decoding, model access, and worker cleanup.
  return navigator.locks.request(LOCAL_VOICE_INFERENCE_LOCK, { signal }, async () => {
    const urls: string[] = [];
    try {
      const context = new OfflineAudioContext(1, 1, LOCAL_VOICE_SAMPLE_RATE);
      const decoded = await context.decodeAudioData(await audio.arrayBuffer());
      // Capture timers can run late. Keep the recording and bound inference to the duration limit.
      const samples = new Float32Array(
        Math.min(decoded.length, LOCAL_VOICE_MAX_SECONDS * LOCAL_VOICE_SAMPLE_RATE)
      );
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const data = decoded.getChannelData(channel);
        for (let i = 0; i < samples.length; i++) samples[i] += data[i] / decoded.numberOfChannels;
      }
      // Read only verified cache entries. Missing files require an explicit download in Settings.
      await navigator.locks.request(voiceModelCacheName(id), { signal }, async () => {
        const cache = await caches.open(voiceModelCacheName(id));
        for (const file of LOCAL_VOICE_MODELS[id].files) {
          const response = await cache.match(voiceModelFileUrl(id, file));
          if (!response)
            throw new Error("Download the local model in Settings → Voice before recording.");
          urls.push(URL.createObjectURL(await response.blob()));
        }
      });
      signal.throwIfAborted();
      return await callVoiceWorker(
        {
          type: "transcribe",
          samples,
          encoderUrl: urls[0],
          decoderUrl: urls[1],
          tokenizerUrl: urls[2],
        },
        signal
      );
    } finally {
      for (const url of urls) URL.revokeObjectURL(url);
    }
  });
}

export async function prepareLocalVoiceRuntime(signal: AbortSignal): Promise<void> {
  await callVoiceWorker({ type: "prepare" }, signal);
}

async function callVoiceWorker(request: LocalVoiceRequest, signal: AbortSignal): Promise<string> {
  const worker = new Worker(new URL("../../workers/localVoiceWorker.ts", import.meta.url), {
    type: "module",
    name: "local-voice",
  });
  try {
    return await runLocalVoiceWorker(worker, request, signal);
  } finally {
    // Termination releases ONNX sessions and bounds memory use between recordings.
    worker.terminate();
  }
}

export async function runLocalVoiceWorker(
  worker: Worker,
  request: LocalVoiceRequest,
  signal: AbortSignal
): Promise<string> {
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(LOCAL_VOICE_TIMEOUT_MS)]);
  boundedSignal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, text?: string) => {
      boundedSignal.removeEventListener("abort", onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      if (error) reject(error);
      else resolve(text ?? "");
    };
    const onAbort = () => finish(new Error("Local transcription stopped or timed out."));
    boundedSignal.addEventListener("abort", onAbort, { once: true });
    worker.onerror = () =>
      finish(new Error("Local transcription failed. Check available memory and try again."));
    worker.onmessage = (event: MessageEvent<LocalVoiceResponse>) => {
      if ("error" in event.data) finish(new Error(event.data.error));
      else finish(undefined, event.data.text);
    };
    worker.postMessage(request, request.type === "transcribe" ? [request.samples.buffer] : []);
  });
}
