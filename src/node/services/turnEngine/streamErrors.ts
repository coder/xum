/**
 * Stream error classification: the stream failures the attempt loop raises
 * itself (an empty stream, a terminal refusal and a truncated stream), the
 * stream error type and user-facing message of every other failure
 * (buildStreamErrorPayload), and the reasoning-replay rejections that
 * recoveryPolicy repairs once.
 */
import {
  APICallError,
  LoadAPIKeyError,
  RetryError,
  StreamProviderError,
  type LanguageModel,
} from "ai";
import type { SendMessageError, StreamErrorType } from "@/common/types/errors";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { getErrorMessage } from "@/common/utils/errors";
import { classify429Capacity } from "@/common/utils/errors/classify429Capacity";
import {
  ContextBudgetBlockedError,
  ContextBudgetExceededError,
} from "@/node/services/contextBudgetError";
import {
  extractErrorCode,
  extractPreviousResponseIdFromError,
  extractStatusCode,
} from "@/node/services/turnEngine/providerWire";
import { isAnthropicMessagesModel } from "@/node/services/turnEngine/StepPreparation";
import type { WorkspaceStreamInfo } from "@/node/services/turnEngine/types";
import { getOpenAIResponsesBaseUrlHint } from "@/node/services/utils/openAIResponsesBaseUrlHint";
import {
  coerceStreamErrorTypeForMessage,
  stripNoisyErrorPrefix,
  type StreamErrorPayload,
} from "@/node/services/utils/sendMessageError";
import { nodeClock } from "@/node/utils/hostClock";

const EMPTY_STREAM_OUTPUT_ERROR_MESSAGE =
  "The model ended the stream before producing any assistant-visible output. This usually means the upstream stream was dropped rather than completed normally. Xum will retry automatically when possible, and if retries keep failing you should try again or switch models.";

const STREAM_TRUNCATED_MESSAGE_SUFFIX =
  "stream closed unexpectedly before the response completed. Xum will retry automatically when possible, and if retries keep failing you should try again or switch models.";

export class EmptyStreamOutputError extends Error {
  constructor() {
    super(EMPTY_STREAM_OUTPUT_ERROR_MESSAGE);
    this.name = "EmptyStreamOutputError";
  }
}

/**
 * Terminal provider refusal: the model declined to continue the turn. Unlike
 * EmptyStreamOutputError (a transport drop), retrying the same request will
 * likely refuse again, so this maps to the non-retryable "model_refusal" stream
 * error type.
 */
export class ModelRefusalError extends Error {
  constructor(model: string, finishReason: string, fallbackNote?: string) {
    super(
      `The model refused to continue (finishReason: ${finishReason}): ${model}. ` +
        "Retrying the same request is unlikely to help; try rephrasing or a different model." +
        (fallbackNote ? ` ${fallbackNote}` : "")
    );
    this.name = "ModelRefusalError";
  }
}

export class StreamTruncatedError extends Error {
  readonly providerDisplayName: string;

  constructor(providerDisplayName: string) {
    super(`${providerDisplayName} ${STREAM_TRUNCATED_MESSAGE_SUFFIX}`);
    this.name = "StreamTruncatedError";
    this.providerDisplayName = providerDisplayName;
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

function isAPICallModelNotFound(error: APICallError): boolean {
  if (!hasErrorType(error.data)) return false;
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
  if (!hasErrorType(error)) return null;
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

/** `{ error: { code, type } }`, the error body shape of the OpenAI and Anthropic APIs. */
function hasErrorType(data: unknown): data is { error: { code?: string; type?: string } } {
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

// These deterministic rejections survive encrypted-only replay: cross-org
// blobs and same-turn reasoning references from a flapping route. Keep the
// match narrow so unrelated provider errors retain their normal retry policy.
// Returns the providerOptions namespace whose replayed reasoning was rejected.
export function getReasoningReplayRejection(
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

export function buildStreamErrorPayload(
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
  if (getReasoningReplayRejection(error, streamInfo.request.model) != null) {
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
 * Converts errors to strongly-typed SendMessageError
 */
export function convertToSendMessageError(error: unknown): SendMessageError {
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
