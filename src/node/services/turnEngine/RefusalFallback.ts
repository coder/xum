/**
 * RefusalFallback swaps a refused turn onto the next model of its refusal-fallback
 * chain, inside the running attempt loop. It records the refused attempt's usage,
 * prepares and starts the fallback request, and points the live stream at it.
 * StreamManager's attempt loop (recoverRefusedAttempt) calls
 * tryModelFallbackAfterRefusal and continues on the swapped stream.
 */
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import type { MuxMetadata, MuxMessage } from "@/common/types/message";
import { hasTokenUsage } from "@/common/types/message";
import { Err, Ok, type Result } from "@/common/types/result";
import type { CompletedMessagePart } from "@/common/types/stream";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import { applyCacheControl, getRequestAnthropicCacheTtl } from "@/common/utils/ai/cacheStrategy";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { getErrorMessage } from "@/common/utils/errors";
import { collectDeferLoadingToolNames } from "@/common/utils/tools/toolCatalog";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { rebaseAutoThinkingEscalation } from "@/node/services/autoThinkingEscalation";
import { ContextBudgetExceededError } from "@/node/services/contextBudgetError";
import {
  stripMessageCacheControl,
  type ContinuousPrefixSwap,
} from "@/node/services/continuousCompactionJournal";
import type { HistoryService } from "@/node/services/historyService";
import { runLanguageModelCleanup } from "@/node/services/languageModelCleanup";
import type { Logger } from "@/node/services/log";
import type { ActiveTurnThinkingOverride } from "@/node/services/thinkingOverride";
import type { AnthropicThinkingReplayPoint } from "@/node/utils/messages/anthropicThinkingReplay";
import { ProviderRequest, type StreamRequestConfig } from "./ProviderRequest";
import { StepApply } from "./StepApply";
import { applyTurnReplayReceipt, type StepMessageTracker } from "./StepPreparation";
import { publishLiveRouting, withAutoThinkingClaim } from "./TurnEngine";
import type { TurnEvents } from "./TurnEvents";
import type {
  ModelFallbackOptions,
  ModelFallbackPrepareOptions,
  PreparedModelFallback,
  StreamManagerTokenTracker,
  WorkspaceId,
} from "./types";
import type { WorkspaceStreamInfo } from "./turnState";
import { cloneUsage, markProviderMetadataCostsIncluded, type UsageLedger } from "./UsageLedger";

function hasIncompleteToolCallPart(parts: CompletedMessagePart[]): boolean {
  return parts.some((part) => part.type === "dynamic-tool" && part.state !== "output-available");
}

type ModelFallbackState = NonNullable<WorkspaceStreamInfo["modelFallback"]>;

/** Outcome of a refusal-fallback attempt (see tryModelFallbackAfterRefusal). */
type RefusalFallbackOutcome = { kind: "swapped" } | { kind: "terminal"; terminalNote?: string };

/** Returns the metadata with the chain's current refusal record (requested + refused models). */
export function withModelFallbackRecord(
  metadata: Partial<MuxMetadata> | undefined,
  fallbackState: Pick<ModelFallbackState, "requestedModel" | "refusedModels">
): Partial<MuxMetadata> {
  return {
    ...metadata,
    modelFallback: {
      requestedModel: fallbackState.requestedModel,
      refusedModels: [...fallbackState.refusedModels],
    },
  };
}

/**
 * Picks the chain's next model after the latest refusal, or the terminal note
 * when the chain is exhausted or the refused partial output cannot continue.
 */
export function resolveNextFallbackModel(
  fallbackState: Pick<ModelFallbackState, "options" | "refusedModels">,
  preserveParts: boolean,
  parts: CompletedMessagePart[]
): { kind: "next"; modelString: string } | { kind: "terminal"; terminalNote: string } {
  const nextModelString = fallbackState.options.chain[fallbackState.refusedModels.length - 1];
  if (nextModelString === undefined) {
    return {
      kind: "terminal",
      terminalNote: `Model fallback chain exhausted; refused models: ${fallbackState.refusedModels.join(", ")}.`,
    };
  }

  if (preserveParts && hasIncompleteToolCallPart(parts)) {
    return {
      kind: "terminal",
      terminalNote:
        "Model fallback was skipped because the refused partial response had an incomplete tool call.",
    };
  }
  return { kind: "next", modelString: nextModelString };
}

/**
 * Fold a mid-turn thinking override (pending or already applied) into the
 * fallback's baseline so the hop doesn't silently revert the user's
 * mid-turn change. Pending is cleared here — prepare() re-clamps it for
 * the fallback model and bakes it into the rebuilt provider options.
 */
export function foldThinkingOverrideForFallback(
  overrideHolder: ActiveTurnThinkingOverride | undefined
): ThinkingLevel | undefined {
  const thinkingLevelOverride = overrideHolder?.pending ?? overrideHolder?.applied;
  if (overrideHolder?.pending != null) {
    overrideHolder.pending = undefined;
  }
  if (overrideHolder != null && thinkingLevelOverride != null) {
    // Keep the override visible to later hops: prepare() bakes it into this
    // hop's baseline, but a second hop re-folds from `applied`.
    overrideHolder.applied = thinkingLevelOverride;
  }
  return thinkingLevelOverride;
}

/** The prepare() options for a fallback hop, or undefined when it has none. */
export function buildFallbackPrepareOptions(
  continuationMessage: MuxMessage | undefined,
  thinkingLevelOverride: ThinkingLevel | undefined
): ModelFallbackPrepareOptions | undefined {
  return continuationMessage != null || thinkingLevelOverride != null
    ? {
        ...(continuationMessage != null
          ? { continuation: { assistantMessage: continuationMessage } }
          : {}),
        ...(thinkingLevelOverride != null ? { thinkingLevelOverride } : {}),
      }
    : undefined;
}

/**
 * Whether the fallback request may keep the continuous-compaction prefix swap.
 * Fallback preparation can combine consecutive tool-only steps from the live
 * Mux row. An internal cut is no longer a provable wire-message boundary.
 */
export function canReuseFallbackPrefix(
  family: string | undefined,
  consumedSwap: ContinuousPrefixSwap,
  preparedThinkingLevel: string | undefined,
  nextRequest: Pick<StreamRequestConfig, "tools">
): boolean {
  return (
    family === consumedSwap.journal.providerFamily &&
    consumedSwap.journal.liveTailCopySpec.partIndex === 0 &&
    (preparedThinkingLevel ?? "off") === consumedSwap.journal.preparation.effectiveThinkingLevel &&
    // The swapped prefix references only the parent's native deferred tools (#5262).
    [...collectDeferLoadingToolNames(nextRequest.tools ?? {})].sort().join("\n") ===
      [...(consumedSwap.journal.preparation.deferLoadingToolNames ?? [])].sort().join("\n")
  );
}

/** The fallback request's system messages plus the swap's conversation prefix. */
export function buildFallbackPrefix(
  consumedSwap: ContinuousPrefixSwap,
  nextRequest: Pick<
    StreamRequestConfig,
    "messages" | "cacheEnabled" | "providerOptions" | "anthropicCacheTtl"
  >
): ModelMessage[] {
  const conversation = stripMessageCacheControl(
    consumedSwap.prefix.filter((message) => message.role !== "system")
  );
  return [
    ...nextRequest.messages.filter((message) => message.role === "system"),
    ...(nextRequest.cacheEnabled
      ? applyCacheControl(
          conversation,
          "anthropic:prefix",
          getRequestAnthropicCacheTtl(nextRequest)
        )
      : conversation),
  ];
}

/** One refusal-fallback hop's inputs, shared by the swap steps. */
interface RefusalFallbackSwap {
  workspaceId: WorkspaceId;
  streamInfo: WorkspaceStreamInfo;
  fallbackState: ModelFallbackState;
  nextModelString: string;
  /** Canonical refusing model (the display list and chain bookkeeping). */
  refusedModel: string;
  refusalFinishReason: string;
  preserveParts: boolean;
  /** Cloned partial assistant turn when continuing after partial output. */
  continuationMessage: MuxMessage | undefined;
}

export interface RefusalFallbackDeps {
  readonly usageLedger: Pick<UsageLedger, "recordRefusedAttempt" | "recordTerminalRefusal">;
  readonly providerRequest: Pick<ProviderRequest, "buildStreamRequestConfig" | "swapPrefix">;
  readonly historyService: Pick<HistoryService, "getContinuousCompactionJournal">;
  readonly turnEvents: Pick<TurnEvents<WorkspaceStreamInfo>, "emitTurnEvent">;
  /** StreamManager's token tracker, read at call time (whitebox tests replace it). */
  readonly tokenTracker: Pick<StreamManagerTokenTracker, "setModel">;
  readonly getWorkspaceLogger: (
    workspaceId: WorkspaceId,
    streamInfo?: Pick<WorkspaceStreamInfo, "workspaceName">
  ) => Logger;
  readonly resolveMetadataModel: (
    modelString: string,
    providersConfigSnapshot?: ProvidersConfigMap
  ) => string;
  readonly handleToolExecutionStart: (
    workspaceId: WorkspaceId,
    messageId: string,
    toolCallId: string
  ) => void;
  /** StreamManager.createStreamResult, read at call time (whitebox tests replace it). */
  readonly createStreamResult: (
    request: StreamRequestConfig,
    abortController: AbortController,
    stepTracker: StepMessageTracker
  ) => WorkspaceStreamInfo["streamResult"];
  readonly resetStreamStateForRetry: (
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    options?: { preserveParts?: boolean; preserveUsage?: boolean; workspaceLog?: Logger }
  ) => Promise<void>;
  readonly moveAnthropicThinkingReplayPoint: (
    streamInfo: WorkspaceStreamInfo,
    point: AnthropicThinkingReplayPoint
  ) => boolean;
  /** The stream's usage and provider metadata, as StreamManager.getStreamMetadata reads them. */
  readonly getStreamMetadata: (streamInfo: WorkspaceStreamInfo) => Promise<{
    totalUsage?: LanguageModelV2Usage;
    contextProviderMetadata?: Record<string, unknown>;
  }>;
  readonly backfillReasoningTokensFromParts: (
    streamInfo: WorkspaceStreamInfo,
    usage: LanguageModelV2Usage | undefined
  ) => Promise<void>;
  readonly getAggregatedProviderMetadata: (
    streamInfo: WorkspaceStreamInfo
  ) => Promise<Record<string, unknown> | undefined>;
  readonly buildPartialAssistantMessage: (
    streamInfo: WorkspaceStreamInfo,
    options?: { metadata?: Partial<MuxMetadata>; parts?: MuxMessage["parts"] }
  ) => MuxMessage;
}

export class RefusalFallback {
  constructor(private readonly deps: RefusalFallbackDeps) {}

  private async getRefusalUsageSnapshot(streamInfo: WorkspaceStreamInfo): Promise<{
    usage?: LanguageModelV2Usage;
    providerMetadata?: Record<string, unknown>;
  }> {
    let usage = hasTokenUsage(streamInfo.cumulativeUsage) ? streamInfo.cumulativeUsage : undefined;
    let providerMetadata = streamInfo.cumulativeProviderMetadata
      ? { ...streamInfo.cumulativeProviderMetadata }
      : undefined;

    if (!usage) {
      const streamMeta = await this.deps.getStreamMetadata(streamInfo);
      usage = hasTokenUsage(streamMeta.totalUsage) ? streamMeta.totalUsage : undefined;
      providerMetadata = providerMetadata ?? streamMeta.contextProviderMetadata;
    }

    if (!usage) {
      return {};
    }

    // Refused attempts never reach the normal stream-end path, so backfill
    // provider-omitted reasoningTokens before snapshotting usage for the
    // refusing model. reasoningBackfillStartIndex excludes earlier refused hops
    // when a later fallback also refuses after preserved parts.
    await this.deps.backfillReasoningTokensFromParts(streamInfo, usage);

    providerMetadata =
      providerMetadata ??
      (streamInfo.cumulativeProviderMetadata
        ? { ...streamInfo.cumulativeProviderMetadata }
        : await this.deps.getAggregatedProviderMetadata(streamInfo));

    return {
      usage: cloneUsage(usage),
      providerMetadata: markProviderMetadataCostsIncluded(
        providerMetadata ? { ...providerMetadata } : undefined,
        streamInfo.initialMetadata?.costsIncluded
      ),
    };
  }

  /** Attributes a refused fallback attempt's usage (UsageLedger.recordRefusedAttempt). */
  private async recordRefusedAttemptUsage(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    refusedModel: string
  ): Promise<void> {
    await this.deps.usageLedger.recordRefusedAttempt(
      workspaceId,
      streamInfo,
      refusedModel,
      await this.getRefusalUsageSnapshot(streamInfo)
    );
  }

  private async recordTerminalRefusalUsage(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    refusedModel: string
  ): Promise<void> {
    await this.deps.usageLedger.recordTerminalRefusal(
      workspaceId,
      streamInfo,
      refusedModel,
      await this.getRefusalUsageSnapshot(streamInfo)
    );
  }

  private buildPartialRefusalContinuationMessage(
    streamInfo: WorkspaceStreamInfo,
    refusalFinishReason: string
  ): Result<MuxMessage, string> {
    try {
      const parts = structuredClone(streamInfo.parts) as MuxMessage["parts"];
      return Ok(
        this.deps.buildPartialAssistantMessage(streamInfo, {
          metadata: { finishReason: refusalFinishReason },
          parts,
        })
      );
    } catch (error) {
      return Err(`cloning partial assistant output failed: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Attempt a refusal-fallback model swap in place of a terminal model_refusal.
   *
   * This runs entirely inside the active stream loop, BEFORE any error event or
   * partial error state is committed, so TaskService/waiters never observe an
   * intermediate refusal while the chain is being attempted (no settlement
   * race) and no stale failed placeholder is persisted mid-chain.
   *
   * Returns { kind: "swapped" } when the loop should `continue` on the new
   * streamResult, or { kind: "terminal", terminalNote? } when the refusal must
   * fail the turn (no chain, chain exhausted, interrupted, or an unstartable
   * fallback model — which intentionally fails instead of skipping ahead).
   */
  async tryModelFallbackAfterRefusal(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    refusalFinishReason: string,
    options?: { preserveParts?: boolean }
  ): Promise<RefusalFallbackOutcome> {
    const fallbackState = streamInfo.modelFallback;
    const preserveParts = options?.preserveParts === true;
    const refusedModel = normalizeToCanonical(streamInfo.model);
    // Usage attribution keeps the RAW identity: canonicalization rewrites a
    // cross-typed Coder instance (coder:openai/<claude>, type anthropic) to
    // openai:<claude>, and recordSessionUsage / ledger rebuilds could then no
    // longer recover the instance type for pricing. The canonical string is
    // only for the display list / chain bookkeeping below.
    const refusedModelForUsage = streamInfo.model;

    if (!fallbackState) {
      await this.recordTerminalRefusalUsage(workspaceId, streamInfo, refusedModelForUsage);
      return { kind: "terminal" };
    }

    fallbackState.refusedModels.push(refusedModel);
    StepApply.setInitialMetadata(
      streamInfo,
      withModelFallbackRecord(streamInfo.initialMetadata, fallbackState)
    );

    if (streamInfo.abortController.signal.aborted || streamInfo.softInterrupt.pending) {
      await this.recordRefusedAttemptUsage(workspaceId, streamInfo, refusedModelForUsage);
      return { kind: "terminal" };
    }

    // Attribute this refused attempt's usage to the refusing model for EVERY
    // chain outcome (swap, exhaustion, unstartable fallback) before any state
    // reset. Chains that end in a terminal failure must not drop the final
    // hop's tokens from session usage / cost accounting.
    await this.recordRefusedAttemptUsage(workspaceId, streamInfo, refusedModelForUsage);

    const next = resolveNextFallbackModel(fallbackState, preserveParts, streamInfo.parts);
    if (next.kind === "terminal") {
      return next;
    }

    const continuation = this.buildRefusalContinuation(
      streamInfo,
      preserveParts,
      refusalFinishReason
    );
    if (!continuation.success) {
      return {
        kind: "terminal",
        terminalNote: `Model fallback was skipped because ${continuation.error}.`,
      };
    }

    return this.swapToFallbackModel({
      workspaceId,
      streamInfo,
      fallbackState,
      nextModelString: next.modelString,
      refusedModel,
      refusalFinishReason,
      preserveParts,
      continuationMessage: continuation.data,
    });
  }

  /** The cloned partial turn to continue from, or undefined when parts are not preserved. */
  private buildRefusalContinuation(
    streamInfo: WorkspaceStreamInfo,
    preserveParts: boolean,
    refusalFinishReason: string
  ): Result<MuxMessage | undefined, string> {
    return preserveParts
      ? this.buildPartialRefusalContinuationMessage(streamInfo, refusalFinishReason)
      : Ok(undefined);
  }

  /** Prepares, builds and starts the fallback request, then commits the swap. */
  private async swapToFallbackModel(swap: RefusalFallbackSwap): Promise<RefusalFallbackOutcome> {
    const { workspaceId, streamInfo, nextModelString } = swap;
    const workspaceLog = this.deps.getWorkspaceLogger(workspaceId, streamInfo);
    const overrideHolder = streamInfo.request.thinkingOverrideState;
    const thinkingLevelOverride = foldThinkingOverrideForFallback(overrideHolder);
    const prepareCallOptions = buildFallbackPrepareOptions(
      swap.continuationMessage,
      thinkingLevelOverride
    );
    streamInfo.stepTracker.pendingPrefixSwap = undefined;
    const prepared = await this.prepareFallbackModel(swap, prepareCallOptions);
    if (!prepared.success) {
      return { kind: "terminal", terminalNote: prepared.error };
    }

    const fallbackMessages = applyTurnReplayReceipt(streamInfo.stepTracker, prepared.data.messages);
    // Build the swapped request/stream into locals first so a failure here
    // leaves streamInfo unmodified (the terminal error then names the model
    // that actually refused, not a half-applied fallback).
    const nextRequest = this.buildFallbackStreamRequest(swap, prepared.data, fallbackMessages);
    const consumedSwap = streamInfo.stepTracker.consumedPrefixSwap;
    if (consumedSwap) {
      await this.applyFallbackPrefixSwap(swap, consumedSwap, nextRequest, prepared.data);
    }
    // createStreamResult may eagerly prepare the first fallback step and update
    // latestMessages. Clear stale source-step messages before starting it so a
    // later disk-reset await cannot wipe freshly prepared fallback messages.
    streamInfo.stepTracker.latestMessages = undefined;
    let nextStreamResult: WorkspaceStreamInfo["streamResult"];
    try {
      nextStreamResult = this.deps.createStreamResult(
        nextRequest,
        streamInfo.abortController,
        streamInfo.stepTracker
      );
    } catch (error) {
      // The prepared fallback model never becomes streamInfo.request.model, so
      // the stream-exit finally would miss it (e.g. OpenAI WS transports hold
      // open sockets until cleanup runs).
      runLanguageModelCleanup(prepared.data.model);
      return {
        kind: "terminal",
        terminalNote: `Configured fallback model ${nextModelString} could not be started: ${getErrorMessage(error)}`,
      };
    }

    await this.commitFallbackSwap(swap, {
      prepared: prepared.data,
      fallbackMessages,
      nextRequest,
      nextStreamResult,
      consumedSwap,
      overrideHolder,
      workspaceLog,
    });
    return { kind: "swapped" };
  }

  /**
   * Runs the chain's prepare() for the next model. The error is the terminal note.
   *
   * A throw out of prepare() must not escape to the generic stream-error path:
   * it would be categorized as a retryable api/unknown error and re-enter the
   * unbounded auto-retry loop this feature exists to prevent. Aborts rethrow so
   * a user interrupt during prepare stays an abort instead of a refusal.
   */
  private async prepareFallbackModel(
    swap: RefusalFallbackSwap,
    prepareCallOptions: ModelFallbackPrepareOptions | undefined
  ): Promise<Result<PreparedModelFallback, string>> {
    const { streamInfo, fallbackState, nextModelString } = swap;
    let prepared: Awaited<ReturnType<ModelFallbackOptions["prepare"]>>;
    try {
      prepared = await fallbackState.options.prepare(nextModelString, prepareCallOptions);
    } catch (error) {
      if (streamInfo.abortController.signal.aborted) {
        throw error;
      }
      return Err(
        `Configured fallback model ${nextModelString} could not be started: ${getErrorMessage(error)}`
      );
    }
    if (!prepared.success) {
      if (typeof prepared.error !== "string") throw new ContextBudgetExceededError(prepared.error);
      return Err(
        `Configured fallback model ${nextModelString} could not be started: ${prepared.error}`
      );
    }
    return prepared;
  }

  /** The fallback model's request config; the live hooks and holders carry over. */
  private buildFallbackStreamRequest(
    swap: RefusalFallbackSwap,
    prepared: PreparedModelFallback,
    fallbackMessages: ModelMessage[]
  ): StreamRequestConfig {
    const { workspaceId, streamInfo, fallbackState } = swap;
    return this.deps.providerRequest.buildStreamRequestConfig({
      model: prepared.model,
      modelString: prepared.modelString,
      messages: fallbackMessages,
      system: prepared.system,
      tools: prepared.tools,
      providerOptions: prepared.providerOptions,
      anthropicCacheTtl: prepared.anthropicCacheTtl,
      maxOutputTokens: fallbackState.original.maxOutputTokens,
      callSettingsOverrides: prepared.callSettingsOverrides,
      toolPolicy: streamInfo.request.toolPolicy,
      hasQueuedMessages: streamInfo.request.hasQueuedMessages,
      getQueuedInputStopCause: streamInfo.request.getQueuedInputStopCause,
      headers: prepared.headers,
      onChunk: streamInfo.request.onChunk,
      onStepMessages: streamInfo.request.onStepMessages,
      onStepSettled: streamInfo.request.onStepSettled,
      contextBudgetLimit: prepared.contextBudgetLimit,
      contextBudgetTurnAnchor: prepared.contextBudgetTurnAnchor,
      // Same state object: aiService's fallback prepare() rebuilt it in place
      // against the fallback toolset, so prepareStep keeps reading live state.
      toolSearchState: streamInfo.request.toolSearchState,
      onToolExecutionStart: (toolCallId) =>
        this.deps.handleToolExecutionStart(workspaceId, streamInfo.messageId, toolCallId),
      // Same holder object (the session's setter keeps working across the
      // hop) with a closure bound to the FALLBACK model. Attached before
      // createStreamResult below in case the SDK eagerly prepares step 1.
      thinkingOverrideState: streamInfo.request.thinkingOverrideState,
      rebuildProviderOptionsForThinkingLevel: prepared.rebuildProviderOptionsForThinkingLevel,
      forcedFirstStepToolNames: prepared.forcedFirstStepToolNames,
      providersConfigSnapshot: prepared.providersConfig,
      rebuildFirstStepForThinkingLevel: prepared.rebuildFirstStepForThinkingLevel,
    });
  }

  /**
   * Keeps the continuous-compaction prefix swap on the fallback request when the
   * fallback's wire still matches the journal, else marks the swap invalidated.
   */
  private async applyFallbackPrefixSwap(
    swap: RefusalFallbackSwap,
    consumedSwap: ContinuousPrefixSwap,
    nextRequest: StreamRequestConfig,
    prepared: PreparedModelFallback
  ): Promise<void> {
    const family = this.deps
      .resolveMetadataModel(prepared.modelString, prepared.providersConfig)
      .split(":", 1)[0];
    let messages: ModelMessage[] | null = null;
    if (canReuseFallbackPrefix(family, consumedSwap, prepared.thinkingLevel, nextRequest)) {
      messages = await this.recordFallbackPrefixSwap(
        swap,
        consumedSwap,
        nextRequest,
        prepared.modelString
      );
    }
    if (messages) nextRequest.messages = messages;
    else swap.streamInfo.stepTracker.prefixSwapInvalidated = true;
  }

  /**
   * Swaps the fallback request's prefix and records it in the journal. Returns
   * the swapped messages, or null when the swap fails or goes stale meanwhile.
   */
  private async recordFallbackPrefixSwap(
    swap: RefusalFallbackSwap,
    consumedSwap: ContinuousPrefixSwap,
    nextRequest: StreamRequestConfig,
    modelString: string
  ): Promise<ModelMessage[] | null> {
    const { workspaceId, streamInfo } = swap;
    const prefix = buildFallbackPrefix(consumedSwap, nextRequest);
    const swapped = this.deps.providerRequest.swapPrefix(nextRequest.messages, {
      ...consumedSwap,
      prefix,
    });
    if (!swapped) {
      return null;
    }
    const appliedThinking = nextRequest.thinkingOverrideState?.applied;
    const isCurrent = () =>
      streamInfo.stepTracker.consumedPrefixSwap === consumedSwap &&
      !streamInfo.abortController.signal.aborted &&
      nextRequest.thinkingOverrideState?.pending == null &&
      nextRequest.thinkingOverrideState?.applied === appliedThinking;
    const journal = await this.deps.historyService
      .getContinuousCompactionJournal(workspaceId)
      .recordFallbackPrefix(
        consumedSwap.journal,
        {
          modelString,
          prefix,
          providerOptions: nextRequest.providerOptions,
          system: nextRequest.system,
        },
        isCurrent,
        (committed) => {
          consumedSwap.journal = committed;
        }
      );
    if (journal && isCurrent()) {
      consumedSwap.journal = journal;
      return swapped;
    }
    return null;
  }

  /** Points the live stream at the started fallback request (the swap succeeded). */
  private async commitFallbackSwap(
    swap: RefusalFallbackSwap,
    started: {
      prepared: PreparedModelFallback;
      fallbackMessages: ModelMessage[];
      nextRequest: StreamRequestConfig;
      nextStreamResult: WorkspaceStreamInfo["streamResult"];
      consumedSwap: ContinuousPrefixSwap | undefined;
      overrideHolder: ActiveTurnThinkingOverride | undefined;
      workspaceLog: Logger;
    }
  ): Promise<void> {
    const { workspaceId, streamInfo, fallbackState, preserveParts } = swap;
    const { prepared, workspaceLog } = started;

    // Before any await: the stream may already be preparing its first step, and a step-0
    // thinking rebuild there records a newer volatile-tail plan (recordSystemSections),
    // which must win over the patch's baseline. That rebuild always runs after an await.
    StepApply.setInitialMetadata(streamInfo, {
      ...streamInfo.initialMetadata,
      ...prepared.initialMetadataPatch,
    });

    // The fallback stream exists now; durable side effects describing this
    // request identity (superseding turn envelope) may be recorded.
    await prepared.onStreamConstructed?.();

    workspaceLog.warn(
      preserveParts
        ? "Model refused after partial output; continuing on configured fallback model"
        : "Model refused with no output; retrying on configured fallback model",
      {
        messageId: streamInfo.messageId,
        refusedModel: swap.refusedModel,
        nextModel: prepared.modelString,
        refusalFinishReason: swap.refusalFinishReason,
        chain: fallbackState.options.chain,
        preservedPartCount: preserveParts ? streamInfo.parts.length : 0,
      }
    );

    // The refused attempt's usage was recorded above, BEFORE the reset wipes
    // cumulative counters (cross-model usage must not be priced under the
    // fallback model).
    await this.deps.resetStreamStateForRetry(workspaceId, streamInfo, {
      preserveParts,
      workspaceLog,
    });
    StepApply.setReasoningBackfillStart(
      streamInfo,
      preserveParts ? streamInfo.parts.length : undefined
    );
    // The receipt strip also removed this row's preserved thinking, so the receipt's point
    // moves to the fallback's first step. It rides on the fallback's first partial write.
    if (started.fallbackMessages !== prepared.messages) {
      this.deps.moveAnthropicThinkingReplayPoint(
        streamInfo,
        streamInfo.stepStartIndices.length - 1
      );
    }

    this.adoptFallbackModelIdentity(streamInfo, fallbackState, prepared, started.overrideHolder);
    // Release the refused model's transport resources now: the stream-exit
    // finally only cleans the final request's model, so without this the
    // refused model (e.g. an OpenAI WS transport socket) would leak per hop.
    runLanguageModelCleanup(streamInfo.request.model);
    ProviderRequest.beginAttempt(streamInfo, started.nextRequest, () => started.nextStreamResult);
    publishLiveRouting(streamInfo);
    await this.deps.tokenTracker.setModel(streamInfo.model, streamInfo.metadataModel);
    if (started.consumedSwap) {
      this.emitPrefixSwapInvalidationOnce(workspaceId, streamInfo);
    }
  }

  /** Moves the stream's model, metadata and Auto routing onto the fallback model. */
  private adoptFallbackModelIdentity(
    streamInfo: WorkspaceStreamInfo,
    fallbackState: ModelFallbackState,
    prepared: PreparedModelFallback,
    overrideHolder: ActiveTurnThinkingOverride | undefined
  ): void {
    ProviderRequest.adoptModel(streamInfo, {
      modelString: prepared.modelString,
      metadataModel: this.deps.resolveMetadataModel(prepared.modelString, prepared.providersConfig),
      thinkingLevel: prepared.thinkingLevel,
    });
    // Final stream-end metadata spreads initialMetadata, so route attribution
    // corrections (the patch, applied above) and the fallback record propagate automatically.
    StepApply.setInitialMetadata(streamInfo, {
      ...withModelFallbackRecord(streamInfo.initialMetadata, fallbackState),
      // The routing record names the model that actually answered, not the refused tier model,
      // and (when Auto set it) the thinking level the fallback preparation clamped to.
      ...(streamInfo.initialMetadata?.autoModelRouting != null && {
        autoModelRouting: withAutoThinkingClaim(
          { ...streamInfo.initialMetadata.autoModelRouting, model: prepared.modelString },
          coerceThinkingLevel(prepared.thinkingLevel),
          overrideHolder?.manual
        ),
      }),
    });
    // Escalation climbs from the level the stream runs at now: the fallback model's ladder
    // may have clamped Auto's claim, and a raise proposed from the refused model's level
    // would be a no-op here and retire escalation for the rest of the turn.
    const escalationState = streamInfo.stepTracker.autoThinkingEscalation;
    const claimedLevel = streamInfo.initialMetadata?.autoModelRouting?.thinkingLevel;
    if (escalationState && claimedLevel != null) {
      rebaseAutoThinkingEscalation(escalationState, claimedLevel);
    }
  }

  /** Tells the session once per turn that the fallback hop dropped the prefix swap. */
  private emitPrefixSwapInvalidationOnce(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): void {
    if (
      streamInfo.stepTracker.prefixSwapInvalidated &&
      !streamInfo.stepTracker.prefixSwapInvalidationEmitted
    ) {
      streamInfo.stepTracker.prefixSwapInvalidationEmitted = true;
      this.deps.turnEvents.emitTurnEvent({
        type: "prefix-swap-invalidated",
        workspaceId,
        messageId: streamInfo.messageId,
      });
    }
  }
}
