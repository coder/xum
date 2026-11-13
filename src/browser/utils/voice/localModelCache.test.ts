import { rejects } from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { downloadVoiceModel, isVoiceModelDownloaded, readModelDownload } from "./localModelCache";
import {
  LOCAL_VOICE_MODELS,
  voiceModelCacheName,
  voiceModelFileUrl,
  type VoiceModelFile,
} from "@/common/constants/localVoiceModels";

const file: VoiceModelFile = {
  name: "model.onnx",
  bytes: 3,
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
};

function download(response: Response, modelFile = file, signal = new AbortController().signal) {
  return readModelDownload(response, modelFile, signal, () => undefined);
}

describe("verified voice model downloads", () => {
  test("accepts complete bytes and reports cumulative progress", async () => {
    const progress: number[] = [];
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("a"));
          controller.enqueue(new TextEncoder().encode("bc"));
          controller.close();
        },
      })
    );
    const blob = await readModelDownload(response, file, new AbortController().signal, (bytes) =>
      progress.push(bytes)
    );
    expect(await blob.text()).toBe("abc");
    expect(progress).toEqual([1, 3]);
  });

  test("rejects an HTTP failure instead of caching its error page", async () => {
    await rejects(download(new Response("abc", { status: 503 })), /HTTP 503/);
  });

  test("rejects truncated downloads", async () => {
    await rejects(download(new Response("ab")), /Incomplete download/);
  });

  test("rejects excess bytes before reading the whole response", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("abcd"));
        },
        cancel() {
          cancelled = true;
        },
      })
    );
    await rejects(download(response), /Unexpected size/);
    expect(cancelled).toBe(true);
  });

  test("rejects altered content even when its length matches", async () => {
    await rejects(download(new Response("abd")), /Checksum mismatch/);
  });

  test("cancellation does not return an installable model", async () => {
    const controller = new AbortController();
    controller.abort();
    await rejects(download(new Response("abc"), file, controller.signal));
  });
});

describe("shared voice model download cache", () => {
  const id = "parakeet-v3";
  let urls: string[];
  let lockReady: ReturnType<typeof Promise.withResolvers<void>>;
  let restore: () => void;

  beforeEach(() => {
    urls = [];
    lockReady = Promise.withResolvers<void>();
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const cachesDescriptor = Object.getOwnPropertyDescriptor(globalThis, "caches");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        locks: {
          request: async (_name: string, _options: LockOptions, callback: () => Promise<void>) => {
            await lockReady.promise;
            return callback();
          },
        },
      },
    });
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: {
        has: () => Promise.resolve(urls.length > 0),
        open: () =>
          Promise.resolve({ keys: () => Promise.resolve(urls.map((url) => new Request(url))) }),
        delete: mock(() => {
          urls = [];
          return Promise.resolve(true);
        }),
      },
    });
    restore = () => {
      for (const [key, descriptor] of [
        ["navigator", navigatorDescriptor],
        ["caches", cachesDescriptor],
      ] as const) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };
  });

  afterEach(() => restore());

  test("preserves a model that another window completes while this download waits for its lock", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected download"));
    const deleteSpy = spyOn(caches, "delete");
    const progress = mock(() => undefined);
    try {
      expect(await isVoiceModelDownloaded(id)).toBe(false);
      const pending = downloadVoiceModel(id, new AbortController().signal, progress);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();
      urls = LOCAL_VOICE_MODELS[id].files.map((modelFile) => voiceModelFileUrl(id, modelFile));
      lockReady.resolve();
      await pending;
      expect(await isVoiceModelDownloaded(id)).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(progress).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  test("replaces an incomplete cache and removes it after a failed download", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unavailable", { status: 503 })
    );
    const deleteSpy = spyOn(caches, "delete");
    try {
      urls = [voiceModelFileUrl(id, LOCAL_VOICE_MODELS[id].files[0])];
      expect(await isVoiceModelDownloaded(id)).toBe(false);
      lockReady.resolve();
      await rejects(
        downloadVoiceModel(id, new AbortController().signal, () => undefined),
        /HTTP 503/
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(deleteSpy).toHaveBeenCalledWith(voiceModelCacheName(id));
      expect(await isVoiceModelDownloaded(id)).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });
});
