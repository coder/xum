import { rejects } from "node:assert/strict";
import { describe, expect, test } from "bun:test";
import { readModelDownload } from "./localModelCache";
import type { VoiceModelFile } from "@/common/constants/localVoiceModels";

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
