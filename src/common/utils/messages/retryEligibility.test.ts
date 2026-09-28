import { describe, it, expect } from "bun:test";
import {
  getLastNonDecorativeMessage,
  getInterruptionContext,
  isNonRetryableSendError,
  isNonRetryableStreamError,
  isPreTokenInterruptedUserTurn,
  isProviderConfigFixableError,
  PENDING_STREAM_START_GRACE_PERIOD_MS,
} from "./retryEligibility";
import type { DisplayedMessage } from "@/common/types/message";
import type { SendMessageError } from "@/common/types/errors";

const userMessage = (
  overrides: Partial<Extract<DisplayedMessage, { type: "user" }>> = {}
): Extract<DisplayedMessage, { type: "user" }> => ({
  type: "user",
  id: "user-1",
  historyId: "user-1",
  content: "Hello",
  historySequence: 1,
  ...overrides,
});

const assistantMessage = (
  overrides: Partial<Extract<DisplayedMessage, { type: "assistant" }>> = {}
): Extract<DisplayedMessage, { type: "assistant" }> => ({
  type: "assistant",
  id: "assistant-1",
  historyId: "assistant-1",
  content: "Complete response",
  historySequence: 2,
  isStreaming: false,
  isPartial: false,
  isLastPartOfMessage: true,
  isCompacted: false,
  isIdleCompacted: false,
  ...overrides,
});

const streamErrorMessage = (
  overrides: Partial<Extract<DisplayedMessage, { type: "stream-error" }>> = {}
): Extract<DisplayedMessage, { type: "stream-error" }> => ({
  type: "stream-error",
  id: "error-1",
  historyId: "assistant-1",
  error: "Connection failed",
  errorType: "network",
  historySequence: 2,
  ...overrides,
});

const compactionBoundary = (
  overrides: Partial<Extract<DisplayedMessage, { type: "compaction-boundary" }>> = {}
): Extract<DisplayedMessage, { type: "compaction-boundary" }> => ({
  type: "compaction-boundary",
  id: "boundary-1",
  historySequence: 2,
  position: "end",
  ...overrides,
});

describe("getLastNonDecorativeMessage", () => {
  it("returns the latest actionable row when transcript ends with boundaries", () => {
    const messages: DisplayedMessage[] = [
      streamErrorMessage({ error: "Context length exceeded", errorType: "context_exceeded" }),
      compactionBoundary({ id: "boundary-end" }),
    ];

    const lastMessage = getLastNonDecorativeMessage(messages);
    expect(lastMessage?.id).toBe("error-1");
  });

  it("returns undefined when all rows are decorative", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "history-hidden",
        id: "history-hidden-1",
        hiddenCount: 10,
        historySequence: 3,
      },
      {
        type: "workspace-init",
        id: "workspace-init-1",
        historySequence: -1,
        status: "running",
        hookPath: ".mux/init",
        lines: [],
        progress: null,
        exitCode: null,
        timestamp: Date.now(),
        durationMs: null,
      },
      compactionBoundary({ historySequence: 4, position: "start" }),
    ];

    expect(getLastNonDecorativeMessage(messages)).toBeUndefined();
  });
});

describe("context budget retry suppression", () => {
  it("does not automatically retry either a preflight refusal or a terminal budget block", () => {
    expect(isNonRetryableSendError({ type: "context_budget_exceeded" })).toBe(true);
    expect(isNonRetryableSendError({ type: "context_budget_blocked" })).toBe(true);
    expect(isNonRetryableStreamError({ type: "context_budget_blocked" })).toBe(true);
    expect(
      getInterruptionContext([
        userMessage(),
        streamErrorMessage({ errorType: "context_budget_blocked" }),
      ]).isEligibleForAutoRetry
    ).toBe(false);
    expect(
      getInterruptionContext([userMessage(), streamErrorMessage({ errorType: "network" })])
        .isEligibleForAutoRetry
    ).toBe(true);
  });
});

describe("terminal budget rejection barriers", () => {
  it("does not skip a rejected user tail to revive older interrupted work", () => {
    const messages = [
      assistantMessage({ isPartial: true }),
      userMessage({ contextBudgetRejected: true }),
    ];
    expect(getInterruptionContext(messages).hasInterruptedStream).toBe(false);
    expect(getInterruptionContext(messages).isEligibleForAutoRetry).toBe(false);
    expect(isPreTokenInterruptedUserTurn(messages.at(-1), { reason: "user", at: 1 })).toBe(false);
    expect(
      getInterruptionContext([
        ...messages,
        userMessage({ id: "next", historyId: "next", historySequence: 3 }),
      ]).hasInterruptedStream
    ).toBe(true);
  });

  it("does not advertise a live retry action for a terminal context-budget error", () => {
    expect(
      getInterruptionContext([
        userMessage(),
        streamErrorMessage({ errorType: "context_budget_blocked" }),
      ]).hasInterruptedStream
    ).toBe(false);
    expect(
      getInterruptionContext([userMessage(), streamErrorMessage({ errorType: "network" })])
        .hasInterruptedStream
    ).toBe(true);
  });
});

describe("hasInterruptedStream", () => {
  it("returns false for empty messages", () => {
    expect(getInterruptionContext([]).hasInterruptedStream).toBe(false);
  });

  it("returns true for stream-error message", () => {
    const messages: DisplayedMessage[] = [userMessage(), streamErrorMessage()];
    expect(getInterruptionContext(messages).hasInterruptedStream).toBe(true);
  });

  it("ignores decorative compaction boundary rows when checking interruption", () => {
    const messages: DisplayedMessage[] = [
      userMessage(),
      streamErrorMessage(),
      compactionBoundary(),
    ];

    expect(getInterruptionContext(messages).hasInterruptedStream).toBe(true);
    expect(getInterruptionContext(messages).isEligibleForAutoRetry).toBe(true);
  });

  it("returns true for partial assistant message", () => {
    const messages: DisplayedMessage[] = [
      userMessage(),
      assistantMessage({ content: "Incomplete response", isPartial: true }),
    ];
    expect(getInterruptionContext(messages).hasInterruptedStream).toBe(true);
  });

  it("returns false for executing ask_user_question (waiting state)", () => {
    const messages: DisplayedMessage[] = [
      userMessage(),
      {
        type: "tool",
        id: "tool-1",
        historyId: "assistant-1",
        toolName: "ask_user_question",
        toolCallId: "call-1",
        args: { questions: [] },
        status: "executing",
        isPartial: true,
        historySequence: 2,
        isLastPartOfMessage: true,
      },
    ];

    expect(getInterruptionContext(messages).hasInterruptedStream).toBe(false);
  });
  it("returns true for partial tool message", () => {
    const messages: DisplayedMessage[] = [
      userMessage(),
      {
        type: "tool",
        id: "tool-1",
        historyId: "assistant-1",
        toolName: "bash",
        toolCallId: "call-1",
        args: { script: "echo test", timeout_secs: 10, display_name: "Test" },
        status: "interrupted",
        isPartial: true,
        historySequence: 2,
        isLastPartOfMessage: true,
      },
    ];
    expect(getInterruptionContext(messages).hasInterruptedStream).toBe(true);
  });

  it("returns true for partial reasoning message", () => {
    const messages: DisplayedMessage[] = [
      userMessage(),
      {
        type: "reasoning",
        id: "reasoning-1",
        historyId: "assistant-1",
        content: "Let me think...",
        historySequence: 2,
        isStreaming: false,
        isPartial: true,
        isLastPartOfMessage: true,
      },
    ];
    expect(getInterruptionContext(messages).hasInterruptedStream).toBe(true);
  });

  it("returns false for completed messages", () => {
    const messages: DisplayedMessage[] = [userMessage(), assistantMessage()];
    expect(getInterruptionContext(messages).hasInterruptedStream).toBe(false);
  });

  it("returns true when last message is user message (app restarted during slow model)", () => {
    const messages: DisplayedMessage[] = [
      userMessage(),
      assistantMessage(),
      userMessage({
        id: "user-2",
        historyId: "user-2",
        content: "Another question",
        historySequence: 3,
      }),
    ];
    expect(getInterruptionContext(messages, null).hasInterruptedStream).toBe(true);
  });

  it("suppresses retry while runtime startup is still in progress", () => {
    const messages: DisplayedMessage[] = [userMessage()];

    const runtimeStatus = {
      type: "runtime-status" as const,
      workspaceId: "ws-1",
      phase: "starting" as const,
      runtimeType: "ssh" as const,
      source: "runtime" as const,
      detail: "Starting workspace...",
    };

    expect(getInterruptionContext(messages, null, runtimeStatus).hasInterruptedStream).toBe(false);
    expect(getInterruptionContext(messages, null, runtimeStatus).isEligibleForAutoRetry).toBe(
      false
    );
  });

  it("keeps retry eligible for non-runtime startup breadcrumbs", () => {
    const messages: DisplayedMessage[] = [userMessage()];

    const runtimeStatus = {
      type: "runtime-status" as const,
      workspaceId: "ws-1",
      phase: "starting" as const,
      runtimeType: "ssh" as const,
      source: "startup" as const,
      detail: "Loading tools...",
    };

    expect(getInterruptionContext(messages, null, runtimeStatus).hasInterruptedStream).toBe(true);
    expect(getInterruptionContext(messages, null, runtimeStatus).isEligibleForAutoRetry).toBe(true);
  });

  it("returns false when message was sent very recently (within grace period)", () => {
    const messages: DisplayedMessage[] = [
      userMessage(),
      assistantMessage(),
      userMessage({
        id: "user-2",
        historyId: "user-2",
        content: "Another question",
        historySequence: 3,
      }),
    ];
    // Message sent 1 second ago - still within grace window
    const recentTimestamp = Date.now() - (PENDING_STREAM_START_GRACE_PERIOD_MS - 1000);
    expect(getInterruptionContext(messages, recentTimestamp).hasInterruptedStream).toBe(false);
  });

  it("returns true when user message has no response (slow model scenario)", () => {
    const messages: DisplayedMessage[] = [userMessage()];
    expect(getInterruptionContext(messages, null).hasInterruptedStream).toBe(true);
  });

  it("returns false when user message just sent (within grace period)", () => {
    const messages: DisplayedMessage[] = [userMessage()];
    const justSent = Date.now() - (PENDING_STREAM_START_GRACE_PERIOD_MS - 500);
    expect(getInterruptionContext(messages, justSent).hasInterruptedStream).toBe(false);
  });

  it("returns true when message sent beyond grace period (stream likely hung)", () => {
    const messages: DisplayedMessage[] = [userMessage()];
    const longAgo = Date.now() - (PENDING_STREAM_START_GRACE_PERIOD_MS + 1000);
    expect(getInterruptionContext(messages, longAgo).hasInterruptedStream).toBe(true);
  });

  describe("stream error types (all show manual retry UI)", () => {
    it("returns true for authentication errors (shows manual retry)", () => {
      const messages: DisplayedMessage[] = [
        userMessage(),
        streamErrorMessage({ error: "Invalid API key", errorType: "authentication" }),
      ];
      expect(getInterruptionContext(messages).hasInterruptedStream).toBe(true);
    });

    it("returns true for network errors", () => {
      const messages: DisplayedMessage[] = [
        userMessage(),
        streamErrorMessage({ error: "Network connection failed" }),
      ];
      expect(getInterruptionContext(messages).hasInterruptedStream).toBe(true);
    });
  });
});

describe("isEligibleForAutoRetry", () => {
  it("returns false for empty messages", () => {
    expect(getInterruptionContext([]).isEligibleForAutoRetry).toBe(false);
  });

  it("returns false for completed messages", () => {
    const messages: DisplayedMessage[] = [userMessage(), assistantMessage()];
    expect(getInterruptionContext(messages).isEligibleForAutoRetry).toBe(false);
  });

  describe("non-retryable error types", () => {
    it("returns false for authentication errors (requires user to fix API key)", () => {
      const messages: DisplayedMessage[] = [
        userMessage(),
        streamErrorMessage({ error: "Invalid API key", errorType: "authentication" }),
      ];
      expect(getInterruptionContext(messages).isEligibleForAutoRetry).toBe(false);
    });

    it("returns false for quota errors (requires user to upgrade/wait)", () => {
      const messages: DisplayedMessage[] = [
        userMessage(),
        streamErrorMessage({ error: "Usage quota exceeded", errorType: "quota" }),
      ];
      expect(getInterruptionContext(messages).isEligibleForAutoRetry).toBe(false);
    });

    it("returns false for model_not_found errors (requires user to select different model)", () => {
      const messages: DisplayedMessage[] = [
        userMessage(),
        streamErrorMessage({ error: "Model not found", errorType: "model_not_found" }),
      ];
      expect(getInterruptionContext(messages).isEligibleForAutoRetry).toBe(false);
    });

    it("returns false for context_exceeded errors (requires user to reduce context)", () => {
      const messages: DisplayedMessage[] = [
        userMessage(),
        streamErrorMessage({ error: "Context length exceeded", errorType: "context_exceeded" }),
      ];
      expect(getInterruptionContext(messages).isEligibleForAutoRetry).toBe(false);
    });

    it("keeps context_exceeded non-retryable when decorative boundaries are trailing", () => {
      const messages: DisplayedMessage[] = [
        userMessage(),
        streamErrorMessage({ error: "Context length exceeded", errorType: "context_exceeded" }),
        compactionBoundary({ id: "boundary-end" }),
      ];

      expect(getInterruptionContext(messages).hasInterruptedStream).toBe(true);
      expect(getInterruptionContext(messages).isEligibleForAutoRetry).toBe(false);
    });

    it("returns false for aborted errors (user cancelled)", () => {
      const messages: DisplayedMessage[] = [
        userMessage(),
        streamErrorMessage({ error: "Request aborted", errorType: "aborted" }),
      ];
      expect(getInterruptionContext(messages).isEligibleForAutoRetry).toBe(false);
    });
    it("returns false for runtime_not_ready errors (workspace needs attention)", () => {
      const messages: DisplayedMessage[] = [
        userMessage(),
        streamErrorMessage({
          error: "Coder workspace does not exist",
          errorType: "runtime_not_ready",
        }),
      ];
      expect(getInterruptionContext(messages).isEligibleForAutoRetry).toBe(false);
    });

    it("returns false for model_refusal errors (retrying will refuse again)", () => {
      const messages: DisplayedMessage[] = [
        userMessage(),
        streamErrorMessage({
          error: "The model refused to respond",
          errorType: "model_refusal",
        }),
      ];
      expect(getInterruptionContext(messages).isEligibleForAutoRetry).toBe(false);
    });

    it("keeps manual retry for a persisted reasoning_rejected error but never auto-retries it", () => {
      // Startup recovery reads this row back from history: the in-stream repair
      // already ran, so replaying the same request would be rejected again.
      const messages: DisplayedMessage[] = [
        userMessage(),
        streamErrorMessage({
          error: "The encrypted content for item rs_1 could not be verified.",
          errorType: "reasoning_rejected",
        }),
      ];
      expect(getInterruptionContext(messages).hasInterruptedStream).toBe(true);
      expect(getInterruptionContext(messages).isEligibleForAutoRetry).toBe(false);
    });
  });

  describe("retryable error types", () => {
    it("returns true for network errors", () => {
      const messages: DisplayedMessage[] = [
        userMessage(),
        streamErrorMessage({ error: "Network connection failed" }),
      ];
      expect(getInterruptionContext(messages).isEligibleForAutoRetry).toBe(true);
    });

    it("returns true for server errors", () => {
      const messages: DisplayedMessage[] = [
        userMessage(),
        streamErrorMessage({ error: "Internal server error", errorType: "server_error" }),
      ];
      expect(getInterruptionContext(messages).isEligibleForAutoRetry).toBe(true);
    });

    it("returns true for rate limit errors", () => {
      const messages: DisplayedMessage[] = [
        userMessage(),
        streamErrorMessage({ error: "Rate limit exceeded", errorType: "rate_limit" }),
      ];
      expect(getInterruptionContext(messages).isEligibleForAutoRetry).toBe(true);
    });

    it("returns true for runtime_start_failed errors (transient runtime start failures)", () => {
      const messages: DisplayedMessage[] = [
        userMessage(),
        streamErrorMessage({ error: "Failed to start runtime", errorType: "runtime_start_failed" }),
      ];
      expect(getInterruptionContext(messages).isEligibleForAutoRetry).toBe(true);
    });
  });

  describe("partial messages and user messages", () => {
    it("returns true for partial assistant messages", () => {
      const messages: DisplayedMessage[] = [
        userMessage(),
        assistantMessage({ content: "Incomplete response", isPartial: true }),
      ];
      expect(getInterruptionContext(messages).isEligibleForAutoRetry).toBe(true);
    });

    it("returns true for trailing user messages (app restart scenario)", () => {
      const messages: DisplayedMessage[] = [
        userMessage(),
        assistantMessage(),
        userMessage({
          id: "user-2",
          historyId: "user-2",
          content: "Another question",
          historySequence: 3,
        }),
      ];
      expect(getInterruptionContext(messages, null).isEligibleForAutoRetry).toBe(true);
    });

    it("hides retry barrier for user-initiated abort (Ctrl+C)", () => {
      const messages: DisplayedMessage[] = [userMessage()];
      const lastAbortReason = { reason: "user" as const, at: Date.now() };
      // User abort = intentional action, not an error - no warning banner
      expect(
        getInterruptionContext(messages, null, null, lastAbortReason).hasInterruptedStream
      ).toBe(false);
      expect(
        getInterruptionContext(messages, null, null, lastAbortReason).isEligibleForAutoRetry
      ).toBe(false);
    });

    it("hides retry barrier for startup abort", () => {
      const messages: DisplayedMessage[] = [userMessage()];
      const lastAbortReason = { reason: "startup" as const, at: Date.now() };
      // Startup abort = intentional action during app init, not an error
      expect(
        getInterruptionContext(messages, null, null, lastAbortReason).hasInterruptedStream
      ).toBe(false);
      expect(
        getInterruptionContext(messages, null, null, lastAbortReason).isEligibleForAutoRetry
      ).toBe(false);
    });
    it("returns false when user message sent very recently (within grace period)", () => {
      const messages: DisplayedMessage[] = [userMessage()];
      const justSent = Date.now() - (PENDING_STREAM_START_GRACE_PERIOD_MS - 500);
      expect(getInterruptionContext(messages, justSent).isEligibleForAutoRetry).toBe(false);
    });
  });
});

describe("isProviderConfigFixableError", () => {
  const fixableStreamErrors = ["authentication", "quota"];
  const fixableSendErrors = ["api_key_not_found", "oauth_not_connected", "provider_disabled"];

  for (const type of fixableStreamErrors) {
    it(`flags non-retryable stream error ${type} as config-fixable`, () => {
      expect(isNonRetryableStreamError({ type })).toBe(true);
      expect(isProviderConfigFixableError(type)).toBe(true);
    });
  }

  for (const type of fixableSendErrors) {
    it(`flags non-retryable send error ${type} as config-fixable`, () => {
      expect(isNonRetryableSendError({ type })).toBe(true);
      expect(isProviderConfigFixableError(type)).toBe(true);
    });
  }

  for (const type of [
    "network",
    "server_error",
    "rate_limit",
    "unknown",
    "context_exceeded",
    "model_refusal",
    "aborted",
    "runtime_not_ready",
    "model_not_found",
    "agent_resolution",
  ]) {
    it(`does not flag ${type} as config-fixable`, () => {
      expect(isProviderConfigFixableError(type)).toBe(false);
    });
  }

  it("flags agent_resolution as non-retryable (deterministic strict contract failure)", () => {
    expect(isNonRetryableStreamError({ type: "agent_resolution" })).toBe(true);
  });
});

describe("isNonRetryableSendError", () => {
  const cases: Array<{ error: SendMessageError; expected: boolean }> = [
    { error: { type: "api_key_not_found", provider: "anthropic" }, expected: true },
    { error: { type: "oauth_not_connected", provider: "codex" }, expected: true },
    { error: { type: "provider_disabled", provider: "openai" }, expected: true },
    { error: { type: "provider_not_supported", provider: "unknown-provider" }, expected: true },
    { error: { type: "invalid_model_string", message: "Invalid model format" }, expected: true },
    { error: { type: "unknown", raw: "Some transient error" }, expected: false },
    {
      error: { type: "runtime_not_ready", message: "Coder workspace does not exist" },
      expected: true,
    },
    {
      error: { type: "runtime_start_failed", message: "Failed to start runtime" },
      expected: false,
    },
    {
      error: {
        type: "incompatible_workspace",
        message: "This workspace uses a runtime configuration from a newer version of mux.",
      },
      expected: true,
    },
  ];

  for (const { error, expected } of cases) {
    it(`returns ${expected ? "true" : "false"} for ${error.type} error`, () => {
      expect(isNonRetryableSendError(error)).toBe(expected);
    });
  }
});

describe("isPreTokenInterruptedUserTurn", () => {
  it("is true for a trailing user message aborted by the user (pre-token interrupt)", () => {
    // No assistant row yet, so the partial-message divider path can't fire; the
    // user must still be able to continue the stopped turn.
    expect(isPreTokenInterruptedUserTurn(userMessage(), { reason: "user", at: Date.now() })).toBe(
      true
    );
  });

  it("is true for a startup abort (also suppresses RetryBarrier)", () => {
    expect(
      isPreTokenInterruptedUserTurn(userMessage(), { reason: "startup", at: Date.now() })
    ).toBe(true);
  });

  it("is false for a system abort (RetryBarrier owns recovery)", () => {
    expect(isPreTokenInterruptedUserTurn(userMessage(), { reason: "system", at: Date.now() })).toBe(
      false
    );
  });

  it("is false with no abort reason (app-restart case; RetryBarrier owns it)", () => {
    expect(isPreTokenInterruptedUserTurn(userMessage(), null)).toBe(false);
  });

  it("is false when the tail is an assistant message (partial path handles it)", () => {
    expect(
      isPreTokenInterruptedUserTurn(assistantMessage({ isPartial: true }), {
        reason: "user",
        at: Date.now(),
      })
    ).toBe(false);
  });
});
