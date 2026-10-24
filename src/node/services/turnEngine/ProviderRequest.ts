/**
 * ProviderRequest: the one owner of opening a StreamManager turn's provider stream
 * (turn-engine layer 4a). This first slice holds the cross-turn provider state that
 * request building reads: the OpenAI previousResponseIds the provider lost, and the
 * continuous-compaction prefix swap that the next step's request applies.
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
import type { ModelMessage } from "ai";

import {
  stripMessageCacheControl,
  type ContinuousPrefixSwap,
} from "@/node/services/continuousCompactionJournal";
import { log, type Logger } from "@/node/services/log";
import { unprojectNativeToolReferences } from "@/common/utils/tools/toolCatalog";

import {
  extractErrorCode,
  extractPreviousResponseIdFromError,
  extractStatusCode,
} from "./providerWire";

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
}
