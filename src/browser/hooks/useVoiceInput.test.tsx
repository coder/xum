import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { StrictMode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { installDom } from "../../../tests/ui/dom";
import type { VoiceModelId } from "@/common/constants/localVoiceModels";
import { useVoiceInput } from "./useVoiceInput";
import { supportsLocalVoice } from "@/browser/stores/LocalVoiceStore";
import { createTestApiClient } from "@/browser/testUtils";

let sampleByte = 128;
let sampleAudioFrame: (() => void) | null = null;
let stopTrack = mock(() => undefined);
let stream = createMediaStream();

class MediaRecorderMock {
  static isTypeSupported(_mimeType: string): boolean {
    return true;
  }

  readonly stream: MediaStream;
  state: RecordingState = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(mediaStream: MediaStream) {
    this.stream = mediaStream;
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"]) });
    this.onstop?.();
  }
}

class AnalyserNodeMock {
  frequencyBinCount = 128;
  fftSize = 256;
  smoothingTimeConstant = 0;

  getByteTimeDomainData(data: Uint8Array<ArrayBufferLike>): void {
    data.fill(sampleByte);
  }
}

class AudioContextMock {
  createAnalyser(): AnalyserNode {
    return new AnalyserNodeMock() as unknown as AnalyserNode;
  }

  createMediaStreamSource(_stream: MediaStream): MediaStreamAudioSourceNode {
    return {
      connect: (_destination: AudioNode) => undefined,
    } as unknown as MediaStreamAudioSourceNode;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function createMediaStream(): MediaStream {
  return {
    getTracks: () => [{ stop: stopTrack }],
  } as unknown as MediaStream;
}

const getUserMedia = mock((_constraints: MediaStreamConstraints) => Promise.resolve(stream));
const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
const originalMediaDevices = Object.getOwnPropertyDescriptor(globalThis.navigator, "mediaDevices");

function installVoiceGlobals(): void {
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: MediaRecorderMock as unknown as typeof MediaRecorder,
  });
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: AudioContextMock as unknown as typeof AudioContext,
  });
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
}

function restoreGlobal(
  name: "MediaRecorder" | "AudioContext",
  descriptor?: PropertyDescriptor
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
}

function sampleFrames(count: number): void {
  const sample = sampleAudioFrame;
  if (!sample) throw new Error("Expected voice input metering to be active");

  for (let index = 0; index < count; index += 1) sample();
}

function renderVoiceInput(useRecordingKeybinds = false, strict = false) {
  const transcribe = mock((_input: { audioBase64: string }) =>
    Promise.resolve({
      success: true as const,
      data: "transcript",
    })
  );
  const onSend = mock(() => undefined);
  const hook = renderHook(
    () =>
      useVoiceInput({
        useRecordingKeybinds,
        onSend,
        api: createTestApiClient({ voice: { transcribe } }),
        isTranscriptionAvailable: true,
        onTranscript: mock(() => undefined),
      }),
    strict ? { wrapper: StrictMode } : undefined
  );

  return { ...hook, transcribe, onSend };
}

describe("useVoiceInput", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    stopTrack = mock(() => undefined);
    stream = createMediaStream();
    sampleByte = 128;
    sampleAudioFrame = null;
    getUserMedia.mockClear();
    installVoiceGlobals();
    setSystemTime(new Date("2026-08-20T12:00:00.000Z"));

    window.setInterval = ((handler: () => void) => {
      sampleAudioFrame = handler;
      return 1;
    }) as typeof window.setInterval;
    window.clearInterval = ((_handle?: number) => {
      sampleAudioFrame = null;
    }) as typeof window.clearInterval;
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    setSystemTime();
  });

  afterAll(() => {
    restoreGlobal("MediaRecorder", originalMediaRecorder);
    restoreGlobal("AudioContext", originalAudioContext);
    if (originalMediaDevices) {
      Object.defineProperty(globalThis.navigator, "mediaDevices", originalMediaDevices);
    } else {
      Reflect.deleteProperty(globalThis.navigator, "mediaDevices");
    }
  });

  test("limits local model downloads to browsers and the main desktop window", () => {
    const descriptors = ["OfflineAudioContext", "caches"].map(
      (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
    );
    try {
      Object.defineProperty(globalThis, "OfflineAudioContext", {
        configurable: true,
        value: AudioContextMock,
      });
      Object.defineProperty(globalThis, "caches", { configurable: true, value: {} });
      Object.defineProperty(navigator, "locks", { configurable: true, value: {} });
      expect(supportsLocalVoice()).toBe(true);
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: "Xum Electron/44.3.0",
      });
      expect(supportsLocalVoice()).toBe(false);
      window.api = { platform: "linux", versions: { electron: "44.3.0" } };
      expect(supportsLocalVoice()).toBe(true);
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  test("does not offer recording in Electron remote-server windows", () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Xum Electron/44.3.0",
    });
    const { result } = renderVoiceInput();
    expect(result.current.isSupported).toBe(false);
    expect(result.current.shouldShowUI).toBe(false);
    expect(result.current.requiresSecureContext).toBe(false);
    act(() => result.current.start());
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
  });

  test("keeps recording available in the main Electron window", async () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Xum Electron/44.3.0",
    });
    window.api = { platform: "linux", versions: { electron: "44.3.0" } };
    const { result } = renderVoiceInput();
    expect(result.current.isSupported).toBe(true);
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe("recording"));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  test("the first recording survives Strict Mode effect replay", async () => {
    const { result, transcribe } = renderVoiceInput(false, true);
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe("recording"));
    sampleByte = 160;
    sampleFrames(5);
    setSystemTime(new Date("2026-08-20T12:00:00.600Z"));
    act(() => result.current.stop());
    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
  });

  test("Escape cancels transcription and restores the composer", async () => {
    const onTranscript = mock(() => undefined);
    const onError = mock(() => undefined);
    let signal: AbortSignal | undefined;
    const transcribe = mock(
      (_input: { audioBase64: string }, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise<{ success: true; data: string }>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
        });
      }
    );
    const api = createTestApiClient({ voice: { transcribe } });
    const { result } = renderHook(() =>
      useVoiceInput({
        api,
        onTranscript,
        onError,
        isTranscriptionAvailable: true,
        useRecordingKeybinds: true,
      })
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe("recording"));
    sampleByte = 160;
    sampleFrames(5);
    setSystemTime(new Date("2026-08-20T12:00:00.600Z"));
    act(() => result.current.stop());
    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitFor(() => expect(result.current.state).toBe("idle"));
    expect(signal?.aborted).toBe(true);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test("a settings change does not redirect an active recording", async () => {
    const transcribe = mock(() => Promise.resolve({ success: true as const, data: "speech" }));
    const api = createTestApiClient({ voice: { transcribe } });
    const { result, rerender } = renderHook(
      (props: { voiceModel: VoiceModelId | null }) =>
        useVoiceInput({
          api,
          voiceModel: props.voiceModel,
          isTranscriptionAvailable: true,
          onTranscript: () => undefined,
        }),
      { initialProps: { voiceModel: "openai" as VoiceModelId | null } }
    );
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe("recording"));
    rerender({ voiceModel: null });
    sampleByte = 160;
    sampleFrames(5);
    setSystemTime(new Date("2026-08-20T12:00:00.600Z"));
    act(() => result.current.stop());
    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
  });

  function desktopCanvas() {
    const viewport = document.createElement("div");
    viewport.setAttribute("data-desktop-viewport", "");
    const canvas = document.createElement("canvas");
    viewport.appendChild(canvas);
    document.body.appendChild(viewport);
    return canvas;
  }

  test.each([
    { key: "Escape", cancel: true, send: false },
    { key: " ", cancel: false, send: true },
    { key: "d", ctrlKey: true, cancel: false, send: false },
    { key: "d", metaKey: true, cancel: false, send: false },
  ])("guest recording shortcut %j leaves host recording unchanged", async (shortcut) => {
    Object.defineProperty(navigator, "platform", {
      value: "metaKey" in shortcut ? "MacIntel" : "Linux",
    });
    const { result, transcribe, onSend } = renderVoiceInput(true);
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe("recording"));
    sampleByte = 160;
    sampleFrames(5);
    setSystemTime(new Date("2026-08-20T12:00:00.600Z"));
    const canvas = desktopCanvas();
    const event = new window.KeyboardEvent("keydown", {
      ...shortcut,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      canvas.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(result.current.state).toBe("recording");
    expect(stopTrack).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();

    act(() => {
      document.body.dispatchEvent(
        new window.KeyboardEvent("keydown", { ...shortcut, bubbles: true })
      );
    });
    await waitFor(() => expect(result.current.state).toBe("idle"));
    expect(transcribe).toHaveBeenCalledTimes(shortcut.cancel ? 0 : 1);
    expect(onSend).toHaveBeenCalledTimes(shortcut.send ? 1 : 0);
  });

  test("guest Space keyup cannot clear the host held-at-start guard", async () => {
    const { result, transcribe } = renderVoiceInput(true);
    const canvas = desktopCanvas();
    document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe("recording"));
    sampleByte = 160;
    sampleFrames(5);
    setSystemTime(new Date("2026-08-20T12:00:00.600Z"));
    canvas.dispatchEvent(new window.KeyboardEvent("keyup", { key: " ", bubbles: true }));
    act(() => {
      document.body.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: " ", repeat: true, bubbles: true })
      );
    });
    expect(result.current.state).toBe("recording");
    expect(transcribe).not.toHaveBeenCalled();
    document.body.dispatchEvent(new window.KeyboardEvent("keyup", { key: " ", bubbles: true }));
    act(() => {
      document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
  });

  test("guest Space held before recording cannot suppress the first host send", async () => {
    const { result, onSend } = renderVoiceInput(true);
    desktopCanvas().dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe("recording"));
    sampleByte = 160;
    sampleFrames(5);
    setSystemTime(new Date("2026-08-20T12:00:00.600Z"));
    act(() => {
      document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  test("does not transcribe a silent recording", async () => {
    const { result, transcribe } = renderVoiceInput();

    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe("recording"));
    sampleFrames(5);
    setSystemTime(new Date("2026-08-20T12:00:00.600Z"));

    act(() => result.current.stop());
    await waitFor(() => expect(result.current.state).toBe("idle"));

    expect(transcribe).not.toHaveBeenCalled();
  });

  test("transcribes a voiced recording", async () => {
    const { result, transcribe } = renderVoiceInput();

    act(() => result.current.start());
    await waitFor(() => expect(result.current.state).toBe("recording"));
    sampleByte = 160;
    sampleFrames(5);
    setSystemTime(new Date("2026-08-20T12:00:00.600Z"));

    act(() => result.current.stop());
    await waitFor(() => expect(result.current.state).toBe("idle"));

    expect(transcribe).toHaveBeenCalledTimes(1);
  });
});
