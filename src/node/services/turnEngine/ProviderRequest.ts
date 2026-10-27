/**
 * ProviderRequest: the one owner of a StreamManager turn's provider request
 * (turn-engine layer 4a). It holds the cross-turn provider state that request building
 * reads (the OpenAI previousResponseIds the provider lost, and the continuous-compaction
 * prefix swap that the next step's request applies), builds the per-attempt request
 * config, and applies a pending mid-turn thinking override to it.
 *
 * StepPreparation opens the stream from that config (createStreamResult). StreamManager
 * still builds the stop conditions (createStopWhenCondition).
 *
 * Shape: like PartialJournal and UsageLedger, a plain class that StreamManager
 * constructs. The swap staging fields stay on each stream's step tracker
 * (WorkspaceStreamInfo.stepTracker), because whitebox fixtures hand-build stream infos;
 * StreamManager looks the stream up and passes it in.
 *
 * Invariants:
 * - A lost previousResponseId is recorded once per manager and never forgotten, so
 *   every later request omits it (TurnRequestBuilder reads isResponseIdLost).
 * - A turn stages at most one prefix swap: staging refuses a stream whose message,
 *   model or thinking level differs from the journal's, or that already holds a swap.
 * - swapPrefix cuts only at a unique locator; a missing or repeated locator keeps the
 *   full context (returns null).
 */
import type { Instructions, LanguageModel, ModelMessage, Tool } from "ai";

import type { ResolvedCallSettingsOverrides } from "@/common/config/schemas/modelParameters";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { QueuedInputStopCause } from "@/common/types/streamStopCause";
import { supportsAnthropicCache } from "@/common/utils/ai/cacheStrategy";
import assert from "@/common/utils/assert";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { getModelStats, getModelStatsResolved } from "@/common/utils/tokens/modelStats";
import type { ToolSearchStreamState } from "@/common/utils/tools/toolCatalog";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";

import type { TurnBudgetAnchor } from "@/node/services/contextBudgetCounting";
import {
  stripMessageCacheControl,
  type ContinuousPrefixSwap,
} from "@/node/services/continuousCompactionJournal";
import { log, type Logger } from "@/node/services/log";
import type {
  OnStepSettled,
  StreamTextOnChunk,
  StreamRequestConfig,
} from "@/node/services/turnEngine/types";
import type { AttemptRequest, WorkspaceStreamInfo } from "@/node/services/turnEngine/turnState";
import type {
  ActiveTurnThinkingOverride,
  RebuildFirstStepForThinkingLevel,
  RebuildProviderOptionsForThinkingLevel,
} from "@/node/services/thinkingOverride";
import { withSequentialExecution } from "@/node/services/tools/withSequentialExecution";
import { unprojectNativeToolReferences } from "@/common/utils/tools/toolCatalog";

import {
  extractErrorCode,
  extractPreviousResponseIdFromError,
  extractStatusCode,
} from "./providerWire";
export type { StreamRequestConfig } from "@/node/services/turnEngine/types";

export interface StreamRequestOptions {
  model: LanguageModel;
  modelString: string;
  messages: ModelMessage[];
  system: Instructions | undefined;
  tools?: Record<string, Tool>;
  providerOptions?: Record<string, unknown>;
  maxOutputTokens?: number;
  callSettingsOverrides?: ResolvedCallSettingsOverrides;
  toolPolicy?: ToolPolicy;
  hasQueuedMessages?: (dispatchMode?: "tool-end" | "turn-end") => boolean;
  getQueuedInputStopCause?: () => QueuedInputStopCause | undefined;
  headers?: Record<string, string | undefined>;
  onChunk?: StreamTextOnChunk;
  onStepMessages?: (messages: ModelMessage[]) => void;
  onStepSettled?: OnStepSettled;
  contextBudgetLimit?: number;
  contextBudgetTurnAnchor?: TurnBudgetAnchor;
  toolSearchState?: ToolSearchStreamState;
  thinkingOverrideState?: ActiveTurnThinkingOverride;
  rebuildProviderOptionsForThinkingLevel?: RebuildProviderOptionsForThinkingLevel;
  forcedFirstStepToolNames?: string[];
  providersConfigSnapshot?: ProvidersConfigMap;
  rebuildFirstStepForThinkingLevel?: RebuildFirstStepForThinkingLevel;
}

export type StreamRequestInput = StreamRequestOptions & {
  onToolExecutionStart?: (toolCallId: string) => void;
};

/** The step-tracker fields that stage and consume a continuous-compaction prefix swap. */
export interface PrefixSwapTracker {
  pendingPrefixSwap?: ContinuousPrefixSwap;
  consumedPrefixSwap?: ContinuousPrefixSwap;
  prefixSwapInvalidated?: boolean;
}

/** The stream fields that decide whether a prefix swap may be staged. */
export interface PrefixSwapStream {
  readonly messageId: string;
  readonly model: string;
  readonly thinkingLevel?: string;
  readonly stepTracker: PrefixSwapTracker;
}

/** The turn fields the lost-response-ID log line reads. */
export interface LostResponseIdTurn {
  readonly messageId: string;
  readonly model: string;
  readonly workspaceName?: string;
}

export interface ProviderRequestDeps {
  readonly getProvidersConfig: () => ProvidersConfigMap | null;
  readonly workspaceLogger: (
    workspaceId: string,
    turn?: Pick<LostResponseIdTurn, "workspaceName">
  ) => Logger;
}

export class ProviderRequest {
  // Track OpenAI previousResponseIds that have been invalidated
  // When frontend retries, buildProviderOptions will omit these IDs
  //
  // Effect migration Phase 10: stays a plain Set by the plain-mutables rule —
  // every mutator runs in a non-Effect context (AI-SDK error paths inside
  // processStreamWithCleanup) and no fiber reads or mutates it, so a Ref would
  // add ceremony without adding safety.
  private lostResponseIds = new Set<string>();

  constructor(private readonly deps: ProviderRequestDeps) {}

  /**
   * Starts the turn's next provider attempt: sets the request it sends, then the
   * stream result built from that request.
   */
  static beginAttempt(
    streamInfo: WorkspaceStreamInfo & AttemptRequest,
    request: StreamRequestConfig,
    createStreamResult: (request: StreamRequestConfig) => AttemptRequest["streamResult"]
  ): void {
    streamInfo.request = request;
    streamInfo.streamResult = createStreamResult(request);
  }

  /** Marks a retry after which stream-end prefers the turn's cumulative usage. */
  static markRetry(
    streamInfo: WorkspaceStreamInfo & AttemptRequest,
    retry: "previousResponseIdAtStep" | "reasoningReplayAtStep" | "afterEmptyOutput"
  ): void {
    switch (retry) {
      case "previousResponseIdAtStep":
        streamInfo.didRetryPreviousResponseIdAtStep = true;
        return;
      case "reasoningReplayAtStep":
        streamInfo.didRetryReasoningReplayAtStep = true;
        return;
      case "afterEmptyOutput":
        streamInfo.didRetryAfterEmptyOutput = true;
        return;
    }
  }

  /**
   * Moves the attempt onto a fallback model. The thinking level changes only when
   * the fallback's preparation chose one.
   */
  static adoptModel(
    streamInfo: WorkspaceStreamInfo & AttemptRequest,
    model: { modelString: string; metadataModel: string; thinkingLevel: string | undefined }
  ): void {
    streamInfo.model = model.modelString;
    streamInfo.metadataModel = model.metadataModel;
    if (model.thinkingLevel !== undefined) {
      streamInfo.thinkingLevel = model.thinkingLevel;
    }
  }

  /** Records the thinking level a mid-turn override applied. */
  static setThinkingLevel(
    streamInfo: WorkspaceStreamInfo & AttemptRequest,
    thinkingLevel: string
  ): void {
    streamInfo.thinkingLevel = thinkingLevel;
  }

  /**
   * Record a previousResponseId as lost if the error indicates OpenAI no longer has it.
   * StreamManager retries once automatically, and buildProviderOptions filters it for future requests.
   */
  recordLostResponseIdIfApplicable(
    workspaceId: string,
    error: unknown,
    streamInfo: LostResponseIdTurn,
    workspaceLog?: Logger
  ): void {
    const responseId = extractPreviousResponseIdFromError(error);
    if (!responseId) {
      return;
    }

    const errorCode = extractErrorCode(error);
    const statusCode = extractStatusCode(error);
    // Record if: we have the specific error code, OR a likely status code.
    // Proxies can surface OpenAI's "previous_response_not_found" as a 400 without the
    // structured error code, so we treat 400 as eligible once the responseId regex
    // matched the error payload/message.
    const shouldRecord =
      errorCode === "previous_response_not_found" ||
      statusCode === 404 ||
      statusCode === 500 ||
      statusCode === 400;

    if (!shouldRecord || this.lostResponseIds.has(responseId)) {
      return;
    }

    const logger = workspaceLog ?? this.deps.workspaceLogger(workspaceId, streamInfo);
    logger.info("Recording lost previousResponseId for future filtering", {
      previousResponseId: responseId,
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      statusCode,
      errorCode,
    });

    this.lostResponseIds.add(responseId);
  }

  /**
   * Check if a previousResponseId has been marked as lost
   * Called by buildProviderOptions to filter out invalid IDs
   */
  public isResponseIdLost(responseId: string): boolean {
    return this.lostResponseIds.has(responseId);
  }

  setPrefixSwap(stream: PrefixSwapStream | undefined, swap: ContinuousPrefixSwap): boolean {
    if (
      !stream ||
      stream.messageId !== swap.journal.streamMessageId ||
      stream.model !== swap.journal.parentModel ||
      (stream.thinkingLevel ?? "off") !== swap.journal.preparation.effectiveThinkingLevel ||
      stream.stepTracker.pendingPrefixSwap ||
      stream.stepTracker.consumedPrefixSwap
    )
      return false;
    stream.stepTracker.pendingPrefixSwap = swap;
    return true;
  }

  clearPrefixSwap(tracker: PrefixSwapTracker | undefined): void {
    if (tracker) {
      tracker.pendingPrefixSwap = undefined;
      tracker.consumedPrefixSwap = undefined;
    }
  }

  getPrefixSwapState(
    tracker: PrefixSwapTracker | undefined
  ): "none" | "pending" | "consumed" | "invalidated" {
    return tracker?.prefixSwapInvalidated
      ? "invalidated"
      : tracker?.consumedPrefixSwap
        ? "consumed"
        : tracker?.pendingPrefixSwap
          ? "pending"
          : "none";
  }

  swapPrefix(messages: ModelMessage[], swap: ContinuousPrefixSwap): ModelMessage[] | null {
    // Reused IDs can name different turns or steps. Neither oldest nor newest
    // proves the cut: ambiguity must use P1 instead of dropping or restoring context.
    let index = -1;
    for (const [messageIndex, message] of messages.entries()) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part.type !== "tool-call" || part.toolCallId !== swap.firstTailToolCallId) continue;
        if (index !== -1) {
          log.warn("[continuous-compaction] ambiguous prefix locator; retaining full context");
          return null;
        }
        index = messageIndex;
      }
    }
    if (index < 0) {
      log.warn("[continuous-compaction] prefix locator missing; retaining full context");
      return null;
    }
    // The retained tail may hold a projected repeated search whose first
    // occurrence the swapped-out prefix carried; restore the raw references so
    // the caller's dedupe re-decides against the swapped transcript. Done here
    // so every swap site (per-step and fallback rebuild) inverts identically.
    return [
      ...swap.prefix,
      ...stripMessageCacheControl(unprojectNativeToolReferences(messages.slice(index))),
    ];
  }

  buildStreamRequestConfig(input: StreamRequestInput): StreamRequestConfig {
    const {
      model,
      modelString,
      messages,
      system,
      tools,
      providerOptions,
      maxOutputTokens,
      callSettingsOverrides,
      toolPolicy,
      hasQueuedMessages,
      getQueuedInputStopCause,
      headers,
      onChunk,
      onStepMessages,
      onStepSettled,
      contextBudgetLimit,
      contextBudgetTurnAnchor,
      toolSearchState,
      onToolExecutionStart,
      thinkingOverrideState,
      rebuildProviderOptionsForThinkingLevel,
      forcedFirstStepToolNames,
      providersConfigSnapshot,
      rebuildFirstStepForThinkingLevel,
    } = input;
    // The request's pinned providers-config snapshot keeps type-derived output limits
    // aligned with the config that created the SDK model.
    const requestProvidersConfig = providersConfigSnapshot ?? this.deps.getProvidersConfig();
    // Mid-turn thinking overrides mutate providerOptions IN PLACE (the SDK's
    // per-step deep-merge reads the object passed at streamText() time, so
    // identity must stay stable). An initially-undefined value would make that
    // mutation unobservable — normalize to a guaranteed mutable object.
    const finalProviderOptions =
      rebuildProviderOptionsForThinkingLevel != null ? (providerOptions ?? {}) : providerOptions;

    // Use the runtime model's max_output_tokens if available and caller didn't
    // specify. This must be the runtime model (not the mapped metadata model)
    // because max_output_tokens is a request parameter sent to the provider —
    // a custom model's provider may not support the mapped model's output cap.
    // If no metadata exists, omit the parameter to let the provider use its
    // default (Anthropic requires this but has low defaults).
    const { maxOutputTokens: configMaxOutputTokens, ...streamCallSettings } =
      callSettingsOverrides ?? {};

    const runtimeModelStats = getModelStats(modelString);
    // Fall back to resolved stats for custom aliases (e.g., provider alias mappedToModel).
    const resolvedModelStats =
      runtimeModelStats ?? getModelStatsResolved(modelString, requestProvidersConfig);
    const effectiveMaxOutputTokens =
      maxOutputTokens ?? configMaxOutputTokens ?? resolvedModelStats?.max_output_tokens;

    return {
      model,
      modelString,
      messages,
      system,
      cacheEnabled: supportsAnthropicCache(modelString, requestProvidersConfig),
      budgetMetadataModel: resolveModelForMetadata(modelString, requestProvidersConfig),
      // Keep provider-level parallel tool planning enabled, but serialize sibling
      // execute() handlers inside this stream so shared mutable state cannot race.
      tools: withSequentialExecution(tools, onToolExecutionStart),
      providerOptions: finalProviderOptions,
      headers,
      maxOutputTokens: effectiveMaxOutputTokens,
      streamCallSettings:
        Object.keys(streamCallSettings).length > 0 ? streamCallSettings : undefined,
      hasQueuedMessages,
      getQueuedInputStopCause,
      onChunk,
      onStepMessages,
      onStepSettled,
      contextBudgetLimit,
      contextBudgetTurnAnchor,
      toolPolicy,
      toolSearchState,
      thinkingOverrideState,
      forcedFirstStepToolNames,
      rebuildProviderOptionsForThinkingLevel,
      rebuildFirstStepForThinkingLevel,
    };
  }

  /**
   * Consume a pending mid-turn thinking-level override for the next step.
   *
   * Consume-once: `pending` is always cleared (a failed/no-op application must
   * not retry on every subsequent step). On success the CONTENT of
   * `request.providerOptions` is replaced in place — object identity is
   * preserved because the SDK's per-step deep-merge reads the reference passed
   * at streamText() time, and deep-merge alone cannot delete keys (e.g. the
   * Anthropic `thinking` object when moving to "off").
   *
   * Returns the rebuilt options (for the prepareStep return value) or
   * undefined when there is nothing to apply.
   */
  applyPendingThinkingOverride(
    request: StreamRequestConfig,
    beforeFirstStep: boolean
  ): Record<string, unknown> | undefined {
    const state = request.thinkingOverrideState;
    const pending = state?.pending;
    // A stage turn sends its counted payload first (#5286): the change applies after it.
    if (state == null || pending == null || (beforeFirstStep && state.holdBeforeFirstRequest)) {
      return undefined;
    }
    state.pending = undefined;
    const rebuild = request.rebuildProviderOptionsForThinkingLevel;
    if (rebuild == null) {
      return undefined;
    }
    const rebuilt = rebuild(pending, beforeFirstStep);
    if (rebuilt == null) {
      log.debug("Mid-turn thinking override skipped (not applicable / no-op)", {
        requestedLevel: pending,
        appliedLevel: state.applied,
      });
      return undefined;
    }
    const target = request.providerOptions;
    // buildStreamRequestConfig normalizes providerOptions to a stable object
    // whenever a rebuild closure is present, so target must exist here.
    assert(target != null, "providerOptions must be normalized when a rebuild closure is present");
    for (const key of Object.keys(target)) {
      delete target[key];
    }
    Object.assign(target, rebuilt.providerOptions);
    state.applied = rebuilt.effectiveLevel;
    state.onApplied?.(rebuilt.effectiveLevel);
    log.debug("Mid-turn thinking override applied", {
      requestedLevel: pending,
      effectiveLevel: rebuilt.effectiveLevel,
    });
    return rebuilt.providerOptions;
  }
}
