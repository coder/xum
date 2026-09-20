/**
 * Auto model routing (auto-model-routing experiment): the composer's Auto entry
 * sends each prompt to TypeSafe's Jev System One for a single difficulty-tier
 * choice and runs the turn on that tier's configured model.
 */

export const TYPESAFE_SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";

/**
 * providers.jsonc entry holding the TypeSafe credential. Deliberately not a
 * ProviderName: TypeSafe serves no chat models, so it must never appear in
 * model lists or provider rows.
 */
export const TYPESAFE_PROVIDER_KEY = "typesafe";

/** Alias resolved server-side to the latest Jev release. */
export const AUTO_MODEL_ROUTING_CLASSIFIER_MODEL = "jev-latest";

/** Environment variables consulted after providers.jsonc, in order. */
export const AUTO_MODEL_ROUTING_API_KEY_ENV_VARS = ["TYPESAFE_API_KEY", "JEV_API_KEY"] as const;

/**
 * Prompt text cap sent to the classifier. Jev's context window is 32k tokens;
 * 24k chars leaves room for the question, criteria, and recent messages.
 */
export const AUTO_MODEL_ROUTING_MAX_PROMPT_CHARS = 24_000;

export const AUTO_MODEL_ROUTING_RECENT_MESSAGE_LIMIT = 3;
export const AUTO_MODEL_ROUTING_RECENT_MESSAGE_MAX_CHARS = 500;

/**
 * Best-effort classification: a slow classifier must not stall the send, so
 * the request is abandoned and the turn falls back to the composer's model.
 */
export const AUTO_MODEL_ROUTING_CLASSIFIER_TIMEOUT_MS = 8_000;
