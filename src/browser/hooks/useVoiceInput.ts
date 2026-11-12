/**
 * Voice input with local models or OpenAI transcription.
 *
 * State machine: idle → requesting → recording → transcribing → idle
 *
 * Hidden on touch devices where native keyboard dictation is available.
 */

import { useState, useCallback, useRef, useEffect, type MutableRefObject } from "react";
import { matchesKeybind, KEYBINDS, isDesktopViewportFocused } from "@/browser/utils/ui/keybinds";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import {
  shouldTranscribeRecording,
  SILENCE_GATE_SAMPLE_INTERVAL_MS,
} from "@/browser/utils/voice/silenceGate";
import type { APIClient } from "@/browser/contexts/API";
import { trackVoiceTranscription } from "@/common/telemetry";
import {
  isLocalVoiceModelId,
  LOCAL_VOICE_MAX_SECONDS,
  type VoiceModelId,
} from "@/common/constants/localVoiceModels";
import { transcribeVoiceRecording } from "@/browser/utils/voice/transcribeVoiceRecording";
import { hasTouchDictation, isRemoteVoiceCaptureBlocked } from "@/browser/stores/LocalVoiceStore";
import { getErrorMessage } from "@/common/utils/errors";

export type VoiceInputState = "idle" | "requesting" | "recording" | "transcribing";

export interface UseVoiceInputOptions {
  onTranscript: (text: string) => void;
  onError?: (error: string) => void;
  /** Called after successful transcription if stop({ send: true }) was used */
  onSend?: () => void;
  /** Whether the selected model has its required download or credentials. */
  isTranscriptionAvailable: boolean;
  voiceModel?: VoiceModelId | null;
  /**
   * When true, hook manages global keybinds during recording:
   * - Space: stop and send (requires release after start)
   * - Escape: cancel
   * - Ctrl+D / Cmd+D: stop without sending
   */
  useRecordingKeybinds?: boolean;
  /** oRPC API client for voice transcription */
  api?: APIClient | null;
}

export interface UseVoiceInputResult {
  state: VoiceInputState;
  isSupported: boolean;
  isAvailable: boolean;
  /** False on touch devices (they have native keyboard dictation) */
  shouldShowUI: boolean;
  /** True when running over HTTP (not localhost) - microphone requires secure context */
  requiresSecureContext: boolean;
  /** The active MediaRecorder instance when recording, for visualization */
  mediaRecorder: MediaRecorder | null;
  start: () => void;
  stop: (options?: { send?: boolean }) => void;
  cancel: () => void;
  toggle: () => void;
}

// =============================================================================
// Platform Detection
// =============================================================================

// Capability checks run at call time, not module load: this module can be evaluated
// before MediaRecorder/mediaDevices exist in the environment (notably under Bun's test
// module caching), which would otherwise freeze stale negatives.
function hasMediaRecorder(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    !isRemoteVoiceCaptureBlocked()
  );
}

function hasGetUserMedia(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

// =============================================================================
// Hook
// =============================================================================

export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const [state, setState] = useState<VoiceInputState>("idle");

  // Refs for MediaRecorder lifecycle
  // We use both ref (for callbacks) and state (to trigger re-render for visualizer)
  const recorderRef = useRef<MediaRecorder | null>(null);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingModelRef = useRef<VoiceModelId | null>("openai");
  const transcriptionControllerRef = useRef<AbortController | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordingDeadlineRef = useRef<number | undefined>(undefined);
  const meterIntervalRef = useRef<number | null>(null);
  const rmsFramesRef = useRef<number[]>([]);

  // Flags set before stopping to control post-stop behavior
  const shouldSendRef = useRef(false);
  const wasCancelledRef = useRef(false);

  // Track recording start time for duration telemetry
  const recordingStartTimeRef = useRef<number>(0);

  // Track whether Space is held outside React's render cycle, so a recording that starts after
  // async microphone access still knows the key was already down. Listeners attach to the
  // current window on mount (not at module load), so each mounted hook tracks the window it
  // actually runs in.
  const isSpaceHeldRef = useRef(false);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isDesktopViewportFocused(e.target)) return;
      if (e.key === " ") isSpaceHeldRef.current = true;
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (isDesktopViewportFocused(e.target)) return;
      if (e.key === " ") isSpaceHeldRef.current = false;
    };
    // Also reset on blur (user switches window while holding space).
    const handleBlur = () => {
      isSpaceHeldRef.current = false;
    };
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  // Keep callbacks fresh without recreating functions
  const callbacksRef = useRef(options);
  useEffect(() => {
    callbacksRef.current = options;
  }, [options]);

  // ---------------------------------------------------------------------------
  // Transcription
  // ---------------------------------------------------------------------------

  const transcribe = useCallback(async (audioBlob: Blob) => {
    setState("transcribing");

    // Capture and reset flags
    const shouldSend = shouldSendRef.current;
    shouldSendRef.current = false;

    // Calculate recording duration for telemetry
    const audioDurationSecs = (Date.now() - recordingStartTimeRef.current) / 1000;

    try {
      const controller = new AbortController();
      transcriptionControllerRef.current = controller;
      const result = await transcribeVoiceRecording(
        recordingModelRef.current,
        audioBlob,
        callbacksRef.current.api,
        controller.signal
      );
      if (controller.signal.aborted) return;

      if (!result.success) {
        callbacksRef.current.onError?.(result.error);
        trackVoiceTranscription(audioDurationSecs, false);
        return;
      }

      const text = result.data.trim();
      if (!text) {
        // Track empty transcription as success (API worked, just no speech)
        trackVoiceTranscription(audioDurationSecs, true);
        return;
      }

      // Track successful transcription
      trackVoiceTranscription(audioDurationSecs, true);

      callbacksRef.current.onTranscript(text);

      // If stop({ send: true }) was called, trigger send after React flushes
      if (shouldSend) {
        setTimeout(() => callbacksRef.current.onSend?.(), 0);
      }
    } catch (err) {
      if (transcriptionControllerRef.current?.signal.aborted) return;
      const msg = getErrorMessage(err);
      callbacksRef.current.onError?.(`Transcription failed: ${msg}`);
      trackVoiceTranscription(audioDurationSecs, false);
    } finally {
      transcriptionControllerRef.current = null;
      setState("idle");
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Release microphone and clean up recorder
  // ---------------------------------------------------------------------------

  const releaseStream = useCallback(() => {
    window.clearTimeout(recordingDeadlineRef.current);
    recordingDeadlineRef.current = undefined;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const stopMetering = useCallback(() => {
    if (meterIntervalRef.current !== null) {
      window.clearInterval(meterIntervalRef.current);
      meterIntervalRef.current = null;
    }

    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    audioContext?.close().catch(() => undefined);
  }, []);

  const startMetering = useCallback(
    (stream: MediaStream) => {
      stopMetering();
      rmsFramesRef.current = [];

      try {
        const audioContext = new AudioContext();
        audioContextRef.current = audioContext;

        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        meterIntervalRef.current = window.setInterval(() => {
          try {
            analyser.getByteTimeDomainData(data);

            let sum = 0;
            for (const sample of data) {
              const normalized = (sample - 128) / 128;
              sum += normalized * normalized;
            }
            rmsFramesRef.current.push(Math.sqrt(sum / data.length));
          } catch {
            rmsFramesRef.current = [];
            stopMetering();
          }
        }, SILENCE_GATE_SAMPLE_INTERVAL_MS);
      } catch {
        // Metering is best-effort; the gate fails open when no samples are available.
        stopMetering();
      }
    },
    [stopMetering]
  );

  // ---------------------------------------------------------------------------
  // Stop Recording (triggers transcription)
  // ---------------------------------------------------------------------------

  const stop = useCallback((options?: { send?: boolean }) => {
    window.clearTimeout(recordingDeadlineRef.current);
    if (options?.send) shouldSendRef.current = true;

    if (recorderRef.current?.state !== "inactive") {
      recorderRef.current?.stop();
      recorderRef.current = null;
      setMediaRecorder(null);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Start Recording
  // ---------------------------------------------------------------------------

  const start = useCallback(async () => {
    // Guard: only start from idle state with valid configuration
    const canStart =
      hasMediaRecorder() &&
      hasGetUserMedia() &&
      !hasTouchDictation() &&
      state === "idle" &&
      callbacksRef.current.isTranscriptionAvailable;

    if (!canStart) return;
    wasCancelledRef.current = false;

    // Keep the selected provider for this recording. Settings changes must not redirect local audio.
    recordingModelRef.current =
      callbacksRef.current.voiceModel === undefined ? "openai" : callbacksRef.current.voiceModel;

    // Show loading state immediately while requesting mic access
    setState("requesting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (wasCancelledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        // Check if this was a cancel (discard audio) or normal stop (transcribe)
        const cancelled = wasCancelledRef.current;
        wasCancelledRef.current = false;
        const recordingDurationMs = Date.now() - recordingStartTimeRef.current;
        const shouldTranscribe = shouldTranscribeRecording({
          rmsFrames: rmsFramesRef.current,
          durationMs: recordingDurationMs,
        });

        const chunks = chunksRef.current;
        chunksRef.current = [];
        releaseStream();
        stopMetering();

        if (cancelled) {
          setState("idle");
        } else if (!shouldTranscribe) {
          shouldSendRef.current = false;
          setState("idle");
        } else {
          void transcribe(new Blob(chunks, { type: mimeType }));
        }
      };

      recorder.onerror = () => {
        callbacksRef.current.onError?.("Recording failed");
        releaseStream();
        stopMetering();
        setState("idle");
      };

      recorderRef.current = recorder;
      setMediaRecorder(recorder);
      startMetering(stream);
      recorder.start();
      recordingStartTimeRef.current = Date.now();
      if (isLocalVoiceModelId(recordingModelRef.current)) {
        // Stop local capture at its processing limit without discarding the completed recording.
        recordingDeadlineRef.current = window.setTimeout(stop, LOCAL_VOICE_MAX_SECONDS * 1000);
      }
      setState("recording");
    } catch (err) {
      stopMetering();
      releaseStream();

      const msg = getErrorMessage(err);
      const isPermissionDenied = msg.includes("Permission denied") || msg.includes("NotAllowed");

      callbacksRef.current.onError?.(
        isPermissionDenied
          ? "Microphone access denied. Please allow microphone access and try again."
          : `Failed to start recording: ${msg}`
      );
      setState("idle");
    }
  }, [state, transcribe, releaseStream, startMetering, stopMetering, stop]);

  // ---------------------------------------------------------------------------
  // Cancel Recording (discard audio, no transcription)
  // ---------------------------------------------------------------------------

  const cancel = useCallback(() => {
    wasCancelledRef.current = true;
    transcriptionControllerRef.current?.abort();
    stop();
  }, [stop]);

  // ---------------------------------------------------------------------------
  // Toggle (convenience for keybinds)
  // ---------------------------------------------------------------------------

  const toggle = useCallback(() => {
    if (state === "recording") stop();
    else if (state === "transcribing") cancel();
    else if (state === "idle") void start();
  }, [state, start, stop, cancel]);

  // ---------------------------------------------------------------------------
  // Cleanup on unmount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      wasCancelledRef.current = true;
      transcriptionControllerRef.current?.abort();
      recorderRef.current?.stop();
      releaseStream();
      stopMetering();
    };
  }, [releaseStream, stopMetering]);

  useVoiceRecordingKeys(options.useRecordingKeybinds, state, isSpaceHeldRef, stop, cancel);

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    state,
    isSupported: hasMediaRecorder() && hasGetUserMedia(),
    isAvailable: options.isTranscriptionAvailable,
    shouldShowUI: hasMediaRecorder() && !hasTouchDictation(),
    requiresSecureContext: hasMediaRecorder() && !hasGetUserMedia(),
    mediaRecorder,
    start: () => void start(),
    stop,
    cancel,
    toggle,
  };
}

function voiceKeyAction(
  event: KeyboardEvent,
  state: VoiceInputState,
  spaceHeld: boolean
): "cancel" | "send" | "stop" | null {
  // Guest desktop shortcuts must not control the host recording.
  if (isDesktopViewportFocused(event.target)) return null;
  if (event.key === "Escape") return "cancel";
  if (state === "transcribing") return null;
  if (event.key === " " && !spaceHeld) return "send";
  if (matchesKeybind(event, KEYBINDS.TOGGLE_VOICE_INPUT)) return "stop";
  return null;
}

function useVoiceRecordingKeys(
  enabled: boolean | undefined,
  state: VoiceInputState,
  isSpaceHeldRef: MutableRefObject<boolean>,
  stop: (options?: { send?: boolean }) => void,
  cancel: () => void
) {
  // Track if space was held when recording started to prevent immediate send
  const spaceHeldAtStartRef = useRef(false);

  useEffect(() => {
    if (!enabled || (state !== "recording" && state !== "transcribing")) {
      spaceHeldAtStartRef.current = false;
      return;
    }

    // Use global key state instead of assuming - handles async mic access delay
    spaceHeldAtStartRef.current = isSpaceHeldRef.current;

    const handleKeyUp = (e: KeyboardEvent) => {
      if (isDesktopViewportFocused(e.target)) return;
      if (e.key === " ") spaceHeldAtStartRef.current = false;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const action = voiceKeyAction(e, state, spaceHeldAtStartRef.current);
      if (action === null) return;
      e.preventDefault();
      if (action === "cancel") {
        stopKeyboardPropagation(e);
        cancel();
      } else {
        stop({ send: action === "send" });
      }
    };

    // Use capture phase to intercept before focused elements consume the event
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [enabled, state, stop, cancel, isSpaceHeldRef]);
}
