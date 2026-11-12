import { rejects } from "node:assert/strict";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { runLocalVoiceWorker, transcribeLocally } from "./localTranscription";
import type { LocalVoiceRequest, LocalVoiceResponse } from "@/browser/workers/localVoiceWorker";
import {
  LOCAL_VOICE_MAX_SECONDS,
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
      LOCAL_VOICE_MODELS[id].files.map((file) => [
        voiceModelFileUrl(id, file),
        new Response(`cached ${file.name}`),
      ])
    );
    const match = mock((url: string) => Promise.resolve(entries.get(url)?.clone()));
    const open = mock((_name: string) => Promise.resolve({ match }));
    const lock = mock((_name: string, options: LockOptions, callback: () => Promise<void>) => {
      options.signal?.throwIfAborted();
      return callback();
    });
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

    function start(controller = new AbortController()) {
      controllers.push(controller);
      const result = transcribeLocally(id, audio, controller.signal);
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

  test("rejects concurrent calls without releasing the active transcription", async () => {
    const env = setup();
    const { result } = env.start();
    await env.posted;
    await rejects(env.start().result, /Another local transcription/);
    await rejects(env.start().result, /Another local transcription/);
    expect(env.decode).toHaveBeenCalledTimes(1);
    expect(env.createWorkerBoundary).toHaveBeenCalledTimes(1);
    expect(env.revokeUrl).not.toHaveBeenCalled();
    expect(env.worker.terminate).not.toHaveBeenCalled();
    env.respond();
    expect(await result).toBe("recognized speech");
    env.expectReleased();
    await env.expectRetrySucceeds();
  });

  test("rejects excessive duration before cache access and permits the duration limit", async () => {
    const env = setup();
    env.decoded.duration = LOCAL_VOICE_MAX_SECONDS + 1;
    await rejects(env.start().result, /Local recordings must be shorter/);
    expect(env.open).not.toHaveBeenCalled();
    expect(env.createUrl).not.toHaveBeenCalled();
    expect(env.createWorkerBoundary).not.toHaveBeenCalled();
    env.expectReleased();
    env.decoded.duration = LOCAL_VOICE_MAX_SECONDS;
    await env.expectRetrySucceeds();
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
