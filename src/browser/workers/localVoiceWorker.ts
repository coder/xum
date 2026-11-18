import { ParakeetModel } from "parakeet.js/parakeet";
import * as ort from "onnxruntime-web";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";
import mjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url";
import { LOCAL_VOICE_SAMPLE_RATE } from "@/common/constants/localVoiceModels";
import { getErrorMessage } from "@/common/utils/errors";

export interface LocalVoiceAudioRequest {
  type: "transcribe";
  samples: Float32Array;
  encoderUrl: string;
  decoderUrl: string;
  tokenizerUrl: string;
}

export type LocalVoiceRequest = LocalVoiceAudioRequest | { type: "prepare" };

export type LocalVoiceResponse = { text: string } | { error: string };

// Bundle the runtime with Xum. Offline inference must never fetch executable code from a CDN.
ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
ort.env.wasm.numThreads = 1;

self.onmessage = async (event: MessageEvent<LocalVoiceRequest>) => {
  try {
    if (event.data.type === "prepare") {
      // Fetch runtime assets during setup, so the app cache can serve the first offline recording.
      for (const url of [wasmUrl, mjsUrl]) {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Cannot load the local speech runtime.");
        await response.arrayBuffer();
      }
      self.postMessage({ text: "" } satisfies LocalVoiceResponse);
      return;
    }
    const model = await ParakeetModel.fromUrls({
      encoderUrl: event.data.encoderUrl,
      decoderUrl: event.data.decoderUrl,
      tokenizerUrl: event.data.tokenizerUrl,
      backend: "wasm",
      cpuThreads: 1,
      preprocessorBackend: "js",
      nMels: 128,
      subsampling: 8,
    });
    const result = await model.transcribeLongAudio(event.data.samples, LOCAL_VOICE_SAMPLE_RATE, {
      chunkLengthS: 20,
    });
    self.postMessage({ text: result.text } satisfies LocalVoiceResponse);
  } catch (error) {
    self.postMessage({ error: getErrorMessage(error) } satisfies LocalVoiceResponse);
  }
};
