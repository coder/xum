export const LOCAL_VOICE_SAMPLE_RATE = 16_000;
export const LOCAL_VOICE_MAX_SECONDS = 120;
export const LOCAL_VOICE_TIMEOUT_MS = 5 * 60_000;
export const LOCAL_VOICE_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

export interface VoiceModelFile {
  name: string;
  bytes: number;
  sha256: string;
}

// Pin model revisions and hashes. Model updates must not change an existing offline installation.
// These ONNX conversions retain NVIDIA's CC BY 4.0 license.
export const LOCAL_VOICE_MODELS = {
  "parakeet-v3": {
    name: "Parakeet TDT v3",
    languages: "25 European languages",
    repo: "ysdede/parakeet-tdt-0.6b-v3-onnx",
    revision: "e5356bf6e24bdb7a269536b0e9e7869bc034b893",
    files: [
      {
        name: "encoder-model.int8.onnx",
        bytes: 652183999,
        sha256: "6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09",
      },
      {
        name: "decoder_joint-model.int8.onnx",
        bytes: 18202004,
        sha256: "eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70",
      },
      {
        name: "vocab.txt",
        bytes: 102132,
        sha256: "ba8e4007c65f4bb4358ffe2ecc13d9ccc7a10351151065242b5c3a943e685742",
      },
    ],
  },
  "parakeet-v2": {
    name: "Parakeet TDT v2",
    languages: "English",
    repo: "ysdede/parakeet-tdt-0.6b-v2-onnx",
    revision: "db4a768f5795e0f508187a34241fbeeef6ebb0d3",
    files: [
      {
        name: "encoder-model.int8.onnx",
        bytes: 652184014,
        sha256: "3e0581fda6ab843888b51e56d7ee78b6d5bc3237ec113af1f732d1d5286aa155",
      },
      {
        name: "decoder_joint-model.int8.onnx",
        bytes: 8998286,
        sha256: "a449f49acd68979d418651dd2dcb737cc0f1bf0225e009e29ee326354edbf7d3",
      },
      {
        name: "vocab.txt",
        bytes: 10409,
        sha256: "d5b4ca312b07f10cc89b6ff1f500201b5bd826dc3f9500c115caeb36c0b10831",
      },
    ],
  },
} as const;

export type LocalVoiceModelId = keyof typeof LOCAL_VOICE_MODELS;
export type VoiceModelId = "openai" | LocalVoiceModelId;
export const LOCAL_VOICE_MODEL_IDS = Object.keys(LOCAL_VOICE_MODELS) as LocalVoiceModelId[];

export function isLocalVoiceModelId(value: unknown): value is LocalVoiceModelId {
  return typeof value === "string" && Object.hasOwn(LOCAL_VOICE_MODELS, value);
}

export function voiceModelFileUrl(id: LocalVoiceModelId, file: VoiceModelFile): string {
  const model = LOCAL_VOICE_MODELS[id];
  return `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.name}`;
}

export function voiceModelCacheName(id: LocalVoiceModelId): string {
  return `xum-voice-${id}-${LOCAL_VOICE_MODELS[id].revision}`;
}
