import { describe, expect, it } from "bun:test";
import type { DisplayedMessage } from "@/common/types/message";
import {
  getRetryBarrierDerivation,
  type RetryBarrierDerivationInput,
} from "./retryBarrierDerivation";

const user = (id: string): DisplayedMessage => ({
  type: "user",
  id,
  historyId: id,
  content: "Hello",
  historySequence: 1,
});

const partialAssistant = (id: string): DisplayedMessage => ({
  type: "assistant",
  id,
  historyId: id,
  content: "Partial response",
  historySequence: 2,
  isStreaming: false,
  isPartial: true,
  isLastPartOfMessage: true,
  isCompacted: false,
  isIdleCompacted: false,
});

const streamError = (errorType: "network" | "context_exceeded"): DisplayedMessage => ({
  type: "stream-error",
  id: "error-1",
  historyId: "assistant-1",
  error: "Connection failed",
  errorType,
  historySequence: 2,
});

const USER_ABORT = { reason: "user", at: 1 } as const;

function derive(
  overrides: Partial<RetryBarrierDerivationInput> & { messages: DisplayedMessage[] }
) {
  return getRetryBarrierDerivation({
    renderedMessages: overrides.messages,
    pendingStreamStartTime: null,
    runtimeStatus: null,
    lastAbortReason: null,
    autoRetryStatus: null,
    isHydratingTranscript: false,
    isTurnActive: false,
    transcriptOnly: false,
    ...overrides,
  });
}

describe("getRetryBarrierDerivation", () => {
  it("shows the retry barrier for an errored turn, but not while hydrating or a turn runs", () => {
    const messages = [user("u1"), streamError("network")];
    expect(derive({ messages }).showRetryBarrierUI).toBe(true);

    for (const hidden of [{ isHydratingTranscript: true }, { isTurnActive: true }]) {
      const result = derive({ messages, ...hidden });
      // Stays mounted (hidden) so its manual-retry state survives the attempt.
      expect(result.shouldMountRetryBarrier).toBe(true);
      expect(result.showRetryBarrier).toBe(false);
      expect(result.showRetryBarrierUI).toBe(false);
    }
  });

  it("never mounts the retry barrier for a context_exceeded error", () => {
    const result = derive({ messages: [user("u1"), streamError("context_exceeded")] });
    expect(result.shouldMountRetryBarrier).toBe(false);
    expect(result.showRetryBarrierUI).toBe(false);
  });

  it("marks a user-aborted partial with a divider that resumes only on the writable tail", () => {
    const messages = [user("u1"), partialAssistant("a1"), user("u2"), partialAssistant("a2")];
    const result = derive({ messages, lastAbortReason: USER_ABORT });
    expect(result.showRetryBarrier).toBe(false);
    expect([...result.interruptedBarrierMessageIds]).toEqual(["a1", "a2"]);
    expect(result.lastRetryCandidateMessage?.id).toBe("a2");
    expect(result.interruptedTailResumable).toBe(true);

    const readOnly = derive({ messages, lastAbortReason: USER_ABORT, transcriptOnly: true });
    expect(readOnly.interruptedTailResumable).toBe(false);
  });

  it("offers resume on a user turn interrupted before its first token", () => {
    const result = derive({ messages: [user("u1")], lastAbortReason: USER_ABORT });
    expect([...result.interruptedBarrierMessageIds]).toEqual(["u1"]);
    expect(result.interruptedTailResumable).toBe(true);
  });

  it("hides dividers while an auto-retry is scheduled or starting", () => {
    for (const autoRetryStatus of [
      { type: "auto-retry-scheduled", attempt: 1, delayMs: 1000, scheduledAt: 1 },
      { type: "auto-retry-starting", attempt: 1 },
    ] as const) {
      const result = derive({
        messages: [user("u1"), partialAssistant("a1")],
        autoRetryStatus,
      });
      expect(result.interruptedBarrierMessageIds.size).toBe(0);
      expect(result.interruptedTailResumable).toBe(false);
    }
  });
});
