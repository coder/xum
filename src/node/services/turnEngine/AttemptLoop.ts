/**
 * AttemptLoop runs a turn's provider attempts once the stream registers: it
 * folds each attempt's parts into the turn, asks recoveryPolicy what follows an
 * attempt (retry, refusal fallback, completion or failure), finishes a completed
 * stream, and settles every terminal outcome. TurnEngine.start launches it
 * through StreamManager.processStreamWithCleanup.
 */
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { PROVIDER_DEFINITIONS } from "@/common/constants/providers";
import type { StreamErrorType } from "@/common/types/errors";
import { hasTokenUsage, type MuxMessage, type MuxMetadata } from "@/common/types/message";
import type { StreamAbortEvent, StreamAbortReason, StreamEndEvent } from "@/common/types/stream";
import type { ThinkingLevel } from "@/common/types/thinking";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import assert from "@/common/utils/assert";
import { clampErrorMessage, getErrorMessage } from "@/common/utils/errors";
import { isRefusalFinishReason } from "@/common/utils/messages/refusalFinishReason";
import { eventSpine } from "@/node/services/events/eventSpine";
import { hasCommitWorthyParts } from "@/node/services/historyService";
import { log, type Logger } from "@/node/services/log";
import type { ToolCallDisplayRegistry } from "@/node/services/toolCallDisplayRegistry";
import { createErrorEvent, type StreamErrorPayload } from "@/node/services/utils/sendMessageError";
import { nodeClock } from "@/node/utils/hostClock";
import { partFold, type FoldablePart, type FoldStep } from "./partFold";
import type { PartialJournal } from "./PartialJournal";
import { ProviderRequest, type StreamRequestConfig } from "./ProviderRequest";
import {
  MAX_EMPTY_STREAM_RECOVERY_ATTEMPTS,
  recoveryPolicy,
  type AttemptHistory,
  type AttemptOutcome,
} from "./recoveryPolicy";
import type { RefusalFallback } from "./RefusalFallback";
import { foldView, type PartLoopState } from "./StepApply";
import type { StepMessageTracker } from "./StepPreparation";
import {
  getOpenAIPreviousResponseId,
  planPreviousResponseIdRetry,
  planReasoningReplayRetry,
  type StreamRetries,
} from "./StreamRetries";
import {
  buildStreamErrorPayload,
  EmptyStreamOutputError,
  ModelRefusalError,
  StreamTruncatedError,
} from "./streamErrors";
import { metadataModelIdentity, type TurnEvents } from "./TurnEvents";
import { StreamState, TurnRegistry } from "./TurnRegistry";
import type { TurnResources } from "./TurnResources";
import type { StreamManagerTokenTracker, TurnCompletion, WorkspaceId } from "./types";
import type { WorkspaceStreamInfo } from "./turnState";
import {
  clonePersistedToolModelUsage,
  cloneUsage,
  markProviderMetadataCostsIncluded,
  type UsageLedger,
} from "./UsageLedger";

function isKnownProviderName(provider: string): provider is keyof typeof PROVIDER_DEFINITIONS {
  return Object.hasOwn(PROVIDER_DEFINITIONS, provider);
}

function getStreamProviderDisplayName(model: string): string {
  const canonicalModel = normalizeToCanonical(model);
  const providerSeparatorIndex = canonicalModel.indexOf(":");
  const provider =
    providerSeparatorIndex > 0 ? canonicalModel.slice(0, providerSeparatorIndex) : undefined;
  if (provider && isKnownProviderName(provider)) {
    return PROVIDER_DEFINITIONS[provider].displayName;
  }

  return "The model";
}

/** The request's stop cause, as the stream-end helpers read it. */
interface StopCauseHolder {
  readonly request: Pick<StreamRequestConfig, "stopCause">;
}

/** The stream-end event of a completed stream, with its final metadata and parts. */
export function buildStreamEndEvent(
  workspaceId: WorkspaceId,
  streamInfo: Pick<
    WorkspaceStreamInfo,
    | "messageId"
    | "model"
    | "metadataModel"
    | "thinkingLevel"
    | "initialMetadata"
    | "toolModelUsages"
    | "historySequence"
    | "parts"
  > &
    StopCauseHolder,
  end: {
    totalUsage: StreamEndEvent["metadata"]["usage"];
    contextUsage: StreamEndEvent["metadata"]["contextUsage"];
    providerMetadata: StreamEndEvent["metadata"]["providerMetadata"];
    contextProviderMetadata: StreamEndEvent["metadata"]["contextProviderMetadata"];
    finishReason: StreamEndEvent["metadata"]["finishReason"];
    duration: number;
    ttftMs: number | undefined;
  }
): StreamEndEvent {
  const {
    totalUsage,
    contextUsage,
    providerMetadata,
    contextProviderMetadata,
    finishReason,
    duration,
    ttftMs,
  } = end;
  const canonicalModel = metadataModelIdentity(streamInfo.model);
  const toolModelUsages =
    streamInfo.toolModelUsages.length > 0
      ? streamInfo.toolModelUsages.map(clonePersistedToolModelUsage)
      : undefined;

  // Emit stream end event with parts preserved in temporal order
  const streamEndEvent: StreamEndEvent = {
    type: "stream-end",
    workspaceId: workspaceId as string,
    messageId: streamInfo.messageId,
    ...(streamInfo.initialMetadata?.acpPromptId != null
      ? { acpPromptId: streamInfo.initialMetadata.acpPromptId }
      : {}),
    metadata: {
      ...streamInfo.initialMetadata, // TurnRequestBuilder-provided metadata (systemMessageTokens, etc)
      model: canonicalModel,
      metadataModel: streamInfo.metadataModel,
      ...(streamInfo.thinkingLevel && {
        thinkingLevel: streamInfo.thinkingLevel as ThinkingLevel,
      }),
      usage: totalUsage, // Total across all steps (for cost calculation)
      contextUsage, // Last step only (for context window display)
      providerMetadata, // Aggregated (for cost calculation)
      contextProviderMetadata, // Last step (for context window display)
      ...(toolModelUsages != null ? { toolModelUsages } : {}),
      ...(finishReason !== undefined && { finishReason }),
      ...(streamInfo.request.stopCause != null && {
        stopCause: streamInfo.request.stopCause,
      }),
      historySequence: streamInfo.historySequence,
      duration,
      ...(ttftMs !== undefined && { ttftMs }),
    },
    parts: streamInfo.parts, // Parts array with temporal ordering (includes reasoning)
  };
  return streamEndEvent;
}

/**
 * The finish reason a completed stream persists. Required-tool completion must remain
 * successful after downgrade or crash recovery: keep the internal stop cause, but persist
 * the legacy-compatible terminal signal.
 */
export function resolveStreamEndFinishReason(
  streamInfo: Pick<WorkspaceStreamInfo, "terminalFinishReason"> & StopCauseHolder,
  providerFinishReason: StreamEndEvent["metadata"]["finishReason"]
): StreamEndEvent["metadata"]["finishReason"] {
  return streamInfo.request.stopCause?.kind === "required-tool"
    ? "stop"
    : (streamInfo.terminalFinishReason ?? providerFinishReason);
}

/** What an aborted stream reports and stamps: its tracked usage, timing and metadata. */
interface AbortedStreamUsage {
  usage: LanguageModelV2Usage | undefined;
  contextUsage: LanguageModelV2Usage | undefined;
  contextProviderMetadata: Record<string, unknown> | undefined;
  providerMetadata: Record<string, unknown> | undefined;
  duration: number;
}

/** The stream-abort event of a canceled stream. */
function buildStreamAbortEvent(
  workspaceId: WorkspaceId,
  streamInfo: Pick<
    WorkspaceStreamInfo,
    "messageId" | "model" | "metadataModel" | "toolModelUsages" | "initialMetadata"
  >,
  abortUsage: AbortedStreamUsage,
  abortReason: StreamAbortReason,
  abandonPartial: boolean | undefined
): StreamAbortEvent {
  const { usage, contextUsage, duration, providerMetadata, contextProviderMetadata } = abortUsage;
  return {
    type: "stream-abort",
    workspaceId,
    messageId: streamInfo.messageId,
    metadata: {
      usage,
      contextUsage,
      duration,
      providerMetadata,
      contextProviderMetadata,
      model: streamInfo.model,
      metadataModel: streamInfo.metadataModel,
      // Same tool-model usage the committed partial gets, so the renderer's
      // per-turn cost views match history replay without a reload.
      ...(streamInfo.toolModelUsages.length > 0
        ? { toolModelUsages: streamInfo.toolModelUsages.map(clonePersistedToolModelUsage) }
        : {}),
    },
    abortReason,
    abandonPartial,
    acpPromptId: streamInfo.initialMetadata?.acpPromptId,
  };
}

/** The usage metadata an aborted turn's partial carries into chat.jsonl. */
function abortedPartialMetadata(
  streamInfo: Pick<WorkspaceStreamInfo, "toolModelUsages">,
  abortUsage: AbortedStreamUsage
): Partial<MuxMetadata> {
  const { usage, providerMetadata, contextUsage, contextProviderMetadata, duration } = abortUsage;
  return {
    ...(usage !== undefined ? { usage: cloneUsage(usage) } : {}),
    ...(providerMetadata !== undefined ? { providerMetadata } : {}),
    ...(contextUsage !== undefined ? { contextUsage } : {}),
    ...(contextProviderMetadata !== undefined ? { contextProviderMetadata } : {}),
    duration,
    ...(streamInfo.toolModelUsages.length > 0
      ? { toolModelUsages: streamInfo.toolModelUsages.map(clonePersistedToolModelUsage) }
      : {}),
  };
}

export interface AttemptLoopDeps {
  readonly turnResources: Pick<
    TurnResources,
    "acquireMcpLease" | "releaseMcpLease" | "closeStreamResources"
  >;
  readonly toolCallDisplayRegistry: Pick<ToolCallDisplayRegistry, "close">;
  readonly partialJournal: Pick<
    PartialJournal,
    "commitFinal" | "awaitPending" | "writeAbortPartial" | "settleAbort"
  >;
  readonly usageLedger: Pick<
    UsageLedger,
    "settle" | "discardInFlight" | "recordDroppedPartialUsage"
  >;
  readonly providerRequest: Pick<ProviderRequest, "recordLostResponseIdIfApplicable">;
  readonly turnEvents: Pick<TurnEvents<WorkspaceStreamInfo>, "emitTurnEvent" | "deliver">;
  readonly refusalFallback: Pick<RefusalFallback, "tryModelFallbackAfterRefusal">;
  readonly workspaceStreams: Map<WorkspaceId, WorkspaceStreamInfo>;
  /** StreamManager's token tracker, read at call time (whitebox tests replace it). */
  readonly tokenTracker: Pick<StreamManagerTokenTracker, "setModel">;
  readonly getWorkspaceLogger: (
    workspaceId: WorkspaceId,
    streamInfo?: Pick<WorkspaceStreamInfo, "workspaceName">
  ) => Logger;
  /** The stream's final metadata, as StreamManager.getStreamMetadata reads it. */
  readonly getStreamMetadata: (streamInfo: WorkspaceStreamInfo) => Promise<{
    totalUsage?: LanguageModelV2Usage;
    contextUsage?: LanguageModelV2Usage;
    contextProviderMetadata?: Record<string, unknown>;
    finishReason?: string;
    duration: number;
  }>;
  readonly endUsage: (
    streamInfo: WorkspaceStreamInfo,
    totalUsage: LanguageModelV2Usage | undefined
  ) => LanguageModelV2Usage | undefined;
  readonly backfillReasoningTokensFromParts: (
    streamInfo: WorkspaceStreamInfo,
    usage: LanguageModelV2Usage | undefined
  ) => Promise<void>;
  readonly resolveTtftMsForStreamEnd: (streamInfo: WorkspaceStreamInfo) => number | undefined;
  readonly resolveProviderMetadataForStreamEnd: (
    streamInfo: WorkspaceStreamInfo
  ) => Promise<Record<string, unknown> | undefined>;
  /** The retry state reset and recoveryPolicy's retry executors. */
  readonly streamRetries: StreamRetries;
  /** StreamManager.createStreamResult, read at call time (whitebox tests replace it). */
  readonly createStreamResult: (
    request: StreamRequestConfig,
    abortController: AbortController,
    stepTracker: StepMessageTracker
  ) => WorkspaceStreamInfo["streamResult"];
  readonly emitStreamStart: (
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    historySequence: number
  ) => void;
  readonly flushPartialWrite: (
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    terminalPartial?: MuxMessage
  ) => Promise<void>;
  /** StepApply.applyStep: runs the fold's intents against the stream state. */
  readonly applyStep: (
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    step: FoldStep,
    loop: PartLoopState
  ) => Promise<void>;
  /** StreamManager's partial snapshot, which the error partial extends. */
  readonly buildPartialAssistantMessage: (
    streamInfo: WorkspaceStreamInfo,
    options?: { metadata?: Partial<MuxMetadata>; parts?: MuxMessage["parts"] }
  ) => MuxMessage;
  readonly discardUnsettledSessionUsage: (
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ) => Promise<void>;
}

export class AttemptLoop {
  constructor(private readonly deps: AttemptLoopDeps) {}

  private async handleEmptyStreamCompletion(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    const workspaceLog = this.deps.getWorkspaceLogger(workspaceId, streamInfo);
    const streamMeta = await this.deps.getStreamMetadata(streamInfo);
    const totalUsage = this.deps.endUsage(streamInfo, streamMeta.totalUsage);
    const contextUsage = streamMeta.contextUsage ?? streamInfo.lastStepUsage;
    const previousResponseId = getOpenAIPreviousResponseId(streamInfo.request.providerOptions);

    // Surface silent provider drops instead of leaving an empty assistant placeholder behind.
    // Recent gpt-5.4-pro stalls only logged stream startup, so future occurrences need an
    // explicit backend breadcrumb and a user-visible retryable error.
    workspaceLog.error("Stream ended without emitting text, reasoning, or tool events", {
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      durationMs: streamMeta.duration,
      totalUsage,
      contextUsage,
      cumulativeUsage: streamInfo.cumulativeUsage,
      previousResponseId,
    });

    await this.handleStreamFailure(workspaceId, streamInfo, new EmptyStreamOutputError());
  }

  private async handleModelRefusalCompletion(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    refusalFinishReason: string,
    fallbackNote?: string
  ): Promise<void> {
    const workspaceLog = this.deps.getWorkspaceLogger(workspaceId, streamInfo);
    const streamMeta = await this.deps.getStreamMetadata(streamInfo);

    workspaceLog.error("Stream ended with a terminal refusal", {
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      finishReason: streamInfo.terminalFinishReason,
      rawFinishReason: streamInfo.terminalRawFinishReason,
      durationMs: streamMeta.duration,
      partsCount: streamInfo.parts.length,
      fallbackNote,
    });

    await this.handleStreamFailure(
      workspaceId,
      streamInfo,
      new ModelRefusalError(streamInfo.model, refusalFinishReason, fallbackNote)
    );
  }

  private async handleTruncatedStreamCompletion(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    const workspaceLog = this.deps.getWorkspaceLogger(workspaceId, streamInfo);
    const streamMeta = await this.deps.getStreamMetadata(streamInfo);
    const totalUsage = this.deps.endUsage(streamInfo, streamMeta.totalUsage);
    const contextUsage = streamMeta.contextUsage ?? streamInfo.lastStepUsage;
    const previousResponseId = getOpenAIPreviousResponseId(streamInfo.request.providerOptions);
    const providerDisplayName = getStreamProviderDisplayName(streamInfo.model);

    // Do not treat iterator EOF as success. Anthropic and OpenAI Responses both
    // have semantic terminal events; without the SDK finish part, this may be a
    // clean proxy/provider drop after partial text was already streamed.
    workspaceLog.error("Stream ended without a terminal finish event", {
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      providerDisplayName,
      durationMs: streamMeta.duration,
      totalUsage,
      contextUsage,
      cumulativeUsage: streamInfo.cumulativeUsage,
      previousResponseId,
      partsCount: streamInfo.parts.length,
    });

    await this.handleStreamFailure(
      workspaceId,
      streamInfo,
      new StreamTruncatedError(providerDisplayName)
    );
  }

  /** Executes recoveryPolicy's empty-output retry; the policy owns eligibility. */
  private async retryEmptyStream(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    emptyStreamRecoveryAttempts: number
  ): Promise<void> {
    const workspaceLog = this.deps.getWorkspaceLogger(workspaceId, streamInfo);
    workspaceLog.warn("Retrying stream after empty-output completion", {
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      nextAttempt: emptyStreamRecoveryAttempts + 1,
      maxAttempts: MAX_EMPTY_STREAM_RECOVERY_ATTEMPTS,
      previousResponseId: getOpenAIPreviousResponseId(streamInfo.request.providerOptions),
    });

    ProviderRequest.markRetry(streamInfo, "afterEmptyOutput");
    await this.deps.streamRetries.resetStreamStateForRetry(workspaceId, streamInfo, {
      preserveUsage: true,
      workspaceLog,
    });
    ProviderRequest.beginAttempt(streamInfo, streamInfo.request, (request) =>
      this.deps.createStreamResult(request, streamInfo.abortController, streamInfo.stepTracker)
    );
  }

  /** Facts for recoveryPolicy about an attempt whose stream closed without throwing. */
  private finishedAttemptOutcome(streamInfo: WorkspaceStreamInfo): AttemptOutcome {
    // A refusal is a deliberate provider outcome, not a transport drop, so
    // recoveryPolicy checks it before the empty-output and truncation paths.
    // With partial output, a configured fallback must continue from the
    // partial transcript rather than replay the original turn and re-run tools.
    const refusal = streamInfo.receivedTerminalEvent
      ? ([streamInfo.terminalFinishReason, streamInfo.terminalRawFinishReason].find(
          isRefusalFinishReason
        ) ?? null)
      : null;
    return {
      _tag: "Finished",
      aborted: streamInfo.abortController.signal.aborted,
      interruptPending: streamInfo.softInterrupt.pending,
      partCount: streamInfo.parts.length,
      terminal: streamInfo.receivedTerminalEvent,
      refusal,
    };
  }

  /**
   * Chooses and runs what follows an attempt whose stream closed without
   * throwing. "retry" starts the next attempt and "complete" lets the caller
   * finalize the turn. "stop" ends the turn: the executor already settled it,
   * or after an abort the canceller owns the terminal bookkeeping
   * (cleanupAbortedStream).
   */
  private async recoverFinishedAttempt(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    history: AttemptHistory
  ): Promise<"retry" | "complete" | "stop"> {
    const decision = recoveryPolicy(this.finishedAttemptOutcome(streamInfo), history);
    switch (decision._tag) {
      case "Aborted":
        return "stop";
      case "Complete":
        return "complete";
      case "Fallback":
        return this.recoverRefusedAttempt(workspaceId, streamInfo, decision.refusal);
      case "Retry":
        assert(decision.change === "empty", "finished attempts only retry empty output");
        await this.retryEmptyStream(workspaceId, streamInfo, history.emptyRetries);
        history.emptyRetries += 1;
        return "retry";
      case "Empty":
        await this.handleEmptyStreamCompletion(workspaceId, streamInfo);
        return "stop";
      case "Truncated":
        await this.handleTruncatedStreamCompletion(workspaceId, streamInfo);
        return "stop";
      default:
        assert(false, `recoveryPolicy returned ${decision._tag} for a finished attempt`);
    }
  }

  private async recoverRefusedAttempt(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    refusal: string
  ): Promise<"retry" | "stop"> {
    // A configured fallback chain may swap models in place of the
    // terminal failure. The swap happens before any error event is
    // emitted, so task settlement can never race a pending fallback.
    const fallback = await this.deps.refusalFallback.tryModelFallbackAfterRefusal(
      workspaceId,
      streamInfo,
      refusal,
      {
        preserveParts: streamInfo.parts.length > 0,
      }
    );
    if (fallback.kind === "swapped") {
      return "retry";
    }

    await this.handleModelRefusalCompletion(
      workspaceId,
      streamInfo,
      refusal,
      fallback.terminalNote
    );
    return "stop";
  }

  /**
   * Chooses and runs what follows an attempt whose stream threw. "retry" starts
   * the next attempt, "fail" asks the caller to fail the turn with `error`, and
   * "aborted" asks the caller to flush the partial and leave the turn for the
   * canceller to settle. Only "retry" runs side effects here.
   */
  private async recoverErroredAttempt(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    error: unknown,
    history: AttemptHistory
  ): Promise<{ kind: "retry" } | { kind: "aborted" } | { kind: "fail"; error: unknown }> {
    // A throw from a check or an executor fails the turn with the thrown error,
    // as when the checks lived in the retry helpers.
    try {
      // The plans are read-only checks over the error and stream state.
      // After an abort they are skipped, as before: the policy ignores them.
      const aborted = streamInfo.abortController.signal.aborted;
      const previousResponseIdPlan = aborted
        ? null
        : planPreviousResponseIdRetry(streamInfo, error);
      const reasoningReplayPlan = aborted ? null : planReasoningReplayRetry(streamInfo, error);
      const decision = recoveryPolicy(
        {
          _tag: "Errored",
          aborted,
          interruptPending: streamInfo.softInterrupt.pending,
          previousResponseIdRetryable: previousResponseIdPlan != null,
          reasoningReplayRetryable: reasoningReplayPlan != null,
        },
        history
      );
      if (decision._tag === "Aborted") {
        return { kind: "aborted" };
      }
      if (decision._tag !== "Retry") {
        assert(decision._tag === "Fail", `recoveryPolicy returned ${decision._tag} for an error`);
        return { kind: "fail", error };
      }
      if (decision.change === "dropPreviousResponseId") {
        assert(previousResponseIdPlan != null, "policy retried without a plan");
        await this.deps.streamRetries.retryStreamWithoutPreviousResponseId(
          workspaceId,
          streamInfo,
          error,
          previousResponseIdPlan
        );
        history.retriedPreviousResponseId = true;
      } else {
        assert(decision.change === "dropReasoningReplay", "errors never retry as empty output");
        assert(reasoningReplayPlan != null, "policy retried without a plan");
        await this.deps.streamRetries.retryStreamWithoutReasoningReplay(
          workspaceId,
          streamInfo,
          error,
          reasoningReplayPlan
        );
        history.retriedReasoningReplay = true;
      }
      return { kind: "retry" };
    } catch (retryError) {
      return { kind: "fail", error: retryError };
    }
  }

  /** Fold one attempt's provider stream into the turn, part by part, until it ends or aborts. */
  private async consumeAttemptStream(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    loop: PartLoopState
  ): Promise<void> {
    for await (const part of streamInfo.streamResult.fullStream) {
      // Check if stream was cancelled BEFORE processing any parts
      // This improves interruption responsiveness by catching aborts earlier
      if (streamInfo.abortController.signal.aborted) {
        break;
      }

      // Log all stream parts to debug reasoning (commented out - too spammy)
      // console.log("[DEBUG streamManager]: Stream part", {
      //   type: part.type,
      //   hasText: "text" in part,
      //   preview: "text" in part ? (part as StreamPartWithText).text?.substring(0, 50) : undefined,
      // });

      const step = partFold(
        foldView(workspaceId, streamInfo, loop),
        part as FoldablePart,
        nodeClock.nowMs()
      );
      await this.deps.applyStep(workspaceId, streamInfo, step, loop);
    }
  }

  /**
   * Finish a completed stream: read its final metadata, commit the final message and settle
   * its usage, then mark it completed and emit stream-end (in that order, see below).
   */
  private async completeStream(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    workspaceLog: Logger
  ): Promise<void> {
    // Get all metadata from stream result in one call
    // - totalUsage: sum of all steps (for cost calculation)
    // - contextUsage: last step only (for context window display)
    // - contextProviderMetadata: last step (for context window cache tokens)
    // Falls back to tracked values when step retries invalidate totalUsage
    // or streamResult metadata fails/times out.
    const streamMeta = await this.deps.getStreamMetadata(streamInfo);
    const totalUsage = this.deps.endUsage(streamInfo, streamMeta.totalUsage);
    await this.deps.backfillReasoningTokensFromParts(streamInfo, totalUsage);
    const contextUsage = streamMeta.contextUsage ?? streamInfo.lastStepUsage;
    const contextProviderMetadata =
      streamMeta.contextProviderMetadata ?? streamInfo.lastStepProviderMetadata;
    const finishReason = resolveStreamEndFinishReason(streamInfo, streamMeta.finishReason);
    if (finishReason === "tool-calls" && streamInfo.request.stopCause == null) {
      workspaceLog.warn("Tool-calls stream ended without a recorded stop cause", {
        messageId: streamInfo.messageId,
        muxMetadata: streamInfo.initialMetadata?.muxMetadata,
      });
    }
    const duration = streamMeta.duration;
    const ttftMs = this.deps.resolveTtftMsForStreamEnd(streamInfo);
    // Aggregated provider metadata across all steps (for cost calculation with cache tokens)
    const providerMetadata = markProviderMetadataCostsIncluded(
      await this.deps.resolveProviderMetadataForStreamEnd(streamInfo),
      streamInfo.initialMetadata?.costsIncluded
    );
    const streamEndEvent = buildStreamEndEvent(workspaceId, streamInfo, {
      totalUsage,
      contextUsage,
      providerMetadata,
      contextProviderMetadata,
      finishReason,
      duration,
      ttftMs,
    });

    // Update history with final message BEFORE emitting stream-end
    // This prevents a race condition where compaction (triggered by stream-end)
    // clears history while updateHistory is still running, causing old messages
    // to be written back after compaction completes.
    if (streamInfo.parts && streamInfo.parts.length > 0) {
      const finalAssistantMessage: MuxMessage = {
        id: streamInfo.messageId,
        role: "assistant",
        metadata: {
          ...streamEndEvent.metadata,
          historySequence: streamInfo.historySequence,
          stepStartPartIndices: streamInfo.stepStartIndices.filter(
            (index) => index < streamInfo.parts.length
          ),
        },
        parts: streamInfo.parts,
      };

      await this.deps.partialJournal.commitFinal(
        workspaceId,
        streamInfo,
        finalAssistantMessage,
        workspaceLog
      );

      // Update cumulative session usage (if service is available)
      // Wrapped in try-catch: usage recording is non-critical and shouldn't block stream completion
      await this.deps.usageLedger.settle(
        workspaceId,
        streamInfo,
        totalUsage,
        providerMetadata,
        "Failed to record session usage (stream completion unaffected)",
        "warn"
      );
    }

    // Mark as completed right before emitting stream-end.
    // This must happen AFTER async I/O (deletePartial, updateHistory) completes.
    // If we set COMPLETED earlier, isStreaming() returns false during cleanup,
    // allowing new messages (e.g., force-compaction) to bypass queuing and write
    // to history before stream-end fires - causing compaction to use wrong parts.
    TurnRegistry.setState(streamInfo, StreamState.COMPLETED);

    // Emit stream-end AFTER history is updated to prevent race with compaction
    // Compaction handler listens to this event and clears history - if we emit
    // before updateHistory completes, compaction can clear the file and then
    // updateHistory writes stale data back.
    this.deps.turnEvents.emitTurnEvent(streamEndEvent);
    TurnRegistry.recordTerminal(streamInfo, {
      status: "completed",
      streamEnd: streamEndEvent,
    });
  }

  /**
   * Processes a stream with guaranteed cleanup, regardless of success or failure
   */
  async processStreamWithCleanup(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    historySequence: number
  ): Promise<void> {
    this.deps.turnResources.acquireMcpLease(workspaceId);

    try {
      // Update state to streaming
      TurnRegistry.setState(streamInfo, StreamState.STREAMING);

      // Emit stream start event (include mode from initialMetadata if available)
      this.deps.emitStreamStart(workspaceId, streamInfo, historySequence);

      // Initialize token tracker for this model
      await this.deps.tokenTracker.setModel(streamInfo.model, streamInfo.metadataModel);

      // Recovery spent in this turn. The recovery helpers update it after each retry.
      const attemptHistory: AttemptHistory = {
        emptyRetries: 0,
        retriedPreviousResponseId: false,
        retriedReasoningReplay: false,
      };
      const workspaceLog = this.deps.getWorkspaceLogger(workspaceId, streamInfo);
      const loop: PartLoopState = { workspaceLog, toolCalls: new Map(), orphanToolResultCount: 0 };

      while (true) {
        // Use fullStream to capture all events including tool calls
        loop.toolCalls = new Map();

        try {
          await this.consumeAttemptStream(workspaceId, streamInfo, loop);

          // No need to save remaining text - text-delta handler already maintains parts array
          // (Removed duplicate push that was causing double text parts)

          // Flush final state to partial.json for crash resilience
          // This happens regardless of abort status to ensure the final state is persisted to disk
          // On abort: second flush after cancelStreamSafely, ensures all streamed content is saved
          // On normal completion: provides crash resilience before AIService writes to chat.jsonl
          await this.deps.flushPartialWrite(workspaceId, streamInfo);

          const next = await this.recoverFinishedAttempt(workspaceId, streamInfo, attemptHistory);
          if (next === "retry") {
            continue;
          }
          if (next === "complete") {
            await this.completeStream(workspaceId, streamInfo, workspaceLog);
          }
          break;
        } catch (error) {
          // A cancellation may surface as an iterator rejection instead of a
          // clean close (provider/transport dependent). The canceller that
          // aborted the signal owns the terminal bookkeeping (cleanupAbortedStream
          // after processingPromise resolves: stream-abort, partial commit,
          // settle), so recording this as a provider failure would turn a user
          // stop or a shutdown abort into an error event and — via the
          // lost-race guard in cleanupAbortedStream — suppress the abort. Take
          // the same exit as the clean-close abort path instead.
          const recovery = await this.recoverErroredAttempt(
            workspaceId,
            streamInfo,
            error,
            attemptHistory
          );
          if (recovery.kind === "retry") {
            continue;
          }
          if (recovery.kind === "aborted") {
            workspaceLog.debug("Stream iterator rejected after abort; treating as cancellation", {
              error: getErrorMessage(error),
            });
            await this.deps.flushPartialWrite(workspaceId, streamInfo);
          } else {
            await this.handleStreamFailure(workspaceId, streamInfo, recovery.error);
          }
          break;
        }
      }
    } catch (error) {
      await this.handleStreamFailure(workspaceId, streamInfo, error);
    } finally {
      await this.settleStreamProcessing(workspaceId, streamInfo);
    }
  }

  /** The guaranteed cleanup of processStreamWithCleanup, for every terminal outcome. */
  private async settleStreamProcessing(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    this.deps.turnResources.releaseMcpLease(workspaceId);

    await this.deps.turnResources.closeStreamResources(streamInfo);

    // Aborts keep their registration until cleanupAbortedStream completes its disk
    // transaction and raw delivery. A stale finally must never remove a replacement.
    if (
      streamInfo.terminalCompletion != null &&
      this.deps.workspaceStreams.get(workspaceId) === streamInfo
    ) {
      this.deps.workspaceStreams.delete(workspaceId);
    }
    await this.deps.discardUnsettledSessionUsage(workspaceId, streamInfo);

    // Lifecycle spine event: emitted from the guaranteed-cleanup path so
    // EVERY terminal outcome (completion, abort/Escape, provider failure)
    // closes the stream.start emitted at the top of this method — observers
    // tracking active streams must never retain stale entries.
    eventSpine.emit("stream.end", {
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
    });

    if (streamInfo.terminalCompletion != null) {
      // Optional-chained: whitebox test fixtures register stream infos without a controller.
      streamInfo.completionController?.settle(streamInfo.terminalCompletion);
    }
  }

  /**
   * Persist error state and emit error events for failed streams.
   */
  private async handleStreamFailure(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    error: unknown
  ): Promise<void> {
    TurnRegistry.setState(streamInfo, StreamState.ERROR);

    const workspaceLog = this.deps.getWorkspaceLogger(workspaceId, streamInfo);

    // Log the actual error for debugging
    workspaceLog.error("Stream processing error:", error);

    // Record lost previousResponseId so future requests can filter it out
    this.deps.providerRequest.recordLostResponseIdIfApplicable(
      workspaceId,
      error,
      streamInfo,
      workspaceLog
    );

    const errorPayload = buildStreamErrorPayload(streamInfo, error);
    const persistedPayload = await this.persistStreamError(workspaceId, streamInfo, errorPayload);
    TurnRegistry.recordTerminal(streamInfo, {
      status: "failed",
      streamError: persistedPayload,
    });
  }

  /**
   * Write error metadata to partial.json and emit the corresponding error event.
   */
  private async persistStreamError(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    payload: StreamErrorPayload & { errorType: StreamErrorType }
  ): Promise<StreamErrorPayload & { errorType: StreamErrorType }> {
    // Clamp at the single choke point every stream error payload passes
    // through before persist/emit, including buildStreamErrorPayload's
    // early-return branches (e.g. ModelRefusalError, whose fallbackNote can
    // embed another error's message). Some SDK errors embed the entire
    // serialized prompt in their message (AI_TypeValidationError via the
    // cause walk); unbounded, that would be persisted to history metadata,
    // shipped over IPC, and rendered in the chat.
    payload = { ...payload, error: clampErrorMessage(payload.error), model: streamInfo.model };
    const refusalFinishReason =
      payload.errorType === "model_refusal"
        ? ([streamInfo.terminalFinishReason, streamInfo.terminalRawFinishReason].find(
            isRefusalFinishReason
          ) ?? streamInfo.terminalFinishReason)
        : undefined;
    const terminalRefusalUsage = streamInfo.terminalRefusalUsage;
    const terminalRefusalProviderMetadata = streamInfo.terminalRefusalProviderMetadata;

    // Errored turns still billed every completed step. Capture the
    // live-tracked cumulative usage for the sidecar below and mirror it into
    // session-usage.json — the error path previously skipped both, ingesting
    // failed turns as $0. Refusal errors are excluded entirely: the refusal
    // paths already attributed the refusing attempt's tokens (terminal
    // refusals via terminalRefusalUsage, fallback hops — including the FINAL
    // hop on chain exhaustion — via recordRefusedAttemptUsage into
    // toolModelUsages + the ledger), so re-recording the cumulative counters
    // here would double-count the last refusing attempt.
    let cumulativeErrorUsage: LanguageModelV2Usage | undefined;
    let cumulativeErrorProviderMetadata: Record<string, unknown> | undefined;
    if (payload.errorType !== "model_refusal" && hasTokenUsage(streamInfo.cumulativeUsage)) {
      cumulativeErrorUsage = cloneUsage(streamInfo.cumulativeUsage);
      await this.deps.backfillReasoningTokensFromParts(streamInfo, cumulativeErrorUsage);
      cumulativeErrorProviderMetadata = markProviderMetadataCostsIncluded(
        streamInfo.cumulativeProviderMetadata
          ? { ...streamInfo.cumulativeProviderMetadata }
          : undefined,
        streamInfo.initialMetadata?.costsIncluded
      );
      await this.deps.usageLedger.settle(
        workspaceId,
        streamInfo,
        cumulativeErrorUsage,
        cumulativeErrorProviderMetadata,
        "Failed to record session usage for errored stream",
        "warn"
      );
    } else {
      // Refusals recorded their own usage above: drop any in-flight copy.
      await this.deps.usageLedger.discardInFlight(workspaceId, streamInfo);
    }
    const errorUsage = terminalRefusalUsage ?? cumulativeErrorUsage;
    const errorProviderMetadata =
      terminalRefusalProviderMetadata ?? cumulativeErrorProviderMetadata;

    const errorPartialMessage = this.deps.buildPartialAssistantMessage(streamInfo, {
      metadata: {
        error: payload.error,
        errorType: payload.errorType,
        ...(refusalFinishReason !== undefined ? { finishReason: refusalFinishReason } : {}),
        ...(errorProviderMetadata !== undefined ? { providerMetadata: errorProviderMetadata } : {}),
        // INVARIANT: usage / toolModelUsages are deliberately NOT stamped on
        // the error partial. Errored turns are sidecar-canonical: unlike
        // aborts, nothing commits the partial at error time (AIService
        // forwards "error" without commitPartial), so usage stamped here
        // would strand in partial.json until an unrelated send — or die
        // entirely when a retry overwrites the partial. The sidecar rows
        // below are ingested immediately by the error listener, and the
        // eventually committed row carries no usage, so exactly one source
        // ever reaches the events table.
      },
    });

    // Write error state to disk through the tracked partial write: it waits for any in-flight
    // flush, cancels a scheduled one, and retires later flushes, so a concurrent cancel cannot
    // land a pre-error snapshot after it (#5344). Awaited so the state is on disk before any
    // resume.
    await this.deps.flushPartialWrite(workspaceId, streamInfo, errorPartialMessage);

    try {
      await this.deps.usageLedger.recordDroppedPartialUsage(
        workspaceId,
        streamInfo,
        errorUsage,
        errorProviderMetadata,
        "errored_stream",
        // A model_refusal error's stream usage row is terminalRefusalUsage
        // (only set for terminal no-fallback refusals); label it as a refusal
        // so analytics can distinguish refusals from generic stream errors.
        payload.errorType === "model_refusal" ? "refused_stream" : "errored_stream"
      );
    } catch (error) {
      log.error("Failed to record errored-stream usage in headless sidecar", { error });
    }

    // Emit error event before completion settles so recovery bookkeeping is ready for waiters.
    this.deps.turnEvents.emitTurnEvent(createErrorEvent(workspaceId as string, payload));
    return payload;
  }

  /**
   * Safely cancels an existing stream with proper cleanup
   *
   * CRITICAL: Waits for the processing promise to complete before cleanup.
   * This ensures the old stream fully exits before a new stream can start,
   * preventing concurrent streams and race conditions.
   */
  async cleanupAbortedStream(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    abortReason: StreamAbortReason,
    abandonPartial?: boolean
  ): Promise<void> {
    // Close before waiting: late or queued invocations cannot publish after abort.
    if (streamInfo.executionScope)
      this.deps.toolCallDisplayRegistry.close(streamInfo.executionScope);
    // CRITICAL: Wait for processing to fully complete before cleanup
    // This prevents race conditions where the old stream is still running
    // while a new stream starts (e.g., old stream writing to partial.json)
    try {
      await streamInfo.processingPromise;
    } catch (error) {
      // The provider has exited even when teardown failed. Cancellation still owns
      // an aborted terminal unless the loop already published another outcome.
      log.error("Stream processing failed during cancellation", { error });
    }

    // The cancel lost the race: the loop had already left the fullStream and
    // finished as completed/failed (terminalCompletion set, stream-end/error
    // emitted, completion settled by processStreamWithCleanup's finally).
    // Re-running the abort bookkeeping here would resurrect partial.json after
    // deletePartial and emit a second terminal event (stream-abort after
    // stream-end), which the renderer reads as "still partial".
    if (streamInfo.terminalCompletion !== undefined) {
      return;
    }

    // Also covers registered STARTING attempts: their envelope callback may itself await
    // stopStream, so join owned resources here without joining that callback back into itself.
    // The envelope only journals; its original callback/mutex lifetime stays independently
    // leased. Canceled engine model/temp/debounce resources retire before raw terminal delivery.
    await this.deps.turnResources.closeStreamResources(streamInfo);

    // For aborts, use our tracked cumulativeUsage directly instead of AI SDK's totalUsage.
    // cumulativeUsage is updated on each finish-step event (before tool execution),
    // so it has accurate data even when the stream is interrupted mid-tool-call.
    // AI SDK's totalUsage may return zeros or stale data when aborted.
    // Duration from the wall-clock streamInfo.startTime.
    const duration = nodeClock.nowMs() - streamInfo.startTime;
    const usage = hasTokenUsage(streamInfo.cumulativeUsage)
      ? streamInfo.cumulativeUsage
      : undefined;

    const abortUsage: AbortedStreamUsage = {
      usage,
      // For context window display, use last step's usage (inputTokens = current context size)
      contextUsage: streamInfo.lastStepUsage,
      contextProviderMetadata: streamInfo.lastStepProviderMetadata,
      // Include provider metadata for accurate cost calculation
      providerMetadata: markProviderMetadataCostsIncluded(
        streamInfo.cumulativeProviderMetadata,
        streamInfo.initialMetadata?.costsIncluded
      ),
      duration,
    };
    const streamAbort = buildStreamAbortEvent(
      workspaceId,
      streamInfo,
      abortUsage,
      abortReason,
      abandonPartial
    );
    try {
      try {
        await this.deps.backfillReasoningTokensFromParts(streamInfo, usage);
      } catch (error) {
        // Estimation is optional: preserve provider usage and the user's abort reason.
        log.error("Failed to estimate reasoning usage on abort", { error });
      }

      // Record session usage for aborted streams (mirrors stream-end path)
      // This ensures tokens consumed before abort are tracked for cost display
      await this.deps.usageLedger.settle(
        workspaceId,
        streamInfo,
        usage,
        abortUsage.providerMetadata,
        "Failed to record session usage on abort",
        "error"
      );

      await this.persistAbortedStreamUsage(workspaceId, streamInfo, abortUsage, abandonPartial);
    } catch (error) {
      log.error("Failed abort bookkeeping; delivering preserved terminal metadata", { error });
    } finally {
      await this.finishAbortedStream(
        workspaceId,
        streamInfo,
        streamAbort,
        abortReason,
        abandonPartial
      );
    }
  }

  /**
   * Stamps the aborted turn's usage onto its partial, or routes it to the
   * headless-usage sidecar when the partial will not reach chat.jsonl.
   */
  private async persistAbortedStreamUsage(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    abortUsage: AbortedStreamUsage,
    abandonPartial: boolean | undefined
  ): Promise<void> {
    const { usage, providerMetadata } = abortUsage;
    // Stamp the aborted turn's usage onto the partial message BEFORE committing
    // it and delivering stream-abort. Analytics
    // prices history rows from metadata.usage, so without this every
    // interrupted turn — user Esc, queued tool-end preemption, monitor wakes —
    // would ingest as $0 even though the provider billed all completed steps.
    if (!abandonPartial && (usage !== undefined || streamInfo.toolModelUsages.length > 0)) {
      try {
        await this.deps.partialJournal.awaitPending(streamInfo);
        const partialMessage = this.deps.buildPartialAssistantMessage(streamInfo, {
          metadata: abortedPartialMetadata(streamInfo, abortUsage),
        });
        await this.deps.partialJournal.writeAbortPartial(workspaceId as string, partialMessage);

        // Tool-only aborts (Esc while a tool is still running): commitPartial
        // refuses to commit partials whose only parts are input-available tool
        // calls, so the usage stamped above would die with the deleted
        // partial. Route that spend through the headless-usage sidecar
        // instead. Same predicate commitPartial applies, so exactly one of
        // {chat row, sidecar row} carries this turn's usage.
        if (!hasCommitWorthyParts(partialMessage.parts)) {
          await this.deps.usageLedger.recordDroppedPartialUsage(
            workspaceId,
            streamInfo,
            usage,
            providerMetadata,
            "aborted_stream"
          );
        }
      } catch (error) {
        log.error("Failed to persist aborted-stream usage on partial message", { error });
      }
    } else if (abandonPartial && (usage !== undefined || streamInfo.toolModelUsages.length > 0)) {
      // Abandoned aborts (edit/discard of the streaming turn): the partial is
      // deliberately dropped and its content never reaches chat.jsonl, but
      // the provider still billed every completed step. The sidecar is the
      // only route to the events table for this spend.
      try {
        await this.deps.usageLedger.recordDroppedPartialUsage(
          workspaceId,
          streamInfo,
          usage,
          providerMetadata,
          "aborted_stream"
        );
      } catch (error) {
        log.error("Failed to record abandoned-abort usage in headless sidecar", { error });
      }
    }
  }

  /**
   * The abort's terminal steps: end the partial, deliver stream-abort, then
   * unregister the stream and settle its completion.
   */
  private async finishAbortedStream(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    streamAbort: StreamAbortEvent,
    abortReason: StreamAbortReason,
    abandonPartial: boolean | undefined
  ): Promise<void> {
    try {
      // Cancellation owns this attempt through disk cleanup and raw delivery. Keeping
      // the registration until then makes replacement startup join the same fence.
      const result = await this.deps.partialJournal.settleAbort(
        workspaceId,
        streamInfo.messageId,
        abandonPartial === true
      );
      // commitPartial already deletes on success. On failure retain recovery data;
      // an unconditional delete here would silently discard an uncommitted answer.
      if (!result.success)
        log.error("Failed partial cleanup during stream-abort", {
          workspaceId,
          error: result.error,
        });
    } catch (error) {
      log.error("Failed partial cleanup during stream-abort", { workspaceId, error });
    }
    try {
      await this.deps.turnEvents.deliver(streamAbort);
    } catch (error) {
      log.error("Stream-abort delivery failed", { error: getErrorMessage(error) });
    } finally {
      if (this.deps.workspaceStreams.get(workspaceId) === streamInfo) {
        this.deps.workspaceStreams.delete(workspaceId);
      }
      const terminalCompletion: TurnCompletion = {
        status: "aborted",
        abortReason,
        streamAbort,
        systemMessageTokens: streamInfo.initialMetadata?.systemMessageTokens,
      };
      TurnRegistry.recordTerminal(streamInfo, terminalCompletion);
      // Session policy consumes this promise separately. It may start a replacement,
      // so neither this fence nor the raw sink may join that policy.
      streamInfo.completionController?.settle(terminalCompletion);
    }
  }
}
