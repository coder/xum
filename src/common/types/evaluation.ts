import { z } from "zod";
import {
  EVALUATION_CHOICE_MAX_OPTIONS,
  EVALUATION_CHOICE_MIN_OPTIONS,
  EVALUATION_MAX_DEPTH,
  EVALUATION_MAX_QUESTIONS,
  EVALUATION_MAX_REQUEST_BYTES,
  EVALUATION_SCORE_MAX_LEVELS,
  EVALUATION_SCORE_MIN_LEVELS,
} from "@/constants/evaluation";
import { stableStringify } from "@/common/utils/stableStringify";

/**
 * Shared shapes for the workflow `evaluate()` primitive: the question/answer
 * contract of AI SDK `experimental_evaluate` (choice | score | boolean) plus the
 * pure, question-aware answer validator that guards both fresh provider output
 * and replayed step results.
 *
 * Crypto-free on purpose so browser bundles (Settings, timeline) can import the
 * schemas and validator; hashing lives in
 * `src/node/services/evaluation/evaluationDigest.ts`.
 */

// ---------------------------------------------------------------------------
// JSON inputs
// ---------------------------------------------------------------------------

export type EvaluationJsonValue =
  | string
  | number
  | boolean
  | null
  | EvaluationJsonValue[]
  | { [key: string]: EvaluationJsonValue };

export const EvaluationJsonValueSchema: z.ZodType<EvaluationJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(EvaluationJsonValueSchema),
    z.record(z.string(), EvaluationJsonValueSchema),
  ])
);

/**
 * Shared state and structured instructions: string | JSON object | JSON array.
 * Bare numbers, booleans and null are rejected (mirrors the SDK's
 * `EvaluationModelV4Input`), so a sandbox passing `evaluate(42, …)` fails as
 * invalid input instead of becoming a billable request.
 */
export const EvaluationInputSchema = z.union([
  z.string(),
  z.array(EvaluationJsonValueSchema),
  z.record(z.string(), EvaluationJsonValueSchema),
]);
export type EvaluationInput = z.infer<typeof EvaluationInputSchema>;

export const EvaluationStateSchema = EvaluationInputSchema;
export type EvaluationState = z.infer<typeof EvaluationStateSchema>;

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

const CriteriaDescriptionSchema = EvaluationInputSchema.nullable();

export const EvaluationChoiceQuestionSchema = z.strictObject({
  type: z.literal("choice"),
  instructions: EvaluationInputSchema,
  criteria: z.record(z.string().min(1), CriteriaDescriptionSchema).refine((criteria) => {
    const count = Object.keys(criteria).length;
    return count >= EVALUATION_CHOICE_MIN_OPTIONS && count <= EVALUATION_CHOICE_MAX_OPTIONS;
  }, `choice criteria must contain between ${EVALUATION_CHOICE_MIN_OPTIONS} and ${EVALUATION_CHOICE_MAX_OPTIONS} options`),
});

export const EvaluationScoreQuestionSchema = z.strictObject({
  type: z.literal("score"),
  instructions: EvaluationInputSchema,
  criteria: z
    .array(CriteriaDescriptionSchema)
    .min(EVALUATION_SCORE_MIN_LEVELS)
    .max(EVALUATION_SCORE_MAX_LEVELS),
});

export const EvaluationBooleanQuestionSchema = z.strictObject({
  type: z.literal("boolean"),
  instructions: EvaluationInputSchema,
  criteria: z
    .strictObject({
      true: CriteriaDescriptionSchema.optional(),
      false: CriteriaDescriptionSchema.optional(),
    })
    .optional(),
});

export const EvaluationQuestionSchema = z.discriminatedUnion("type", [
  EvaluationChoiceQuestionSchema,
  EvaluationScoreQuestionSchema,
  EvaluationBooleanQuestionSchema,
]);
export type EvaluationQuestion = z.infer<typeof EvaluationQuestionSchema>;

/** Question map keyed by stable question ids (1–EVALUATION_MAX_QUESTIONS entries). */
export const EvaluationQuestionsSchema = z
  .record(z.string().min(1), EvaluationQuestionSchema)
  .refine((questions) => {
    const count = Object.keys(questions).length;
    return count >= 1 && count <= EVALUATION_MAX_QUESTIONS;
  }, `questions must contain between 1 and ${EVALUATION_MAX_QUESTIONS} entries`);
export type EvaluationQuestions = Readonly<Record<string, EvaluationQuestion>>;

/** Provider-namespaced options passed through to the SDK (`providerOptions`). */
export const EvaluationProviderOptionsSchema = z.record(
  z.string(),
  z.record(z.string(), EvaluationJsonValueSchema)
);
export type EvaluationProviderOptions = z.infer<typeof EvaluationProviderOptionsSchema>;

/**
 * The sandbox-facing `evaluate(state, spec)` options (consumed by the workflow
 * runner in a later layer). `timeoutMs` is clamped by the host, not here.
 */
export const WorkflowEvaluateSpecSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .refine((id) => id.trim().length > 0, "id must be a non-blank step id"),
  title: z.string().optional(),
  model: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  questions: EvaluationQuestionsSchema,
  providerOptions: EvaluationProviderOptionsSchema.optional(),
});
export type WorkflowEvaluateSpec = z.infer<typeof WorkflowEvaluateSpecSchema>;

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

const ProbabilitySchema = z.number().min(0).max(1);
const DistributionSchema = z.record(z.string(), ProbabilitySchema);

export const EvaluationAnswerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: DistributionSchema.optional(),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    probabilities: DistributionSchema.optional(),
  }),
  z.object({
    type: z.literal("boolean"),
    probability: ProbabilitySchema,
  }),
]);
export type EvaluationAnswer = z.infer<typeof EvaluationAnswerSchema>;

export const EvaluationAnswersSchema = z.record(z.string(), EvaluationAnswerSchema);

/** Question-aware answer type: choices are narrowed to the question's option names. */
export type EvaluationAnswerFor<Q extends EvaluationQuestion> = Q extends {
  type: "choice";
  criteria: infer CRITERIA;
}
  ? {
      readonly type: "choice";
      readonly choice: Extract<keyof CRITERIA, string>;
      readonly probabilities?: Readonly<Record<Extract<keyof CRITERIA, string>, number>>;
    }
  : Q extends { type: "score" }
    ? {
        readonly type: "score";
        readonly score: number;
        readonly probabilities?: Readonly<Record<string, number>>;
      }
    : { readonly type: "boolean"; readonly probability: number };

export type EvaluationAnswers<Q extends EvaluationQuestions> = {
  readonly [ID in keyof Q]: EvaluationAnswerFor<Q[ID]>;
};

/** Decimal places the provider rounded to; `null` when it reports full precision. */
export const EvaluationRoundingSchema = z.object({
  probabilityDecimals: z.number().int().min(0).max(15).optional(),
  scoreDecimals: z.number().int().min(0).max(15).optional(),
});
export type EvaluationRounding = z.infer<typeof EvaluationRoundingSchema>;

// ---------------------------------------------------------------------------
// Persisted step shapes (consumed by the workflow runner in a later layer)
// ---------------------------------------------------------------------------

const NullableTokenCountSchema = z.number().int().nonnegative().nullable();

export const EvaluationStepResultSchema = z.object({
  answers: EvaluationAnswersSchema,
  rounding: EvaluationRoundingSchema.nullable(),
  model: z.object({
    modelString: z.string(),
    responseModelId: z.string(),
  }),
  usage: z.object({
    inputTokens: NullableTokenCountSchema,
    outputTokens: NullableTokenCountSchema,
    totalTokens: NullableTokenCountSchema,
  }),
  state: z.object({
    sha256: z.string(),
    bytes: z.number().int().nonnegative(),
  }),
});
export type EvaluationStepResult = z.infer<typeof EvaluationStepResultSchema>;

/** What the runner admits before dispatching one billable attempt. */
export const EvaluationAdmissionSchema = z.object({
  attempt: z.number().int().positive(),
  selection: z.object({
    modelString: z.string(),
    effectiveModelString: z.string(),
    wireProviderName: z.string(),
    routeKind: z.literal("direct"),
    configFingerprint: z.string(),
  }),
  timeoutMs: z.number().int().positive(),
  attemptDeadlineAt: z.string().datetime({ offset: true }),
  providerOptions: EvaluationProviderOptionsSchema.optional(),
  stateSha256: z.string(),
  stateBytes: z.number().int().nonnegative(),
  questionsSha256: z.string(),
  questionCount: z.number().int().positive(),
});
export type EvaluationAdmission = z.infer<typeof EvaluationAdmissionSchema>;

// ---------------------------------------------------------------------------
// Error identity (finite allowlists; never free text)
// ---------------------------------------------------------------------------

export const EvaluationErrorReasonSchema = z.enum([
  "invalid-input",
  "unsupported",
  "invalid-output",
  "provider-failure",
]);
export type EvaluationErrorReason = z.infer<typeof EvaluationErrorReasonSchema>;

export const EvaluationErrorCodeSchema = z.enum([
  "unsupported-question-type",
  "invalid-argument",
  "invalid-response",
  "type-validation",
  "json-parse",
  "answer-validation",
  "api-call",
  "unknown",
]);
export type EvaluationErrorCode = z.infer<typeof EvaluationErrorCodeSchema>;

// ---------------------------------------------------------------------------
// Question-aware answer validation
// ---------------------------------------------------------------------------

export type EvaluationAnswerViolation =
  | "answers-not-object"
  | "question-set-mismatch"
  | "answer-not-object"
  | "type-mismatch"
  | "unknown-choice"
  | "score-out-of-range"
  | "probability-out-of-range"
  | "distribution-keys"
  | "distribution-values"
  | "distribution-sum"
  | "choice-not-maximal"
  | "score-mean-mismatch"
  | "rounding-invalid"
  | "rounding-mismatch";

export type ValidateAnswersResult<Q extends EvaluationQuestions> =
  | { readonly ok: true; readonly answers: EvaluationAnswers<Q> }
  | {
      readonly ok: false;
      readonly violation: EvaluationAnswerViolation;
      readonly questionId?: string;
    };

// Absolute tolerance shared with the SDK's own validator; the rounding-aware
// slack below is added on top so provider-rounded distributions still pass.
const ABSOLUTE_TOLERANCE = 1e-6;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Half a unit in the last declared decimal; 0 when the provider did not round. */
function roundingSlack(decimals: number | undefined): number | null {
  if (decimals === undefined) {
    return 0;
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 15) {
    return null;
  }
  return 0.5 * 10 ** -decimals;
}

/**
 * Declared rounding only earns its slack when the value really is rounded to
 * that many decimals. Otherwise corrupted or forged `rounding` metadata on a
 * replayed result (e.g. `probabilityDecimals: 0` next to `{0.8, 0.8, 0.8}`)
 * would widen the tolerance enough to accept an inconsistent distribution.
 */
function conformsToDecimals(value: number, decimals: number | undefined): boolean {
  if (decimals === undefined) {
    return true;
  }
  const scaled = value * 10 ** decimals;
  return Math.abs(scaled - Math.round(scaled)) <= 1e-9 * Math.max(1, Math.abs(scaled));
}

function validateDistribution(
  value: unknown,
  keys: readonly string[],
  probabilitySlack: number,
  probabilityDecimals: number | undefined
):
  | { ok: true; distribution: Record<string, number> }
  | { ok: false; violation: EvaluationAnswerViolation } {
  if (!isPlainRecord(value) || !hasExactKeys(value, keys)) {
    return { ok: false, violation: "distribution-keys" };
  }
  const distribution: Record<string, number> = {};
  for (const key of keys) {
    const probability = value[key];
    if (!isProbability(probability)) {
      return { ok: false, violation: "distribution-values" };
    }
    if (!conformsToDecimals(probability, probabilityDecimals)) {
      return { ok: false, violation: "rounding-mismatch" };
    }
    distribution[key] = probability;
  }
  const sum = Object.values(distribution).reduce((total, probability) => total + probability, 0);
  // One half-unit of rounding error per rounded value, accumulated over the sum
  // (a two-decimal distribution over three options may legitimately sum to 0.99).
  if (Math.abs(sum - 1) > ABSOLUTE_TOLERANCE + keys.length * probabilitySlack) {
    return { ok: false, violation: "distribution-sum" };
  }
  return { ok: true, distribution };
}

/**
 * Validate provider (or replayed) answers against the questions they answer.
 *
 * Pure and total: untrusted input never throws. On success the returned
 * `answers` are a fresh projection containing only the contract fields, so
 * provider-added extras never reach persisted results. Mirrors the SDK's rules
 * (exact id set, per-question type, option/level membership, complete
 * distributions, maximal selected choice, score = probability-weighted mean)
 * with the SDK's rounding tolerance so both validators agree.
 */
export function validateAnswersAgainstQuestions<Q extends EvaluationQuestions>(
  questions: Q,
  answers: unknown,
  rounding: EvaluationRounding | null | undefined
): ValidateAnswersResult<Q> {
  const probabilitySlack = roundingSlack(rounding?.probabilityDecimals);
  const scoreSlack = roundingSlack(rounding?.scoreDecimals);
  if (probabilitySlack === null || scoreSlack === null) {
    return { ok: false, violation: "rounding-invalid" };
  }

  const questionIds = Object.keys(questions);
  if (!isPlainRecord(answers) || !hasExactKeys(answers, questionIds)) {
    return {
      ok: false,
      violation:
        answers === null || typeof answers !== "object"
          ? "answers-not-object"
          : "question-set-mismatch",
    };
  }

  const projected: Record<string, EvaluationAnswer> = {};
  for (const id of questionIds) {
    const question = questions[id];
    const answer = answers[id];
    if (!isPlainRecord(answer)) {
      return { ok: false, violation: "answer-not-object", questionId: id };
    }
    if (answer.type !== question.type) {
      return { ok: false, violation: "type-mismatch", questionId: id };
    }

    switch (question.type) {
      case "choice": {
        const options = Object.keys(question.criteria);
        const choice = answer.choice;
        if (typeof choice !== "string" || !Object.hasOwn(question.criteria, choice)) {
          return { ok: false, violation: "unknown-choice", questionId: id };
        }
        if (answer.probabilities === undefined) {
          projected[id] = { type: "choice", choice };
          break;
        }
        const distribution = validateDistribution(
          answer.probabilities,
          options,
          probabilitySlack,
          rounding?.probabilityDecimals
        );
        if (!distribution.ok) {
          return { ok: false, violation: distribution.violation, questionId: id };
        }
        const selected = distribution.distribution[choice];
        if (
          Object.values(distribution.distribution).some(
            (probability) => probability > selected + ABSOLUTE_TOLERANCE
          )
        ) {
          return { ok: false, violation: "choice-not-maximal", questionId: id };
        }
        projected[id] = { type: "choice", choice, probabilities: distribution.distribution };
        break;
      }
      case "score": {
        const maxScore = question.criteria.length - 1;
        const score = answer.score;
        // Fractional scores are legitimate: with a distribution the score is its
        // probability-weighted mean, so only the [0, levels - 1] range is enforced.
        if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > maxScore) {
          return { ok: false, violation: "score-out-of-range", questionId: id };
        }
        if (!conformsToDecimals(score, rounding?.scoreDecimals)) {
          return { ok: false, violation: "rounding-mismatch", questionId: id };
        }
        if (answer.probabilities === undefined) {
          projected[id] = { type: "score", score };
          break;
        }
        const levelKeys = question.criteria.map((_, index) => String(index));
        const distribution = validateDistribution(
          answer.probabilities,
          levelKeys,
          probabilitySlack,
          rounding?.probabilityDecimals
        );
        if (!distribution.ok) {
          return { ok: false, violation: distribution.violation, questionId: id };
        }
        const mean = levelKeys.reduce(
          (total, key) => total + Number(key) * distribution.distribution[key],
          0
        );
        // Each rounded level probability contributes up to index × slack to the
        // mean; the score itself may also be rounded.
        const meanSlack = levelKeys.reduce(
          (total, key) => total + Number(key) * probabilitySlack,
          0
        );
        if (Math.abs(mean - score) > ABSOLUTE_TOLERANCE + meanSlack + scoreSlack) {
          return { ok: false, violation: "score-mean-mismatch", questionId: id };
        }
        projected[id] = { type: "score", score, probabilities: distribution.distribution };
        break;
      }
      case "boolean": {
        const probability = answer.probability;
        if (!isProbability(probability)) {
          return { ok: false, violation: "probability-out-of-range", questionId: id };
        }
        if (!conformsToDecimals(probability, rounding?.probabilityDecimals)) {
          return { ok: false, violation: "rounding-mismatch", questionId: id };
        }
        projected[id] = { type: "boolean", probability };
        break;
      }
    }
  }

  // Every id, type, membership and distribution rule above has been checked
  // against `questions`, which is exactly what `EvaluationAnswers<Q>` encodes.
  return { ok: true, answers: projected as EvaluationAnswers<Q> };
}

// ---------------------------------------------------------------------------
// Canonical request payload (size/depth limits)
// ---------------------------------------------------------------------------

export type EvaluationRequestViolation = "request-too-large" | "request-too-deep";

export type CanonicalRequestResult =
  | {
      readonly ok: true;
      readonly canonical: string;
      readonly bytes: number;
      readonly depth: number;
    }
  | {
      readonly ok: false;
      readonly violation: EvaluationRequestViolation;
      readonly bytes: number;
      readonly depth: number;
    };

/**
 * Nesting depth of a JSON value: scalars are 0, `{}`/`[]` are 1, `{ a: {} }` is 2.
 *
 * Iterative and bounded: `state` is untrusted workflow input, so a recursive
 * walk (or `JSON.stringify`) over a pathologically deep or cyclic value would
 * throw `RangeError` instead of a typed violation. Counting stops as soon as
 * `limit + 1` is reached; the returned depth is then exactly `limit + 1`. The
 * limit is mandatory because a cyclic value never runs out of depth. Its stack
 * is O(width), so run `jsonBytesLowerBound` first on untrusted input.
 */
export function jsonDepth(value: unknown, limit: number): number {
  if (value === null || typeof value !== "object") {
    return 0;
  }
  // Explicit stack of [container, depthOfContainer]; cycles simply keep
  // increasing the depth until the limit stops the walk.
  const stack: Array<[object, number]> = [[value, 1]];
  let deepest = 1;
  while (stack.length > 0) {
    const [container, depth] = stack.pop()!;
    if (depth > deepest) {
      deepest = depth;
    }
    if (deepest > limit) {
      return limit + 1;
    }
    const children: unknown[] = Array.isArray(container) ? container : Object.values(container);
    for (const child of children) {
      if (child !== null && typeof child === "object") {
        stack.push([child, depth + 1]);
      }
    }
  }
  return deepest;
}

export type BoundedParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly violation: "request-too-large"; readonly bytes: number }
  | { readonly ok: false; readonly violation: "request-too-deep"; readonly depth: number }
  | { readonly ok: false; readonly violation: "forbidden-key"; readonly key: string }
  | { readonly ok: false; readonly violation: "invalid"; readonly error: z.ZodError };

/**
 * Keys that JSON input may legitimately carry but that zod's record parser
 * silently drops (it never assigns `__proto__`). Accepting such input would
 * let the parsed value differ from the raw one: two distinct states could
 * share canonical content, or a question/option could vanish without error.
 * Reject them explicitly instead. Only call on values that passed the depth
 * check (the walk is iterative, but width is unbounded like canonicalization).
 */
const FORBIDDEN_JSON_KEYS: ReadonlySet<string> = new Set(["__proto__"]);

function findForbiddenJsonKey(value: unknown): string | undefined {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object") {
      continue;
    }
    if (Array.isArray(current)) {
      // Indexed loop, not `push(...items)`: a wide but in-limit array (e.g.
      // 125k scalars ≈ 250 KB) exceeds V8's argument limit when spread.
      const items: unknown[] = current;
      for (const item of items) {
        stack.push(item);
      }
      continue;
    }
    for (const key of Object.keys(current)) {
      if (FORBIDDEN_JSON_KEYS.has(key)) {
        return key;
      }
      stack.push((current as Record<string, unknown>)[key]);
    }
  }
  return undefined;
}

/**
 * The only supported way to apply the evaluation schemas to untrusted raw
 * values (sandbox `state`/spec, or persisted records read back from disk).
 * The recursive schemas (`z.lazy`) and canonicalization would overflow the
 * stack on a pathologically deep or cyclic value and cost O(size) memory on
 * an oversized one, so the bounded size and depth walks run first and turn
 * such input into typed violations; keys zod would silently drop are rejected
 * before parsing for the same reason.
 *
 * Contract: this guarantees bounded *structural* parsing, not the exact
 * serialized request size. Its `request-too-large` is conclusive (exceeding a
 * lower bound proves the value is oversized), but a pass does not prove the
 * value fits the cap: the lower bound counts UTF-16 units, so e.g.
 * `"é".repeat(131072)` (262146 UTF-8 bytes) parses here. The exact UTF-8
 * request limit is enforced by `canonicalRequestBytes({ state, questions })`,
 * which the workflow runner must apply to the combined request before any
 * provider dispatch.
 */
export function parseEvaluationInputBounded<T>(
  schema: z.ZodType<T>,
  raw: unknown
): BoundedParseResult<T> {
  // Same order as canonicalRequestBytes: size (memory-bounded on any input),
  // then depth, then the key scan, then zod.
  const bytes = jsonBytesLowerBound(raw, EVALUATION_MAX_REQUEST_BYTES);
  if (bytes > EVALUATION_MAX_REQUEST_BYTES) {
    return { ok: false, violation: "request-too-large", bytes };
  }
  const depth = jsonDepth(raw, EVALUATION_MAX_DEPTH);
  if (depth > EVALUATION_MAX_DEPTH) {
    return { ok: false, violation: "request-too-deep", depth };
  }
  const forbiddenKey = findForbiddenJsonKey(raw);
  if (forbiddenKey !== undefined) {
    return { ok: false, violation: "forbidden-key", key: forbiddenKey };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, violation: "invalid", error: parsed.error };
}

/**
 * Canonical (key-sorted) JSON, as used for hashing and replay identity.
 * Recursive: only call it on values that passed a bounded depth check.
 */
export function canonicalEvaluationJson(value: unknown): string {
  return stableStringify(value);
}

/**
 * Cheap lower bound of a value's JSON byte size, computed without allocating
 * the serialization: the root counts one byte, every child of a container
 * costs at least one byte and is charged when its parent is visited, and
 * every string / key contributes its length (UTF-8 never needs fewer bytes
 * than UTF-16 code units, and JSON quoting/escaping only adds).
 *
 * Bounded in time AND memory: the walk stops as soon as `limit` is exceeded,
 * children are charged before they are enqueued (so a 50M-element array is
 * rejected without being copied onto the stack), and object keys are iterated
 * without materializing a key array. Every iteration that enqueues anything
 * also adds bytes, so cyclic values terminate as well — this is therefore the
 * first check to run on untrusted input, ahead of `jsonDepth`.
 */
export function jsonBytesLowerBound(value: unknown, limit: number): number {
  const stack: unknown[] = [value];
  let bytes = 1;
  while (stack.length > 0 && bytes <= limit) {
    const current = stack.pop();
    if (typeof current === "string") {
      bytes += current.length;
    } else if (Array.isArray(current)) {
      const items: unknown[] = current;
      bytes += items.length;
      if (bytes > limit) {
        break;
      }
      for (const item of items) {
        stack.push(item);
      }
    } else if (current !== null && typeof current === "object") {
      const record = current as Record<string, unknown>;
      for (const key in record) {
        if (!Object.hasOwn(record, key)) {
          continue;
        }
        bytes += 1 + key.length;
        if (bytes > limit) {
          break;
        }
        stack.push(record[key]);
      }
    }
  }
  return bytes;
}

/**
 * Canonical JSON of `{ state, questions }` with its UTF-8 byte length and
 * nesting depth (the wrapper object counts as one level), checked against
 * `EVALUATION_MAX_REQUEST_BYTES` / `EVALUATION_MAX_DEPTH`.
 */
export function canonicalRequestBytes(request: {
  readonly state: EvaluationState;
  readonly questions: EvaluationQuestions;
}): CanonicalRequestResult {
  const payload = { state: request.state, questions: request.questions };
  // Size first, without serializing: it is the only walk whose memory is
  // bounded on arbitrary input, and once it passes the payload holds at most
  // EVALUATION_MAX_REQUEST_BYTES nodes, which bounds the depth walk's stack.
  // `bytes` is then the (lower-bound) count at which the walk stopped.
  const lowerBound = jsonBytesLowerBound(payload, EVALUATION_MAX_REQUEST_BYTES);
  if (lowerBound > EVALUATION_MAX_REQUEST_BYTES) {
    return { ok: false, violation: "request-too-large", bytes: lowerBound, depth: 0 };
  }
  // Depth next: canonicalization recurses, so it must never see a payload
  // that exceeds the depth limit (or a cyclic one).
  const depth = jsonDepth(payload, EVALUATION_MAX_DEPTH);
  if (depth > EVALUATION_MAX_DEPTH) {
    return { ok: false, violation: "request-too-deep", bytes: lowerBound, depth };
  }
  const canonical = canonicalEvaluationJson(payload);
  const bytes = new TextEncoder().encode(canonical).length;
  if (bytes > EVALUATION_MAX_REQUEST_BYTES) {
    return { ok: false, violation: "request-too-large", bytes, depth };
  }
  return { ok: true, canonical, bytes, depth };
}
