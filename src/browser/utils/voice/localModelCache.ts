import {
  LOCAL_VOICE_MODELS,
  voiceModelCacheName,
  voiceModelFileUrl,
  type LocalVoiceModelId,
  type VoiceModelFile,
} from "@/common/constants/localVoiceModels";

/** Reject incomplete or altered downloads before they enter the model cache. */
export async function readModelDownload(
  response: Response,
  file: VoiceModelFile,
  signal: AbortSignal,
  onBytes: (bytes: number) => void
): Promise<Blob> {
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array<ArrayBuffer>> = [];
  let received = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > file.bytes) throw new Error(`Unexpected size for ${file.name}`);
      chunks.push(new Uint8Array(value));
      onBytes(received);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (received !== file.bytes) throw new Error(`Incomplete download: ${file.name}`);
  const blob = new Blob(chunks);
  // Release the download chunks before allocating the full buffer for checksum verification.
  chunks.length = 0;
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  if (hash !== file.sha256) throw new Error(`Checksum mismatch: ${file.name}`);
  signal.throwIfAborted();
  return blob;
}

export async function isVoiceModelDownloaded(id: LocalVoiceModelId): Promise<boolean> {
  const name = voiceModelCacheName(id);
  if (!(await caches.has(name))) return false;
  const cache = await caches.open(name);
  const urls = new Set((await cache.keys()).map((request) => request.url));
  return LOCAL_VOICE_MODELS[id].files.every((file) => urls.has(voiceModelFileUrl(id, file)));
}

export async function downloadVoiceModel(
  id: LocalVoiceModelId,
  signal: AbortSignal,
  onBytes: (bytes: number) => void
): Promise<void> {
  const name = voiceModelCacheName(id);
  await navigator.locks.request(name, { signal }, async () => {
    // Another window can finish the download while this request waits for the lock.
    if (await isVoiceModelDownloaded(id)) return;
    await caches.delete(name);
    const cache = await caches.open(name);
    let completedBytes = 0;
    try {
      for (const file of LOCAL_VOICE_MODELS[id].files) {
        const url = voiceModelFileUrl(id, file);
        const response = await fetch(url, {
          signal,
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
        const blob = await readModelDownload(response, file, signal, (bytes) =>
          onBytes(completedBytes + bytes)
        );
        await cache.put(url, new Response(blob));
        completedBytes += file.bytes;
      }
      signal.throwIfAborted();
    } catch (error) {
      await caches.delete(name);
      throw error;
    }
  });
}

export async function removeVoiceModel(id: LocalVoiceModelId): Promise<void> {
  await navigator.locks.request(voiceModelCacheName(id), async () => {
    await caches.delete(voiceModelCacheName(id));
  });
}
