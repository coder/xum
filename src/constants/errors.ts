/**
 * Default bound for clampErrorMessage. Generous for real provider errors,
 * tiny compared to the pathological cases it defends against (AI SDK errors
 * that embed entire serialized request payloads in their message).
 */
export const ERROR_MESSAGE_CLAMP_MAX_CHARS = 8_000;

/** Schema issues an input-validation error lists, in the UI and in the server log alike. */
export const MAX_SHOWN_VALIDATION_ISSUES = 5;

/** Longest single schema issue message an input-validation error repeats. */
export const MAX_VALIDATION_ISSUE_MESSAGE_CHARS = 300;
