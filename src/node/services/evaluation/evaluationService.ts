import { Data, Effect } from "effect";
import {
  APICallError,
  Experimental_EvaluationUnsupportedQuestionTypeError,
  InvalidArgumentError,
  InvalidResponseDataError,
  JSONParseError,
  TypeValidationError,
  experimental_evaluate,
} from "ai";
import type {
  Experimental_EvaluationModelV4,
  JSONValue,
  SharedV4ProviderMetadata,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import {
  EvaluationRoundingSchema,
  validateAnswersAgainstQuestions,
  type EvaluationAnswers,
  type EvaluationErrorCode,
  type EvaluationErrorReason,
  type EvaluationQuestions,
  type EvaluationRounding,
  type EvaluationState,
} from "@/common/types/evaluation";

/**
 * Effect service around AI SDK `experimental_evaluate` for the workflow
 * `evaluate()` primitive.
 *
 * This is the ONLY module that imports the experimental evaluation exports
 * from `ai`, so an SDK rename touches one file. The service is deliberately
 * narrow: it takes an already-resolved evaluation model instance plus state and
 * questions and returns validated answers with bounded metadata. Model
 * selection, admission, journaling and usage recording belong to the workflow
 * adapter/runner — the service never reads Settings and never records usage.
 *
 * Contract:
 * - Errors are never answers: only answers that pass
 *   `validateAnswersAgainstQuestions` are returned.
 * - Interruption is not failure: aborting the running fiber propagates as
 *   Effect interruption, never as an `EvaluationError`.
 * - No SDK-internal retries (`maxRetries: 0`): every billable call is one
 *   visible attempt owned by the caller's retry policy.
 * - Untrusted text confinement: `EvaluationError` carries class identity and
 *   `statusCode` only; SDK messages and response bodies are dropped at
 *   classification.
 */

/** Typed failure of `EvaluationService.evaluate`; no free-text fields by design. */
export class EvaluationError extends Data.TaggedError("EvaluationError")<{
  readonly reason: EvaluationErrorReason;
  readonly code: EvaluationErrorCode;
  /** HTTP status from `APICallError`, when the provider answered at all. */
  readonly statusCode?: number;
}> {}

export type EvaluationModelInstance = Experimental_EvaluationModelV4;

export interface EvaluationCall<Q extends EvaluationQuestions> {
  readonly model: EvaluationModelInstance;
  readonly state: EvaluationState;
  readonly questions: Q;
  readonly providerOptions?: SharedV4ProviderOptions;
}

export interface EvaluationCallResult<Q extends EvaluationQuestions> {
  /** Validated against `questions` (exact id set, types, memberships, distributions). */
  readonly answers: EvaluationAnswers<Q>;
  readonly rounding: EvaluationRounding | null;
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly totalTokens: number | null;
  };
  /**
   * Only the provider-namespaced usage/cache keys `createDisplayUsage` reads
   * (see USAGE_PROVIDER_METADATA_ALLOWLIST); everything else the provider
   * attached is dropped.
   */
  readonly usageProviderMetadata: JSONValue | null;
  readonly responseModelId: string;
  readonly warningsCount: number;
}

/**
 * DI: tag `Evaluation` in `di/tags.ts`, layer `EvaluationLive` in
 * `di/layers/core.ts` (repo convention: one tag/layer file each).
 */
export interface EvaluationService {
  readonly evaluate: <const Q extends EvaluationQuestions>(
    call: EvaluationCall<Q>
  ) => Effect.Effect<EvaluationCallResult<Q>, EvaluationError>;
}

/**
 * Audit of `createDisplayUsage` (src/common/utils/tokens/displayUsage.ts): the
 * provider-metadata paths it reads. Only finite numbers and booleans are kept
 * so provider text can never ride along into persisted usage records.
 */
const USAGE_PROVIDER_METADATA_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["cacheCreationInputTokens"],
  openai: ["reasoningTokens"],
  mux: ["costsIncluded"],
  xai: ["costInUsdTicks"],
};

function projectUsageProviderMetadata(
  metadata: SharedV4ProviderMetadata | undefined
): JSONValue | null {
  if (metadata == null) {
    return null;
  }
  const projected: Record<string, Record<string, number | boolean>> = {};
  for (const [namespace, keys] of Object.entries(USAGE_PROVIDER_METADATA_ALLOWLIST)) {
    const namespaceValue: unknown = metadata[namespace];
    if (namespaceValue == null || typeof namespaceValue !== "object") {
      continue;
    }
    for (const key of keys) {
      const value: unknown = (namespaceValue as Record<string, unknown>)[key];
      // Token counts must be whole and non-negative; `createDisplayUsage` does
      // not re-check them, so a malformed provider/proxy value is dropped here
      // rather than becoming a negative cache/reasoning count downstream.
      if (isTokenCount(value) || typeof value === "boolean") {
        (projected[namespace] ??= {})[key] = value;
      }
    }
  }
  return Object.keys(projected).length > 0 ? projected : null;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Usage is accounting metadata, not an answer: a malformed count (negative,
 * fractional, NaN) must not fail an otherwise valid, already-billed
 * evaluation. It is reported as unknown (`null`) instead, which the ledger
 * shows as unknown cost rather than $0 — the same contract as an absent count.
 */
function projectTokenCount(value: number | undefined): number | null {
  return isTokenCount(value) ? value : null;
}

/**
 * Map an SDK/provider throwable to class identity. Uses the SDK's marker-based
 * `isInstance` checks (never `instanceof`, which breaks across bundled copies).
 * Nothing but the class and `statusCode` survives: the message, `responseBody`,
 * `cause`, request values and `data` payloads are dropped here.
 */
export function classifyEvaluationError(error: unknown): EvaluationError {
  if (Experimental_EvaluationUnsupportedQuestionTypeError.isInstance(error)) {
    return new EvaluationError({ reason: "unsupported", code: "unsupported-question-type" });
  }
  if (InvalidArgumentError.isInstance(error)) {
    return new EvaluationError({ reason: "invalid-input", code: "invalid-argument" });
  }
  if (InvalidResponseDataError.isInstance(error)) {
    return new EvaluationError({ reason: "invalid-output", code: "invalid-response" });
  }
  if (TypeValidationError.isInstance(error)) {
    return new EvaluationError({ reason: "invalid-output", code: "type-validation" });
  }
  if (JSONParseError.isInstance(error)) {
    return new EvaluationError({ reason: "invalid-output", code: "json-parse" });
  }
  if (APICallError.isInstance(error)) {
    return new EvaluationError({
      reason: "provider-failure",
      code: "api-call",
      ...(typeof error.statusCode === "number" ? { statusCode: error.statusCode } : {}),
    });
  }
  return new EvaluationError({ reason: "provider-failure", code: "unknown" });
}

/**
 * `null` when the provider reported full precision, the validated
 * `{ probabilityDecimals?, scoreDecimals? }` projection otherwise, and
 * `undefined` when the value is not a well-formed rounding object.
 */
function projectRounding(raw: unknown): EvaluationRounding | null | undefined {
  if (raw === undefined || raw === null) {
    return null;
  }
  const parsed = EvaluationRoundingSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const rounding: EvaluationRounding = {};
  if (parsed.data.probabilityDecimals !== undefined) {
    rounding.probabilityDecimals = parsed.data.probabilityDecimals;
  }
  if (parsed.data.scoreDecimals !== undefined) {
    rounding.scoreDecimals = parsed.data.scoreDecimals;
  }
  return rounding;
}

export function makeEvaluationService(): EvaluationService {
  return {
    evaluate: <const Q extends EvaluationQuestions>(call: EvaluationCall<Q>) =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          // The fiber's own signal is handed to the SDK, so interrupting the
          // effect aborts the in-flight provider request; the resulting
          // rejection is discarded by the runtime as interruption, not mapped
          // into an EvaluationError.
          try: (signal) =>
            experimental_evaluate({
              model: call.model,
              state: call.state,
              questions: call.questions,
              providerOptions: call.providerOptions,
              abortSignal: signal,
              maxRetries: 0,
            }),
          catch: classifyEvaluationError,
        });

        // Provider-reported rounding is untrusted output too: parse it into the
        // bounded shape first so a non-object or extra fields can neither reach
        // the validator nor be forwarded into persisted results.
        const rounding = projectRounding(result.rounding);
        if (rounding === undefined) {
          return yield* new EvaluationError({
            reason: "invalid-output",
            code: "answer-validation",
          });
        }

        // Second, independent validation so answers are guaranteed to match
        // the questions we asked even if the SDK's own checks change.
        const validated = validateAnswersAgainstQuestions(call.questions, result.answers, rounding);
        if (!validated.ok) {
          return yield* new EvaluationError({
            reason: "invalid-output",
            code: "answer-validation",
          });
        }

        return {
          answers: validated.answers,
          rounding,
          usage: {
            inputTokens: projectTokenCount(result.usage.inputTokens),
            outputTokens: projectTokenCount(result.usage.outputTokens),
            totalTokens: projectTokenCount(result.usage.totalTokens),
          },
          usageProviderMetadata: projectUsageProviderMetadata(result.providerMetadata),
          responseModelId: result.response.modelId,
          warningsCount: result.warnings.length,
        } satisfies EvaluationCallResult<Q>;
      }),
  };
}
