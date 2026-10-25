import { estimateToolResultSize } from "@/common/utils/compaction/contextBudget";
import { ContextBudgetExceededError, ContextBudgetBlockedError } from "./contextBudgetError";
import {
  createContextBudgetAnchor,
  estimateAnchoredRequestTokensForModel,
  estimateToolResultTokensForModel,
} from "./contextBudgetCounting";
import { getAnthropicCacheTtl } from "@/common/utils/ai/cacheStrategy";
import { type ContinuousPrefixSwap } from "./continuousCompactionJournal";
import type { Scope } from "effect";
import {
  type streamText,
  type stepCountIs,
  type LanguageModel,
  LoadAPIKeyError,
  APICallError,
  RetryError,
  StreamProviderError,
} from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { Result } from "@/common/types/result";
import assert from "@/common/utils/assert";
import { log, type Logger } from "./log";
import type {
  StreamAbortEvent,
  StreamAbortReason,
  ToolCallEndEvent,
  ToolCallExecutionStartEvent,
  CompletedMessagePart,
  WorkflowRunAttachedEvent,
} from "@/common/types/stream";

import type { SendMessageError, StreamErrorType } from "@/common/types/errors";
import type { MuxMetadata, MuxMessage, PersistedToolModelUsage } from "@/common/types/message";
import { hasTokenUsage } from "@/common/types/message";
import { stripReasoningReplay } from "@/node/utils/messages/reasoningProviderOptions";
import {
  laterAnthropicThinkingReplayPoint,
  type AnthropicThinkingReplayPoint,
} from "@/node/utils/messages/anthropicThinkingReplay";
import { ThinkingLevelSchema, type ThinkingLevel } from "@/common/types/thinking";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import {
  coerceStreamErrorTypeForMessage,
  createErrorEvent,
  stripNoisyErrorPrefix,
  type StreamErrorPayload,
} from "@/node/services/utils/sendMessageError";
import { hasCommitWorthyParts, type HistoryService } from "./historyService";
import {
  accumulateStepsProviderMetadata,
  normalizeUsage,
  withCacheWriteMetadata,
} from "@/common/utils/tokens/usageHelpers";
import { modelOnlyNotificationsField } from "@/common/utils/tools/internalToolResultFields";
import { buildRequiredToolPatterns } from "@/common/utils/tools/toolPolicy";
import { isAgentToolsDisabled } from "@/node/utils/agentToolsDisabled";
import {
  collectDeferLoadingToolNames,
  computeContextLoadedToolNames,
  dedupeNativeToolReferences,
  computeLoadedToolNames,
} from "@/common/utils/tools/toolCatalog";
import { StreamingTokenTracker } from "@/node/utils/main/StreamingTokenTracker";
import { countTokens } from "@/node/utils/main/tokenizer";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import { ToolCallDisplayRegistry, type ExecutionScope } from "./toolCallDisplayRegistry";
import type { Runtime } from "@/node/runtime/Runtime";
import type { SessionUsageService } from "./sessionUsageService";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { clampErrorMessage, getErrorMessage } from "@/common/utils/errors";
import { defaultEffectRunner, type EffectRunner } from "./di/effectRunner";
import { hostClockFor } from "./di/hostClockLive";
import {
  clonePersistedToolModelUsage,
  cloneUsage,
  markProviderMetadataCostsIncluded,
  UsageLedger,
} from "@/node/services/turnEngine/UsageLedger";
import { PartialJournal, type PartialTarget } from "@/node/services/turnEngine/PartialJournal";
import {
  ProviderRequest,
  type StreamRequestConfig,
} from "@/node/services/turnEngine/ProviderRequest";
import {
  extractErrorCode,
  extractPreviousResponseIdFromError,
  extractStatusCode,
} from "@/node/services/turnEngine/providerWire";
import {
  isAnthropicMessagesModel,
  StepPreparation,
  transformStepMessages,
  type StepMessageTracker,
} from "@/node/services/turnEngine/StepPreparation";
import {
  buildUsageDeltaEvent,
  metadataModelIdentity,
  TurnEventEmitter,
  TurnEvents,
  type NestedToolEvent,
} from "@/node/services/turnEngine/TurnEvents";
import { nodeClock, type HostClock } from "@/node/utils/hostClock";
import type {
  WorkspaceId,
  TurnEngineEventSink,
  TurnStreamHandle,
  SettledStepOutcome,
  OnStepSettled,
  WorkspaceStreamInfo,
  StopStreamOptions,
  ActiveStreamInfo,
  MockStreamLifecycle,
  StreamManagerTokenTracker,
} from "@/node/services/turnEngine/types";
export type {
  StreamTextOnChunk,
  WorkspaceId,
  TurnEngineEvent,
  TurnEngineEventSink,
  TurnCompletion,
  TurnStreamHandle,
  SettledStepBudget,
  ContextBudgetStepDecision,
  SettledStepOutcome,
  OnStepSettled,
  ModelFallbackPrepareOptions,
  ModelFallbackOptions,
  WorkspaceStreamInfo,
  StopStreamOptions,
  ActiveStreamInfo,
  MockStreamLifecycle,
  StreamManagerTokenTracker,
} from "@/node/services/turnEngine/types";
import {
  StreamState,
  TurnRegistry,
  type PendingStreamStartHandle,
  type StreamToken,
} from "@/node/services/turnEngine/TurnRegistry";
import {
  AttemptLoop,
  type PartLoopState,
  type PreviousResponseIdRetryPlan,
  type ReasoningReplayRetryPlan,
  type ToolCallMap,
} from "@/node/services/turnEngine/AttemptLoop";
import { RefusalFallback } from "@/node/services/turnEngine/RefusalFallback";
import {
  EmptyStreamOutputError,
  ModelRefusalError,
  StreamTruncatedError,
} from "@/node/services/turnEngine/streamErrors";
import { TurnResources } from "@/node/services/turnEngine/TurnResources";
import { TurnEngine, type TurnExecutionOptions } from "@/node/services/turnEngine/TurnEngine";
export {
  createTurnCompletionController,
  type TurnExecutionOptions,
} from "@/node/services/turnEngine/TurnEngine";
import { classify429Capacity } from "@/common/utils/errors/classify429Capacity";
import { isRefusalFinishReason } from "@/common/utils/messages/refusalFinishReason";
import { getOpenAIResponsesBaseUrlHint } from "@/node/services/utils/openAIResponsesBaseUrlHint";
import type { FoldIntent, FoldStep, FoldView } from "@/node/services/turnEngine/partFold";

// Disable noisy AI SDK warning logging.
globalThis.AI_SDK_LOG_WARNINGS = false;

function recordTerminalFinish(
  streamInfo: WorkspaceStreamInfo,
  intent: Extract<FoldIntent, { _tag: "RecordTerminalFinish" }>
): void {
  streamInfo.receivedTerminalEvent = true;
  if (intent.finishReason !== undefined) {
    streamInfo.terminalFinishReason = intent.finishReason;
  }
  if (intent.rawFinishReason !== undefined) {
    streamInfo.terminalRawFinishReason = intent.rawFinishReason;
  }
}

function isStreamTruncatedMessage(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes("stream closed before message_stop") ||
    lowerMessage.includes("stream closed before terminal event") ||
    lowerMessage.includes("stream closed unexpectedly before the response completed")
  );
}

// Lowercased prefix that google-auth-library puts on every failure to read or parse
// the GOOGLE_APPLICATION_CREDENTIALS file.
const GOOGLE_ADC_ENV_FILE_ERROR_PREFIX =
  "unable to read the credential file specified by the google_application_credentials environment variable";

// OpenAI rejections of Cyber mode's access_programs.cyber value
// (https://developers.openai.com/api/docs/guides/daybreak). OpenAI's own
// message names the required program or approval level, so it is kept.
const OPENAI_ACCESS_PROGRAM_ERROR_HINTS: Record<string, string> = {
  invalid_access_program: "This model needs a different OpenAI Daybreak access program.",
  // OpenAI also returns this for Daybreak models whose reduced refusals need
  // approval the project lacks, so do not claim the model has no Daybreak.
  unsupported_access_program:
    "OpenAI did not accept Cyber mode for this model. Turn off Cyber in the thinking menu to use standard safeguards.",
  access_program_not_enabled:
    "The OpenAI API key's project does not have this Daybreak program enabled. Ask your OpenAI organization admin, or turn off Cyber in the thinking menu to use standard safeguards.",
};

function getOpenAIAccessProgramError(error: unknown): { code: string; message: string } | null {
  const apiError =
    RetryError.isInstance(error) && error.lastError != null ? error.lastError : error;
  if (!APICallError.isInstance(apiError)) return null;
  const data = apiError.data as { error?: { code?: unknown; message?: unknown } } | undefined;
  const code = data?.error?.code;
  if (typeof code !== "string" || !Object.hasOwn(OPENAI_ACCESS_PROGRAM_ERROR_HINTS, code)) {
    return null;
  }
  const message = data?.error?.message;
  return { code, message: typeof message === "string" ? message : apiError.message };
}

// OpenAI Responses rejecting replayed reasoning. Exact item type on purpose:
// `rs_` is a reasoning item; message/tool items use other prefixes.
const OPENAI_REASONING_ITEM_NOT_FOUND_PATTERN = /Item with id 'rs_[A-Za-z0-9_-]+' not found/;
// "The encrypted content [for item rs_…] <blob> could not be verified. Reason: …"
const OPENAI_ENCRYPTED_CONTENT_UNVERIFIED_PATTERN =
  /encrypted content\b[\s\S]*?\bcould not be verified/;
// Anthropic rejecting a replayed thinking signature, e.g. Opus 5.5 binding the
// block to a system prompt or tool list that has since changed (the memory
// index lives there). Routes without the drop_block control
// (Coder gateway, custom providers) otherwise fail every retry identically.
const ANTHROPIC_THINKING_SIGNATURE_INVALID_PATTERN = /Invalid `signature` in `thinking` block/;

/**
 * The provider's Retry-After in ms from a failed request's response headers, or null when it
 * sent none (or an unusable value). Parsed like the AI SDK's own retry loop
 * (`getRetryDelayInMs` in `ai`): `retry-after-ms` first, then `retry-after` as seconds or an
 * HTTP date. A RetryError (the SDK exhausted its retries) reports its last attempt's headers.
 */
function getProviderRetryAfterMs(error: unknown): number | null {
  const apiError = RetryError.isInstance(error) ? error.lastError : error;
  if (!APICallError.isInstance(apiError)) return null;
  // Header names are lowercase: the SDK collects them from a fetch Headers object.
  const headers = apiError.responseHeaders;
  if (!headers) return null;
  const parse = (): number => {
    const retryAfterMs = headers["retry-after-ms"];
    if (retryAfterMs) {
      const ms = Number.parseFloat(retryAfterMs);
      if (!Number.isNaN(ms)) return ms;
    }
    const retryAfter = headers["retry-after"];
    if (!retryAfter) return Number.NaN;
    const seconds = Number.parseFloat(retryAfter);
    // Wall clock: the header is an HTTP date (#7282).
    return Number.isNaN(seconds) ? Date.parse(retryAfter) - nodeClock.nowMs() : seconds * 1000;
  };
  const ms = parse();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

type StreamErrorClass = Pick<StreamErrorPayload, "error" | "contextBudgetExceeded"> & {
  errorType: StreamErrorType;
};

/**
 * The attempt loop's own failures (streamErrors.ts): each class names its
 * stream error type, and its message is already user-facing.
 */
export function getSelfClassifiedStreamError(error: unknown): StreamErrorClass | null {
  if (error instanceof EmptyStreamOutputError) {
    return { error: error.message, errorType: "empty_output" };
  }
  if (error instanceof ModelRefusalError) {
    return { error: error.message, errorType: "model_refusal" };
  }
  if (error instanceof StreamTruncatedError) {
    return { error: error.message, errorType: "stream_truncated" };
  }
  return null;
}

/** Context-budget refusals keep their own message; an exceeded budget also reports its details. */
export function getContextBudgetStreamError(error: unknown): StreamErrorClass | null {
  if (error instanceof ContextBudgetBlockedError) {
    return { error: error.message, errorType: "context_budget_blocked" };
  }
  if (error instanceof ContextBudgetExceededError) {
    return {
      error: error.message,
      errorType: "context_budget_blocked",
      contextBudgetExceeded: error.details,
    };
  }
  return null;
}

/**
 * Rewrites a provider error's message into user-facing text, and maps an
 * Anthropic overload to `server_error`. Runs after categorizeError.
 */
export function describeProviderStreamError(input: {
  errorMessage: string;
  errorType: StreamErrorType;
  actualError: unknown;
  model: string;
  routeProvider: string;
}): { errorMessage: string; errorType: StreamErrorType } {
  const { actualError, model } = input;
  let { errorMessage, errorType } = input;

  // Enhance previous-response and model-not-found error messages
  if (extractPreviousResponseIdFromError(actualError)) {
    errorMessage = "OpenAI lost the previous response state while streaming. Retry to continue.";
  }
  if (errorType === "model_not_found") {
    // Extract model name from model string (e.g., "anthropic:sonnet-1m" -> "sonnet-1m")
    const [, modelName] = model.split(":");
    errorMessage = `Model '${modelName || model}' does not exist or is not available. Please check your model selection.`;
  }
  const accessProgramError = getOpenAIAccessProgramError(actualError);
  if (accessProgramError != null) {
    errorMessage = `${OPENAI_ACCESS_PROGRAM_ERROR_HINTS[accessProgramError.code]} OpenAI: ${accessProgramError.message}`;
  }

  // Normalize Anthropic overload errors (HTTP 529 / overloaded_error) into a stable,
  // user-friendly message. Keep errorType = server_error so the frontend's auto-retry
  // behavior remains unchanged.
  const isAnthropic = normalizeToCanonical(model).startsWith("anthropic:");
  if (isAnthropic && isAnthropicOverloadError(actualError)) {
    errorMessage = "Anthropic is temporarily overloaded (HTTP 529). Please try again later.";
    errorType = "server_error";
  }

  const openAIResponsesBaseUrlHint = getOpenAIResponsesBaseUrlHint({
    providerId: input.routeProvider,
    error: actualError,
  });
  // An access-program rejection proves the endpoint speaks Responses.
  if (openAIResponsesBaseUrlHint && accessProgramError == null) {
    errorMessage = `${errorMessage}\n\n${openAIResponsesBaseUrlHint}`;
  }
  return { errorMessage, errorType };
}

function hasStructuredErrorProperty(
  data: unknown
): data is { error: { code?: string; type?: string } } {
  return (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof data.error === "object" &&
    data.error !== null
  );
}

function isAPICallModelNotFound(error: APICallError): boolean {
  if (!hasStructuredErrorProperty(error.data)) return false;
  // OpenAI: error.code === 'model_not_found'. The status has flipped between 400 and
  // 404 over time, so key on the code rather than the status.
  if (error.data.error.code === "model_not_found") return true;
  // Anthropic: 404 with error.type === 'not_found_error'
  return error.statusCode === 404 && error.data.error.type === "not_found_error";
}

/** Context exceeded errors (Anthropic + OpenAI-compatible / Copilot). */
function isAPICallContextExceeded(error: APICallError): boolean {
  const msgLower = error.message.toLowerCase();
  // Anthropic: "prompt is too long" / "input is too long"
  // Copilot / OpenAI-compatible: "prompt token count of X exceeds the limit of Y"
  return (
    msgLower.includes("prompt is too long") ||
    msgLower.includes("input is too long") ||
    (msgLower.includes("token") && msgLower.includes("exceeds") && msgLower.includes("limit"))
  );
}

export function categorizeAPICallError(error: APICallError): StreamErrorType {
  if (error.statusCode === 401) return "authentication";
  // Daybreak access-program rejections are deterministic: a retry resends
  // the same program. Like a bad key, the user must change provider config
  // or turn Cyber off, so reuse the non-retryable authentication class.
  if (getOpenAIAccessProgramError(error) != null) return "authentication";
  // 402 (Payment Required) signals a billing problem on the provider account.
  // Treat as non-retryable quota. Some providers also encode quota failures as
  // 429, so classify 429 by payload intent instead of status code alone.
  if (error.statusCode === 402) return "quota";
  if (error.statusCode === 429) {
    return classify429Capacity({
      message: error.message,
      data: error.data,
      responseBody: error.responseBody,
    });
  }
  if (error.statusCode && error.statusCode >= 500) return "server_error";
  // Check for model_not_found errors (OpenAI and Anthropic)
  if (isAPICallModelNotFound(error)) return "model_not_found";
  if (isAPICallContextExceeded(error)) return "context_exceeded";
  return "api";
}

function categorizeRetryError(error: RetryError): StreamErrorType {
  // The AI SDK wraps the underlying error(s) in RetryError when it exhausts its internal retries.
  // If the underlying error is deterministically non-retryable (e.g. model_not_found), we should
  // surface that classification so the frontend auto-retry loop stops.
  //
  // Keep returning retry_failed for generic/transient failures so the UI still communicates that
  // the SDK already retried and gave up.
  const underlyingType = error.lastError ? categorizeError(error.lastError) : "unknown";
  if (
    underlyingType !== "unknown" &&
    underlyingType !== "api" &&
    underlyingType !== "retry_failed"
  ) {
    return underlyingType;
  }
  return "retry_failed";
}

/**
 * OpenAI/Anthropic structured error format (from error.cause), or null when
 * the error has none of the known codes.
 * Structure: { error: { code: 'context_length_exceeded', type: '...', message: '...' } }
 */
export function categorizeStructuredError(error: unknown): StreamErrorType | null {
  if (!hasStructuredErrorProperty(error)) return null;
  const structuredError = error.error;
  // Model not found
  if (structuredError.code === "model_not_found" || structuredError.type === "not_found_error") {
    return "model_not_found";
  }
  // OpenAI context length errors have code: 'context_length_exceeded'
  if (structuredError.code === "context_length_exceeded") return "context_exceeded";
  // Check for other specific error codes/types
  if (structuredError.code === "rate_limit_exceeded") return "rate_limit";
  return null;
}

function isNetworkErrorMessage(message: string): boolean {
  return (
    message.includes("network") ||
    message.includes("fetch") ||
    // node-fetch's text for a failed connection, which google-auth-library's HTTP client
    // (gaxios) keeps. Its URL can be Google's OAuth token endpoint, and the "token" rule
    // below would read that as a context window error.
    (message.startsWith("request to ") && message.includes(" failed, reason: "))
  );
}

function isModelNotFoundMessage(message: string): boolean {
  return (
    message.includes("model") &&
    (message.includes("does not exist") ||
      message.includes("doesn't exist") ||
      message.includes("not found") ||
      message.includes("do not have access") ||
      message.includes("don't have access") ||
      message.includes("no access"))
  );
}

function isContextExceededMessage(message: string): boolean {
  return (
    message.includes("token") ||
    message.includes("context") ||
    message.includes("too long") ||
    message.includes("maximum")
  );
}

function isQuotaMessage(message: string): boolean {
  return (
    message.includes("quota") ||
    message.includes("limit") ||
    message.includes("insufficient balance") ||
    message.includes("add credits") ||
    message.includes("payment required")
  );
}

/** Fall back to string matching for other errors. Rule order matters: the first match wins. */
export function categorizeErrorMessage(error: Error): StreamErrorType {
  const message = error.message.toLowerCase();
  if (isStreamTruncatedMessage(message)) return "stream_truncated";
  // google-auth-library could not turn the GOOGLE_APPLICATION_CREDENTIALS file into
  // a credential (Google Vertex AI). It reads the file locally, so a retry fails the
  // same way, and the keyword rules below misread its text ("refresh_token").
  if (message.startsWith(GOOGLE_ADC_ENV_FILE_ERROR_PREFIX)) return "authentication";
  if (error.name === "AbortError" || message.includes("abort")) return "aborted";
  if (isNetworkErrorMessage(message)) return "network";
  if (isModelNotFoundMessage(message)) return "model_not_found";
  if (isContextExceededMessage(message)) return "context_exceeded";
  if (isQuotaMessage(message)) return "quota";
  if (message.includes("auth") || message.includes("key")) return "authentication";
  return "api";
}

/**
 * Categorizes errors for better error handling (used for event emission)
 */
export function categorizeError(error: unknown): StreamErrorType {
  if (error instanceof ContextBudgetExceededError || error instanceof ContextBudgetBlockedError)
    return "context_budget_blocked";
  if (error instanceof StreamTruncatedError) {
    return "stream_truncated";
  }
  // Use AI SDK error type guards first
  if (LoadAPIKeyError.isInstance(error)) return "authentication";
  if (APICallError.isInstance(error)) return categorizeAPICallError(error);
  if (RetryError.isInstance(error)) return categorizeRetryError(error);
  const structuredType = categorizeStructuredError(error);
  if (structuredType != null) return structuredType;
  if (error instanceof Error) return categorizeErrorMessage(error);
  return "unknown";
}

// Use the resolved SDK model, not the requested prefix: OpenAI Responses can
// arrive through direct, custom, or Coder routes. xAI Responses and OpenRouter
// chat-completions models must not enter this recovery path.
function isOpenAIResponsesModel(model: LanguageModel): boolean {
  if (typeof model === "string") return false;
  return model.provider === "openai.responses";
}

const MAX_ORPHAN_TOOL_RESULT_WARNINGS_PER_STREAM = 3;
const ORPHAN_TOOL_RESULT_PREVIEW_CHARS = 160;
const ORPHAN_TOOL_RESULT_MAX_KEYS = 8;

function summarizeToolResultForLog(output: unknown): Record<string, unknown> {
  if (output === null) {
    return { outputType: "null" };
  }

  if (typeof output === "string") {
    return {
      outputType: "string",
      outputLength: output.length,
      outputPreview: output.slice(0, ORPHAN_TOOL_RESULT_PREVIEW_CHARS),
    };
  }

  if (typeof output === "number" || typeof output === "boolean") {
    return {
      outputType: typeof output,
      outputPreview: String(output),
    };
  }

  if (Array.isArray(output)) {
    return {
      outputType: "array",
      outputLength: output.length,
      firstItemType:
        output.length > 0 && output[0] !== null
          ? typeof output[0]
          : output.length > 0
            ? "null"
            : undefined,
    };
  }

  if (typeof output === "object") {
    const outputRecord = output as Record<string, unknown>;
    const keys = Object.keys(outputRecord);
    const summary: Record<string, unknown> = {
      outputType: "object",
      outputKeyCount: keys.length,
      outputKeys: keys.slice(0, ORPHAN_TOOL_RESULT_MAX_KEYS),
    };

    if (typeof outputRecord.type === "string") {
      summary.outputFormat = outputRecord.type;
    }

    if (Array.isArray(outputRecord.value)) {
      summary.outputValueLength = outputRecord.value.length;
    }

    return summary;
  }

  return {
    outputType: typeof output,
    outputPreview: JSON.stringify(output),
  };
}

// Ensure per-stream part timestamps are strictly monotonic.
//
// Date.now() is millisecond-granularity, so two distinct chunks with identical text emitted in the
// same millisecond can otherwise collide on (timestamp, delta) during reconnect replay buffering.
//
// Part timestamps are record times (stored in history, shown and replayed), so they read the
// wall clock until #7282 moves their consumers to HostClock.
function nextPartTimestamp(streamInfo: WorkspaceStreamInfo): number {
  const now = nodeClock.nowMs();
  const last = streamInfo.lastPartTimestamp;
  const timestamp = now <= last ? last + 1 : now;
  streamInfo.lastPartTimestamp = timestamp;
  return timestamp;
}

/**
 * Optional collaborators for StreamManager. Production omits both; tests
 * inject a fake stream factory (so the real request/prepareStep wiring still
 * runs) and a no-op token tracker (so no tokenizer worker loads).
 */
export interface StreamManagerOptions {
  streamText?: typeof streamText;
  tokenTracker?: StreamManagerTokenTracker;
  /** StreamManagerLive passes the HostClock service. Default: the clock of `runner`. */
  hostClock?: HostClock;
}

/** `{ error: { type } }`, the error body shape of Anthropic's API. */
function hasErrorType(data: unknown): data is { error: { type?: string } } {
  return (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof data.error === "object" &&
    data.error !== null
  );
}

/**
 * The error type of an Anthropic error body embedded in a generic stream error's text. A proxy
 * in front of Anthropic can wrap the provider's error event in a generic one (`type: "error"`),
 * as in `unknown stream error: received error while streaming: {"type":"error","error":{...}}`.
 * Only that wrapper counts: a typed error (an invalid_request_error) can echo request text,
 * such as a tool description, that holds an overload body.
 */
function wrappedAnthropicErrorType(error: StreamProviderError): string | undefined {
  if (error.type !== "error") return undefined;
  const message = error.message;
  const start = message.indexOf("{");
  if (start < 0) return undefined;
  try {
    const body: unknown = JSON.parse(message.slice(start));
    return hasErrorType(body) ? body.error.type : undefined;
  } catch {
    return undefined;
  }
}

function isOverloadedApiCallError(error: APICallError): boolean {
  return (
    error.statusCode === 529 ||
    (hasErrorType(error.data) && error.data.error.type === "overloaded_error")
  );
}

/** An Anthropic overload (HTTP 529 / overloaded_error), before the request or mid-stream. */
function isAnthropicOverloadError(error: unknown): boolean {
  if (APICallError.isInstance(error)) return isOverloadedApiCallError(error);
  if (RetryError.isInstance(error)) {
    return APICallError.isInstance(error.lastError) && isOverloadedApiCallError(error.lastError);
  }
  if (StreamProviderError.isInstance(error)) {
    return (
      error.statusCode === 529 ||
      error.type === "overloaded_error" ||
      wrappedAnthropicErrorType(error) === "overloaded_error"
    );
  }
  return false;
}

/** The request fields the stop conditions read, and the stop cause they record. */
type StopWhenRequest = Pick<
  StreamRequestConfig,
  | "hasQueuedMessages"
  | "getQueuedInputStopCause"
  | "stopCause"
  | "toolPolicy"
  | "onStepSettled"
  | "modelString"
  | "tools"
  | "budgetMetadataModel"
  | "contextBudgetLimit"
  | "system"
  | "messages"
  | "toolSearchState"
>;

type StopConditionOptions = Parameters<ReturnType<typeof stepCountIs>>[0];
type StopConditionStep = StopConditionOptions["steps"][number];

// Completion-tool stop check: completion/routing tools use explicit
// success/ok markers (agent_report, propose_plan).
// When a marker is present, respect it — success:false means the tool
// should be retried, so don't stop. When no marker is present (e.g.,
// MCP tools, arbitrary required tools), treat non-null object results
// as successful completion unless the result is error-shaped.
export function isSuccessfulToolOutput(output: unknown): boolean {
  if (typeof output !== "object" || output === null) {
    return false;
  }
  const parsedOutput = output as Record<string, unknown>;
  if ("success" in parsedOutput) {
    return parsedOutput.success === true;
  }
  if ("ok" in parsedOutput) {
    return parsedOutput.ok === true;
  }
  if (parsedOutput.error != null || parsedOutput.isError === true) {
    return false;
  }
  return true;
}

/** The last step returned a successful result from a tool the policy requires. */
export function hasSuccessfulRequiredToolResult(
  { steps }: StopConditionOptions,
  requiredPatterns: readonly RegExp[]
): boolean {
  if (requiredPatterns.length === 0) {
    return false;
  }
  const lastStep = steps[steps.length - 1];
  return (
    lastStep?.toolResults?.some(
      (toolResult) =>
        // A context-lifecycle request is never a terminal completion, even if a policy
        // lists it as required; otherwise its success would end the stream before the
        // settled-step callback could schedule the rollover it promised.
        toolResult.toolName !== "new_context" &&
        requiredPatterns.some((pattern) => pattern.test(toolResult.toolName)) &&
        isSuccessfulToolOutput(toolResult.output)
    ) ?? false
  );
}

/**
 * Record a settled step's budget decision as the stop cause and say whether to stop.
 * A blocked decision throws: the settled results do not fit the context budget.
 */
export function applyContextBudgetDecision(
  request: Pick<StreamRequestConfig, "stopCause">,
  { decision, continuationEntryId }: SettledStepOutcome
): boolean {
  // All siblings have settled: stop before another provider step without discarding results.
  if (decision !== "continue") {
    // The session captured its designated successor when it decided; a blocked stop hands
    // over to nothing.
    request.stopCause ??= {
      kind: "context-budget",
      decision,
      ...(decision !== "block" && continuationEntryId != null ? { continuationEntryId } : {}),
    };
  }
  if (decision === "block")
    throw new ContextBudgetBlockedError(
      "The settled tool results exceed the context budget. Use /compact or start a new context before continuing."
    );
  return decision !== "continue";
}

/**
 * Estimate the next step's request the way its preflight will (#4855): this step's input
 * plus its response messages, anchored on this step's usage like prepareStep.
 */
async function estimateNextRequestTokens(
  request: Pick<
    StreamRequestConfig,
    | "modelString"
    | "tools"
    | "budgetMetadataModel"
    | "contextBudgetLimit"
    | "system"
    | "messages"
    | "toolSearchState"
  >,
  stepTracker: StepMessageTracker | undefined,
  steps: StopConditionOptions["steps"],
  step: StopConditionStep
): Promise<number | undefined> {
  // The next step's preflight hard-stops on the assembled estimate, which can exceed
  // provider-reported usage by ~10% (#4855). Measure that same request here so the
  // budget decision can roll over before the preflight blocks. Invariant: this measure
  // is never below the one prepareStep will enforce for the next step. The SDK builds
  // the next input as this step's input plus its response messages.
  const nextMessages =
    request.contextBudgetLimit == null
      ? undefined
      : dedupeNativeToolReferences(
          await transformStepMessages([
            ...(stepTracker?.latestMessages ?? [
              ...request.messages,
              ...steps.slice(0, -1).flatMap((prior) => prior.response.messages),
            ]),
            ...step.response.messages,
          ])
        );
  const nextRequest =
    nextMessages == null
      ? undefined
      : await estimateAnchoredRequestTokensForModel(
          {
            system: request.system,
            messages: nextMessages,
            tools: isAgentToolsDisabled() ? undefined : request.tools,
          },
          {
            model: request.modelString,
            metadataModel: request.budgetMetadataModel,
            modelContextLimit: request.contextBudgetLimit,
            activeTools: computeContextLoadedToolNames(request.toolSearchState, nextMessages),
          },
          // prepareStep anchors the next step on this same request and usage, so both
          // measures take the same anchored-or-full branch and the invariant holds.
          createContextBudgetAnchor(stepTracker?.contextBudgetRequest, step)
        );
  return nextRequest?.estimate;
}

/**
 * StreamManager - Handles all streaming operations with type safety and atomic operations
 *
 * Key invariants:
 * - Only one active stream per workspace at any time
 * - Atomic stream creation/cancellation operations
 * - Guaranteed resource cleanup in all code paths
 */
export class StreamManager {
  // TurnRegistry's slot map. Whitebox tests seed and read it through this name.
  private readonly workspaceStreams: Map<WorkspaceId, WorkspaceStreamInfo>;
  // Owns the slot, the start lock, the completion fence and stop (turnEngine/TurnRegistry.ts).
  private readonly turnRegistry: TurnRegistry;
  // Owns the temp dir, the startup abort controller and scope, stream resource
  // teardown and the MCP lease (turnEngine/TurnResources.ts).
  private readonly turnResources: TurnResources;
  // Starts turns: slot, resources, registration, envelope (turnEngine/TurnEngine.ts).
  private readonly turnEngine: TurnEngine;
  private readonly refusalFallback: RefusalFallback;
  private readonly attemptLoop: AttemptLoop;
  // Read by TurnResources at call time; coreServicesRoot.test.ts reads this field.
  private mcpServerManager?: MCPServerManager;
  private mockStreamLifecycle?: MockStreamLifecycle;
  private readonly PARTIAL_WRITE_THROTTLE_MS = 500;
  private readonly historyService: HistoryService;
  // Owns this manager's partial.json and final-message writes (turnEngine/PartialJournal.ts).
  private readonly partialJournal: PartialJournal;
  // Owns the turn's usage accounting and session-usage writes (turnEngine/UsageLedger.ts).
  private readonly usageLedger: UsageLedger;
  // Owns turn event delivery and workflow-run attachments (turnEngine/TurnEvents.ts).
  private readonly turnEvents: TurnEvents<WorkspaceStreamInfo>;
  // Builds and emits part, stream-start and nested tool events, and replays streams.
  private readonly turnEventEmitter: TurnEventEmitter;
  // Builds each streamText call and prepares its steps (turnEngine/StepPreparation.ts).
  private readonly stepPreparation: StepPreparation;
  // Owns lost previousResponseIds and prefix swaps (turnEngine/ProviderRequest.ts).
  private readonly providerRequest: ProviderRequest;
  private readonly getProvidersConfig: () => ProvidersConfigMap | null;
  /**
   * Runs the clock-driven lifecycle fibers (partial-write debounce and its
   * interrupt) and is handed to per-session workers that must share this
   * stream's clock (`RetryManager`, via `AgentSessionStreamManager`). The app
   * runtime's context-bound runner in production — a `TestClock` in tests —
   * and the global runtime wherever nothing is injected (di/effectRunner.ts).
   */
  public readonly effectRunner: EffectRunner;
  /**
   * Record timestamps, throttle windows and timeouts read this clock, so they move with
   * the runner's sleeps: nodeClock in production, the runner's TestClock in tests. Handed
   * to AgentSession and TurnRequestBuilder like `effectRunner`.
   */
  public readonly hostClock: HostClock;
  // Token tracker for live streaming statistics
  private readonly tokenTracker: StreamManagerTokenTracker;
  // Injected stream factory; undefined uses the AI SDK's streamText, resolved at
  // call time so the default stays the live module export.
  private readonly streamTextOverride?: typeof streamText;

  constructor(
    historyService: HistoryService,
    sessionUsageService?: SessionUsageService,
    getProvidersConfig?: () => ProvidersConfigMap | null,
    eventSink: TurnEngineEventSink = () => undefined,
    runner: EffectRunner = defaultEffectRunner,
    engineScope?: Scope.Closeable,
    private readonly toolCallDisplayRegistry = new ToolCallDisplayRegistry(),
    options: StreamManagerOptions = {}
  ) {
    this.historyService = historyService;
    this.getProvidersConfig = getProvidersConfig ?? (() => null);
    this.usageLedger = new UsageLedger({
      sessionUsageService,
      getProvidersConfig: this.getProvidersConfig,
      workspaceLogger: (id, turn) => this.getWorkspaceLogger(id as WorkspaceId, turn),
    });
    this.providerRequest = new ProviderRequest({
      getProvidersConfig: this.getProvidersConfig,
      workspaceLogger: (id, turn) => this.getWorkspaceLogger(id as WorkspaceId, turn),
    });
    this.turnEvents = new TurnEvents<WorkspaceStreamInfo>(eventSink, {
      flushPartialWrite: (id, info) => this.flushPartialWrite(id, info),
    });
    this.effectRunner = runner;
    this.hostClock = options.hostClock ?? hostClockFor(runner);
    this.partialJournal = new PartialJournal({
      historyService,
      runner,
      clock: this.hostClock,
      throttleMs: this.PARTIAL_WRITE_THROTTLE_MS,
    });
    this.turnRegistry = new TurnRegistry({
      effectRunner: runner,
      engineScope,
      turnEvents: this.turnEvents,
      mockStreamLifecycle: () => this.mockStreamLifecycle,
      flushPartialWrite: (id, info) => this.flushPartialWrite(id, info),
      cleanupAbortedStream: (id, info, abortReason, abandonPartial) =>
        this.cleanupAbortedStream(id, info, abortReason, abandonPartial),
    });
    this.workspaceStreams = this.turnRegistry.workspaceStreams;
    this.turnResources = new TurnResources({
      effectRunner: runner,
      toolCallDisplayRegistry: this.toolCallDisplayRegistry,
      partialJournal: this.partialJournal,
      mcpServerManager: () => this.mcpServerManager,
      // Forward at call time: tests spy on and Reflect.set these StreamManager methods.
      createTempDirForStream: (streamToken, runtime) =>
        this.createTempDirForStream(streamToken, runtime),
      cleanupStreamTempDir: (runtime, dir) => this.cleanupStreamTempDir(runtime, dir),
    });
    this.turnEngine = new TurnEngine({
      turnRegistry: this.turnRegistry,
      turnResources: this.turnResources,
      providerRequest: this.providerRequest,
      toolCallDisplayRegistry: this.toolCallDisplayRegistry,
      // Forward at call time: these methods stay in StreamManager, and whitebox
      // tests replace createStreamResult on it.
      resolveMetadataModel: (modelString, snapshot) =>
        this.resolveMetadataModel(modelString, snapshot),
      handleToolExecutionStart: (workspaceId, messageId, toolCallId) =>
        this.handleToolExecutionStart(workspaceId, messageId, toolCallId),
      createStreamResult: (request, abortController, stepTracker) =>
        this.createStreamResult(request, abortController, stepTracker),
      processStreamWithCleanup: (workspaceId, streamInfo, historySequence) =>
        this.processStreamWithCleanup(workspaceId, streamInfo, historySequence),
      convertToSendMessageError: (error) => this.convertToSendMessageError(error),
    });
    this.tokenTracker = options.tokenTracker ?? new StreamingTokenTracker();
    this.refusalFallback = new RefusalFallback({
      usageLedger: this.usageLedger,
      providerRequest: this.providerRequest,
      historyService: this.historyService,
      turnEvents: this.turnEvents,
      // Forward at call time: these methods stay in StreamManager, and whitebox
      // tests replace createStreamResult and tokenTracker on it.
      tokenTracker: {
        setModel: (model, metadataModel) => this.tokenTracker.setModel(model, metadataModel),
      },
      getWorkspaceLogger: (workspaceId, streamInfo) =>
        this.getWorkspaceLogger(workspaceId, streamInfo),
      resolveMetadataModel: (modelString, snapshot) =>
        this.resolveMetadataModel(modelString, snapshot),
      handleToolExecutionStart: (workspaceId, messageId, toolCallId) =>
        this.handleToolExecutionStart(workspaceId, messageId, toolCallId),
      createStreamResult: (request, abortController, stepTracker) =>
        this.createStreamResult(request, abortController, stepTracker),
      resetStreamStateForRetry: (workspaceId, streamInfo, options) =>
        this.resetStreamStateForRetry(workspaceId, streamInfo, options),
      moveAnthropicThinkingReplayPoint: (streamInfo, point) =>
        this.moveAnthropicThinkingReplayPoint(streamInfo, point),
      getStreamMetadata: (streamInfo) => this.getStreamMetadata(streamInfo),
      backfillReasoningTokensFromParts: (streamInfo, usage) =>
        this.backfillReasoningTokensFromParts(streamInfo, usage),
      getAggregatedProviderMetadata: (streamInfo) => this.getAggregatedProviderMetadata(streamInfo),
      buildPartialAssistantMessage: (streamInfo, options) =>
        this.buildPartialAssistantMessage(streamInfo, options),
    });
    this.attemptLoop = new AttemptLoop({
      turnResources: this.turnResources,
      partialJournal: this.partialJournal,
      usageLedger: this.usageLedger,
      providerRequest: this.providerRequest,
      turnEvents: this.turnEvents,
      refusalFallback: this.refusalFallback,
      workspaceStreams: this.workspaceStreams,
      // Forward at call time: these methods stay in StreamManager, and whitebox
      // tests replace createStreamResult and tokenTracker on it.
      tokenTracker: {
        setModel: (model, metadataModel) => this.tokenTracker.setModel(model, metadataModel),
      },
      getWorkspaceLogger: (workspaceId, streamInfo) =>
        this.getWorkspaceLogger(workspaceId, streamInfo),
      getStreamMetadata: (streamInfo) => this.getStreamMetadata(streamInfo),
      endUsage: (streamInfo, totalUsage) => this.endUsage(streamInfo, totalUsage),
      backfillReasoningTokensFromParts: (streamInfo, usage) =>
        this.backfillReasoningTokensFromParts(streamInfo, usage),
      resolveTtftMsForStreamEnd: (streamInfo) => this.resolveTtftMsForStreamEnd(streamInfo),
      resolveProviderMetadataForStreamEnd: (streamInfo) =>
        this.resolveProviderMetadataForStreamEnd(streamInfo),
      getOpenAIPreviousResponseId: (providerOptions) =>
        this.getOpenAIPreviousResponseId(providerOptions),
      resetStreamStateForRetry: (workspaceId, streamInfo, options) =>
        this.resetStreamStateForRetry(workspaceId, streamInfo, options),
      createStreamResult: (request, abortController, stepTracker) =>
        this.createStreamResult(request, abortController, stepTracker),
      emitStreamStart: (workspaceId, streamInfo, historySequence) =>
        this.emitStreamStart(workspaceId, streamInfo, historySequence),
      flushPartialWrite: (workspaceId, streamInfo) =>
        this.flushPartialWrite(workspaceId, streamInfo),
      foldView: (workspaceId, streamInfo, loop) => this.foldView(workspaceId, streamInfo, loop),
      applyStep: (workspaceId, streamInfo, step, loop) =>
        this.applyStep(workspaceId, streamInfo, step, loop),
      planPreviousResponseIdRetry: (streamInfo, error) =>
        this.planPreviousResponseIdRetry(streamInfo, error),
      planReasoningReplayRetry: (streamInfo, error) =>
        this.planReasoningReplayRetry(streamInfo, error),
      retryStreamWithoutPreviousResponseId: (workspaceId, streamInfo, error, plan) =>
        this.retryStreamWithoutPreviousResponseId(workspaceId, streamInfo, error, plan),
      retryStreamWithoutReasoningReplay: (workspaceId, streamInfo, error, plan) =>
        this.retryStreamWithoutReasoningReplay(workspaceId, streamInfo, error, plan),
      buildStreamErrorPayload: (streamInfo, error) =>
        this.buildStreamErrorPayload(streamInfo, error),
      persistStreamError: (workspaceId, streamInfo, payload) =>
        this.persistStreamError(workspaceId, streamInfo, payload),
      discardUnsettledSessionUsage: (workspaceId, streamInfo) =>
        this.discardUnsettledSessionUsage(workspaceId, streamInfo),
    });
    this.streamTextOverride = options.streamText;
    this.stepPreparation = new StepPreparation({
      providerRequest: this.providerRequest,
      historyService: this.historyService,
      streamTextOverride: this.streamTextOverride,
      createStopWhenCondition: (request, stepTracker) =>
        this.createStopWhenCondition(request, stepTracker),
    });
    this.turnEventEmitter = new TurnEventEmitter(this.turnEvents, {
      // Forward to the field at call time: whitebox tests replace tokenTracker after
      // construction (Reflect.set), and the emitter must use the same tracker.
      tokenTracker: {
        setModel: (model, metadataModel) => this.tokenTracker.setModel(model, metadataModel),
        countTokens: (text) => this.tokenTracker.countTokens(text),
      },
      toolCallDisplayRegistry: this.toolCallDisplayRegistry,
      getStream: (id) => this.workspaceStreams.get(id),
      flushPartialWrite: (id, info) => this.flushPartialWrite(id, info),
      schedulePartialWrite: (id, info) => this.schedulePartialWrite(id, info),
      turnReplayOffAfterServerTool: (info) => this.turnReplayOffAfterServerTool(info),
    });
  }

  setEventSink(eventSink: TurnEngineEventSink): void {
    this.turnEvents.setEventSink(eventSink);
  }

  private getWorkspaceLogger(
    workspaceId: WorkspaceId,
    streamInfo?: Pick<WorkspaceStreamInfo, "workspaceName">
  ): Logger {
    const fields: Record<string, unknown> = { workspaceId };
    if (streamInfo?.workspaceName) {
      fields.workspaceName = streamInfo.workspaceName;
    }
    return log.withFields(fields);
  }
  resolveMetadataModel(modelString: string, providersConfigSnapshot?: ProvidersConfigMap): string {
    try {
      // A caller's pinned request snapshot wins over the live config so the
      // recorded identity matches the request that was actually built (a
      // concurrent catalog refresh can retag/remove the instance mid-turn).
      return resolveModelForMetadata(
        modelString,
        providersConfigSnapshot ?? this.getProvidersConfig()
      );
    } catch (error) {
      log.debug("Failed to resolve metadata model override", {
        modelString,
        error: getErrorMessage(error),
      });
      return modelString;
    }
  }

  setMCPServerManager(manager: MCPServerManager | undefined): void {
    this.mcpServerManager = manager;
  }

  setMockStreamLifecycle(lifecycle: MockStreamLifecycle | undefined): void {
    this.mockStreamLifecycle = lifecycle;
  }

  getStartupAbortReason(signal?: AbortSignal): StreamAbortReason {
    return this.turnRegistry.getStartupAbortReason(signal);
  }

  beginStreamStart(
    input: Parameters<TurnRegistry["beginStreamStart"]>[0]
  ): PendingStreamStartHandle {
    return this.turnRegistry.beginStreamStart(input);
  }

  recordToolModelUsage(
    workspaceId: string,
    messageId: string,
    event: PersistedToolModelUsage
  ): void {
    const streamInfo = this.workspaceStreams.get(workspaceId as WorkspaceId);
    if (streamInfo?.messageId !== messageId) {
      return;
    }

    this.usageLedger.recordToolModelUsage(streamInfo, event);
  }

  async attachWorkflowRunToToolCall(event: WorkflowRunAttachedEvent): Promise<boolean> {
    return this.turnEvents.attachWorkflowRunToToolCall(
      event,
      this.workspaceStreams.get(event.workspaceId as WorkspaceId)
    );
  }

  /**
   * Record on the dynamic-tool part when its execute() actually began running and notify
   * the UI. Returns false when the part has not landed in streamInfo.parts yet.
   */
  private applyToolExecutionStart(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    toolCallId: string,
    timestamp: number
  ): boolean {
    const partIndex = streamInfo.parts.findIndex(
      (part) => part.type === "dynamic-tool" && part.toolCallId === toolCallId
    );
    if (partIndex === -1) {
      return false;
    }

    const part = streamInfo.parts[partIndex];
    assert(part.type === "dynamic-tool", "applyToolExecutionStart matched a non-tool part");
    streamInfo.parts[partIndex] = { ...part, executionStartedAt: timestamp };

    this.turnEvents.emitTurnEvent({
      type: "tool-call-execution-start",
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      toolCallId,
      timestamp,
    } satisfies ToolCallExecutionStartEvent);
    return true;
  }

  /**
   * Called from withSequentialExecution the moment a tool call's execute() acquires the
   * execution lock. Parallel tool calls run sequentially, so this is the honest start of
   * execution — the part's own `timestamp` only marks when the model emitted the call.
   */
  private handleToolExecutionStart(
    workspaceId: WorkspaceId,
    messageId: string,
    toolCallId: string
  ): void {
    const streamInfo = this.workspaceStreams.get(workspaceId);
    if (streamInfo?.messageId !== messageId) {
      return;
    }

    // Use the stream's monotonic clock, not raw Date.now(): the tool-call part timestamp
    // was monotonicized by nextPartTimestamp(), so a same-millisecond raw reading could be
    // <= it. Reconnect replay repairs missed execution starts only when
    // executionStartedAt > cursor, and the cursor sits at the tool-call timestamp when the
    // client disconnected right after tool-call-start.
    const timestamp = nextPartTimestamp(streamInfo);
    if (!this.applyToolExecutionStart(workspaceId, streamInfo, toolCallId, timestamp)) {
      // execute() won the race against the fullStream consumer; the "tool-call" case
      // consumes this entry right after storing the part.
      (streamInfo.pendingToolExecutionStarts ??= new Map()).set(toolCallId, timestamp);
    }
  }

  private partialTarget(workspaceId: WorkspaceId, streamInfo: WorkspaceStreamInfo): PartialTarget {
    return {
      workspaceId: workspaceId as string,
      state: streamInfo,
      snapshot: () => this.buildPartialAssistantMessage(streamInfo),
    };
  }

  /** Throttled partial write (PartialJournal.schedule). */
  private async schedulePartialWrite(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    await this.partialJournal.schedule(
      this.partialTarget(workspaceId, streamInfo),
      streamInfo.resourceScope
    );
  }

  /** Immediate partial write after any in-flight one (PartialJournal.flush). */
  private async flushPartialWrite(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    terminalPartial?: MuxMessage
  ): Promise<void> {
    await this.partialJournal.flush(this.partialTarget(workspaceId, streamInfo), terminalPartial);
  }

  /** Used by callers that prepare resources (like tools) before starting the stream. */
  public generateStreamToken(): StreamToken {
    return this.turnRegistry.generateStreamToken();
  }

  /** TurnResources.createTempDirForStream. Tests spy on this method; startStream calls it. */
  public async createTempDirForStream(streamToken: StreamToken, runtime: Runtime): Promise<string> {
    return this.turnResources.createTempDirForStream(streamToken, runtime);
  }

  /** TurnResources.cleanupStreamTempDir. Tests replace this method; the release calls it. */
  private cleanupStreamTempDir(runtime: Runtime, runtimeTempDir: string): void {
    this.turnResources.cleanupStreamTempDir(runtime, runtimeTempDir);
  }

  /**
   * Extracts usage and duration metadata from stream result.
   *
   * Usage is only available after stream completes naturally.
   * On abort, the usage promise may hang - we use a timeout to return quickly.
   */
  private async emitToolCallDeltaIfPresent(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    part: unknown
  ): Promise<boolean> {
    const maybeDelta = part as { type?: string } | undefined;
    if (maybeDelta?.type !== "tool-call-delta") {
      return false;
    }

    const toolDelta = part as {
      toolCallId: string;
      toolName: string;
      argsTextDelta: string;
    };

    const deltaText = String(toolDelta.argsTextDelta ?? "");
    if (deltaText.length === 0) {
      return true;
    }

    const tokens = await this.tokenTracker.countTokens(deltaText);
    // Record time: wall clock until #7282 moves its consumers to HostClock.
    const timestamp = nodeClock.nowMs();

    this.turnEvents.emitTurnEvent({
      type: "tool-call-delta",
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      toolCallId: toolDelta.toolCallId,
      toolName: toolDelta.toolName,
      delta: toolDelta.argsTextDelta,
      tokens,
      timestamp,
    });

    return true;
  }

  private async getStreamMetadata(
    streamInfo: WorkspaceStreamInfo,
    timeoutMs = 1000
  ): Promise<{
    totalUsage?: LanguageModelV2Usage;
    contextUsage?: LanguageModelV2Usage;
    contextProviderMetadata?: Record<string, unknown>;
    finishReason?: string;
    duration: number;
  }> {
    // Helper: wrap promise with independent timeout + error handling
    // Each promise resolves independently - one failure doesn't mask others
    const withTimeout = <T>(promise: PromiseLike<T>): Promise<T | undefined> =>
      Promise.race([
        promise,
        new Promise<undefined>((resolve) =>
          this.hostClock.setTimer(() => resolve(undefined), timeoutMs)
        ),
      ]).catch(() => undefined);

    // Fetch all metadata in parallel with independent timeouts
    // - totalUsage: sum of all steps (for cost calculation). AI SDK 7's
    //   top-level `usage` accumulates across all steps (old `totalUsage`).
    // - contextUsage: last step only (for context window display) — moved to
    //   `finalStep.usage` in AI SDK 7.
    // - contextProviderMetadata: last step (for context window cache display)
    const streamResultWithFinishReason = streamInfo.streamResult as {
      finishReason?: PromiseLike<string>;
    };
    const [totalUsageRaw, finalStep, finishReason] = await Promise.all([
      withTimeout(streamInfo.streamResult.usage),
      withTimeout(streamInfo.streamResult.finalStep),
      streamResultWithFinishReason.finishReason
        ? withTimeout(streamResultWithFinishReason.finishReason)
        : Promise.resolve(undefined),
    ]);

    return {
      totalUsage: normalizeUsage(totalUsageRaw),
      contextUsage: normalizeUsage(finalStep?.usage),
      // AI SDK 7 moved Anthropic cache-write tokens off provider metadata;
      // re-inject from the final step's usage so cache display keeps working.
      contextProviderMetadata: withCacheWriteMetadata(
        finalStep?.providerMetadata,
        finalStep?.usage
      ),
      finishReason,
      // Duration from the wall-clock streamInfo.startTime.
      duration: nodeClock.nowMs() - streamInfo.startTime,
    };
  }

  /**
   * A retry that restarted the SDK stream but kept the earlier attempt's billed usage: the
   * new stream's totals and steps cover only the retried call.
   */
  private restartedWithPreservedUsage(streamInfo: WorkspaceStreamInfo): boolean {
    return (
      streamInfo.didRetryPreviousResponseIdAtStep ||
      streamInfo.didRetryAfterEmptyOutput === true ||
      streamInfo.didRetryReasoningReplayAtStep === true
    );
  }

  private endUsage(
    streamInfo: WorkspaceStreamInfo,
    totalUsage: LanguageModelV2Usage | undefined
  ): LanguageModelV2Usage | undefined {
    return this.usageLedger.endUsage(
      streamInfo,
      totalUsage,
      this.restartedWithPreservedUsage(streamInfo)
    );
  }

  private async backfillReasoningTokensFromParts(
    streamInfo: Pick<
      WorkspaceStreamInfo,
      "parts" | "metadataModel" | "model" | "reasoningBackfillStartIndex"
    >,
    usage: LanguageModelV2Usage | undefined
  ): Promise<void> {
    // Backfill reasoningTokens from the full reasoning text when the provider
    // doesn't report them. @ai-sdk/anthropic sets reasoning: undefined even for
    // extended-thinking models. Tokenizing concatenated text (not per-delta
    // sums) avoids BPE chunk-boundary inflation.
    if (!usage || usage.reasoningTokens) {
      return;
    }

    const reasoningText = streamInfo.parts
      .slice(streamInfo.reasoningBackfillStartIndex ?? 0)
      .filter(
        (part): part is Extract<CompletedMessagePart, { type: "reasoning" }> =>
          part.type === "reasoning"
      )
      .map((part) => part.text)
      .join("");
    if (!reasoningText) {
      return;
    }

    usage.reasoningTokens = await countTokens(
      streamInfo.metadataModel ?? streamInfo.model,
      reasoningText
    );
  }

  private resolveTtftMsForStreamEnd(streamInfo: WorkspaceStreamInfo): number | undefined {
    const firstTokenPart = streamInfo.parts.find(
      (
        part
      ): part is Extract<
        CompletedMessagePart,
        { type: "text" | "reasoning"; timestamp?: number }
      > => (part.type === "text" || part.type === "reasoning") && part.text.length > 0
    );

    if (!firstTokenPart) {
      return undefined;
    }

    if (!Number.isFinite(streamInfo.startTime)) {
      return undefined;
    }

    const firstTokenTimestamp = firstTokenPart.timestamp;
    if (typeof firstTokenTimestamp !== "number" || !Number.isFinite(firstTokenTimestamp)) {
      return undefined;
    }

    const ttftMs = Math.max(0, firstTokenTimestamp - streamInfo.startTime);
    return Number.isFinite(ttftMs) ? ttftMs : undefined;
  }

  /**
   * Provider metadata for the usage resolveTotalUsageForStreamEnd picks: after a retry that
   * kept the earlier attempt's usage, only the live accumulation also covers the steps before
   * the retry (their cache writes and long-context shares).
   */
  private async resolveProviderMetadataForStreamEnd(
    streamInfo: WorkspaceStreamInfo
  ): Promise<Record<string, unknown> | undefined> {
    return (
      this.usageLedger.preservedEndProviderMetadata(
        streamInfo,
        this.restartedWithPreservedUsage(streamInfo)
      ) ?? this.getAggregatedProviderMetadata(streamInfo)
    );
  }

  /**
   * Aggregate provider metadata across all steps.
   *
   * CRITICAL: For multi-step tool calls, cache creation tokens are reported per-step.
   * streamResult.providerMetadata only contains the LAST step's metadata, missing
   * cache creation tokens from earlier steps. We must sum across all steps.
   */
  private async getAggregatedProviderMetadata(
    streamInfo: WorkspaceStreamInfo,
    timeoutMs = 1000
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const steps = await Promise.race([
        streamInfo.streamResult.steps,
        new Promise<undefined>((resolve) =>
          this.hostClock.setTimer(() => resolve(undefined), timeoutMs)
        ),
      ]);

      if (!steps || steps.length === 0) {
        // The live per-step accumulation covers every step; without one, fall back to the
        // final step's provider metadata.
        if (streamInfo.cumulativeProviderMetadata) {
          return { ...streamInfo.cumulativeProviderMetadata };
        }
        const finalStep = await streamInfo.streamResult.finalStep;
        return accumulateStepsProviderMetadata([finalStep], streamInfo.metadataModel);
      }

      // Aggregate cache creation tokens and long-context shares across all steps
      // (accumulateStepsProviderMetadata re-injects AI SDK 7's per-step cache writes).
      return accumulateStepsProviderMetadata(steps, streamInfo.metadataModel);
    } catch (error) {
      log.debug("Could not aggregate provider metadata:", error);
      return undefined;
    }
  }

  /**
   * Safely cancels an existing stream with proper cleanup
   *
   * CRITICAL: Waits for the processing promise to complete before cleanup.
   * This ensures the old stream fully exits before a new stream can start,
   * preventing concurrent streams and race conditions.
   */
  /** Read-only snapshot of the stream state that partFold reads. */
  private foldView(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    loop: PartLoopState
  ): FoldView {
    return {
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      parts: streamInfo.parts,
      currentReasoningBlock: streamInfo.currentReasoningBlock,
      lastPartTimestamp: streamInfo.lastPartTimestamp,
      model: streamInfo.model,
      anthropicMessagesWire: isAnthropicMessagesModel(streamInfo.request.model),
      toolCalls: loop.toolCalls,
    };
  }

  /**
   * Runs partFold's intents in order with the existing helpers. Synchronous
   * intents run without a yield between them, awaited helpers stay awaited, and
   * schedulePartialWrite stays fire-and-forget, as when the fold was inline.
   */
  private async applyStep(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    step: FoldStep,
    loop: PartLoopState
  ): Promise<void> {
    // Store before the first await: tool execution starts stamp parts while
    // the intents below await, and part timestamps must stay monotonic.
    streamInfo.lastPartTimestamp = step.lastPartTimestamp;
    if (step.ignoredTextDelta) {
      log.debug("[streamManager] Ignoring non-string text-delta payload", {
        workspaceId,
        model: streamInfo.model,
        ...step.ignoredTextDelta,
      });
    }
    for (const intent of step.intents) {
      const pending = this.applyIntent(workspaceId, streamInfo, intent, loop);
      if (pending !== undefined) {
        await pending;
      }
    }
  }

  /** Returns the helper's promise for intents the stream loop must await (its value is unused). */
  private applyIntent(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    intent: FoldIntent,
    loop: PartLoopState
  ): Promise<unknown> | undefined {
    switch (intent._tag) {
      case "StartStep":
        this.recordStepStart(streamInfo);
        streamInfo.streamStepOrdinals.push(streamInfo.stepStartIndices.length - 1);
        return this.writeInTurnThinkingStripReceipt(workspaceId, streamInfo);
      case "OpenReasoningBlock":
        streamInfo.currentReasoningBlock = {};
        return undefined;
      case "Append":
        return this.appendFoldedPart(workspaceId, streamInfo, intent);
      case "UpdateReasoningPart":
        this.updateReasoningPart(streamInfo, intent);
        return undefined;
      case "Emit":
        this.turnEvents.emitTurnEvent(intent.event);
        return undefined;
      case "CheckSoftCancel":
        return this.turnRegistry.checkSoftCancelStream(workspaceId, streamInfo);
      default:
        return this.applyToolIntent(workspaceId, streamInfo, intent, loop);
    }
  }

  private applyToolIntent(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    intent: FoldIntent,
    loop: PartLoopState
  ): Promise<unknown> | undefined {
    switch (intent._tag) {
      case "RecordToolCall":
        // Tool call started - store in map for later lookup
        loop.toolCalls.set(intent.toolCallId, {
          toolCallId: intent.toolCallId,
          toolName: intent.toolName,
          input: intent.input,
        });
        if (intent.anthropicServerTool) {
          (streamInfo.anthropicServerToolCallIds ??= new Set()).add(intent.toolCallId);
        }
        return undefined;
      case "SetToolCallOutput": {
        const toolCall = loop.toolCalls.get(intent.toolCallId);
        assert(toolCall != null, "partFold sets output only on a tracked tool call");
        toolCall.output = intent.output;
        return undefined;
      }
      case "FinishToolCall":
        // Use shared completion logic (await to ensure partial is flushed before event)
        return this.finishToolCall(
          workspaceId,
          streamInfo,
          loop.toolCalls,
          intent.toolCallId,
          intent.toolName,
          intent.output,
          intent.providerExecuted,
          intent.modelOnlyNotifications
        );
      case "EmitToolCallDelta":
        return this.emitToolCallDeltaIfPresent(workspaceId, streamInfo, intent.part);
      case "SchedulePartialWrite":
        void this.schedulePartialWrite(workspaceId, streamInfo);
        return undefined;
      default:
        return this.applyTurnIntent(workspaceId, streamInfo, intent, loop);
    }
  }

  private applyTurnIntent(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    intent: FoldIntent,
    loop: PartLoopState
  ): Promise<unknown> | undefined {
    switch (intent._tag) {
      case "RecordTerminalFinish":
        recordTerminalFinish(streamInfo, intent);
        return undefined;
      case "RecordStepUsage":
        this.recordStepUsage(workspaceId, streamInfo, intent.usage, intent.providerMetadata);
        return undefined;
      case "RecordInFlightUsage":
        return this.usageLedger.recordInFlight(workspaceId, streamInfo);
      case "FlushPartialWrite":
        return this.flushPartialWrite(workspaceId, streamInfo);
      case "Fail":
        // Capture the error and immediately throw to trigger error handling
        throw intent.error;
      default:
        this.applyLogIntent(streamInfo, intent, loop);
        return undefined;
    }
  }

  private applyLogIntent(
    streamInfo: WorkspaceStreamInfo,
    intent: FoldIntent,
    loop: PartLoopState
  ): void {
    switch (intent._tag) {
      case "Log":
        loop.workspaceLog[intent.level](intent.message, intent.fields);
        return;
      case "LogToolCall": {
        const inputText = JSON.stringify(intent.input);
        log.debug(
          `[StreamManager] tool-call: toolName=${intent.toolName}, input length=${inputText.length}`
        );
        return;
      }
      case "LogOrphanToolResult":
        loop.orphanToolResultCount += 1;
        this.logOrphanToolResult(
          loop.workspaceLog,
          streamInfo,
          { toolCallId: intent.toolCallId, toolName: intent.toolName },
          intent.output,
          loop.orphanToolResultCount,
          loop.toolCalls.size
        );
        return;
      case "LogToolError": {
        const logLevel = streamInfo.abortController.signal.aborted ? log.debug : log.error;
        logLevel(`Tool execution error for '${intent.toolName}'`, {
          toolCallId: intent.toolCallId,
          error: intent.error,
        });
        return;
      }
      default:
        assert(false, `applyStep has no handler for ${intent._tag}`);
    }
  }

  private async appendFoldedPart(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    intent: Extract<FoldIntent, { _tag: "Append" }>
  ): Promise<void> {
    await this.turnEventEmitter.appendPartAndEmit(
      workspaceId,
      streamInfo,
      intent.part,
      intent.skipPartialWrite !== true
    );
    // The same object appendPartAndEmit pushed: signature deltas compare by reference.
    if (intent.trackInBlock && streamInfo.currentReasoningBlock) {
      streamInfo.currentReasoningBlock.lastPart = intent.part;
    }
  }

  /** Adds one finish-step's usage to the stream totals, then emits usage-delta. */
  private recordStepUsage(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    stepUsage: LanguageModelV2Usage,
    stepProviderMetadata: Record<string, unknown> | undefined
  ): void {
    // Update cumulative totals for this stream. The emit below runs with
    // zero suspension after the mutation (emitTurnEvent invokes
    // the sink synchronously), so downstream Effect queue bridges
    // (SubscriptionEmit's offerUnsafe) observe usage-delta events
    // in mutation order.
    this.usageLedger.recordStep(streamInfo, stepUsage, stepProviderMetadata);

    const usageEvent = buildUsageDeltaEvent({
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      // Step-level (for context window display)
      usage: stepUsage,
      providerMetadata: stepProviderMetadata,
      // Cumulative (for live cost display)
      cumulativeUsage: streamInfo.cumulativeUsage,
      cumulativeProviderMetadata: streamInfo.cumulativeProviderMetadata,
      // Preserve costs-included zero-cost behavior throughout the stream.
      costsIncluded: streamInfo.initialMetadata?.costsIncluded,
    });
    streamInfo.currentStepStartIndex = streamInfo.parts.length;
    this.turnEvents.emitTurnEvent(usageEvent);
  }

  private updateReasoningPart(
    streamInfo: WorkspaceStreamInfo,
    intent: Extract<FoldIntent, { _tag: "UpdateReasoningPart" }>
  ): void {
    const target = streamInfo.parts[intent.index];
    // partFold read the index from this array in the same synchronous turn.
    assert(target?.type === "reasoning", "partFold updates only reasoning parts");
    if (intent.signature) {
      target.signature = intent.signature;
    }
    target.providerOptions = intent.providerOptions;
    if (intent.trackInBlock && streamInfo.currentReasoningBlock) {
      streamInfo.currentReasoningBlock.lastPart = target;
    }
  }

  /**
   * #5887 containment: thinking that follows an Anthropic server tool in this row cannot
   * replay as the API returned it (see anthropicServerToolCallIds). Write the receipt with
   * the point at the row's end, so later requests in the context segment send no thinking
   * up to and including this row (removing every thinking block is valid; a gap or a
   * put-back block is not). Rows after it replay theirs. It wins over a step point and
   * never moves back. It rides on the partial write that stores this reasoning part (every
   * reasoning append schedules one).
   */
  private turnReplayOffAfterServerTool(streamInfo: WorkspaceStreamInfo): void {
    const serverToolIds = streamInfo.anthropicServerToolCallIds;
    if (
      serverToolIds == null ||
      streamInfo.initialMetadata?.anthropicThinkingReplayFromStep === "end"
    ) {
      return;
    }
    // Only Anthropic reasoning is bound to the native prefix: a refusal fallback to another
    // provider keeps the parts (and the IDs) but its reasoning replays nothing Anthropic.
    if (!isAnthropicMessagesModel(streamInfo.request.model)) return;
    // Read the parts, not only the ID set: a retry that drops parts drops the server tool too.
    const followsServerTool = streamInfo.parts.some(
      (part) => part.type === "dynamic-tool" && serverToolIds.has(part.toolCallId)
    );
    if (!followsServerTool) {
      // Every recorded server tool's part is gone. The tool-call case records an ID and
      // stores its part before any later reasoning, so the IDs are stale: drop them, or
      // every later reasoning delta would scan all parts again (perf).
      streamInfo.anthropicServerToolCallIds = undefined;
      return;
    }
    this.moveAnthropicThinkingReplayPoint(streamInfo, "end");
  }

  /**
   * Preserved thinking: once the step whose request stripped earlier Anthropic thinking
   * (stepTracker.anthropicThinkingStripStep) has started, write the receipt with that step as
   * the point, or the next turn replays the removed blocks and gets a 400. Persisted with the
   * next partial write; a crash before it only costs one repair (fail-safe).
   */
  private async writeInTurnThinkingStripReceipt(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    const stripStep = streamInfo.stepTracker.anthropicThinkingStripStep;
    // prepareStep may already have prepared a later step: wait until that step started.
    if (stripStep == null || stripStep >= streamInfo.streamStepOrdinals.length) return;
    streamInfo.stepTracker.anthropicThinkingStripStep = undefined;
    if (
      this.moveAnthropicThinkingReplayPoint(streamInfo, streamInfo.streamStepOrdinals[stripStep])
    ) {
      await this.schedulePartialWrite(workspaceId, streamInfo);
    }
  }

  /**
   * Write or move this row's thinking-replay receipt (MuxMetadata.anthropicThinkingReplay).
   * A second strip in the same turn moves the point forward: it removed everything the
   * earlier one did, and its later blocks are bound to the new prefix. initialMetadata feeds
   * the partial, error partial and final row alike. Returns whether anything changed; the
   * caller persists it.
   */
  private moveAnthropicThinkingReplayPoint(
    streamInfo: WorkspaceStreamInfo,
    point: AnthropicThinkingReplayPoint
  ): boolean {
    const current = streamInfo.initialMetadata;
    const next = laterAnthropicThinkingReplayPoint(
      current?.anthropicThinkingReplay === "off"
        ? current.anthropicThinkingReplayFromStep
        : undefined,
      point
    );
    if (
      current?.anthropicThinkingReplay === "off" &&
      current.anthropicThinkingReplayFromStep === next
    ) {
      return false;
    }
    streamInfo.initialMetadata = {
      ...current,
      anthropicThinkingReplay: "off",
      anthropicThinkingReplayFromStep: next,
    };
    return true;
  }

  private async cleanupAbortedStream(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    abortReason: StreamAbortReason,
    abandonPartial?: boolean
  ): Promise<void> {
    // Close before waiting: late or queued invocations cannot publish after abort.
    if (streamInfo.executionScope) this.toolCallDisplayRegistry.close(streamInfo.executionScope);
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
    await this.turnResources.closeStreamResources(streamInfo);

    // For aborts, use our tracked cumulativeUsage directly instead of AI SDK's totalUsage.
    // cumulativeUsage is updated on each finish-step event (before tool execution),
    // so it has accurate data even when the stream is interrupted mid-tool-call.
    // AI SDK's totalUsage may return zeros or stale data when aborted.
    // Duration from the wall-clock streamInfo.startTime.
    const duration = nodeClock.nowMs() - streamInfo.startTime;
    const usage = hasTokenUsage(streamInfo.cumulativeUsage)
      ? streamInfo.cumulativeUsage
      : undefined;

    // For context window display, use last step's usage (inputTokens = current context size)
    const contextUsage = streamInfo.lastStepUsage;
    const contextProviderMetadata = streamInfo.lastStepProviderMetadata;

    // Include provider metadata for accurate cost calculation
    const providerMetadata = markProviderMetadataCostsIncluded(
      streamInfo.cumulativeProviderMetadata,
      streamInfo.initialMetadata?.costsIncluded
    );

    const streamAbort: StreamAbortEvent = {
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
        // Same tool-model usage the committed partial gets below, so the renderer's
        // per-turn cost views match history replay without a reload.
        ...(streamInfo.toolModelUsages.length > 0
          ? { toolModelUsages: streamInfo.toolModelUsages.map(clonePersistedToolModelUsage) }
          : {}),
      },
      abortReason,
      abandonPartial,
      acpPromptId: streamInfo.initialMetadata?.acpPromptId,
    };
    try {
      try {
        await this.backfillReasoningTokensFromParts(streamInfo, usage);
      } catch (error) {
        // Estimation is optional: preserve provider usage and the user's abort reason.
        log.error("Failed to estimate reasoning usage on abort", { error });
      }

      // Record session usage for aborted streams (mirrors stream-end path)
      // This ensures tokens consumed before abort are tracked for cost display
      await this.usageLedger.settle(
        workspaceId,
        streamInfo,
        usage,
        providerMetadata,
        "Failed to record session usage on abort",
        "error"
      );

      // Stamp the aborted turn's usage onto the partial message BEFORE committing
      // it and delivering stream-abort. Analytics
      // prices history rows from metadata.usage, so without this every
      // interrupted turn — user Esc, queued tool-end preemption, monitor wakes —
      // would ingest as $0 even though the provider billed all completed steps.
      if (!abandonPartial && (usage !== undefined || streamInfo.toolModelUsages.length > 0)) {
        try {
          await this.partialJournal.awaitPending(streamInfo);
          const partialMessage = this.buildPartialAssistantMessage(streamInfo, {
            metadata: {
              ...(usage !== undefined ? { usage: cloneUsage(usage) } : {}),
              ...(providerMetadata !== undefined ? { providerMetadata } : {}),
              ...(contextUsage !== undefined ? { contextUsage } : {}),
              ...(contextProviderMetadata !== undefined ? { contextProviderMetadata } : {}),
              duration,
              ...(streamInfo.toolModelUsages.length > 0
                ? { toolModelUsages: streamInfo.toolModelUsages.map(clonePersistedToolModelUsage) }
                : {}),
            },
          });
          await this.partialJournal.writeAbortPartial(workspaceId as string, partialMessage);

          // Tool-only aborts (Esc while a tool is still running): commitPartial
          // refuses to commit partials whose only parts are input-available tool
          // calls, so the usage stamped above would die with the deleted
          // partial. Route that spend through the headless-usage sidecar
          // instead. Same predicate commitPartial applies, so exactly one of
          // {chat row, sidecar row} carries this turn's usage.
          if (!hasCommitWorthyParts(partialMessage.parts)) {
            await this.usageLedger.recordDroppedPartialUsage(
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
          await this.usageLedger.recordDroppedPartialUsage(
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
    } catch (error) {
      log.error("Failed abort bookkeeping; delivering preserved terminal metadata", { error });
    } finally {
      try {
        // Cancellation owns this attempt through disk cleanup and raw delivery. Keeping
        // the registration until then makes replacement startup join the same fence.
        const result = await this.partialJournal.settleAbort(
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
        await this.turnEvents.deliver(streamAbort);
      } catch (error) {
        log.error("Stream-abort delivery failed", { error: getErrorMessage(error) });
      } finally {
        if (this.workspaceStreams.get(workspaceId) === streamInfo) {
          this.workspaceStreams.delete(workspaceId);
        }
        streamInfo.terminalCompletion = {
          status: "aborted",
          abortReason,
          streamAbort,
          systemMessageTokens: streamInfo.initialMetadata?.systemMessageTokens,
        };
        // Session policy consumes this promise separately. It may start a replacement,
        // so neither this fence nor the raw sink may join that policy.
        streamInfo.completionController?.settle(streamInfo.terminalCompletion);
      }
    }
  }

  /**
   * A terminal path that recorded no usage (e.g. a completion with no parts) leaves no
   * in-flight file. An abort is not terminal yet here: cleanupAbortedStream settles it after
   * processing ends, and until then the file is its only durable record.
   */
  private async discardUnsettledSessionUsage(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    if (streamInfo.terminalCompletion != null) {
      await this.usageLedger.discardInFlight(workspaceId, streamInfo);
    }
  }

  private createStopWhenCondition(
    request: StopWhenRequest,
    stepTracker?: StepMessageTracker
  ): Array<ReturnType<typeof stepCountIs>> {
    const requiredPatterns = buildRequiredToolPatterns(request.toolPolicy);

    return [
      ({ steps }) => {
        if (steps.length < 100000) return false;
        request.stopCause ??= { kind: "step-limit" };
        return true;
      },
      // The SDK evaluates stop conditions only after every sibling tool result in the
      // model's current step settles. Do not move this to individual tool-call-end events:
      // that would abort the remaining calls the model emitted in the same batch.
      (options) => this.stopAfterSettledStep(request, stepTracker, requiredPatterns, options),
      (options) => {
        if (!hasSuccessfulRequiredToolResult(options, requiredPatterns)) return false;
        request.stopCause ??= { kind: "required-tool" };
        return true;
      },
    ];
  }

  /**
   * The settled-step stop condition: the step's context-budget decision first, then a
   * required-tool completion (handled by its own condition), then queued input.
   */
  private async stopAfterSettledStep(
    request: StopWhenRequest,
    stepTracker: StepMessageTracker | undefined,
    requiredPatterns: readonly RegExp[],
    options: StopConditionOptions
  ): Promise<boolean> {
    const { steps } = options;
    const step = steps.at(-1);
    const onStepSettled = request.onStepSettled;
    if (onStepSettled && step && !hasSuccessfulRequiredToolResult(options, requiredPatterns)) {
      // Budget stops are authoritative even when only a turn-end message is queued.
      if (await this.settleStepBudget(request, onStepSettled, stepTracker, steps, step))
        return true;
    }
    if (hasSuccessfulRequiredToolResult(options, requiredPatterns)) return false;
    const queuedInput = request.getQueuedInputStopCause?.();
    if (queuedInput != null) {
      request.stopCause ??= queuedInput;
      return true;
    }
    return request.hasQueuedMessages?.("tool-end") ?? false;
  }

  /**
   * Report a settled step to the session's budget callback, with its tool-result size and
   * the next request's estimate, and apply the decision. True means stop now.
   */
  private async settleStepBudget(
    request: StopWhenRequest,
    onStepSettled: OnStepSettled,
    stepTracker: StepMessageTracker | undefined,
    steps: StopConditionOptions["steps"],
    step: StopConditionStep
  ): Promise<boolean> {
    const outputs = step.toolResults.map((result) => result.output);
    const size = estimateToolResultSize(outputs);
    const toolResultTokens = await estimateToolResultTokensForModel(outputs, {
      model: request.modelString,
      metadataModel: request.budgetMetadataModel,
    });
    const nextRequestTokens = await estimateNextRequestTokens(request, stepTracker, steps, step);
    const outcome = await onStepSettled({
      model: request.modelString,
      usage: normalizeUsage(step.usage),
      providerMetadata: step.providerMetadata,
      ...size,
      toolResultTokens,
      ...(nextRequestTokens != null ? { nextRequestTokens } : {}),
      sessionHistoryAvailable: request.tools?.session_history != null,
      newContextAvailable: request.tools?.new_context != null,
      newContextRequested: step.toolResults.some(
        (result) => result.toolName === "new_context" && isSuccessfulToolOutput(result.output)
      ),
    });
    return applyContextBudgetDecision(request, outcome);
  }

  getPrefixSwapPreparation(workspaceId: string) {
    const info = this.workspaceStreams.get(workspaceId as WorkspaceId);
    if (!info) return null;
    const tools = info.request.tools ?? {};
    const deferLoadingToolNames = [...collectDeferLoadingToolNames(tools)];
    return {
      requestProviderOptions: info.request.providerOptions,
      systemPrefix: info.request.messages.filter((message) => message.role === "system"),
      cacheEnabled: info.request.cacheEnabled ?? false,
      preparation: {
        effectiveAgentId: info.initialMetadata?.agentId ?? "exec",
        // Same list as the turn's own transition: native deferred tools stay unlisted until loaded.
        toolNamesForSentinel:
          computeLoadedToolNames(info.request.toolSearchState)?.sort() ?? Object.keys(tools),
        effectiveThinkingLevel: ThinkingLevelSchema.parse(info.thinkingLevel ?? "off"),
        modelString: info.model,
        providerForMessages: info.metadataModel.split(":", 1)[0],
        anthropicCacheTtl: getAnthropicCacheTtl(info.request.providerOptions),
        ...(deferLoadingToolNames.length > 0 ? { deferLoadingToolNames } : {}),
      },
    };
  }

  setPrefixSwap(workspaceId: string, swap: ContinuousPrefixSwap): boolean {
    return this.providerRequest.setPrefixSwap(
      this.workspaceStreams.get(workspaceId as WorkspaceId),
      swap
    );
  }

  clearPrefixSwap(workspaceId: string): void {
    this.providerRequest.clearPrefixSwap(
      this.workspaceStreams.get(workspaceId as WorkspaceId)?.stepTracker
    );
  }

  getPrefixSwapState(workspaceId: string): "none" | "pending" | "consumed" | "invalidated" {
    return this.providerRequest.getPrefixSwapState(
      this.workspaceStreams.get(workspaceId as WorkspaceId)?.stepTracker
    );
  }

  /**
   * StepPreparation.createStreamResult. Kept as a method: whitebox tests replace it on
   * StreamManager with Reflect.set, and every caller goes through it.
   */
  private createStreamResult(
    request: StreamRequestConfig,
    abortController: AbortController,
    stepTracker?: StepMessageTracker
  ): Awaited<ReturnType<typeof streamText>> {
    return this.stepPreparation.createStreamResult(request, abortController, stepTracker);
  }

  /**
   * Complete a tool call by updating its part and emitting tool-call-end event.
   * CRITICAL: Flushes partial to disk BEFORE emitting event to prevent race conditions
   * where listeners (e.g., sendQueuedMessages) read stale partial data.
   */
  private async completeToolCall(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    toolCalls: ToolCallMap,
    toolCallId: string,
    toolName: string,
    output: unknown,
    providerExecuted?: boolean,
    modelOnlyNotifications?: string[]
  ): Promise<void> {
    // Find and update the existing tool part
    const existingPartIndex = streamInfo.parts.findIndex(
      (p) => p.type === "dynamic-tool" && p.toolCallId === toolCallId
    );
    const pendingAttachment = this.turnEvents.takePendingWorkflowRunAttachment(
      streamInfo,
      toolCallId
    );
    const mcpServer = streamInfo.executionScope
      ? this.toolCallDisplayRegistry.take(streamInfo.executionScope, toolCallId)
      : undefined;

    if (existingPartIndex !== -1) {
      const existingPart = streamInfo.parts[existingPartIndex];
      if (existingPart.type === "dynamic-tool") {
        streamInfo.parts[existingPartIndex] = {
          ...existingPart,
          ...(pendingAttachment != null ? { workflowRun: pendingAttachment } : {}),
          ...(mcpServer ? { mcpServer } : {}),
          state: "output-available" as const,
          output,
          // Set even when undefined: an earlier completion's notes must not outlive it (#6665).
          modelOnlyNotifications,
        };
      }
    } else {
      // Fallback: if the matching tool-call part is missing, still persist output so the UI
      // does not stay stuck in input-available. Input may be missing for provider-native tools.
      const toolCall = toolCalls.get(toolCallId);
      streamInfo.parts.push({
        type: "dynamic-tool" as const,
        toolCallId,
        toolName,
        state: "output-available" as const,
        input: toolCall?.input ?? null,
        output,
        ...modelOnlyNotificationsField(modelOnlyNotifications),
        ...(mcpServer ? { mcpServer } : {}),
        timestamp: nextPartTimestamp(streamInfo),
        ...(pendingAttachment != null ? { workflowRun: pendingAttachment } : {}),
      });
    }

    // CRITICAL: Flush partial to disk BEFORE emitting event
    // This ensures listeners (like sendQueuedMessages) see the tool result when they
    // read partial.json via commitPartial. Without this await, there's a race condition
    // where the partial is read before the tool result is written, causing "amnesia".
    await this.flushPartialWrite(workspaceId, streamInfo);
    if (pendingAttachment != null) {
      this.turnEvents.emitWorkflowRunAttachedFromAttachment({
        workspaceId,
        messageId: streamInfo.messageId,
        toolCallId,
        attachment: pendingAttachment,
      });
    }

    // Emit tool-call-end event (listeners can now safely read partial)
    const completionTimestamp = nextPartTimestamp(streamInfo);
    streamInfo.toolCompletionTimestamps ??= new Map();
    streamInfo.toolCompletionTimestamps.set(toolCallId, completionTimestamp);
    this.turnEvents.emitTurnEvent({
      type: "tool-call-end",
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      toolCallId,
      toolName,
      result: output,
      ...(mcpServer ? { mcpServer } : {}),
      ...(providerExecuted === true ? { providerExecuted: true } : {}),
      timestamp: completionTimestamp,
    } as ToolCallEndEvent);
  }

  private async finishToolCall(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    toolCalls: ToolCallMap,
    toolCallId: string,
    toolName: string,
    output: unknown,
    providerExecuted?: boolean,
    modelOnlyNotifications?: string[]
  ): Promise<void> {
    await this.completeToolCall(
      workspaceId,
      streamInfo,
      toolCalls,
      toolCallId,
      toolName,
      output,
      providerExecuted,
      modelOnlyNotifications
    );
    await this.turnRegistry.checkSoftCancelStream(workspaceId, streamInfo);
  }

  private logOrphanToolResult(
    workspaceLog: Logger,
    streamInfo: WorkspaceStreamInfo,
    part: { toolCallId: string; toolName: string },
    output: unknown,
    orphanCount: number,
    trackedToolCallCount: number
  ): void {
    if (orphanCount > MAX_ORPHAN_TOOL_RESULT_WARNINGS_PER_STREAM) {
      return;
    }

    workspaceLog.warn(
      "[streamManager] Received tool-result without matching tool-call map entry; persisting fallback output",
      {
        messageId: streamInfo.messageId,
        model: streamInfo.model,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        orphanCount,
        trackedToolCallCount,
        isWebSearch: part.toolName === "web_search",
        ...summarizeToolResultForLog(output),
      }
    );

    if (orphanCount === MAX_ORPHAN_TOOL_RESULT_WARNINGS_PER_STREAM) {
      workspaceLog.warn(
        "[streamManager] Suppressing additional orphan tool-result warnings for this stream",
        {
          messageId: streamInfo.messageId,
          model: streamInfo.model,
          suppressedAfter: orphanCount,
        }
      );
    }
  }

  /** Emit a PTC code_execution nested tool event (TurnEventEmitter.emitNestedToolEvent). */
  emitNestedToolEvent(scope: ExecutionScope, event: NestedToolEvent): void {
    this.turnEventEmitter.emitNestedToolEvent(scope, event);
  }

  private emitStreamStart(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    historySequence: number,
    options?: { replay?: boolean }
  ): void {
    this.turnEventEmitter.emitStreamStart(workspaceId, streamInfo, historySequence, options);
  }

  private buildPartialAssistantMessage(
    streamInfo: WorkspaceStreamInfo,
    options: { metadata?: Partial<MuxMetadata>; parts?: MuxMessage["parts"] } = {}
  ): MuxMessage {
    const canonicalModel = metadataModelIdentity(streamInfo.model);

    return {
      id: streamInfo.messageId,
      role: "assistant",
      metadata: {
        historySequence: streamInfo.historySequence,
        timestamp: streamInfo.startTime,
        ...streamInfo.initialMetadata,
        model: canonicalModel,
        metadataModel: streamInfo.metadataModel,
        ...(streamInfo.thinkingLevel && {
          thinkingLevel: streamInfo.thinkingLevel as ThinkingLevel,
        }),
        partial: true,
        ...options.metadata,
        stepStartPartIndices: streamInfo.stepStartIndices.filter(
          (index) => index < (options.parts ?? streamInfo.parts).length
        ),
      },
      parts: options.parts ?? streamInfo.parts,
    };
  }

  /** The attempt loop (AttemptLoop); TurnEngine and whitebox tests call it here. */
  private processStreamWithCleanup(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    historySequence: number
  ): Promise<void> {
    return this.attemptLoop.processStreamWithCleanup(workspaceId, streamInfo, historySequence);
  }

  private buildStreamErrorPayload(
    streamInfo: WorkspaceStreamInfo,
    error: unknown
  ): StreamErrorPayload & { errorType: StreamErrorType } {
    const messageId = streamInfo.messageId;
    const acpPromptId = streamInfo.initialMetadata?.acpPromptId;
    const selfClassified = getSelfClassifiedStreamError(error);
    if (selfClassified != null) {
      return { messageId, ...selfClassified, acpPromptId };
    }

    // For categorization, use the cause if available (preserves the original error structure)
    const actualError: unknown = error instanceof Error && error.cause ? error.cause : error;

    const contextBudget = getContextBudgetStreamError(actualError);
    if (contextBudget != null) {
      return { messageId, ...contextBudget, acpPromptId };
    }

    let errorType = categorizeError(actualError);

    // A matching rejection that reaches failure handling is final: the one-shot
    // repair (retryStreamWithoutReasoningReplay) already ran, or was
    // unsafe/no-op. Its generic `api` class is auto-retryable, and every outer
    // retry would resend the same rejected input, so classify it terminal.
    // Only this exact shape is reclassified; a later 503/401/429 keeps its own.
    if (this.getReasoningReplayRejection(error, streamInfo.request.model) != null) {
      errorType = "reasoning_rejected";
    }

    const described = describeProviderStreamError({
      // Extract error message (errors thrown from 'error' parts already have the correct message)
      // Apply prefix stripping to remove noisy "undefined: " prefixes from provider errors
      errorMessage: stripNoisyErrorPrefix(getErrorMessage(error)),
      errorType,
      actualError,
      model: streamInfo.model,
      // The route provider identifies whose config served the request. The
      // canonical model would misattribute gateway routes: openrouter:openai/x
      // canonicalizes to openai:x but never uses the openai base URL.
      routeProvider: streamInfo.initialMetadata?.routeProvider ?? "",
    });

    errorType = coerceStreamErrorTypeForMessage(described.errorType, described.errorMessage);
    // The AI SDK honors Retry-After only for its own short in-request retries; once they are
    // exhausted, Xum's auto-retry must not come back sooner than the provider asked.
    const retryAfterMs = errorType === "rate_limit" ? getProviderRetryAfterMs(actualError) : null;

    return {
      messageId,
      error: described.errorMessage,
      errorType,
      acpPromptId,
      ...(retryAfterMs != null ? { retryAfterMs } : {}),
    };
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
      await this.backfillReasoningTokensFromParts(streamInfo, cumulativeErrorUsage);
      cumulativeErrorProviderMetadata = markProviderMetadataCostsIncluded(
        streamInfo.cumulativeProviderMetadata
          ? { ...streamInfo.cumulativeProviderMetadata }
          : undefined,
        streamInfo.initialMetadata?.costsIncluded
      );
      await this.usageLedger.settle(
        workspaceId,
        streamInfo,
        cumulativeErrorUsage,
        cumulativeErrorProviderMetadata,
        "Failed to record session usage for errored stream",
        "warn"
      );
    } else {
      // Refusals recorded their own usage above: drop any in-flight copy.
      await this.usageLedger.discardInFlight(workspaceId, streamInfo);
    }
    const errorUsage = terminalRefusalUsage ?? cumulativeErrorUsage;
    const errorProviderMetadata =
      terminalRefusalProviderMetadata ?? cumulativeErrorProviderMetadata;

    const errorPartialMessage = this.buildPartialAssistantMessage(streamInfo, {
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
    await this.flushPartialWrite(workspaceId, streamInfo, errorPartialMessage);

    try {
      await this.usageLedger.recordDroppedPartialUsage(
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
    this.turnEvents.emitTurnEvent(createErrorEvent(workspaceId as string, payload));
    return payload;
  }

  private getOpenAIPreviousResponseId(
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

  private clearOpenAIPreviousResponseId(
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

  private recordStepStart(streamInfo: WorkspaceStreamInfo): void {
    const start = streamInfo.parts.length;
    // Retries may discard parts. Drop stale/duplicate starts before reseeding.
    streamInfo.stepStartIndices = streamInfo.stepStartIndices.filter((index) => index < start);
    streamInfo.stepStartIndices.push(start);
    streamInfo.currentStepStartIndex = start;
  }

  private async resetStreamStateForRetry(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    options?: { preserveParts?: boolean; preserveUsage?: boolean; workspaceLog?: Logger }
  ): Promise<void> {
    streamInfo.stepTracker.pendingPrefixSwap = undefined;
    // The next streamText call numbers its steps from 0 again.
    streamInfo.stepTracker.anthropicThinkingStripStep = undefined;
    streamInfo.streamStepOrdinals = [];
    const preserveParts = options?.preserveParts ?? false;
    const preserveUsage = options?.preserveUsage ?? false;

    await this.partialJournal.resetForRetry(streamInfo);

    if (!preserveParts) {
      streamInfo.parts = [];
    }
    if (!preserveParts) {
      streamInfo.reasoningBackfillStartIndex = undefined;
    }
    // A retried attempt starts with no open reasoning block.
    streamInfo.currentReasoningBlock = undefined;
    this.recordStepStart(streamInfo);
    streamInfo.receivedTerminalEvent = false;
    streamInfo.terminalFinishReason = undefined;
    streamInfo.terminalRawFinishReason = undefined;

    if (!preserveUsage) {
      await this.usageLedger.resetForRetry(workspaceId, streamInfo);
    }

    if (!preserveParts) {
      try {
        await this.partialJournal.deleteForRetry(workspaceId as string);
      } catch (deleteError) {
        const logger = options?.workspaceLog ?? this.getWorkspaceLogger(workspaceId, streamInfo);
        logger.warn("Failed to clear partial state before retry", { error: deleteError });
      }
    }
  }

  /**
   * Read-only eligibility check for recoveryPolicy: returns what a retry without
   * an invalid previousResponseId needs, or null when the error is not that case
   * or a retry here would duplicate output. Interrupts and the once-per-turn
   * budget belong to the policy.
   */
  private planPreviousResponseIdRetry(
    streamInfo: WorkspaceStreamInfo,
    error: unknown
  ): PreviousResponseIdRetryPlan | null {
    const hasParts = streamInfo.parts.length > 0;
    const currentStepStartIndex = streamInfo.currentStepStartIndex;
    // If the current step already emitted parts, retrying would duplicate output/tool calls.
    if (hasParts && currentStepStartIndex !== streamInfo.parts.length) {
      return null;
    }

    const lost = this.matchLostPreviousResponseId(
      error,
      this.getOpenAIPreviousResponseId(streamInfo.request.providerOptions)
    );
    if (lost == null) {
      return null;
    }

    const stepMessages = streamInfo.stepTracker.latestMessages;
    if (hasParts && !stepMessages) {
      return null;
    }

    const providerOptions = this.clearOpenAIPreviousResponseId(streamInfo.request.providerOptions);
    if (providerOptions === streamInfo.request.providerOptions) {
      return null;
    }

    return { hasParts, stepMessages, providerOptions, ...lost };
  }

  /**
   * Pure error check: the error says the request's previousResponseId is gone.
   * Returns the lost ID with the error's code and status for logging, or null.
   */
  private matchLostPreviousResponseId(
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

  /** Executes recoveryPolicy's dropPreviousResponseId retry with a plan from the check above. */
  private async retryStreamWithoutPreviousResponseId(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    error: unknown,
    plan: PreviousResponseIdRetryPlan
  ): Promise<void> {
    const { hasParts, previousResponseId, stepMessages, providerOptions, errorCode, statusCode } =
      plan;
    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
    this.providerRequest.recordLostResponseIdIfApplicable(
      workspaceId,
      error,
      streamInfo,
      workspaceLog
    );

    // Step-boundary retries restart the SDK stream, so totalUsage only reflects
    // the retried step. Track this to prefer cumulativeUsage at stream end.
    if (hasParts) {
      streamInfo.didRetryPreviousResponseIdAtStep = true;
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

    streamInfo.request = {
      ...streamInfo.request,
      ...(stepMessages ? { messages: stepMessages } : {}),
      providerOptions,
    };
    streamInfo.streamResult = this.createStreamResult(
      streamInfo.request,
      streamInfo.abortController,
      streamInfo.stepTracker
    );
  }

  // These deterministic rejections survive encrypted-only replay: cross-org
  // blobs and same-turn reasoning references from a flapping route. Keep the
  // match narrow so unrelated provider errors retain their normal retry policy.
  // Returns the providerOptions namespace whose replayed reasoning was rejected.
  private getReasoningReplayRejection(
    error: unknown,
    model: LanguageModel
  ): "openai" | "anthropic" | null {
    // The SDK can exhaust its own retries on a synthetic stream-error 500.
    // Classify only the final cause; earlier failures must not taint a later one.
    if (RetryError.isInstance(error)) {
      error = error.lastError;
    }
    const statusCode = extractStatusCode(error);
    // Gateways can drop the structured code and forward only the message.
    const texts = [
      APICallError.isInstance(error) ? error.responseBody : undefined,
      error instanceof Error ? error.message : undefined,
    ];
    const mentions = (pattern: RegExp) =>
      texts.some((text) => typeof text === "string" && pattern.test(text));
    if (isAnthropicMessagesModel(model)) {
      return statusCode === 400 && mentions(ANTHROPIC_THINKING_SIGNATURE_INVALID_PATTERN)
        ? "anthropic"
        : null;
    }
    // WebSocket/SSE validation errors have no HTTP failure status. The SDK
    // assigns 500 to code-less frames, including missing reasoning references.
    const isStreamError =
      StreamProviderError.isInstance(error) ||
      (APICallError.isInstance(error) &&
        error.responseHeaders?.["content-type"]?.startsWith("text/event-stream") &&
        typeof error.data === "object" &&
        error.data !== null &&
        "type" in error.data &&
        (error.data.type === "error" || error.data.type === "response.failed"));
    if (statusCode !== 400 && statusCode !== 404 && !(statusCode === 500 && isStreamError)) {
      return null;
    }
    if (!isOpenAIResponsesModel(model)) {
      return null;
    }
    return extractErrorCode(error) === "invalid_encrypted_content" ||
      mentions(OPENAI_REASONING_ITEM_NOT_FOUND_PATTERN) ||
      mentions(OPENAI_ENCRYPTED_CONTENT_UNVERIFIED_PATTERN)
      ? "openai"
      : null;
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
  private planReasoningReplayRetry(
    streamInfo: WorkspaceStreamInfo,
    error: unknown
  ): ReasoningReplayRetryPlan | null {
    const hasParts = streamInfo.parts.length > 0;
    // If the current step already emitted parts, retrying would duplicate output/tool calls.
    if (hasParts && streamInfo.currentStepStartIndex !== streamInfo.parts.length) {
      return null;
    }

    const rejectedNamespace = this.getReasoningReplayRejection(error, streamInfo.request.model);
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

  /** Executes recoveryPolicy's dropReasoningReplay retry with a plan from the check above. */
  private async retryStreamWithoutReasoningReplay(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    error: unknown,
    plan: ReasoningReplayRetryPlan
  ): Promise<void> {
    const { hasParts, rejectedNamespace, messages } = plan;
    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
    const errorCode = extractErrorCode(error);
    const statusCode = extractStatusCode(error);

    // Step-boundary retries restart the SDK stream, so totalUsage only reflects
    // the retried step. Track this to prefer cumulativeUsage at stream end.
    if (hasParts) {
      streamInfo.didRetryReasoningReplayAtStep = true;
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
      this.moveAnthropicThinkingReplayPoint(streamInfo, streamInfo.stepStartIndices.length - 1);
      await this.flushPartialWrite(workspaceId, streamInfo);
    }

    streamInfo.request = { ...streamInfo.request, messages };
    streamInfo.streamResult = this.createStreamResult(
      streamInfo.request,
      streamInfo.abortController,
      streamInfo.stepTracker
    );
  }

  /**
   * Converts errors to strongly-typed SendMessageError
   */
  private convertToSendMessageError(error: unknown): SendMessageError {
    // Check for specific AI SDK errors using type guards
    if (LoadAPIKeyError.isInstance(error)) {
      return {
        type: "api_key_not_found",
        provider: "anthropic", // We can infer this from LoadAPIKeyError context
      };
    }

    // Fallback for unknown errors
    const message = getErrorMessage(error);
    return { type: "unknown", raw: message };
  }

  /**
   * Starts a new stream for a workspace, automatically cancelling any existing stream
   *
   * Uses per-workspace mutex to prevent concurrent streams. The mutex ensures:
   * 1. Only one startStream can execute at a time per workspace
   * 2. Old stream fully exits before new stream starts
   * 3. No race conditions in stream registration or cleanup
   */
  async startStream(
    options: TurnExecutionOptions
  ): Promise<Result<TurnStreamHandle, SendMessageError>> {
    return this.turnEngine.start(options);
  }

  /**
   * Check if a previousResponseId has been marked as lost
   * Called by buildProviderOptions to filter out invalid IDs
   */
  public isResponseIdLost(responseId: string): boolean {
    return this.providerRequest.isResponseIdLost(responseId);
  }

  /**
   * Stops an active stream for a workspace
   * If soft is true, performs a soft interrupt (cancels at next block boundary)
   */
  async stopStream(workspaceId: string, options?: StopStreamOptions): Promise<Result<void>> {
    return this.turnRegistry.stopStream(workspaceId, options);
  }

  getStreamState(workspaceId: string): StreamState {
    return this.turnRegistry.getStreamState(workspaceId);
  }

  isStreaming(workspaceId: string): boolean {
    return this.turnRegistry.isStreaming(workspaceId);
  }

  getActiveStreams(): string[] {
    return this.turnRegistry.getActiveStreams();
  }

  async acquireStreamStartLock(workspaceId: string) {
    return this.turnRegistry.acquireStreamStartLock(workspaceId);
  }

  getStreamInfo(workspaceId: string, includeFinalizing = false): ActiveStreamInfo | undefined {
    return this.turnRegistry.getStreamInfo(workspaceId, includeFinalizing);
  }

  /**
   * Replay stream events
   * Emits the same events (stream-start, stream-delta, etc.) that would be emitted during live streaming
   * This allows replay to flow through the same event path as live streaming (no duplication)
   */
  async replayStream(workspaceId: string, opts?: { afterTimestamp?: number }): Promise<void> {
    if (this.mockStreamLifecycle) {
      await this.mockStreamLifecycle.replayStream(workspaceId, opts);
      return;
    }

    const typedWorkspaceId = workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);

    // Only replay if stream is actively running
    if (
      !streamInfo ||
      (streamInfo.state !== StreamState.STARTING && streamInfo.state !== StreamState.STREAMING)
    ) {
      return;
    }

    await this.turnEventEmitter.replayStream(workspaceId, streamInfo, opts);
  }
}
