import type { TurnCoordinator } from "./turnCoordinator";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMuxMessage } from "@/common/types/message";
import type { CompactionFollowUpRequest, MuxMessage } from "@/common/types/message";
import assert from "@/common/utils/assert";
import { Err, Ok } from "@/common/types/result";
import type { FilePart, SendMessageOptions } from "@/common/orpc/types";
import type { Config } from "@/node/config";
import type { AgentSession } from "./agentSession";
import {
  createAgentSessionHarness,
  type AgentSessionHarnessOptions,
} from "./agentSession.testHarness";
import { createTestHistoryService } from "./testHistoryService";

// NOTE: These tests validate crash-safe compaction follow-up recovery, including
// legacy `mode` fallback, without repeating a full AgentSession fixture per case.

type SendOptions = SendMessageOptions & { fileParts?: FilePart[] };

interface AutoRetryResumeRequest {
  options: SendMessageOptions;
  agentInitiated?: boolean;
}

/**
 * Private state with no public observable: the coordinator is the only way to admit a turn
 * mid-cleanup, and the auto-retry envelope is only replayed by the timer-driven retry.
 */
interface SessionInternals {
  lastAutoRetryResumeRequest?: AutoRetryResumeRequest;
  coordinator: TurnCoordinator;
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

describe("AgentSession continue-message agentId fallback", () => {
  let historyCleanup: (() => Promise<void>) | undefined;
  const sessions: AgentSession[] = [];

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.dispose();
    }
    await historyCleanup?.();
    historyCleanup = undefined;
    mock.restore();
  });

  const createSession = async (
    messages: MuxMessage[] = [],
    seedConfig?: (config: Config) => Promise<void>,
    harnessOptions?: Pick<
      AgentSessionHarnessOptions,
      "hasExternalSendPreflight" | "onPostCompactionStateChange"
    >
  ) => {
    const { historyService, config, cleanup } = await createTestHistoryService();
    historyCleanup = cleanup;
    await seedConfig?.(config);
    for (const message of messages) {
      await historyService.appendToHistory("ws", message);
    }

    const { session } = await createAgentSessionHarness({
      workspaceId: "ws",
      config,
      historyService,
      ...harnessOptions,
    });
    sessions.push(session);

    return {
      session,
      historyService,
      internals: session as unknown as SessionInternals,
    };
  };

  test.each(
    [false, true].flatMap((heartbeat) =>
      [false, true].map((published) => ({ heartbeat, published }))
    )
  )(
    "a new turn respects the follow-up cleanup receipt (heartbeat=$heartbeat, published=$published)",
    async ({ heartbeat, published }) => {
      const summary = heartbeat
        ? heartbeatBoundaryMessage()
        : compactionSummaryMessage("summary", idleFollowUp());
      const changed = mock(() => undefined);
      const { session, historyService, internals } = await createSession([summary], undefined, {
        onPostCompactionStateChange: changed,
      });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const cleanup = historyService.cleanupCompactionFollowUp.bind(historyService);
      spyOn(historyService, "cleanupCompactionFollowUp").mockImplementationOnce(async (...args) => {
        const result = published ? await cleanup(...args) : undefined;
        entered.resolve();
        await release.promise;
        return result ?? cleanup(...args);
      });
      session.queueMessage("manual work", { model: "openai:gpt-4o", agentId: "exec" });
      const dispatch = session.dispatchPendingCompactionFollowUpIfNeeded();
      try {
        await entered.promise;
        const admission = internals.coordinator.prepare({
          kind: "fresh",
          intent: "direct",
          expectedTurnId: internals.coordinator.turnId,
        });
        expect(admission.status).toBe("admitted");
        release.resolve();
        expect(await dispatch).toBe(false);
        const history = await historyService.getLastMessages("ws", 1);
        assert(history.success, "Expected history after follow-up cleanup");
        if (!published) {
          expect(history.data[0].metadata?.muxMetadata).toHaveProperty("pendingFollowUp");
        } else if (heartbeat) {
          expect(history.data).toHaveLength(0);
        } else {
          expect(history.data[0].metadata?.muxMetadata).not.toHaveProperty("pendingFollowUp");
        }
        expect(changed).toHaveBeenCalledTimes(published && heartbeat ? 1 : 0);
      } finally {
        release.resolve();
        await dispatch;
      }
    }
  );

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
    const { session } = await createSession([
      compactionSummaryMessage("summary-1", legacyFollowUp),
    ]);

    spyOn(session, "sendMessage").mockImplementation(
      (
        message: string,
        options?: SendOptions,
        internal?: { synthetic?: boolean; agentInitiated?: boolean }
      ) => {
        dispatchedMessage = message;
        dispatchedOptions = options;
        dispatchedInternal = internal;
        return Promise.resolve(Ok(undefined));
      }
    );

    await session.dispatchPendingCompactionFollowUpIfNeeded();

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
    const { session } = await createSession([
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
    spyOn(session, "sendMessage").mockImplementation((_message: string, options?: SendOptions) => {
      dispatchedOptions = options;
      return Promise.resolve(Ok(undefined));
    });

    await session.dispatchPendingCompactionFollowUpIfNeeded();

    expect(dispatchedOptions?.experiments?.programmaticToolCalling).toBe(true);
    expect(dispatchedOptions?.experiments?.rlm).toBe(true);
  });

  test("dispatchPendingFollowUp preserves agent-initiated attribution", async () => {
    let dispatchedInternal: { synthetic?: boolean; agentInitiated?: boolean } | undefined;
    const { session, internals } = await createSession([
      compactionSummaryMessage("summary-agent-initiated", {
        text: "continue delegated work",
        model: "openai:gpt-4o",
        agentId: "exec",
        agentInitiated: true,
      }),
    ]);
    spyOn(session, "sendMessage").mockImplementation(
      (
        _message: string,
        _options?: SendOptions,
        internal?: { synthetic?: boolean; agentInitiated?: boolean }
      ) => {
        dispatchedInternal = internal;
        return Promise.resolve(Ok(undefined));
      }
    );

    await session.dispatchPendingCompactionFollowUpIfNeeded();

    expect(dispatchedInternal).toMatchObject({ synthetic: true, agentInitiated: true });
    expect(internals.lastAutoRetryResumeRequest?.agentInitiated).toBe(true);
  });

  test("dispatchPendingFollowUp forwards strictAgentResolution to the resumed turn", async () => {
    let dispatchedOptions: SendOptions | undefined;
    const { session } = await createSession([
      compactionSummaryMessage("summary-strict", {
        text: "continue delegated work",
        model: "openai:gpt-4o",
        agentId: "plan",
        strictAgentResolution: true,
      }),
    ]);
    spyOn(session, "sendMessage").mockImplementation((_message: string, options?: SendOptions) => {
      dispatchedOptions = options;
      return Promise.resolve(Ok(undefined));
    });

    await session.dispatchPendingCompactionFollowUpIfNeeded();

    // The requested agent may have been removed/hidden/disabled while compaction ran;
    // the resumed turn must stay loud instead of silently falling back to exec.
    expect(dispatchedOptions?.agentId).toBe("plan");
    expect(dispatchedOptions?.strictAgentResolution).toBe(true);
  });

  test("dispatchPendingFollowUp restores the Auto routing record on the redispatched turn", async () => {
    let dispatchedOptions: (SendOptions & { autoModelRoutingRecord?: unknown }) | undefined;
    const record = {
      status: "routed" as const,
      tierId: "hard",
      model: "openai:gpt-5.5",
      requestedFallbackModel: "openai:gpt-4o",
    };
    const { session } = await createSession([
      compactionSummaryMessage("summary-auto-routing", {
        text: "refactor the scheduler",
        model: "openai:gpt-5.5",
        agentId: "exec",
        autoModelRouting: record,
      }),
    ]);
    spyOn(session, "sendMessage").mockImplementation((_message: string, options?: SendOptions) => {
      dispatchedOptions = options;
      return Promise.resolve(Ok(undefined));
    });

    await session.dispatchPendingCompactionFollowUpIfNeeded();

    expect(dispatchedOptions?.model).toBe("openai:gpt-5.5");
    expect(dispatchedOptions?.autoModelRoutingRecord).toEqual(record);
    expect(dispatchedOptions?.autoModelRouting).toBeUndefined();
  });

  test("dispatchPendingFollowUp leaves the follow-up pending when the workspace is archived on disk", async () => {
    const archiveWorkspace = (config: Config) =>
      config.editConfig((cfg) => {
        cfg.projects.set("/tmp", {
          workspaces: [{ id: "ws", path: "/tmp/ws", archivedAt: "2026-01-01T00:00:00.000Z" }],
        });
        return cfg;
      });
    const { session, historyService } = await createSession(
      [
        compactionSummaryMessage("summary-archived", {
          text: "resume after compaction",
          model: "openai:gpt-4o",
          agentId: "exec",
        }),
      ],
      archiveWorkspace
    );
    const sendMessage = spyOn(session, "sendMessage").mockImplementation(() =>
      Promise.resolve(Ok(undefined))
    );

    const dispatched = await session.dispatchPendingCompactionFollowUpIfNeeded();

    expect(dispatched).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    // Still pending for the next startup after an unarchive.
    const lastMessages = await historyService.getLastMessages("ws", 1);
    expect(lastMessages.success && lastMessages.data[0]?.metadata?.muxMetadata).toMatchObject({
      type: "compaction-summary",
      pendingFollowUp: { text: "resume after compaction" },
    });
  });

  test("dispatchPendingFollowUp skips idle-only follow-ups when queued user input exists", async () => {
    const { session, historyService } = await createSession([
      compactionSummaryMessage("summary-idle-only", idleFollowUp()),
    ]);
    const sendMessage = spyOn(session, "sendMessage").mockImplementation(() =>
      Promise.resolve(Ok(undefined))
    );
    session.queueMessage(
      "user returned",
      { model: "openai:gpt-4o", agentId: "exec" },
      { synthetic: false }
    );

    const dispatched = await session.dispatchPendingCompactionFollowUpIfNeeded();

    expect(dispatched).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();

    const lastMessages = await historyService.getLastMessages("ws", 1);
    expect(lastMessages.success).toBe(true);
    if (!lastMessages.success) {
      throw new Error(`Expected history read to succeed: ${lastMessages.error}`);
    }
    expect(lastMessages.data[0]?.metadata?.muxMetadata).toEqual({ type: "compaction-summary" });
  });

  test("dispatchPendingFollowUp removes heartbeat reset boundaries when idle-only follow-ups are skipped", async () => {
    const earlierMessage = createMuxMessage("before-reset", "assistant", "Earlier context");
    const { session, historyService } = await createSession([
      earlierMessage,
      heartbeatBoundaryMessage(),
    ]);
    const sendMessage = spyOn(session, "sendMessage").mockImplementation(() =>
      Promise.resolve(Ok(undefined))
    );
    session.queueMessage(
      "user returned",
      { model: "openai:gpt-4o", agentId: "exec" },
      { synthetic: false }
    );

    const dispatched = await session.dispatchPendingCompactionFollowUpIfNeeded();

    expect(dispatched).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();

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
    const { session, historyService } = await createSession(
      [earlierMessage, heartbeatBoundaryMessage()],
      undefined,
      { hasExternalSendPreflight: () => true }
    );
    const sendMessage = spyOn(session, "sendMessage").mockImplementation(() =>
      Promise.resolve(Ok(undefined))
    );

    const dispatched = await session.dispatchPendingCompactionFollowUpIfNeeded();

    expect(dispatched).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();

    const historyResult = await historyService.getLastMessages("ws", 10);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`Expected history read to succeed: ${historyResult.error}`);
    }
    expect(historyResult.data.map((message) => message.id)).toEqual(["before-reset"]);
  });

  test("dispatchPendingFollowUp skips idle-only follow-ups when a new turn is already active", async () => {
    const { session, historyService } = await createSession([
      compactionSummaryMessage("summary-active-turn", idleFollowUp()),
    ]);
    const sendMessage = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));
    spyOn(session, "isBusy").mockReturnValue(true);

    const dispatched = await session.dispatchPendingCompactionFollowUpIfNeeded();

    expect(dispatched).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();

    const lastMessages = await historyService.getLastMessages("ws", 1);
    expect(lastMessages.success).toBe(true);
    if (!lastMessages.success) {
      throw new Error(`Expected history read to succeed: ${lastMessages.error}`);
    }
    expect(lastMessages.data[0]?.metadata?.muxMetadata).toEqual({ type: "compaction-summary" });
  });

  test("dispatchPendingFollowUp keeps heartbeat reset boundaries once a non-idle turn has started", async () => {
    const { session, historyService } = await createSession([heartbeatBoundaryMessage()]);
    const sendMessage = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));
    spyOn(session, "isBusy").mockReturnValue(true);

    const dispatched = await session.dispatchPendingCompactionFollowUpIfNeeded();

    expect(dispatched).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();

    const historyResult = await historyService.getLastMessages("ws", 10);
    expect(historyResult.success).toBe(true);
    if (!historyResult.success) {
      throw new Error(`Expected history read to succeed: ${historyResult.error}`);
    }
    expect(historyResult.data[0]?.id).toBe("heartbeat-boundary");
    expect(historyResult.data[0]?.metadata?.muxMetadata).toEqual({ type: "compaction-summary" });
  });

  test("dispatchPendingFollowUp still runs idle-only follow-ups during compaction completion", async () => {
    const { session, internals } = await createSession([
      compactionSummaryMessage("summary-completing-turn", idleFollowUp()),
    ]);
    const sendMessage = spyOn(session, "sendMessage").mockResolvedValue(Ok(undefined));
    internals.coordinator.beginPolicy(internals.coordinator.turnId);

    const dispatched = await session.dispatchPendingCompactionFollowUpIfNeeded();

    expect(dispatched).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
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
    const { session, internals } = await createSession([
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
    spyOn(session, "sendMessage").mockImplementation(() =>
      Promise.resolve(Err({ type: "runtime_start_failed" as const, message: "startup failed" }))
    );

    let dispatchError: unknown;
    try {
      await session.dispatchPendingCompactionFollowUpIfNeeded();
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
    const { session, historyService } = await createSession();
    spyOn(historyService, "getLastMessages").mockResolvedValue(
      Err("temporary history read failure")
    );

    let dispatchError: unknown;
    try {
      await session.dispatchPendingCompactionFollowUpIfNeeded();
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
    const { session } = await createSession([
      compactionSummaryMessage("summary-once", {
        text: "follow up once",
        model: "openai:gpt-4o",
        agentId: "exec",
      }),
    ]);
    spyOn(session, "sendMessage").mockImplementation(() => {
      sendCount += 1;
      return Promise.resolve(Ok(undefined));
    });

    await Promise.all([session.runStartupRecovery(), session.runStartupRecovery()]);

    expect(sendCount).toBe(1);
  });

  test("startup recovery retries pending follow-up after an initial send failure", async () => {
    let sendCount = 0;
    const { session } = await createSession([
      compactionSummaryMessage("summary-retry", {
        text: "follow up retry",
        model: "openai:gpt-4o",
        agentId: "exec",
      }),
    ]);
    spyOn(session, "sendMessage").mockImplementation(() => {
      sendCount += 1;
      if (sendCount === 1) {
        return Promise.resolve(
          Err({ type: "runtime_start_failed" as const, message: "startup failed" })
        );
      }
      return Promise.resolve(Ok(undefined));
    });

    await session.runStartupRecovery();

    expect(sendCount).toBe(1);

    await session.runStartupRecovery();

    expect(sendCount).toBe(2);
  });

  // RLM keep-recent floor: post-crash recovery when the compaction summary is
  // no longer the last history row because preserved-tail copies trail it.
  test("startup recovery dispatches the follow-up when preserved-tail copies trail the summary", async () => {
    let dispatchedMessage: string | undefined;
    const { session } = await createSession([
      rlmSummaryBoundaryMessage({
        text: "follow up after tail",
        model: "openai:gpt-4o",
        agentId: "exec",
      }),
      preservedTailCopy("tail-copy-1", "user", "original user message"),
      preservedTailCopy("tail-copy-2", "assistant", "original assistant reply"),
    ]);
    const sendMessage = spyOn(session, "sendMessage").mockImplementation((message: string) => {
      dispatchedMessage = message;
      return Promise.resolve(Ok(undefined));
    });

    await session.runStartupRecovery();

    expect(dispatchedMessage).toBe("follow up after tail");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("startup recovery declines a trailing tail copy when a non-copy row follows the boundary", async () => {
    // Staleness guard: the epoch is not exactly [summary, ...tail copies], so
    // "compaction just completed" no longer holds and the follow-up must stay
    // parked on the summary for a later legitimate recovery.
    const { session, historyService } = await createSession([
      rlmSummaryBoundaryMessage({
        text: "stale follow up",
        model: "openai:gpt-4o",
        agentId: "exec",
      }),
      preservedTailCopy("tail-copy-1", "user", "original user message"),
      createMuxMessage("post-compaction-turn", "assistant", "new turn after compaction"),
      preservedTailCopy("tail-copy-2", "assistant", "trailing copy"),
    ]);
    const sendMessage = spyOn(session, "sendMessage").mockImplementation(() =>
      Promise.resolve(Ok(undefined))
    );

    const dispatched = await session.dispatchPendingCompactionFollowUpIfNeeded();

    expect(dispatched).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();

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
