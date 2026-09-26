import { APICallError, experimental_evaluate } from "ai";
import { Effect } from "effect";
import { Err, Ok, type Result } from "@/common/types/result";
import type {
  AutoModelRoutingDecision,
  AutoModelRoutingEvaluationStatus,
  AutoModelRoutingTier,
} from "@/common/types/autoModelRouting";
import {
  AUTO_MODEL_ROUTING_CLASSIFIER_TIMEOUT_MS,
  AUTO_MODEL_ROUTING_MAX_PROMPT_CHARS,
  AUTO_MODEL_ROUTING_MIN_TIERS,
  AUTO_MODEL_ROUTING_RECENT_MESSAGE_LIMIT,
  AUTO_MODEL_ROUTING_RECENT_MESSAGE_MAX_CHARS,
  TYPESAFE_PROVIDER_KEY,
} from "@/constants/autoModelRouting";
import {
  createEvaluationModel,
  resolveEvaluationModelTarget,
  type EvaluationModelFactoryDeps,
} from "@/node/services/evaluationModelFactory";
import { log } from "@/node/services/log";

const QUESTION_ID = "difficulty";
const QUESTION_INSTRUCTIONS =
  "Which difficulty tier best describes the work this coding-agent prompt asks for? " +
  "Judge scope, ambiguity, how many files or systems are involved, and how much reasoning is needed.";

export interface AutoModelRouterClassifyInput {
  prompt: string;
  /** Prior user prompts, oldest first, for conversational context. */
  recentUserMessages?: string[];
  tiers: AutoModelRoutingTier[];
  /** The user's `provider:model` evaluation model from the routing config. */
  evaluationModel: string;
  signal?: AbortSignal;
}

/**
 * Difficulty classifier for the auto-model-routing experiment: one AI SDK
 * `experimental_evaluate` "choice" question whose options are the user's tier
 * descriptions, judged by the user's evaluation model. Every failure is an Err so
 * the caller falls back to the composer's choices. No retries: a second paid
 * round-trip is not worth the send latency.
 *
 * Provided to the core graph as `AutoModelRouterTag` (di/layers/core.ts).
 */
export class AutoModelRouter {
  constructor(private readonly deps: EvaluationModelFactoryDeps) {}

  /** Availability without loading a provider SDK or sending anything. */
  getEvaluationStatus(evaluationModel: string): AutoModelRoutingEvaluationStatus {
    const target = resolveEvaluationModelTarget(evaluationModel, this.deps);
    return target.success
      ? { evaluationModel, available: true }
      : { evaluationModel, available: false, reason: target.error.message };
  }

  classify(input: AutoModelRouterClassifyInput): Promise<Result<AutoModelRoutingDecision, string>> {
    return Effect.runPromise(this.classifyEffect(input));
  }

  classifyEffect(
    input: AutoModelRouterClassifyInput
  ): Effect.Effect<Result<AutoModelRoutingDecision, string>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    return Effect.gen(function* () {
      if (input.tiers.length < AUTO_MODEL_ROUTING_MIN_TIERS) {
        return Err(`Auto model routing needs at least ${AUTO_MODEL_ROUTING_MIN_TIERS} tiers`);
      }
      const model = yield* createEvaluationModel(input.evaluationModel, self.deps);
      if (!model.success) return self.fail(model.error.message);

      const recentUserMessages = (input.recentUserMessages ?? [])
        .slice(-AUTO_MODEL_ROUTING_RECENT_MESSAGE_LIMIT)
        .map((text) => text.slice(0, AUTO_MODEL_ROUTING_RECENT_MESSAGE_MAX_CHARS));
      const timeoutSignal = AbortSignal.timeout(AUTO_MODEL_ROUTING_CLASSIFIER_TIMEOUT_MS);
      const startedAt = Date.now();
      const evaluation = yield* Effect.tryPromise({
        try: () =>
          experimental_evaluate({
            model: model.data,
            state: {
              prompt: input.prompt.slice(0, AUTO_MODEL_ROUTING_MAX_PROMPT_CHARS),
              ...(recentUserMessages.length > 0 ? { recentUserMessages } : {}),
            },
            questions: {
              [QUESTION_ID]: {
                type: "choice",
                instructions: QUESTION_INSTRUCTIONS,
                criteria: Object.fromEntries(
                  input.tiers.map((tier) => [tier.id, tier.description])
                ),
              },
            },
            maxRetries: 0,
            abortSignal: input.signal
              ? AbortSignal.any([input.signal, timeoutSignal])
              : timeoutSignal,
          }),
        catch: (error) => error,
      }).pipe(
        Effect.map((result) => Ok(result)),
        Effect.catch((error) => Effect.succeed(Err(error)))
      );
      if (!evaluation.success) {
        // The reason is persisted in message metadata, so keep provider error bodies out
        // of it; the full error goes to the debug log.
        log.debug("Auto model routing evaluation error", { error: evaluation.error });
        return self.fail(
          timeoutSignal.aborted
            ? `Evaluation timed out after ${AUTO_MODEL_ROUTING_CLASSIFIER_TIMEOUT_MS}ms`
            : describeEvaluationError(evaluation.error)
        );
      }

      // experimental_evaluate rejects a choice outside the criteria and any distribution
      // that is not complete over exactly the criteria keys, so both are trusted here.
      const answer = evaluation.data.answers[QUESTION_ID];
      const confidence = readTypeSafeConfidence(evaluation.data.providerMetadata);
      const decision: AutoModelRoutingDecision = {
        tierId: answer.choice,
        ...(confidence != null ? { confidence } : {}),
        ...(answer.probabilities ? { probabilities: answer.probabilities } : {}),
        evaluationModel: input.evaluationModel,
        // TypeSafe reports no token usage; keep those decisions free of an all-undefined object.
        ...(hasTokenCounts(evaluation.data.usage) ? { usage: evaluation.data.usage } : {}),
        ...(evaluation.data.providerMetadata
          ? { providerMetadata: evaluation.data.providerMetadata }
          : {}),
      };
      log.debug("Auto model routing classified prompt", {
        tierId: decision.tierId,
        confidence: decision.confidence,
        evaluationModel: input.evaluationModel,
        latencyMs: Date.now() - startedAt,
      });
      return Ok(decision);
    });
  }

  private fail(reason: string): Result<AutoModelRoutingDecision, string> {
    log.warn("Auto model routing evaluation failed; falling back to the composer's choices", {
      reason,
    });
    return Err(reason);
  }
}

function hasTokenCounts(usage: NonNullable<AutoModelRoutingDecision["usage"]>): boolean {
  return usage.inputTokens != null || usage.outputTokens != null || usage.totalTokens != null;
}

/** SDK error messages embed response bodies (and with them any echoed credential), so only a category survives. */
function describeEvaluationError(error: unknown): string {
  if (APICallError.isInstance(error)) {
    return error.statusCode != null
      ? `Evaluation request failed with HTTP ${error.statusCode}`
      : "Evaluation request failed";
  }
  return `Evaluation failed (${error instanceof Error ? error.name : typeof error})`;
}

/** TypeSafe reports a per-question confidence in provider metadata; other evaluators do not. */
function readTypeSafeConfidence(providerMetadata: unknown): number | undefined {
  if (typeof providerMetadata !== "object" || providerMetadata === null) return undefined;
  const typesafe = (providerMetadata as Record<string, unknown>)[TYPESAFE_PROVIDER_KEY];
  if (typeof typesafe !== "object" || typesafe === null) return undefined;
  const confidence = (typesafe as Record<string, unknown>).confidence;
  if (typeof confidence !== "object" || confidence === null) return undefined;
  const value = (confidence as Record<string, unknown>)[QUESTION_ID];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
