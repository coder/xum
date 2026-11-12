import { rejects } from "node:assert/strict";
import { describe, expect, mock, test } from "bun:test";
import { runLocalVoiceWorker } from "./localTranscription";
import type { LocalVoiceResponse } from "@/browser/workers/localVoiceWorker";

function createWorker() {
  const worker = {
    onmessage: null as ((event: MessageEvent<LocalVoiceResponse>) => void) | null,
    onerror: null as (() => void) | null,
    postMessage: mock(() => undefined),
  };
  return { worker, boundary: worker as unknown as Worker };
}

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
