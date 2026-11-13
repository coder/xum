import { rejects } from "node:assert/strict";
import { describe, expect, mock, test } from "bun:test";
import { createTestApiClient } from "@/browser/testUtils";
import { transcribeVoiceRecording } from "./transcribeVoiceRecording";

const audio = new Blob(["audio"]);
const signal = new AbortController().signal;

function cloud() {
  const transcribe = mock(() =>
    Promise.resolve({ success: true as const, data: "cloud transcript" })
  );
  return { transcribe, api: createTestApiClient({ voice: { transcribe } }) };
}

describe("voice transcription routing", () => {
  test("local transcription works without a backend or API key", async () => {
    const local = mock(() => Promise.resolve("local transcript"));
    expect(await transcribeVoiceRecording("parakeet-v3", audio, null, signal, local)).toEqual({
      success: true,
      data: "local transcript",
    });
    expect(local).toHaveBeenCalledWith("parakeet-v3", audio, signal);
  });

  test("local errors never fall back to the cloud", async () => {
    const { api, transcribe } = cloud();
    const local = mock(() => Promise.reject(new Error("Model unavailable")));
    await rejects(
      transcribeVoiceRecording("parakeet-v2", audio, api, signal, local),
      /Model unavailable/
    );
    expect(transcribe).not.toHaveBeenCalled();
  });

  test("cloud selection retains the backend transcription API", async () => {
    const { api, transcribe } = cloud();
    const local = mock(() => Promise.resolve("local transcript"));
    expect(await transcribeVoiceRecording("openai", audio, api, signal, local)).toEqual({
      success: true,
      data: "cloud transcript",
    });
    expect(transcribe).toHaveBeenCalledWith({ audioBase64: btoa("audio") }, { signal });
    expect(local).not.toHaveBeenCalled();
  });

  test("an invalid saved selection cannot upload audio", async () => {
    const { api, transcribe } = cloud();
    const local = mock(() => Promise.resolve("local transcript"));
    expect((await transcribeVoiceRecording(null, audio, api, signal, local)).success).toBe(false);
    expect(transcribe).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
  });
});
