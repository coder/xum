import {
  LOCAL_VOICE_DOWNLOAD_TIMEOUT_MS,
  LOCAL_VOICE_MODEL_IDS,
  LOCAL_VOICE_MODELS,
  type LocalVoiceModelId,
} from "@/common/constants/localVoiceModels";
import { getErrorMessage } from "@/common/utils/errors";
import {
  downloadVoiceModel,
  isVoiceModelDownloaded,
  removeVoiceModel,
} from "@/browser/utils/voice/localModelCache";

import { prepareLocalVoiceRuntime } from "@/browser/utils/voice/localTranscription";

interface LocalVoiceState {
  downloaded: LocalVoiceModelId[];
  loading: boolean;
  operation: { id: LocalVoiceModelId; kind: "download" | "remove"; bytes: number } | null;
  error: string | null;
}

let state: LocalVoiceState = { downloaded: [], loading: true, operation: null, error: null };
const listeners = new Set<() => void>();
let initialized = false;
let channel: BroadcastChannel | null = null;
let downloadController: AbortController | null = null;

function update(patch: Partial<LocalVoiceState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function isRemoteVoiceCaptureBlocked(): boolean {
  // Remote Electron windows have no preload bridge and deny microphone permission.
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    navigator.userAgent.includes("Electron/") &&
    window.api == null
  );
}

export function supportsLocalVoice(): boolean {
  return (
    !isRemoteVoiceCaptureBlocked() &&
    typeof Worker !== "undefined" &&
    typeof WebAssembly !== "undefined" &&
    typeof OfflineAudioContext !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof caches !== "undefined" &&
    typeof navigator.locks !== "undefined"
  );
}

export const localVoiceStore = {
  getSnapshot: () => state,
  subscribe(this: void, listener: () => void) {
    listeners.add(listener);
    if (!initialized) {
      initialized = true;
      // Cache Storage is shared across windows. Refresh after another window changes a model.
      if (typeof BroadcastChannel !== "undefined") {
        channel = new BroadcastChannel("xum-local-voice");
        channel.onmessage = refreshQuietly;
      }
      window.addEventListener("focus", refreshQuietly);
      localVoiceStore
        .refresh()
        .catch((error: unknown) => update({ loading: false, error: getErrorMessage(error) }));
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        channel?.close();
        channel = null;
        window.removeEventListener("focus", refreshQuietly);
        initialized = false;
      }
    };
  },
  async refresh() {
    const downloaded: LocalVoiceModelId[] = [];
    if (supportsLocalVoice()) {
      for (const id of LOCAL_VOICE_MODEL_IDS) {
        if (await isVoiceModelDownloaded(id)) downloaded.push(id);
      }
    }
    update({ downloaded, loading: false });
  },
  async download(id: LocalVoiceModelId) {
    if (state.operation) return;
    const controller = new AbortController();
    downloadController = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(LOCAL_VOICE_DOWNLOAD_TIMEOUT_MS),
    ]);
    update({ operation: { id, kind: "download", bytes: 0 }, error: null });
    try {
      await prepareLocalVoiceRuntime(signal);
      const total = LOCAL_VOICE_MODELS[id].files.reduce((sum, file) => sum + file.bytes, 0);
      let percent = -1;
      await downloadVoiceModel(id, signal, (bytes) => {
        const nextPercent = Math.floor((bytes / total) * 100);
        if (nextPercent === percent) return;
        percent = nextPercent;
        update({ operation: { id, kind: "download", bytes } });
      });
    } catch (error) {
      if (!controller.signal.aborted) update({ error: getErrorMessage(error) });
    } finally {
      downloadController = null;
      update({ operation: null });
      await localVoiceStore.refresh();
      channel?.postMessage(null);
    }
  },
  cancelDownload() {
    downloadController?.abort();
  },
  async remove(id: LocalVoiceModelId) {
    if (state.operation) return;
    update({ operation: { id, kind: "remove", bytes: 0 }, error: null });
    try {
      await removeVoiceModel(id);
    } catch (error) {
      update({ error: getErrorMessage(error) });
    } finally {
      update({ operation: null });
      await localVoiceStore.refresh();
      channel?.postMessage(null);
    }
  },
};

function refreshQuietly(): void {
  localVoiceStore
    .refresh()
    .catch((error: unknown) => update({ error: getErrorMessage(error), loading: false }));
}
