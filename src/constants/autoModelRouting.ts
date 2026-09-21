/**
 * Auto model routing (auto-model-routing experiment): the composer's Auto entries
 * send each prompt to the user's evaluation model (AI SDK `experimental_evaluate`)
 * for a single difficulty-tier choice and run the turn on that tier's model and/or
 * thinking level.
 */

/**
 * providers.jsonc entry holding the TypeSafe credential. Deliberately not a
 * ProviderName: TypeSafe serves no chat models, so it must never appear in
 * model lists or provider rows.
 */
export const TYPESAFE_PROVIDER_KEY = "typesafe";

/**
 * Providers whose AI SDK package exposes `evaluationModel()`. The evaluation model
 * is a user choice (`provider:model`); nothing else about routing is provider-specific.
 */
export const AUTO_MODEL_ROUTING_EVALUATION_PROVIDERS = [
  TYPESAFE_PROVIDER_KEY,
  "openai",
  "anthropic",
  "google",
] as const;
export type AutoModelRoutingEvaluationProvider =
  (typeof AUTO_MODEL_ROUTING_EVALUATION_PROVIDERS)[number];

/** TypeSafe's native evaluator: the default until the user picks another model. */
export const DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL = `${TYPESAFE_PROVIDER_KEY}:jev-latest`;

/** Environment variables consulted after providers.jsonc for the TypeSafe key, in order. */
export const TYPESAFE_API_KEY_ENV_VARS = [
  "TYPESAFE_API_KEY",
  "TYPESAFE_AI_API_KEY",
  "JEV_API_KEY",
] as const;

/**
 * Prompt text cap sent to the evaluation model. Small evaluators have windows around
 * 32k tokens; 24k chars leaves room for the question, criteria, and recent messages.
 */
export const AUTO_MODEL_ROUTING_MAX_PROMPT_CHARS = 24_000;

export const AUTO_MODEL_ROUTING_MIN_TIERS = 2;
export const AUTO_MODEL_ROUTING_MAX_TIERS = 8;

/**
 * Tier labels ride in the transcript badge; descriptions are copied verbatim into
 * the evaluation criteria, so unbounded text could push every request past a small
 * evaluator's window and leave Auto permanently falling back.
 */
export const AUTO_MODEL_ROUTING_MAX_LABEL_CHARS = 32;
export const AUTO_MODEL_ROUTING_MAX_DESCRIPTION_CHARS = 400;

export const AUTO_MODEL_ROUTING_RECENT_MESSAGE_LIMIT = 3;
export const AUTO_MODEL_ROUTING_RECENT_MESSAGE_MAX_CHARS = 500;

/**
 * Best-effort classification: a slow evaluator must not stall the send, so the
 * request is abandoned and the turn falls back to the composer's choices.
 */
export const AUTO_MODEL_ROUTING_CLASSIFIER_TIMEOUT_MS = 8_000;

/**
 * Mid-turn thinking escalation for turns whose thinking level Auto chose. The turn
 * counts as stuck after this many consecutive tool steps that all failed, or that
 * repeated one identical call; each raise moves one level up the ladder.
 */
export const AUTO_THINKING_ESCALATION_WINDOW_STEPS = 3;
/** Raises per turn; the tier's level plus two is as far as Auto goes without the user. */
export const AUTO_THINKING_ESCALATION_MAX_PER_TURN = 2;
