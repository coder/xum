// Limits for the workflow `evaluate()` primitive (AI SDK `experimental_evaluate`).
//
// The option/level limits are the strictest limits across the supported
// evaluation providers, applied universally so a workflow that validates here
// runs unchanged on every eligible provider. Request-size limits bound the
// canonical `{ state, questions }` payload before any provider call so an
// oversized or pathologically nested sandbox value is rejected as invalid
// input instead of becoming a billable request.

export const EVALUATION_MAX_QUESTIONS = 32;
export const EVALUATION_MAX_REQUEST_BYTES = 256 * 1024;
export const EVALUATION_MAX_DEPTH = 16;

export const EVALUATION_DEFAULT_TIMEOUT_MS = 60_000;
export const EVALUATION_MIN_TIMEOUT_MS = 5_000;
export const EVALUATION_MAX_TIMEOUT_MS = 300_000;
export const EVALUATION_MAX_ATTEMPTS = 3;

export const EVALUATION_CHOICE_MIN_OPTIONS = 1;
export const EVALUATION_CHOICE_MAX_OPTIONS = 255;
export const EVALUATION_SCORE_MIN_LEVELS = 2;
export const EVALUATION_SCORE_MAX_LEVELS = 10;
