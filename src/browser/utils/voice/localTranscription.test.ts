import { rejects } from "node:assert/strict";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { runLocalVoiceWorker, transcribeLocally } from "./localTranscription";
import type { LocalVoiceRequest, LocalVoiceResponse } from "@/browser/workers/localVoiceWorker";
import {
  LOCAL_VOICE_INFERENCE_LOCK,
  LOCAL_VOICE_MAX_SECONDS,
  LOCAL_VOICE_MODEL_IDS,
  LOCAL_VOICE_MODELS,
  LOCAL_VOICE_SAMPLE_RATE,
  voiceModelCacheName,
  voiceModelFileUrl,
  type LocalVoiceModelId,
} from "@/common/constants/localVoiceModels";

function createWorker() {
  const worker = {
    onmessage: null as ((event: MessageEvent<LocalVoiceResponse>) => void) | null,
    onerror: null as (() => void) | null,
    postMessage: mock((_request: LocalVoiceRequest, _transfer: Transferable[]): void => undefined),
    terminate: mock(() => undefined),
  };
  return { worker, boundary: worker as unknown as Worker };
}

function createLocks() {
  const tails = new Map<string, Promise<void>>();
  const held = new Set<string>();
  const request = mock(
    async <T>(name: string, options: LockOptions, callback: () => Promise<T>) => {
      options.signal?.throwIfAborted();
      const previous = tails.get(name) ?? Promise.resolve();
      const released = Promise.withResolvers<void>();
      // A cancelled waiter must not let later requests bypass the current lock holder.
      tails.set(
        name,
        previous.then(() => released.promise)
      );
      const aborted = Promise.withResolvers<never>();
      const onAbort = () => aborted.reject(options.signal?.reason);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await Promise.race([previous, aborted.promise]);
        options.signal?.throwIfAborted();
        options.signal?.removeEventListener("abort", onAbort);
        held.add(name);
        try {
          return await callback();
        } finally {
          held.delete(name);
        }
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
        released.resolve();
      }
    }
  );
  return { request, held };
}

describe("transcribeLocally", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  function setup(
    id: LocalVoiceModelId = "parakeet-v3",
    channels = [
      [1, 0, -1],
      [-1, 1, 0],
    ]
  ) {
    // Replace browser boundaries only. These tests must not start inference or download models.
    const descriptors = new Map(
      ["OfflineAudioContext", "Worker", "navigator", "caches"].map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ])
    );
    const channelData = channels.map((channel) => new Float32Array(channel));
    const decoded = {
      duration: 1,
      length: channelData[0].length,
      numberOfChannels: channelData.length,
      getChannelData: (channel: number) => channelData[channel],
    } satisfies Pick<AudioBuffer, "duration" | "length" | "numberOfChannels" | "getChannelData">;
    const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    const decode = mock((_data: ArrayBuffer) => Promise.resolve(decoded));
    const createContext = mock(function (_channels: number, _length: number, _sampleRate: number) {
      return { decodeAudioData: decode };
    });
    const entries = new Map(
      LOCAL_VOICE_MODEL_IDS.flatMap((modelId) =>
        LOCAL_VOICE_MODELS[modelId].files.map(
          (file) => [voiceModelFileUrl(modelId, file), new Response(`cached ${file.name}`)] as const
        )
      )
    );
    const match = mock((url: string) => Promise.resolve(entries.get(url)?.clone()));
    const open = mock((_name: string) => Promise.resolve({ match }));
    const { request: lock, held } = createLocks();
    const { worker, boundary } = createWorker();
    const posted = Promise.withResolvers<void>();
    worker.postMessage.mockImplementation(() => posted.resolve());
    const createWorkerBoundary = mock(function (_url: URL, _options: WorkerOptions) {
      return boundary;
    });
    for (const [key, value] of Object.entries({
      OfflineAudioContext: createContext,
      Worker: createWorkerBoundary,
      navigator: { locks: { request: lock } },
      caches: { open },
    })) {
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    const createUrl = spyOn(URL, "createObjectURL");
    const revokeUrl = spyOn(URL, "revokeObjectURL");
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Unexpected network request")
    );
    const controllers: AbortController[] = [];
    const pending: Array<Promise<string>> = [];

    function start(controller = new AbortController(), recording = audio, modelId = id) {
      controllers.push(controller);
      const result = transcribeLocally(modelId, recording, controller.signal);
      pending.push(result);
      return { controller, result };
    }

    function respond(response: LocalVoiceResponse = { text: "recognized speech" }) {
      worker.onmessage?.({ data: response } as MessageEvent<LocalVoiceResponse>);
    }

    function createdUrls(): string[] {
      return createUrl.mock.results.flatMap((result) =>
        result.type === "return" ? [result.value] : []
      );
    }

    cleanup = async () => {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(pending);
      const urls = createdUrls();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
      fetchSpy.mockRestore();
      // Release real blob URLs even when an assertion interrupts a test.
      for (const url of urls) URL.revokeObjectURL(url);
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };

    function expectReleased() {
      expect(held.size).toBe(0);
      expect(revokeUrl.mock.calls.map(([url]) => url)).toEqual(createdUrls());
      expect(worker.terminate).toHaveBeenCalledTimes(createWorkerBoundary.mock.calls.length);
      expect(worker.onmessage).toBeNull();
      expect(worker.onerror).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    }

    async function expectRetrySucceeds() {
      worker.postMessage.mockImplementation(() => respond());
      expect(await start().result).toBe("recognized speech");
      expectReleased();
    }

    return {
      start,
      respond,
      posted: posted.promise,
      worker,
      createWorkerBoundary,
      createContext,
      decode,
      decoded,
      audio,
      entries,
      open,
      lock,
      held,
      match,
      createUrl,
      revokeUrl,
      createdUrls,
      expectReleased,
      expectRetrySucceeds,
    };
  }

  test.each([
    { id: "parakeet-v2", channels: [[1, 0.5, -1]], samples: [1, 0.5, -1] },
    {
      id: "parakeet-v3",
      channels: [
        [1, 0, -1],
        [-1, 1, 0],
      ],
      samples: [0, 0.5, -0.5],
    },
    {
      id: "parakeet-v3",
      channels: [
        [1, 0, -1],
        [-1, 0.75, 0],
        [0, 0.75, -0.5],
      ],
      samples: [0, 0.5, -0.5],
    },
  ] satisfies Array<{ id: LocalVoiceModelId; channels: number[][]; samples: number[] }>)(
    "transcribes $id audio from cached model files with channels $channels",
    async ({ id, channels, samples }) => {
      const env = setup(id, channels);
      const { controller, result } = env.start();
      await env.posted;
      expect(env.createContext).toHaveBeenCalledWith(1, 1, LOCAL_VOICE_SAMPLE_RATE);
      expect(env.decode).toHaveBeenCalledWith(await env.audio.arrayBuffer());
      const [request, transfer] = env.worker.postMessage.mock.calls[0];
      expect(request.type).toBe("transcribe");
      if (request.type !== "transcribe") throw new Error("Expected an audio request");
      expect(request.samples).toBeInstanceOf(Float32Array);
      expect(request.samples).toHaveLength(samples.length);
      for (const [index, sample] of samples.entries()) {
        expect(request.samples[index]).toBeCloseTo(sample, 6);
      }
      expect(transfer).toEqual([request.samples.buffer]);
      expect(transfer[0]).toBe(request.samples.buffer);
      expect(env.lock).toHaveBeenNthCalledWith(
        1,
        LOCAL_VOICE_INFERENCE_LOCK,
        { signal: controller.signal },
        expect.any(Function)
      );
      expect(env.lock).toHaveBeenCalledWith(
        voiceModelCacheName(id),
        { signal: controller.signal },
        expect.any(Function)
      );
      expect(env.open).toHaveBeenCalledWith(voiceModelCacheName(id));
      expect(env.match.mock.calls.map(([url]) => url)).toEqual(
        LOCAL_VOICE_MODELS[id].files.map((file) => voiceModelFileUrl(id, file))
      );
      const urls = [request.encoderUrl, request.decoderUrl, request.tokenizerUrl];
      expect(urls).toEqual(env.createdUrls());
      expect(urls.every((url) => url.startsWith("blob:"))).toBe(true);
      const modelContents = await Promise.all(
        env.createUrl.mock.calls.map(([blob]) => {
          if (!(blob instanceof Blob)) throw new Error("Expected a model blob");
          return blob.text();
        })
      );
      expect(modelContents).toEqual(
        LOCAL_VOICE_MODELS[id].files.map((file) => `cached ${file.name}`)
      );
      expect(env.revokeUrl).not.toHaveBeenCalled();
      expect(env.worker.terminate).not.toHaveBeenCalled();
      env.respond();
      expect(await result).toBe("recognized speech");
      env.expectReleased();
    }
  );

  test.each(["success", "error", "abort"] as const)(
    "serializes recordings across models after %s and releases resources before the next decode",
    async (outcome) => {
      const env = setup();
      const first = env.start();
      await env.posted;
      const nextPosted = Promise.withResolvers<void>();
      env.worker.postMessage.mockImplementationOnce(() => nextPosted.resolve());
      const secondAudio = new Blob([new Uint8Array([4, 5, 6])]);
      const second = env.start(new AbortController(), secondAudio, "parakeet-v2");
      expect(env.decode).toHaveBeenCalledTimes(1);
      expect(env.open).toHaveBeenCalledTimes(1);
      expect(env.createWorkerBoundary).toHaveBeenCalledTimes(1);
      expect(env.revokeUrl).not.toHaveBeenCalled();
      expect(env.worker.terminate).not.toHaveBeenCalled();
      expect(env.held.has(LOCAL_VOICE_INFERENCE_LOCK)).toBe(true);
      env.decode.mockImplementationOnce(() => {
        expect(env.worker.terminate).toHaveBeenCalledTimes(1);
        expect(env.revokeUrl).toHaveBeenCalledTimes(3);
        return Promise.resolve(env.decoded);
      });
      if (outcome === "success") {
        env.respond({ text: "first recording" });
        expect(await first.result).toBe("first recording");
      } else {
        if (outcome === "error") env.respond({ error: "Not enough memory" });
        else first.controller.abort();
        await rejects(
          first.result,
          outcome === "error" ? /Not enough memory/ : /stopped or timed out/
        );
      }
      await nextPosted.promise;
      expect(env.decode).toHaveBeenLastCalledWith(await secondAudio.arrayBuffer());
      expect(env.open).toHaveBeenLastCalledWith(voiceModelCacheName("parakeet-v2"));
      expect(env.createWorkerBoundary).toHaveBeenCalledTimes(2);
      env.respond({ text: "second recording" });
      expect(await second.result).toBe("second recording");
      env.expectReleased();
    }
  );

  test("queued cancellation leaves the active recording and the next waiter intact", async () => {
    const env = setup();
    const first = env.start();
    await env.posted;
    const cancelled = env.start();
    const nextPosted = Promise.withResolvers<void>();
    env.worker.postMessage.mockImplementationOnce(() => nextPosted.resolve());
    const last = env.start();
    cancelled.controller.abort();
    await rejects(cancelled.result, { name: "AbortError" });
    expect(env.decode).toHaveBeenCalledTimes(1);
    expect(env.open).toHaveBeenCalledTimes(1);
    expect(env.createWorkerBoundary).toHaveBeenCalledTimes(1);
    expect(env.revokeUrl).not.toHaveBeenCalled();
    expect(env.worker.terminate).not.toHaveBeenCalled();
    expect(env.held.has(LOCAL_VOICE_INFERENCE_LOCK)).toBe(true);
    env.respond({ text: "first recording" });
    expect(await first.result).toBe("first recording");
    await nextPosted.promise;
    env.respond({ text: "last recording" });
    expect(await last.result).toBe("last recording");
    expect(env.decode).toHaveBeenCalledTimes(2);
    expect(env.createWorkerBoundary).toHaveBeenCalledTimes(2);
    env.expectReleased();
  });

  test("waits for another window's inference lock before decoding or loading a model", async () => {
    const env = setup();
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const otherWindow = env.lock(LOCAL_VOICE_INFERENCE_LOCK, {}, () => {
      acquired.resolve();
      return release.promise;
    });
    await acquired.promise;
    env.worker.postMessage.mockImplementation(() => env.respond());
    try {
      const { result } = env.start();
      expect(env.createContext).not.toHaveBeenCalled();
      expect(env.decode).not.toHaveBeenCalled();
      expect(env.open).not.toHaveBeenCalled();
      expect(env.createWorkerBoundary).not.toHaveBeenCalled();
      expect(env.lock).toHaveBeenCalledTimes(2);
      release.resolve();
      expect(await result).toBe("recognized speech");
      env.expectReleased();
    } finally {
      release.resolve();
      await otherWindow;
    }
  });

  test.each([-1, 0, 1])("preserves audio at the PCM limit with %i extra samples", async (extra) => {
    const env = setup();
    const maxSamples = LOCAL_VOICE_MAX_SECONDS * LOCAL_VOICE_SAMPLE_RATE;
    const retainedSamples = Math.min(maxSamples, maxSamples + extra);
    const channel = new Float32Array(maxSamples + extra).fill(0.5);
    channel[retainedSamples - 1] = 0.25;
    env.decoded.length = channel.length;
    env.decoded.duration = channel.length / LOCAL_VOICE_SAMPLE_RATE;
    env.decoded.numberOfChannels = 1;
    env.decoded.getChannelData = () => channel;
    env.worker.postMessage.mockImplementation((request) => {
      expect(request.type).toBe("transcribe");
      if (request.type !== "transcribe") throw new Error("Expected an audio request");
      expect(request.samples).toHaveLength(retainedSamples);
      expect(request.samples[0]).toBe(0.5);
      expect(request.samples[retainedSamples - 1]).toBe(0.25);
      env.respond();
    });
    expect(await env.start().result).toBe("recognized speech");
    env.expectReleased();
  });

  test.each([0, 1, 2])(
    "rejects missing cache entry %i and releases partial blob URLs",
    async (index) => {
      const env = setup();
      const url = voiceModelFileUrl("parakeet-v3", LOCAL_VOICE_MODELS["parakeet-v3"].files[index]);
      env.entries.delete(url);
      await rejects(env.start().result, /Download the local model/);
      expect(env.createWorkerBoundary).not.toHaveBeenCalled();
      expect(env.createUrl).toHaveBeenCalledTimes(index);
      env.expectReleased();
      env.entries.set(url, new Response("restored cache entry"));
      await env.expectRetrySucceeds();
    }
  );

  test("aborting inference releases the worker and blob URLs and permits another recording", async () => {
    const env = setup();
    const { controller, result } = env.start();
    await env.posted;
    controller.abort();
    await rejects(result, /stopped or timed out/);
    env.expectReleased();
    await env.expectRetrySucceeds();
  });

  test("a cancelled request does not read cached files or start a worker", async () => {
    const env = setup();
    const controller = new AbortController();
    controller.abort();
    await rejects(env.start(controller).result, { name: "AbortError" });
    expect(env.createContext).not.toHaveBeenCalled();
    expect(env.decode).not.toHaveBeenCalled();
    expect(env.open).not.toHaveBeenCalled();
    expect(env.createWorkerBoundary).not.toHaveBeenCalled();
    env.expectReleased();
    await env.expectRetrySucceeds();
  });

  test("worker failure releases resources instead of returning a transcript", async () => {
    const env = setup();
    const { result } = env.start();
    await env.posted;
    env.respond({ error: "Not enough memory" });
    await rejects(result, /Not enough memory/);
    env.expectReleased();
    await env.expectRetrySucceeds();
  });
});

describe("local voice worker lifecycle", () => {
  test("returns text and clears listeners after completion", async () => {
    const { worker, boundary } = createWorker();
    const result = runLocalVoiceWorker(boundary, { type: "prepare" }, new AbortController().signal);
    worker.onmessage?.({ data: { text: "recognized speech" } } as MessageEvent<LocalVoiceResponse>);
    expect(await result).toBe("recognized speech");
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
  });

  test("aborting a worker request rejects and clears listeners", async () => {
    const { worker, boundary } = createWorker();
    const controller = new AbortController();
    const result = runLocalVoiceWorker(boundary, { type: "prepare" }, controller.signal);
    controller.abort();
    await rejects(result, /stopped or timed out/);
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
  });

  test("does not send work after cancellation", async () => {
    const { worker, boundary } = createWorker();
    const controller = new AbortController();
    controller.abort();
    await rejects(runLocalVoiceWorker(boundary, { type: "prepare" }, controller.signal));
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  test("propagates model errors instead of returning empty success", async () => {
    const { worker, boundary } = createWorker();
    const result = runLocalVoiceWorker(boundary, { type: "prepare" }, new AbortController().signal);
    worker.onmessage?.({
      data: { error: "Model cannot load" },
    } as MessageEvent<LocalVoiceResponse>);
    await rejects(result, /Model cannot load/);
    expect(worker.onmessage).toBeNull();
  });

  test("handles worker crashes", async () => {
    const { worker, boundary } = createWorker();
    const result = runLocalVoiceWorker(boundary, { type: "prepare" }, new AbortController().signal);
    worker.onerror?.();
    await rejects(result, /Local transcription failed/);
    expect(worker.onerror).toBeNull();
  });
});
