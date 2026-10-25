/**
 * The stream's in-attempt retries: the previousResponseId and reasoning-replay
 * repairs that recoveryPolicy picks (a read-only plan, then its executor), and
 * the stream state reset every retry shares (StreamRetries.resetStreamStateForRetry).
 */
import type { ModelMessage } from "ai";
import type { Logger } from "@/node/services/log";
import type { PartialJournal } from "@/node/services/turnEngine/PartialJournal";
import {
  ProviderRequest,
  type StreamRequestConfig,
} from "@/node/services/turnEngine/ProviderRequest";
import {
  extractErrorCode,
  extractPreviousResponseIdFromError,
  extractStatusCode,
} from "@/node/services/turnEngine/providerWire";
import { StepApply } from "@/node/services/turnEngine/StepApply";
import type { StepMessageTracker } from "@/node/services/turnEngine/StepPreparation";
import { getReasoningReplayRejection } from "@/node/services/turnEngine/streamErrors";
import type { WorkspaceId } from "@/node/services/turnEngine/types";
import type { WorkspaceStreamInfo } from "@/node/services/turnEngine/turnState";
import type { UsageLedger } from "@/node/services/turnEngine/UsageLedger";
import type { AnthropicThinkingReplayPoint } from "@/node/utils/messages/anthropicThinkingReplay";
import { stripReasoningReplay } from "@/node/utils/messages/reasoningProviderOptions";

/** What planPreviousResponseIdRetry found; its executor consumes it unchanged. */
export interface PreviousResponseIdRetryPlan {
  /** Retry the current step only (keep parts and usage) instead of the whole stream. */
  hasParts: boolean;
  previousResponseId: string;
  stepMessages: WorkspaceStreamInfo["stepTracker"]["latestMessages"];
  /** The request's provider options without previousResponseId. */
  providerOptions: Record<string, unknown> | undefined;
  errorCode: string | undefined;
  statusCode: number | undefined;
}

/** What planReasoningReplayRetry found; its executor consumes it unchanged. */
export interface ReasoningReplayRetryPlan {
  /** Retry the current step only (keep parts and usage) instead of the whole stream. */
  hasParts: boolean;
  rejectedNamespace: "openai" | "anthropic";
  /** The request transcript without the rejected namespace's reasoning. */
  messages: ModelMessage[];
}

export function getOpenAIPreviousResponseId(
  providerOptions?: Record<string, unknown>
): string | undefined {
  if (!providerOptions || typeof providerOptions !== "object" || !("openai" in providerOptions)) {
    return undefined;
  }

  const openaiOptions = providerOptions.openai;
  if (!openaiOptions || typeof openaiOptions !== "object") {
    return undefined;
  }

  const previousResponseId = (openaiOptions as Record<string, unknown>).previousResponseId;
  return typeof previousResponseId === "string" ? previousResponseId : undefined;
}

function clearOpenAIPreviousResponseId(
  providerOptions?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!providerOptions || typeof providerOptions !== "object" || !("openai" in providerOptions)) {
    return providerOptions;
  }

  const openaiOptions = providerOptions.openai;
  if (!openaiOptions || typeof openaiOptions !== "object") {
    return providerOptions;
  }

  if (!("previousResponseId" in openaiOptions)) {
    return providerOptions;
  }

  const { previousResponseId: _prev, ...rest } = openaiOptions as Record<string, unknown>;
  return {
    ...providerOptions,
    openai: rest,
  };
}

/**
 * Read-only eligibility check for recoveryPolicy: returns what a retry without
 * an invalid previousResponseId needs, or null when the error is not that case
 * or a retry here would duplicate output. Interrupts and the once-per-turn
 * budget belong to the policy.
 */
export function planPreviousResponseIdRetry(
  streamInfo: WorkspaceStreamInfo,
  error: unknown
): PreviousResponseIdRetryPlan | null {
  const hasParts = streamInfo.parts.length > 0;
  const currentStepStartIndex = streamInfo.currentStepStartIndex;
  // If the current step already emitted parts, retrying would duplicate output/tool calls.
  if (hasParts && currentStepStartIndex !== streamInfo.parts.length) {
    return null;
  }

  const lost = matchLostPreviousResponseId(
    error,
    getOpenAIPreviousResponseId(streamInfo.request.providerOptions)
  );
  if (lost == null) {
    return null;
  }

  const stepMessages = streamInfo.stepTracker.latestMessages;
  if (hasParts && !stepMessages) {
    return null;
  }

  const providerOptions = clearOpenAIPreviousResponseId(streamInfo.request.providerOptions);
  if (providerOptions === streamInfo.request.providerOptions) {
    return null;
  }

  return { hasParts, stepMessages, providerOptions, ...lost };
}

/**
 * Pure error check: the error says the request's previousResponseId is gone.
 * Returns the lost ID with the error's code and status for logging, or null.
 */
function matchLostPreviousResponseId(
  error: unknown,
  previousResponseId: string | undefined
): Pick<PreviousResponseIdRetryPlan, "previousResponseId" | "errorCode" | "statusCode"> | null {
  const responseId = extractPreviousResponseIdFromError(error);
  if (!responseId || responseId !== previousResponseId) {
    return null;
  }

  const errorCode = extractErrorCode(error);
  const statusCode = extractStatusCode(error);
  // Retry if: we have the specific error code, OR a likely status code,
  // OR we successfully extracted a response ID from the error message
  // (the message match is strong evidence this is a "not found" error regardless of status code)
  const shouldRetry =
    errorCode === "previous_response_not_found" ||
    statusCode === 404 ||
    statusCode === 500 ||
    statusCode === 400;
  return shouldRetry ? { previousResponseId: responseId, errorCode, statusCode } : null;
}

// Mirror previousResponseId recovery without repeating emitted output or
// completed tools. The repair budget belongs to this attempt, so a manual
// continuation may try again after the user changes route or credentials.
/**
 * Read-only eligibility check for recoveryPolicy: returns the stripped request
 * for a retry without rejected reasoning replay, or null when the error is not
 * that case or a retry here would duplicate output or change nothing.
 * Interrupts and the once-per-turn budget belong to the policy.
 */
export function planReasoningReplayRetry(
  streamInfo: WorkspaceStreamInfo,
  error: unknown
): ReasoningReplayRetryPlan | null {
  const hasParts = streamInfo.parts.length > 0;
  // If the current step already emitted parts, retrying would duplicate output/tool calls.
  if (hasParts && streamInfo.currentStepStartIndex !== streamInfo.parts.length) {
    return null;
  }

  const rejectedNamespace = getReasoningReplayRejection(error, streamInfo.request.model);
  if (rejectedNamespace == null) {
    return null;
  }

  // Even step 0 can be compacted or rebuilt before output. Retry the prepared
  // transcript so recovery cannot restore context that preparation discarded.
  const stepMessages = streamInfo.stepTracker.latestMessages;
  if (hasParts && !stepMessages) {
    return null;
  }
  const sourceMessages = stepMessages ?? streamInfo.request.messages;
  // Strip every block of the namespace, not just the one the error names:
  // removing one changes the prefix later blocks were bound to.
  const messages = stripReasoningReplay(sourceMessages, rejectedNamespace);
  if (messages === sourceMessages) {
    return null;
  }

  return { hasParts, rejectedNamespace, messages };
}

export interface StreamRetriesDeps {
  readonly partialJournal: PartialJournal;
  readonly usageLedger: UsageLedger;
  readonly providerRequest: ProviderRequest;
  readonly getWorkspaceLogger: (
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ) => Logger;
  /** StreamManager.createStreamResult, read at call time (whitebox tests replace it). */
  readonly createStreamResult: (
    request: StreamRequestConfig,
    abortController: AbortController,
    stepTracker: StepMessageTracker
  ) => WorkspaceStreamInfo["streamResult"];
  readonly moveAnthropicThinkingReplayPoint: (
    streamInfo: WorkspaceStreamInfo,
    point: AnthropicThinkingReplayPoint
  ) => boolean;
  readonly flushPartialWrite: (
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ) => Promise<void>;
}

export class StreamRetries {
  constructor(private readonly deps: StreamRetriesDeps) {}

  async resetStreamStateForRetry(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    options?: { preserveParts?: boolean; preserveUsage?: boolean; workspaceLog?: Logger }
  ): Promise<void> {
    streamInfo.stepTracker.pendingPrefixSwap = undefined;
    // The next streamText call numbers its steps from 0 again.
    streamInfo.stepTracker.anthropicThinkingStripStep = undefined;
    StepApply.restartStepNumbering(streamInfo);
    const preserveParts = options?.preserveParts ?? false;
    const preserveUsage = options?.preserveUsage ?? false;

    await this.deps.partialJournal.resetForRetry(streamInfo);

    StepApply.resetForRetry(streamInfo, { preserveParts });

    if (!preserveUsage) {
      await this.deps.usageLedger.resetForRetry(workspaceId, streamInfo);
    }

    if (!preserveParts) {
      try {
        await this.deps.partialJournal.deleteForRetry(workspaceId as string);
      } catch (deleteError) {
        const logger =
          options?.workspaceLog ?? this.deps.getWorkspaceLogger(workspaceId, streamInfo);
        logger.warn("Failed to clear partial state before retry", { error: deleteError });
      }
    }
  }

  /** Executes recoveryPolicy's dropPreviousResponseId retry with a plan from the check above. */
  async retryStreamWithoutPreviousResponseId(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    error: unknown,
    plan: PreviousResponseIdRetryPlan
  ): Promise<void> {
    const { hasParts, previousResponseId, stepMessages, providerOptions, errorCode, statusCode } =
      plan;
    const workspaceLog = this.deps.getWorkspaceLogger(workspaceId, streamInfo);
    this.deps.providerRequest.recordLostResponseIdIfApplicable(
      workspaceId,
      error,
      streamInfo,
      workspaceLog
    );

    // Step-boundary retries restart the SDK stream, so totalUsage only reflects
    // the retried step. Track this to prefer cumulativeUsage at stream end.
    if (hasParts) {
      ProviderRequest.markRetry(streamInfo, "previousResponseIdAtStep");
    }

    workspaceLog.info("Retrying stream without invalid previousResponseId", {
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      retryScope: hasParts ? "step" : "stream",
      previousResponseId,
      errorCode,
      statusCode,
    });

    await this.resetStreamStateForRetry(workspaceId, streamInfo, {
      preserveParts: hasParts,
      preserveUsage: hasParts,
      workspaceLog,
    });

    ProviderRequest.beginAttempt(
      streamInfo,
      {
        ...streamInfo.request,
        ...(stepMessages ? { messages: stepMessages } : {}),
        providerOptions,
      },
      (request) =>
        this.deps.createStreamResult(request, streamInfo.abortController, streamInfo.stepTracker)
    );
  }

  /** Executes recoveryPolicy's dropReasoningReplay retry with a plan from the check above. */
  async retryStreamWithoutReasoningReplay(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    error: unknown,
    plan: ReasoningReplayRetryPlan
  ): Promise<void> {
    const { hasParts, rejectedNamespace, messages } = plan;
    const workspaceLog = this.deps.getWorkspaceLogger(workspaceId, streamInfo);
    const errorCode = extractErrorCode(error);
    const statusCode = extractStatusCode(error);

    // Step-boundary retries restart the SDK stream, so totalUsage only reflects
    // the retried step. Track this to prefer cumulativeUsage at stream end.
    if (hasParts) {
      ProviderRequest.markRetry(streamInfo, "reasoningReplayAtStep");
    }

    workspaceLog.info("Retrying stream without rejected reasoning replay", {
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      rejectedNamespace,
      retryScope: hasParts ? "step" : "stream",
      errorCode,
      statusCode,
    });

    await this.resetStreamStateForRetry(workspaceId, streamInfo, {
      preserveParts: hasParts,
      preserveUsage: hasParts,
      workspaceLog,
    });

    if (rejectedNamespace === "anthropic") {
      // Preserved thinking: once thinking is removed, putting it back invalidates every
      // later block, so the next turns must keep it out (messagePipeline reads this
      // receipt). The retry sends every earlier row and this row's earlier steps without
      // thinking, so the point is the retried step (the reset above recorded its start):
      // step 0 for a repair at the turn start. Persist before the retry request goes out
      // so a crash mid-retry cannot forget the strip. A step-0 repair has no parts yet:
      // commitPartial keeps the receipt on the empty row (#5886).
      this.deps.moveAnthropicThinkingReplayPoint(
        streamInfo,
        streamInfo.stepStartIndices.length - 1
      );
      await this.deps.flushPartialWrite(workspaceId, streamInfo);
    }

    ProviderRequest.beginAttempt(streamInfo, { ...streamInfo.request, messages }, (request) =>
      this.deps.createStreamResult(request, streamInfo.abortController, streamInfo.stepTracker)
    );
  }
}
