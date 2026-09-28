import { AsyncLocalStorage } from "node:async_hooks";
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
import { isKnownOpenAIServiceTier } from "@/common/utils/tokens/serviceTierPricing";

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
 * - Untrusted text confinement: `EvaluationError` carries class identity,
 *   `statusCode` and, for a received response, its sanitized usage only; SDK
 *   messages and response bodies are dropped at classification.
 */

/**
 * The billing of a response the provider returned (and charged for) before it
 * was rejected: exactly the sanitized fields the success path records, never
 * answers or text. Provider token counts come from the billing envelope, which
 * does not depend on the answer content that failed validation (#4728).
 */
export type EvaluationBilledUsage = Pick<
  EvaluationCallResult<EvaluationQuestions>,
  "usage" | "usageProviderMetadata"
>;

/** Typed failure of `EvaluationService.evaluate`; no free-text fields by design. */
export class EvaluationError extends Data.TaggedError("EvaluationError")<{
  readonly reason: EvaluationErrorReason;
  readonly code: EvaluationErrorCode;
  /** HTTP status from `APICallError`, when the provider answered at all. */
  readonly statusCode?: number;
  /** Present when a provider response was received (and billed) before the rejection. */
  readonly billedUsage?: EvaluationBilledUsage;
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
 * provider-metadata paths it reads. Only finite numbers, booleans and known service-tier values are kept
 * so provider text can never ride along into persisted usage records.
 */
const USAGE_PROVIDER_METADATA_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["cacheCreationInputTokens"],
  openai: ["reasoningTokens", "serviceTier"],
  mux: ["costsIncluded"],
  xai: ["costInUsdTicks"],
};

function projectUsageProviderMetadata(
  metadata: SharedV4ProviderMetadata | undefined
): JSONValue | null {
  if (metadata == null) {
    return null;
  }
  const projected: Record<string, Record<string, number | boolean | string>> = {};
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
      // `serviceTier` is the one string kept: only a known enum value, never provider text (#4352).
      const kept =
        key === "serviceTier"
          ? isKnownOpenAIServiceTier(value)
            ? value
            : undefined
          : isTokenCount(value) || typeof value === "boolean"
            ? value
            : undefined;
      if (kept !== undefined) {
        (projected[namespace] ??= {})[key] = kept;
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

/** The one projection of provider billing, shared by success and rejection paths. */
function projectBilledUsage(
  usage:
    | { inputTokens?: number | undefined; outputTokens?: number | undefined; totalTokens?: number }
    | undefined,
  providerMetadata: SharedV4ProviderMetadata | undefined
): EvaluationBilledUsage {
  const inputTokens = projectTokenCount(usage?.inputTokens);
  const outputTokens = projectTokenCount(usage?.outputTokens);
  // The SDK computes a total only for answers it accepted; for a rejected
  // response derive it, and only when both counts are known.
  // The sum goes through the same projection, so an overflow past a safe integer is unknown.
  const derivedTotal =
    inputTokens !== null && outputTokens !== null
      ? projectTokenCount(inputTokens + outputTokens)
      : null;
  return {
    usage: {
      inputTokens,
      outputTokens,
      totalTokens:
        usage?.totalTokens !== undefined ? projectTokenCount(usage.totalTokens) : derivedTotal,
    },
    usageProviderMetadata: projectUsageProviderMetadata(providerMetadata),
  };
}

/** Billing of the provider response the current `evaluate()` call received, if any. */
interface BillingScope {
  billed?: EvaluationBilledUsage;
}

const billingScope = new AsyncLocalStorage<BillingScope>();
const INNER_BILLING_CAPTURE = Symbol("xum.evaluationInnerBillingCapture");

/**
 * provider-utils' `EvaluationLanguageModel` (behind the OpenAI, Anthropic and
 * Google `.evaluationModel()`) validates answers inside `doEvaluate` and throws
 * before returning usage, so a billed response it rejects would never reach the
 * ledger (#4728). It keeps the wrapped LanguageModelV4 on `model`, an SDK
 * internal pinned by a contract test. Wrap that instance's `doGenerate` once;
 * each call reports its usage to the `evaluate()` scope it runs in
 * (AsyncLocalStorage, because pinned models are shared across concurrent calls).
 * Models without the field (TypeSafe, mocks, a future SDK) are left alone.
 * Exported for wrappers that hide the field (withAnthropicEvaluationEffort):
 * they install it on the model they wrap.
 */
export function installInnerBillingCapture(model: EvaluationModelInstance): void {
  const inner: unknown = (model as { model?: unknown }).model;
  if (inner === null || typeof inner !== "object") {
    return;
  }
  const target = inner as { doGenerate?: unknown; [INNER_BILLING_CAPTURE]?: true };
  if (target[INNER_BILLING_CAPTURE] === true || typeof target.doGenerate !== "function") {
    return;
  }
  const doGenerate = target.doGenerate as (options: unknown) => PromiseLike<{
    usage?: { inputTokens?: { total?: number }; outputTokens?: { total?: number } };
    providerMetadata?: SharedV4ProviderMetadata;
  }>;
  target.doGenerate = async (options: unknown) => {
    const result = await doGenerate.call(inner, options);
    const scope = billingScope.getStore();
    if (scope !== undefined) {
      // Same mapping as the adapter's own success return (`usage.*.total`).
      const usage = result.usage;
      scope.billed = projectBilledUsage(
        { inputTokens: usage?.inputTokens?.total, outputTokens: usage?.outputTokens?.total },
        result.providerMetadata
      );
    }
    return result;
  };
  target[INNER_BILLING_CAPTURE] = true;
}

/**
 * Per-call view of the model that records what `doEvaluate` returned, so the
 * SDK's own answer validation (which throws after this returns) cannot drop it.
 */
function withBillingCapture(
  model: EvaluationModelInstance,
  scope: BillingScope
): EvaluationModelInstance {
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedQuestionTypes: model.supportedQuestionTypes,
    doEvaluate: async (options) => {
      const result = await model.doEvaluate(options);
      scope.billed = projectBilledUsage(result.usage, result.providerMetadata);
      return result;
    },
  };
}

/** One call's billing capture: evaluate with `model` inside `run`, then read `billed`. */
export interface EvaluationBillingCapture {
  readonly model: EvaluationModelInstance;
  run<T>(fn: () => T): T;
  /** Billing of the response this call received, if any; set even when the answer was rejected. */
  readonly billed: EvaluationBilledUsage | undefined;
}

/**
 * Both captures (#4728) for one call. Exported for callers that need the raw SDK
 * result instead of `evaluate()`'s projection: auto model routing reads TypeSafe
 * confidence and choice probabilities, and still bills rejected answers (#4774).
 */
export function createEvaluationBillingCapture(
  model: EvaluationModelInstance
): EvaluationBillingCapture {
  installInnerBillingCapture(model);
  const scope: BillingScope = {};
  return {
    model: withBillingCapture(model, scope),
    run: (fn) => billingScope.run(scope, fn),
    get billed() {
      return scope.billed;
    },
  };
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

/**
 * Upper bound for the provider-reported model id kept in results. It is
 * untrusted display metadata (rendered React-escaped, never model-facing), so
 * the only hazard is unbounded growth of persisted records; real ids are short.
 */
const MAX_RESPONSE_MODEL_ID_LENGTH = 200;

/**
 * Bound the provider-reported response model id. A missing, empty or
 * non-string value falls back to the id we asked for, and an oversized one is
 * truncated: display metadata must never fail an already-billed evaluation.
 */
function projectResponseModelId(reported: unknown, requested: string): string {
  const candidate = typeof reported === "string" && reported.length > 0 ? reported : requested;
  return candidate.length > MAX_RESPONSE_MODEL_ID_LENGTH
    ? candidate.slice(0, MAX_RESPONSE_MODEL_ID_LENGTH)
    : candidate;
}

export function makeEvaluationService(): EvaluationService {
  return {
    evaluate: <const Q extends EvaluationQuestions>(call: EvaluationCall<Q>) =>
      Effect.gen(function* () {
        const capture = createEvaluationBillingCapture(call.model);
        const result = yield* Effect.tryPromise({
          // The fiber's own signal is handed to the SDK, so interrupting the
          // effect aborts the in-flight provider request; the resulting
          // rejection is discarded by the runtime as interruption, not mapped
          // into an EvaluationError.
          try: (signal) => {
            // experimental_evaluate logs provider warnings unless this global is false, and a
            // warning can echo the evaluated state. Set it here instead of relying on
            // streamManager having been imported first (#4363).
            globalThis.AI_SDK_LOG_WARNINGS = false;
            return capture.run(() =>
              experimental_evaluate({
                model: capture.model,
                state: call.state,
                questions: call.questions,
                providerOptions: call.providerOptions,
                abortSignal: signal,
                maxRetries: 0,
              })
            );
          },
          // A response received before the throw was billed; keep its usage.
          catch: (error) => {
            const classified = classifyEvaluationError(error);
            const billed = capture.billed;
            return billed === undefined
              ? classified
              : new EvaluationError({
                  reason: classified.reason,
                  code: classified.code,
                  ...(classified.statusCode !== undefined
                    ? { statusCode: classified.statusCode }
                    : {}),
                  billedUsage: billed,
                });
          },
        });
        const billed = projectBilledUsage(result.usage, result.providerMetadata);

        // Provider-reported rounding is untrusted output too: parse it into the
        // bounded shape first so a non-object or extra fields can neither reach
        // the validator nor be forwarded into persisted results.
        const rounding = projectRounding(result.rounding);
        if (rounding === undefined) {
          return yield* new EvaluationError({
            reason: "invalid-output",
            code: "answer-validation",
            billedUsage: billed,
          });
        }

        // Second, independent validation so answers are guaranteed to match
        // the questions we asked even if the SDK's own checks change.
        const validated = validateAnswersAgainstQuestions(call.questions, result.answers, rounding);
        if (!validated.ok) {
          return yield* new EvaluationError({
            reason: "invalid-output",
            code: "answer-validation",
            billedUsage: billed,
          });
        }

        return {
          answers: validated.answers,
          rounding,
          ...billed,
          responseModelId: projectResponseModelId(result.response.modelId, call.model.modelId),
          warningsCount: result.warnings.length,
        } satisfies EvaluationCallResult<Q>;
      }),
  };
}
