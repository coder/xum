import { afterEach, describe, expect, mock, test } from "bun:test";
import { createMuxMessage } from "@/common/types/message";
import type { CompactionFollowUpRequest, MuxMessage } from "@/common/types/message";
import type { FilePart, SendMessageOptions } from "@/common/orpc/types";
import type { Config } from "@/node/config";
import { AgentSession } from "./agentSession";
import { createStreamLifecycleMocks } from "./agentSession.testHarness";
import type { AIService } from "./aiService";
import type { BackgroundProcessManager } from "./backgroundProcessManager";
import type { InitStateManager } from "./initStateManager";
import { createTestHistoryService } from "./testHistoryService";

// NOTE: These tests validate crash-safe compaction follow-up recovery, including
// legacy `mode` fallback, without repeating a full AgentSession fixture per case.

type SendOptions = SendMessageOptions & { fileParts?: FilePart[] };

type SendMessageResult =
  | { success: true }
  | { success: false; error: { type: string; message?: string } };

interface AutoRetryResumeRequest {
  options: SendMessageOptions;
  agentInitiated?: boolean;
  stepBudget?: number;
  modelFallbackProgress?: unknown;
  revalidateAdmission?: boolean;
}

interface SendInternal {
  synthetic?: boolean;
  agentInitiated?: boolean;
  stepBudget?: number;
  modelFallbackProgress?: unknown;
  revalidateAdmission?: boolean;
  refuseStreamStart?: () => boolean;
}

interface SessionInternals {
  dispatchPendingFollowUp: () => Promise<boolean>;
  sendMessage: (
    message: string,
    options?: SendOptions,
    internal?: SendInternal
  ) => Promise<SendMessageResult>;
  scheduleStartupRecovery: () => void;
  startupRecoveryPromise: Promise<void> | null;
  startupRecoveryScheduled: boolean;
  lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
}

const idleFollowUp = (): CompactionFollowUpRequest => ({
  text: "heartbeat follow-up",
  model: "openai:gpt-4o",
  agentId: "exec",
  dispatchOptions: { requireIdle: true },
});

function compactionSummaryMessage(
  id: string,
  pendingFollowUp: CompactionFollowUpRequest
): MuxMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: "Compaction summary" }],
    metadata: {
      muxMetadata: {
        type: "compaction-summary",
        pendingFollowUp,
      },
    },
  } satisfies MuxMessage;
}

/**
 * RLM keep-recent floor: a durable compaction boundary summary followed by
 * preserved-tail copies. The startup follow-up recovery branch must locate the
 * summary through the epoch read when the last history row is a tail copy.
 */
function rlmSummaryBoundaryMessage(pendingFollowUp: CompactionFollowUpRequest): MuxMessage {
  return createMuxMessage("rlm-summary", "assistant", "Compaction summary", {
    compacted: true,
    compactionBoundary: true,
    compactionEpoch: 1,
    muxMetadata: {
      type: "compaction-summary",
      pendingFollowUp,
    },
  });
}

function preservedTailCopy(id: string, role: "user" | "assistant", text: string): MuxMessage {
  return createMuxMessage(id, role, text, {
    synthetic: true,
    rlmPreservedTailCopy: true,
  });
}

function heartbeatBoundaryMessage(pendingFollowUp = idleFollowUp()): MuxMessage {
  return createMuxMessage("heartbeat-boundary", "assistant", "Reset boundary", {
    compacted: "heartbeat",
    compactionBoundary: true,
    compactionEpoch: 1,
    muxMetadata: {
      type: "compaction-summary",
      pendingFollowUp,
    },
  });
}

function createAiService(): AIService {
  return {
    on() {
      return this;
    },
    off() {
      return this;
    },
    ...createStreamLifecycleMocks(),
    isStreaming: () => false,
    stopStream: mock(() => Promise.resolve({ success: true as const, data: undefined })),
  } as unknown as AIService;
}

function createInitStateManager(): InitStateManager {
  return {
    on() {
      return this;
    },
    off() {
      return this;
    },
  } as unknown as InitStateManager;
}

function createBackgroundProcessManager(): BackgroundProcessManager {
  return {
    cleanup: mock(() => Promise.resolve()),
    setMessageQueued: mock(() => undefined),
  } as unknown as BackgroundProcessManager;
}

function createConfig(): Config {
  return {
    rootDir: "/tmp",
    sessionsDir: "/tmp",
    srcDir: "/tmp",
    loadConfigOrDefault: mock(() => ({})),
  } as unknown as Config;
}

describe("AgentSession continue-message agentId fallback", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  const sessions: AgentSession[] = [];

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      session.dispose();
    }
    await historyCleanup?.();
    historyCleanup = undefined;
  });

  const createSession = async (
    messages: MuxMessage[] = [],
    turnOptions?: Pick<
      ConstructorParameters<typeof AgentSession>[0],
      "admitStrandedTurnResume" | "settleForfeitedWorkspaceTurnContinuation"
    >
  ) => {
    const { historyService, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    for (const message of messages) {
      await historyService.appendToHistory("ws", message);
    }

    const session = new AgentSession({
      workspaceId: "ws",
      config: createConfig(),
      historyService,
      aiService: createAiService(),
      initStateManager: createInitStateManager(),
      backgroundProcessManager: createBackgroundProcessManager(),
      ...turnOptions,
    });
    sessions.push(session);

    return {
      session,
      historyService,
      internals: session as unknown as SessionInternals,
    };
  };

  test("legacy continueMessage.mode does not fall back to compact agent", async () => {
    let dispatchedMessage: string | undefined;
    let dispatchedOptions: SendOptions | undefined;
    let dispatchedInternal: { synthetic?: boolean; agentInitiated?: boolean } | undefined;
    const legacyFollowUp = {
      text: "follow up",
      model: "openai:gpt-4o",
      agentId: undefined as unknown as string,
      mode: "plan" as const,
    };
    const { internals } = await createSession([
      compactionSummaryMessage("summary-1", legacyFollowUp),
    ]);

    internals.sendMessage = mock(
      (
        message: string,
        options?: SendOptions,
        internal?: { synthetic?: boolean; agentInitiated?: boolean }
      ) => {
        dispatchedMessage = message;
        dispatchedOptions = options;
        dispatchedInternal = internal;
        return Promise.resolve({ success: true as const });
      }
    );

    await internals.dispatchPendingFollowUp();

    expect(dispatchedMessage).toBe("follow up");
    expect(dispatchedOptions?.agentId).toBe("plan");
    expect(dispatchedInternal?.synthetic).toBe(true);
  });

  test("dispatchPendingFollowUp aliases legacy exclusive-PTC experiments", async () => {
    // An older build can persist {programmaticToolCalling: false,
    // programmaticToolCallingExclusive: true}; dispatch copies raw persisted
    // JSON into the next send, and the explicit false would otherwise win
    // over backend overrides while the removed legacy field is ignored —
    // silently downgrading the crash-safe follow-up to PTC-off (and making
    // its rlm flag inert).
    let dispatchedOptions: SendOptions | undefined;
    const { internals } = await createSession([
      compactionSummaryMessage("summary-legacy-ptc", {
        text: "continue after compaction",
        model: "openai:gpt-4o",
        agentId: "exec",
        experiments: {
          programmaticToolCalling: false,
          programmaticToolCallingExclusive: true,
          rlm: true,
        },
      }),
    ]);
    internals.sendMessage = mock((_message: string, options?: SendOptions) => {
      dispatchedOptions = options;
      return Promise.resolve({ success: true as const });
    });

    await internals.dispatchPendingFollowUp();

    expect(dispatchedOptions?.experiments?.programmaticToolCalling).toBe(true);
    expect(dispatchedOptions?.experiments?.rlm).toBe(true);
  });

  test("dispatchPendingFollowUp preserves agent-initiated attribution", async () => {
    let dispatchedInternal: { synthetic?: boolean; agentInitiated?: boolean } | undefined;
    const { internals } = await createSession([
      compactionSummaryMessage("summary-agent-initiated", {
        text: "continue delegated work",
        model: "openai:gpt-4o",
        agentId: "exec",
        agentInitiated: true,
      }),
    ]);
    internals.sendMessage = mock(
      (
        _message: string,
        _options?: SendOptions,
        internal?: { synthetic?: boolean; agentInitiated?: boolean }
      ) => {
        dispatchedInternal = internal;
        return Promise.resolve({ success: true as const });
      }
    );

    await internals.dispatchPendingFollowUp();

    expect(dispatchedInternal).toMatchObject({ synthetic: true, agentInitiated: true });
    expect(internals.lastAutoRetryResumeRequest?.agentInitiated).toBe(true);
  });

  test("dispatchPendingFollowUp continues the interrupted turn's step budget, fallback chain, and admission revalidation", async () => {
    const progress = {
      requestedModel: "anthropic:claude-sonnet-4-5",
      refusedModels: ["anthropic:claude-sonnet-4-5"],
      chain: ["openai:gpt-4o", "google:gemini-fallback"],
    };
    const dispatched: SendInternal[] = [];
    const { internals } = await createSession([
      compactionSummaryMessage("summary-remainder", {
        text: "Continue",
        model: "openai:gpt-4o",
        agentId: "exec",
        stepBudget: 7,
        modelFallbackProgress: progress,
        revalidateAdmission: true,
      }),
    ]);
    internals.sendMessage = mock(
      (_message: string, _options?: SendOptions, internal?: SendInternal) => {
        dispatched.push(internal ?? {});
        return Promise.resolve({ success: true as const });
      }
    );

    await internals.dispatchPendingFollowUp();

    expect(dispatched[0]).toMatchObject({
      stepBudget: 7,
      modelFallbackProgress: progress,
      revalidateAdmission: true,
    });
    expect(internals.lastAutoRetryResumeRequest).toMatchObject({
      stepBudget: 7,
      modelFallbackProgress: progress,
      revalidateAdmission: true,
    });
  });

  const DELEGATED_TURN = {
    type: "workspace-turn-task",
    taskHandleId: "wst_follow_up",
    ownerWorkspaceId: "owner-ws",
    turnId: "turn-follow-up",
  } as const;

  test("dispatchPendingFollowUp discards a follow-up whose interrupted turn spent its step budget", async () => {
    const settle = mock((_correlation: unknown, _reason: string) => Promise.resolve());
    const { internals, historyService } = await createSession(
      [
        compactionSummaryMessage("summary-spent", {
          text: "Continue",
          model: "openai:gpt-4o",
          agentId: "exec",
          stepBudget: 0,
          muxMetadata: DELEGATED_TURN,
        }),
      ],
      { settleForfeitedWorkspaceTurnContinuation: settle }
    );
    const sendMessage = mock(() => Promise.resolve({ success: true as const }));
    internals.sendMessage = sendMessage;

    expect(await internals.dispatchPendingFollowUp()).toBe(false);

    // The ceiling ended the turn; the follow-up is dropped rather than left to redispatch later,
    // and the delegated turn it continued is settled since no successor stream will end it.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]?.[0]).toEqual(DELEGATED_TURN);
    const tail = await historyService.getLastMessages("ws", 1);
    expect(tail.success).toBe(true);
    const summary = tail.success ? tail.data[0] : undefined;
    expect(summary?.id).toBe("summary-spent");
    expect(summary?.metadata?.muxMetadata).toEqual({ type: "compaction-summary" });
  });

  test("dispatchPendingFollowUp admits a delegated turn's follow-up like a stranded resume", async () => {
    const settle = mock((_correlation: unknown, _reason: string) => Promise.resolve());
    let stale = false;
    const admit = mock((_correlation: unknown) =>
      Promise.resolve({ admissible: true, admissionStale: () => stale })
    );
    const dispatched: SendInternal[] = [];
    const { internals } = await createSession(
      [
        compactionSummaryMessage("summary-delegated", {
          text: "Continue",
          model: "openai:gpt-4o",
          agentId: "exec",
          muxMetadata: DELEGATED_TURN,
        }),
      ],
      { admitStrandedTurnResume: admit, settleForfeitedWorkspaceTurnContinuation: settle }
    );
    internals.sendMessage = mock(
      (_message: string, _options?: SendOptions, internal?: SendInternal) => {
        dispatched.push(internal ?? {});
        return Promise.resolve({ success: true as const });
      }
    );

    expect(await internals.dispatchPendingFollowUp()).toBe(true);

    // Admitted against the delegated turn, with the handle probe carried to the launch boundary.
    expect(admit.mock.calls[0]?.[0]).toEqual(DELEGATED_TURN);
    expect(dispatched[0]?.refuseStreamStart?.()).toBe(false);
    stale = true;
    expect(dispatched[0]?.refuseStreamStart?.()).toBe(true);
    expect(settle).not.toHaveBeenCalled();
  });

  test("dispatchPendingFollowUp settles and drops a delegated turn's follow-up its owner no longer admits", async () => {
    const settle = mock((_correlation: unknown, _reason: string) => Promise.resolve());
    const { internals, historyService } = await createSession(
      [
        compactionSummaryMessage("summary-refused", {
          text: "Continue",
          model: "openai:gpt-4o",
          agentId: "exec",
          muxMetadata: DELEGATED_TURN,
        }),
      ],
      {
        admitStrandedTurnResume: mock(() => Promise.resolve({ admissible: false })),
        settleForfeitedWorkspaceTurnContinuation: settle,
      }
    );
    const sendMessage = mock(() => Promise.resolve({ success: true as const }));
    internals.sendMessage = sendMessage;

    expect(await internals.dispatchPendingFollowUp()).toBe(false);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]?.[0]).toEqual(DELEGATED_TURN);
    const tail = await historyService.getLastMessages("ws", 1);
    const summary = tail.success ? tail.data[0] : undefined;
    expect(summary?.metadata?.muxMetadata).toEqual({ type: "compaction-summary" });
  });

  test("dispatchPendingFollowUp drops a malformed persisted remainder", async () => {
    const dispatched: SendInternal[] = [];
    const { internals } = await createSession([
      compactionSummaryMessage("summary-malformed-remainder", {
        text: "Continue",
        model: "openai:gpt-4o",
        agentId: "exec",
        stepBudget: "seven" as unknown as number,
        modelFallbackProgress: {
          requestedModel: 1,
        } as unknown as CompactionFollowUpRequest["modelFallbackProgress"],
      }),
    ]);
    internals.sendMessage = mock(
      (_message: string, _options?: SendOptions, internal?: SendInternal) => {
        dispatched.push(internal ?? {});
        return Promise.resolve({ success: true as const });
      }
    );

    await internals.dispatchPendingFollowUp();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.stepBudget).toBeUndefined();
    expect(dispatched[0]?.modelFallbackProgress).toBeUndefined();
  });

  test("dispatchPendingFollowUp forwards strictAgentResolution to the resumed turn", async () => {
    let dispatchedOptions: SendOptions | undefined;
    const { internals } = await createSession([
      compactionSummaryMessage("summary-strict", {
        text: "continue delegated work",
        model: "openai:gpt-4o",
        agentId: "plan",
        strictAgentResolution: true,
      }),
    ]);
    internals.sendMessage = mock((_message: string, options?: SendOptions) => {
      dispatchedOptions = options;
      return Promise.resolve({ success: true as const });
    });

    await internals.dispatchPendingFollowUp();

    // The requested agent may have been removed/hidden/disabled while compaction ran;
    // the resumed turn must stay loud instead of silently falling back to exec.
    expect(dispatchedOptions?.agentId).toBe("plan");
    expect(dispatchedOptions?.strictAgentResolution).toBe(true);
  });

  test("dispatchPendingFollowUp skips idle-only follow-ups when queued user input exists", async () => {
    const { session, historyService, internals } = await createSession([
      compactionSummaryMessage("summary-idle-only", idleFollowUp()),
    ]);
    internals.sendMessage = mock(() => Promise.resolve({ success: true as const }));
    session.queueMessage(
      "user returned",
      { model: "openai:gpt-4o", agentId: "exec" },
      { synthetic: false }
    );

    const dispatched = await internals.dispatchPendingFollowUp();

    expect(dispatched).toBe(false);
    expect(internals.sendMessage).not.toHaveBeenCalled();

    const lastMessages = await historyService.getLastMessages("ws", 1);
    expect(lastMessages.success).toBe(true);
    if (!lastMessages.success) {
      throw new Error(`Expected history read to succeed: ${lastMessages.error}`);
    }
    expect(lastMessages.data[0]?.metadata?.muxMetadata).toEqual({ type: "compaction-summary" });
  });

  test("dispatchPendingFollowUp removes heartbeat reset boundaries when idle-only follow-ups are skipped", async () => {
    const earlierMessage = createMuxMessage("before-reset", "assistant", "Earlier context");
    const { session, historyService, internals } = await createSession([
      earlierMessage,
      heartbeatBoundaryMessage(),
    ]);
    internals.sendMessage = mock(() => Promise.resolve({ success: true as const }));
    session.queueMessage(
      "user returned",
      { model: "openai:gpt-4o", agentId: "exec" },
      { synthetic: false }
    );

    const dispatched = await internals.dispatchPendingFollowUp();

    expect(dispatched).toBe(false);
    expect(internals.sendMessage).not.toHaveBeenCalled();

    const historyResult = await historyService.getLastMessages("ws", 10);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`Expected history read to succeed: ${historyResult.error}`);
    }
    expect(historyResult.data.map((message) => message.id)).toEqual(["before-reset"]);
  });

  test("dispatchPendingFollowUp rolls back heartbeat boundaries when a service send is in preflight", async () => {
    // Codex P2 (PRRT_kwDOPxxmWM6cRi_N): a manual service-level send still in
    // preflight is user contention too — the heartbeat reset boundary must be
    // rolled back (as for queued input), not left in history with the
    // follow-up silently cleared.
    const earlierMessage = createMuxMessage("before-reset", "assistant", "Earlier context");
    const { session, historyService, internals } = await createSession([
      earlierMessage,
      heartbeatBoundaryMessage(),
    ]);
    internals.sendMessage = mock(() => Promise.resolve({ success: true as const }));
    (session as unknown as { hasExternalSendPreflight?: () => boolean }).hasExternalSendPreflight =
      () => true;

    const dispatched = await internals.dispatchPendingFollowUp();

    expect(dispatched).toBe(false);
    expect(internals.sendMessage).not.toHaveBeenCalled();

    const historyResult = await historyService.getLastMessages("ws", 10);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`Expected history read to succeed: ${historyResult.error}`);
    }
    expect(historyResult.data.map((message) => message.id)).toEqual(["before-reset"]);
  });

  test("dispatchPendingFollowUp skips idle-only follow-ups when a new turn is already active", async () => {
    const { historyService, internals } = await createSession([
      compactionSummaryMessage("summary-active-turn", idleFollowUp()),
    ]);
    const busyInternals = internals as SessionInternals & { isBusy: () => boolean };
    busyInternals.sendMessage = mock(() => Promise.resolve({ success: true as const }));
    busyInternals.isBusy = () => true;

    const dispatched = await busyInternals.dispatchPendingFollowUp();

    expect(dispatched).toBe(false);
    expect(busyInternals.sendMessage).not.toHaveBeenCalled();

    const lastMessages = await historyService.getLastMessages("ws", 1);
    expect(lastMessages.success).toBe(true);
    if (!lastMessages.success) {
      throw new Error(`Expected history read to succeed: ${lastMessages.error}`);
    }
    expect(lastMessages.data[0]?.metadata?.muxMetadata).toEqual({ type: "compaction-summary" });
  });

  test("dispatchPendingFollowUp keeps heartbeat reset boundaries once a non-idle turn has started", async () => {
    const { historyService, internals } = await createSession([heartbeatBoundaryMessage()]);
    const busyInternals = internals as SessionInternals & { isBusy: () => boolean };
    busyInternals.sendMessage = mock(() => Promise.resolve({ success: true as const }));
    busyInternals.isBusy = () => true;

    const dispatched = await busyInternals.dispatchPendingFollowUp();

    expect(dispatched).toBe(false);
    expect(busyInternals.sendMessage).not.toHaveBeenCalled();

    const historyResult = await historyService.getLastMessages("ws", 10);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`Expected history read to succeed: ${historyResult.error}`);
    }
    expect(historyResult.data[0]?.id).toBe("heartbeat-boundary");
    expect(historyResult.data[0]?.metadata?.muxMetadata).toEqual({ type: "compaction-summary" });
  });

  test("dispatchPendingFollowUp still runs idle-only follow-ups during compaction completion", async () => {
    const { internals } = await createSession([
      compactionSummaryMessage("summary-completing-turn", idleFollowUp()),
    ]);
    const completingInternals = internals as SessionInternals & { turnPhase: string };
    completingInternals.sendMessage = mock(() => Promise.resolve({ success: true as const }));
    completingInternals.turnPhase = "completing";

    const dispatched = await completingInternals.dispatchPendingFollowUp();

    expect(dispatched).toBe(true);
    expect(completingInternals.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("dispatchPendingFollowUp rewrites stale compact retry state to the reconstructed follow-up", async () => {
    const legacyFollowUp = {
      text: "follow up retry",
      model: "openai:gpt-4o",
      agentId: undefined as unknown as string,
      mode: "plan" as const,
      allowAgentSetGoal: true,
      thinkingLevel: "high" as const,
    };
    const { internals } = await createSession([
      compactionSummaryMessage("summary-retry-state", legacyFollowUp),
    ]);
    internals.lastAutoRetryResumeRequest = {
      options: {
        model: "openai:gpt-4o-mini",
        agentId: "compact",
        toolPolicy: [{ regex_match: ".*", action: "disable" }],
      },
      agentInitiated: true,
    };
    internals.sendMessage = mock(() =>
      Promise.resolve({
        success: false as const,
        error: { type: "runtime_start_failed", message: "startup failed" },
      })
    );

    let dispatchError: unknown;
    try {
      await internals.dispatchPendingFollowUp();
    } catch (error) {
      dispatchError = error;
    }

    expect(dispatchError).toBeInstanceOf(Error);
    if (!(dispatchError instanceof Error)) {
      throw new Error("Expected dispatchPendingFollowUp to throw when sendMessage fails");
    }
    expect(dispatchError.message).toContain("Failed to dispatch pending follow-up");
    expect(internals.lastAutoRetryResumeRequest?.options.model).toBe("openai:gpt-4o");
    expect(internals.lastAutoRetryResumeRequest?.options.agentId).toBe("plan");
    expect(internals.lastAutoRetryResumeRequest?.options.allowAgentSetGoal).toBe(true);
    expect(internals.lastAutoRetryResumeRequest?.options.thinkingLevel).toBe("high");
    expect(internals.lastAutoRetryResumeRequest?.options.toolPolicy).toBeUndefined();
    expect(internals.lastAutoRetryResumeRequest?.agentInitiated).toBeUndefined();
  });

  test("dispatchPendingFollowUp throws when history read fails", async () => {
    const { internals } = await createSession();
    const historyInternals = internals as SessionInternals & {
      historyService: {
        getLastMessages: (
          workspaceId: string,
          count: number
        ) => Promise<{ success: boolean; error?: string; data: MuxMessage[] }>;
      };
    };
    historyInternals.historyService.getLastMessages = mock(() =>
      Promise.resolve({ success: false, error: "temporary history read failure", data: [] })
    );

    let dispatchError: unknown;
    try {
      await historyInternals.dispatchPendingFollowUp();
    } catch (error) {
      dispatchError = error;
    }

    expect(dispatchError).toBeInstanceOf(Error);
    if (!(dispatchError instanceof Error)) {
      throw new Error("Expected dispatchPendingFollowUp to throw on history read failures");
    }
    expect(dispatchError.message).toContain(
      "Failed to read history for startup follow-up recovery"
    );
  });

  test("startup recovery dispatches pending follow-up only once", async () => {
    let sendCount = 0;
    const { internals } = await createSession([
      compactionSummaryMessage("summary-once", {
        text: "follow up once",
        model: "openai:gpt-4o",
        agentId: "exec",
      }),
    ]);
    internals.sendMessage = mock(() => {
      sendCount += 1;
      return Promise.resolve({ success: true as const });
    });

    internals.scheduleStartupRecovery();
    internals.scheduleStartupRecovery();
    await internals.startupRecoveryPromise;

    expect(sendCount).toBe(1);
  });

  test("startup recovery retries pending follow-up after an initial send failure", async () => {
    let sendCount = 0;
    const { internals } = await createSession([
      compactionSummaryMessage("summary-retry", {
        text: "follow up retry",
        model: "openai:gpt-4o",
        agentId: "exec",
      }),
    ]);
    internals.sendMessage = mock(() => {
      sendCount += 1;
      if (sendCount === 1) {
        return Promise.resolve({
          success: false,
          error: { type: "runtime_start_failed", message: "startup failed" },
        });
      }
      return Promise.resolve({ success: true as const });
    });

    internals.scheduleStartupRecovery();
    await internals.startupRecoveryPromise;

    expect(sendCount).toBe(1);
    expect(internals.startupRecoveryScheduled).toBe(false);

    internals.scheduleStartupRecovery();
    await internals.startupRecoveryPromise;

    expect(sendCount).toBe(2);
    expect(internals.startupRecoveryScheduled).toBe(true);
  });

  // RLM keep-recent floor: post-crash recovery when the compaction summary is
  // no longer the last history row because preserved-tail copies trail it.
  test("startup recovery dispatches the follow-up when preserved-tail copies trail the summary", async () => {
    let dispatchedMessage: string | undefined;
    const { internals } = await createSession([
      rlmSummaryBoundaryMessage({
        text: "follow up after tail",
        model: "openai:gpt-4o",
        agentId: "exec",
      }),
      preservedTailCopy("tail-copy-1", "user", "original user message"),
      preservedTailCopy("tail-copy-2", "assistant", "original assistant reply"),
    ]);
    internals.sendMessage = mock((message: string) => {
      dispatchedMessage = message;
      return Promise.resolve({ success: true as const });
    });

    internals.scheduleStartupRecovery();
    await internals.startupRecoveryPromise;

    expect(dispatchedMessage).toBe("follow up after tail");
    expect(internals.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("startup recovery declines a trailing tail copy when a non-copy row follows the boundary", async () => {
    // Staleness guard: the epoch is not exactly [summary, ...tail copies], so
    // "compaction just completed" no longer holds and the follow-up must stay
    // parked on the summary for a later legitimate recovery.
    const { historyService, internals } = await createSession([
      rlmSummaryBoundaryMessage({
        text: "stale follow up",
        model: "openai:gpt-4o",
        agentId: "exec",
      }),
      preservedTailCopy("tail-copy-1", "user", "original user message"),
      createMuxMessage("post-compaction-turn", "assistant", "new turn after compaction"),
      preservedTailCopy("tail-copy-2", "assistant", "trailing copy"),
    ]);
    internals.sendMessage = mock(() => Promise.resolve({ success: true as const }));

    const dispatched = await internals.dispatchPendingFollowUp();

    expect(dispatched).toBe(false);
    expect(internals.sendMessage).not.toHaveBeenCalled();

    const historyResult = await historyService.getLastMessages("ws", 10);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`Expected history read to succeed: ${historyResult.error}`);
    }
    const summary = historyResult.data.find((message) => message.id === "rlm-summary");
    expect(summary?.metadata?.muxMetadata).toMatchObject({
      type: "compaction-summary",
      pendingFollowUp: { text: "stale follow up" },
    });
  });
});
